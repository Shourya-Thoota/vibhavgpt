import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { shadowCostLedger } from "../db/schema.js";
import {
  ACTIVE_PRICING_VERSION_ID,
  calculateImageCost,
  calculateInferenceCost,
  normalizedUsageComponents,
  resolvePricingContract,
} from "./shadow-ledger.js";
import {
  getActiveSubscription,
  monthlyEntitlementPeriodEnd,
  monthlyEntitlementPeriodStart,
  tierForSubscription,
  utcMonthWindow,
} from "./service.js";

let defaultDb = null;
async function getDefaultDb() {
  if (!defaultDb) {
    const clientModule = await import("../db/client.js");
    defaultDb = clientModule.db;
  }
  return defaultDb;
}

/**
 * Authoritative Subscription Plan Allowance limits in micro-dollars ($1 USD = 1,000,000 micro-dollars).
 * Grounded strictly in owner policy:
 * - Max: $50/month display price, $30 included actual AI cost per monthly billing cycle.
 * - Pro: Existing subscription price ($12.99/mo), $12 included actual AI cost per billing cycle.
 * - Plus: Existing subscription price ($4.99/mo), $5 included actual AI cost per billing cycle.
 * - Free: $0.11 monthly, $0.011 daily, 20 requests/day cap, 0 images.
 *
 * Paid plans have no arbitrary short-window financial limits that prevent access
 * to their cycle allowance. Technical rate limits/abuse protections remain separate.
 */
export const PLAN_ALLOWANCES = Object.freeze({
  max: Object.freeze({
    tier: "max",
    monthlyAllowanceMicros: 30_000_000, // $30.00 USD actual AI cost per monthly billing cycle
    maxImagesPerMonth: 200,
    imageSpendingSublimitMicros: 30_000_000,
  }),
  pro: Object.freeze({
    tier: "pro",
    monthlyAllowanceMicros: 12_000_000, // $12.00 USD actual AI cost per billing cycle
    maxImagesPerMonth: 60,
    imageSpendingSublimitMicros: 12_000_000,
  }),
  plus: Object.freeze({
    tier: "plus",
    monthlyAllowanceMicros: 5_000_000,  // $5.00 USD actual AI cost per billing cycle
    maxImagesPerMonth: 25,
    imageSpendingSublimitMicros: 5_000_000,
  }),
  free: Object.freeze({
    tier: "free",
    monthlyAllowanceMicros: 110_000,    // $0.11 USD per calendar month
    dailyAllowanceMicros: 11_000,       // $0.011 USD daily window
    maxDailyRequests: 20,
    imageSpendingSublimitMicros: 0,
    maxImagesPerMonth: 0,              // Images strictly disabled
  }),
});

/**
 * Authoritative approved free-model group.
 * Endpoints are never assumed to be free based on display name alone; they must
 * be explicitly classified in this group with planEligibility === "free".
 */
export const APPROVED_FREE_MODEL_GROUP = Object.freeze([
  Object.freeze({
    modelKey: "lumen",
    familySlug: "vibhavgpt/lumen",
    displayName: "VibhavGPT Lumen",
    familyGroup: "native",
    planEligibility: "free",
    description: "Lightweight, simple tasks included on all accounts.",
  }),
]);

export const ALLOWANCE_LIFECYCLE_STATES = Object.freeze({
  RESERVED: "reserved",
  DISPATCHED: "dispatched",
  SETTLED: "settled",
  RELEASED: "released",
  UNCERTAIN: "uncertain",
  RECONCILED: "reconciled",
  ATTEMPT_FAILED: "attempt_failed",
});

export const ESTIMATION_POLICY_VERSIONS = Object.freeze({
  DISABLED: "disabled",
  V1: "fallback_bytes_v1",
});

export const ACTIVE_ESTIMATION_POLICY = ESTIMATION_POLICY_VERSIONS.DISABLED;

export const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_LEASE_DURATION_MS = 60 * 1000;      // 60 seconds
export const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;      // 5 hours
export const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;       // 24 hours

export class AllowanceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || "allowance_error";
    this.status = options.status || 400;
    Object.assign(this, options);
  }
}

export class AllowanceExceededError extends AllowanceError {
  constructor(message, options = {}) {
    super(message, { code: "allowance_exceeded", status: 429, ...options });
  }
}

export class AllowanceIdempotencyConflictError extends AllowanceError {
  constructor(message, options = {}) {
    super(message, { code: "idempotency_conflict", status: 409, ...options });
  }
}

export class AllowanceInvalidTransitionError extends AllowanceError {
  constructor(message, options = {}) {
    super(message, { code: "invalid_lifecycle_transition", status: 409, ...options });
  }
}

export class AllowanceNotFoundError extends AllowanceError {
  constructor(message, options = {}) {
    super(message, { code: "reservation_not_found", status: 404, ...options });
  }
}

/**
 * Calculates effective consumption of a ledger row for allowance checks.
 * Expired undispatched reservations are zeroed out immediately without waiting for sweep.
 */
function rowEffectiveMicros(row, now) {
  const status = row.status;
  if (status === ALLOWANCE_LIFECYCLE_STATES.SETTLED || status === ALLOWANCE_LIFECYCLE_STATES.RECONCILED) {
    // Allowance settlement and reconciliation always write settledCostMicros (actual cost).
    // Legacy shadow-observation rows can also reach "reconciled" but only carry the marked-up
    // shadowDeductionMicros; they record native chat for analysis and are not allowance usage.
    return Number(row.settledCostMicros ?? 0);
  }
  if (status === ALLOWANCE_LIFECYCLE_STATES.RESERVED) {
    if (!row.dispatchedAt && row.reservationExpiresAt && new Date(row.reservationExpiresAt) <= now) {
      return 0; // Stale undispatched hold has expired
    }
    return Number(row.reservedCostMicros ?? 0);
  }
  if (status === ALLOWANCE_LIFECYCLE_STATES.DISPATCHED || status === ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN) {
    return Number(row.reservedCostMicros ?? 0);
  }
  return 0;
}

/**
 * Actual cost from the rates pinned on the reservation (registry snapshot), with
 * cached input billed at the cached-read rate and reasoning counted inside output.
 * Exact integer pico-dollar arithmetic, ceil to a micro-dollar, no markup.
 */
export function calculateCostFromPinnedRates({ usage, rates }) {
  const parts = normalizedUsageComponents(usage);
  if (!parts.valid || !rates) return null;
  const rateIn = BigInt(Math.round(Number(rates.input ?? 0) * 1_000_000));
  const rateOut = BigInt(Math.round(Number(rates.output ?? 0) * 1_000_000));
  const rateCache = BigInt(Math.round(Number(rates.cacheRead ?? rates.input ?? 0) * 1_000_000));
  const cached = Math.min(parts.cachedInputTokens, parts.inputTokens);
  const rawPico = BigInt(parts.inputTokens - cached) * rateIn + BigInt(cached) * rateCache + BigInt(parts.outputTokens) * rateOut;
  return {
    rawCostMicros: Number((rawPico + 999_999n) / 1_000_000n),
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
    cachedInputTokens: cached,
    reasoningTokens: parts.reasoningTokens,
    usageConfidence: "measured",
    pricingConfidence: "pinned_registry_rates",
  };
}

// A cost the provider reported for this exact request, in USD. Only used when the
// transport adapter marks it as such, never for an arbitrary "cost" field.
export function providerReportedCostMicros(usage) {
  if (usage?.costBasis !== "provider_reported") return null;
  const cost = Number(usage.cost);
  if (!Number.isFinite(cost) || cost < 0) return null;
  return Math.ceil(Number((cost * 1_000_000).toFixed(6)));
}

/**
 * Estimates worst-case reservation cost for text inference.
 * Uses exact integer pico-dollar arithmetic with 10% platform markup and ceil rounding.
 */
export function estimateInferenceReservationCost({
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  estimatedInputTokens = 0,
  maxOutputTokens = 4096,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  pinnedRates = null,
} = {}) {
  const contract = resolvePricingContract({
    tier: modelKey,
    modelIdentifier,
    provider,
    transport,
    pricingVersionId,
  });

  const rateIn = pinnedRates?.input ?? contract?.input ?? 0.30;
  const rateOut = pinnedRates?.output ?? contract?.output ?? 2.50;
  const rateCache = pinnedRates?.cacheRead ?? contract?.cacheRead ?? rateIn;

  const bufferTokens = 512;
  const inputTokens = Math.max(0, Number(estimatedInputTokens) || 0) + bufferTokens;
  const outputTokens = Math.max(0, Number(maxOutputTokens) || 0);

  const rateInPico = BigInt(Math.round(rateIn * 1_000_000));
  const rateOutPico = BigInt(Math.round(rateOut * 1_000_000));

  const rawPico = BigInt(inputTokens) * rateInPico + BigInt(outputTokens) * rateOutPico;
  const deductionPico = rawPico > 0n ? rawPico : 0n;

  const reservedCostMicros = deductionPico > 0n
    ? Number((deductionPico + 999_999n) / 1_000_000n)
    : 0;

  const rawCostMicros = rawPico > 0n
    ? Number((rawPico + 999_999n) / 1_000_000n)
    : 0;

  return {
    reservedCostMicros,
    rawCostMicros,
    estimatedInputTokens: inputTokens,
    maxOutputTokens: outputTokens,
    pricingVersionId: (contract || pinnedRates) ? pricingVersionId : "fallback_estimate",
    pricingSource: pinnedRates ? "snapshot_contract" : (contract?.provenance ?? "fallback_estimate"),
    rates: {
      input: rateIn,
      output: rateOut,
      cacheRead: rateCache,
    },
  };
}

/**
 * Dynamically calculates maximum affordable output tokens when remaining allowance
 * cannot cover default output ceiling. Adheres strictly to Section 5.1 of spec:
 * Max Affordable Output = floor((Remaining Allowance - 1.10 * Cost(Input)) / (1.10 * P_out) * 1M).
 * Minimum floor: 256 tokens. Returns 0 if minimum floor cannot be satisfied.
 */
export function calculateDynamicOutputTokenCap({
  availableMicros,
  estimatedInputTokens = 0,
  rateIn,
  rateOut,
}) {
  if (availableMicros <= 0 || !rateOut || rateOut <= 0) return 0;

  const bufferTokens = 512;
  const totalInputTokens = Math.max(0, Number(estimatedInputTokens) || 0) + bufferTokens;
  const rateInPico = BigInt(Math.round(rateIn * 1_000_000));
  const inputRawPico = BigInt(totalInputTokens) * rateInPico;
  const inputDeductionPico = inputRawPico > 0n ? inputRawPico : 0n;
  const inputCostMicros = Number((inputDeductionPico + 999_999n) / 1_000_000n);

  if (availableMicros <= inputCostMicros) {
    return 0; // Cannot even afford input prompt + buffer
  }

  const remainingOutputMicros = availableMicros - inputCostMicros;
  const remainingOutputPico = BigInt(remainingOutputMicros) * 1_000_000n;

  const rateOutPico = BigInt(Math.round(rateOut * 1_000_000));
  const rateOutDeductionPico = rateOutPico;

  if (rateOutDeductionPico === 0n) return 4096;

  const affordableTokens = Number(remainingOutputPico / rateOutDeductionPico);

  if (affordableTokens >= 256) {
    return affordableTokens;
  }
  return 0;
}

/**
 * Evaluates a user's available allowance across dual windows (monthly & 5-hour rolling/daily)
 * and modality-specific spending sublimits.
 * Crucial invariant: Unresolved in-flight or uncertain holds remain held against available
 * balance even across rolling window boundaries.
 */
export async function getAvailableAllowance(userId, options = {}, executor = null) {
  if (!userId) throw new AllowanceError("userId is required", { code: "missing_user_id" });

  const db = executor || await getDefaultDb();
  const now = options.now instanceof Date ? options.now : new Date();

  // 1. Determine plan & billing cycle
  let plan = options.plan;
  let subscription = null;
  if (!plan) {
    subscription = await getActiveSubscription(userId, db);
    plan = tierForSubscription(subscription, now);
  } else {
    subscription = await getActiveSubscription(userId, db);
  }
  const planLimits = PLAN_ALLOWANCES[plan] || PLAN_ALLOWANCES.free;

  // 2. Window bounds
  let monthlyStart;
  let monthlyEnd;
  const hasStripeAnchor = subscription?.currentPeriodStartedAt != null;
  const hasHistoricalAnchor = subscription?.createdAt != null && new Date(subscription.createdAt) <= now;
  if (["plus", "pro", "max"].includes(plan) && (hasStripeAnchor || hasHistoricalAnchor)) {
    monthlyStart = monthlyEntitlementPeriodStart(subscription, now);
    monthlyEnd = monthlyEntitlementPeriodEnd(subscription, now);
  } else {
    const month = utcMonthWindow(now);
    monthlyStart = month.start;
    monthlyEnd = month.end;
  }

  const rollingStart = new Date(now.getTime() - ROLLING_WINDOW_MS);
  const dailyStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const dailyEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));

  // Query all entries for user: settled within earliest active window, PLUS any unresolved holds
  const earliestStart = new Date(Math.min(monthlyStart.getTime(), rollingStart.getTime(), dailyStart.getTime()));

  const rows = await db
    .select()
    .from(shadowCostLedger)
    .where(
      and(
        eq(shadowCostLedger.userId, userId),
        lte(shadowCostLedger.createdAt, now),
        or(
          gte(shadowCostLedger.createdAt, earliestStart),
          inArray(shadowCostLedger.status, [
            ALLOWANCE_LIFECYCLE_STATES.RESERVED,
            ALLOWANCE_LIFECYCLE_STATES.DISPATCHED,
            ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN,
          ])
        )
      )
    );

  let monthlyUsed = 0;
  // Breakdown of monthlyUsed: settled/reconciled cost versus unresolved holds.
  let monthlyConfirmed = 0;
  let monthlyPending = 0;
  let rollingUsed = 0;
  let dailyUsed = 0;
  let dailyRequestsUsed = 0;
  let monthlyImageCount = 0;
  let monthlyImageSpentMicros = 0;

  for (const row of rows) {
    const cost = rowEffectiveMicros(row, now);
    const rowTime = new Date(row.createdAt).getTime();
    const isUnresolvedHold = (
      row.status === ALLOWANCE_LIFECYCLE_STATES.RESERVED ||
      row.status === ALLOWANCE_LIFECYCLE_STATES.DISPATCHED ||
      row.status === ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN
    );

    // Monthly window aggregation: include settled within month OR active unresolved holds
    if (rowTime >= monthlyStart.getTime() && rowTime <= monthlyEnd.getTime()) {
      monthlyUsed += cost;
      if (isUnresolvedHold) monthlyPending += cost;
      else monthlyConfirmed += cost;
      if (row.modality === "image" && row.status !== ALLOWANCE_LIFECYCLE_STATES.RELEASED && row.status !== ALLOWANCE_LIFECYCLE_STATES.ATTEMPT_FAILED) {
        monthlyImageCount += 1;
        monthlyImageSpentMicros += cost;
      }
    } else if (isUnresolvedHold && cost > 0) {
      monthlyUsed += cost;
      monthlyPending += cost;
      if (row.modality === "image") {
        monthlyImageCount += 1;
        monthlyImageSpentMicros += cost;
      }
    }

    // 5-hour rolling window aggregation: include settled within window OR active unresolved holds
    if (rowTime >= rollingStart.getTime()) {
      rollingUsed += cost;
    } else if (isUnresolvedHold && cost > 0) {
      rollingUsed += cost;
    }

    // Daily window aggregation (Free tier)
    if (rowTime >= dailyStart.getTime() && rowTime <= dailyEnd.getTime()) {
      dailyUsed += cost;
      const isPreDispatchRelease = row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED && !row.dispatchedAt;
      if (!isPreDispatchRelease && row.status !== ALLOWANCE_LIFECYCLE_STATES.ATTEMPT_FAILED) {
        dailyRequestsUsed += 1;
      }
    } else if (isUnresolvedHold && cost > 0) {
      dailyUsed += cost;
    }
  }

  const monthlyRemaining = Math.max(0, planLimits.monthlyAllowanceMicros - monthlyUsed);
  const rollingRemaining = planLimits.rollingAllowanceMicros !== undefined
    ? Math.max(0, planLimits.rollingAllowanceMicros - rollingUsed)
    : null;
  const dailyRemaining = planLimits.dailyAllowanceMicros !== undefined
    ? Math.max(0, planLimits.dailyAllowanceMicros - dailyUsed)
    : null;

  let availableMicros = monthlyRemaining;
  if (rollingRemaining !== null) {
    availableMicros = Math.min(availableMicros, rollingRemaining);
  }
  if (dailyRemaining !== null) {
    availableMicros = Math.min(availableMicros, dailyRemaining);
  }

  let availableImageMicros = 0;
  if (planLimits.maxImagesPerMonth > monthlyImageCount) {
    const imageSublimitRemaining = Math.max(0, (planLimits.imageSpendingSublimitMicros ?? 0) - monthlyImageSpentMicros);
    availableImageMicros = Math.min(availableMicros, imageSublimitRemaining);
  }

  return {
    userId,
    plan,
    monthly: {
      limitMicros: planLimits.monthlyAllowanceMicros,
      usedMicros: monthlyUsed,
      confirmedMicros: monthlyConfirmed,
      pendingMicros: monthlyPending,
      remainingMicros: monthlyRemaining,
      periodStart: monthlyStart,
      periodEnd: monthlyEnd,
    },
    rolling: {
      limitMicros: planLimits.rollingAllowanceMicros ?? null,
      usedMicros: rollingUsed,
      remainingMicros: rollingRemaining,
      periodStart: rollingStart,
      periodEnd: now,
    },
    daily: planLimits.dailyAllowanceMicros !== undefined ? {
      limitMicros: planLimits.dailyAllowanceMicros,
      usedMicros: dailyUsed,
      remainingMicros: dailyRemaining,
      periodStart: dailyStart,
      periodEnd: dailyEnd,
      dailyRequestsUsed,
      maxDailyRequests: planLimits.maxDailyRequests,
    } : null,
    images: {
      maxImages: planLimits.maxImagesPerMonth,
      usedCount: monthlyImageCount,
      remainingCount: Math.max(0, planLimits.maxImagesPerMonth - monthlyImageCount),
      sublimitMicros: planLimits.imageSpendingSublimitMicros ?? 0,
      usedMicros: monthlyImageSpentMicros,
      remainingMicros: Math.max(0, (planLimits.imageSpendingSublimitMicros ?? 0) - monthlyImageSpentMicros),
    },
    availableMicros,
    availableImageMicros,
  };
}

/**
 * Places an atomic, idempotent allowance reservation hold in PostgreSQL.
 * Serializes per-account mutations via SELECT pg_advisory_xact_lock(hashtext(userId)).
 */
export async function reserveAllowance({
  userId,
  requestId,
  operation = "inference",
  modality = "text",
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  estimatedInputTokens = 0,
  maxOutputTokens = 4096,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  idempotencyKey,
  metadata = {},
  ttlMs = DEFAULT_RESERVATION_TTL_MS,
  reservationTtlMs = null,
  now = new Date(),
}, executor = null) {
  const effectiveTtlMs = reservationTtlMs ?? ttlMs;
  if (!userId) throw new AllowanceError("userId is required", { code: "missing_user_id" });
  if (!idempotencyKey) throw new AllowanceError("idempotencyKey is required", { code: "missing_idempotency_key" });
  if (!modelKey) throw new AllowanceError("modelKey is required", { code: "missing_model_key" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    // 1. Concurrency isolation: Advisory lock per user
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    // 2. Idempotency Check
    const [existing] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existing) {
      if (
        existing.userId === userId &&
        existing.operation === operation &&
        existing.modelKey === modelKey
      ) {
        return {
          reservationId: existing.id,
          reservedCostMicros: existing.reservedCostMicros,
          status: existing.status,
          reservationExpiresAt: existing.reservationExpiresAt,
          isDuplicate: true,
          row: existing,
        };
      }
      throw new AllowanceIdempotencyConflictError(
        "Idempotency key collision with conflicting reservation payload",
        { idempotencyKey, existingUserId: existing.userId, requestedUserId: userId }
      );
    }

    // 3. Balance verification
    const balance = await getAvailableAllowance(userId, { now }, tx);
    const planLimits = PLAN_ALLOWANCES[balance.plan] || PLAN_ALLOWANCES.free;

    // Check Free tier daily request count ceiling
    if (balance.plan === "free" && balance.daily && balance.daily.dailyRequestsUsed >= planLimits.maxDailyRequests) {
      throw new AllowanceExceededError("Daily request allowance limit reached for Free tier", {
        window: "daily_requests",
        userId,
        limitRequests: planLimits.maxDailyRequests,
        usedRequests: balance.daily.dailyRequestsUsed,
        resetAt: balance.daily.periodEnd,
      });
    }

    // Check Image modality constraints
    if (modality === "image") {
      if (planLimits.maxImagesPerMonth === 0) {
        throw new AllowanceExceededError("Image generation is not included in the Free tier", {
          window: "image_sublimit",
          userId,
          requiredPlan: "Plus or Pro",
        });
      }
      if (balance.images.usedCount >= planLimits.maxImagesPerMonth) {
        throw new AllowanceExceededError("Monthly image generation count cap reached", {
          window: "image_count",
          userId,
          maxImages: planLimits.maxImagesPerMonth,
          resetAt: balance.monthly.periodEnd,
        });
      }
    }

    // 4. Estimation & dynamic capping
    let estimation;
    let cappedOutputTokens = null;

    if (modality === "image") {
      const imgCalc = calculateImageCost({
        modelKey,
        modelIdentifier,
        provider,
        transport,
        pricingVersionId,
      });
      const reservedCost = imgCalc.shadowDeductionMicros || 44_000;
      estimation = {
        reservedCostMicros: reservedCost,
        rawCostMicros: imgCalc.rawCostMicros || 40_000,
        pricingVersionId: imgCalc.pricingVersionId || pricingVersionId,
        pricingSource: imgCalc.pricingSource || "image_contract",
        rates: { perItem: 0.04 },
      };

      if (balance.availableImageMicros < estimation.reservedCostMicros) {
        throw new AllowanceExceededError("Image generation allowance exceeded", {
          window: "image_sublimit",
          userId,
          availableMicros: balance.availableImageMicros,
          requestedMicros: estimation.reservedCostMicros,
          limitMicros: planLimits.imageSpendingSublimitMicros,
          resetAt: balance.monthly.periodEnd,
        });
      }
    } else {
      estimation = estimateInferenceReservationCost({
        modelKey,
        modelIdentifier,
        provider,
        transport,
        estimatedInputTokens,
        maxOutputTokens,
        pricingVersionId,
        pinnedRates: metadata?.pinnedRates || null,
      });

      let affordableTokens = 0;
      if (balance.availableMicros < estimation.reservedCostMicros) {
        affordableTokens = calculateDynamicOutputTokenCap({
          availableMicros: balance.availableMicros,
          estimatedInputTokens,
          rateIn: estimation.rates.input,
          rateOut: estimation.rates.output,
        });

        if (affordableTokens >= 256) {
          cappedOutputTokens = Math.min(maxOutputTokens, affordableTokens);
          estimation = estimateInferenceReservationCost({
            modelKey,
            modelIdentifier,
            provider,
            transport,
            estimatedInputTokens,
            maxOutputTokens: cappedOutputTokens,
            pricingVersionId,
            pinnedRates: metadata?.pinnedRates || null,
          });
        }

        if (balance.availableMicros < estimation.reservedCostMicros) {
          const window = balance.rolling && balance.rolling.remainingMicros !== null && balance.rolling.remainingMicros < estimation.reservedCostMicros
            ? "rolling"
            : (balance.daily && balance.daily.remainingMicros !== null && balance.daily.remainingMicros < estimation.reservedCostMicros ? "daily" : "monthly");
          const limitMicros = window === "rolling"
            ? planLimits.rollingAllowanceMicros
            : (window === "daily" ? planLimits.dailyAllowanceMicros : planLimits.monthlyAllowanceMicros);
          const resetAt = window === "rolling"
            ? new Date(now.getTime() + ROLLING_WINDOW_MS)
            : (window === "daily" ? balance.daily.periodEnd : balance.monthly.periodEnd);

          throw new AllowanceExceededError(
            `Allowance limit reached for ${window === "monthly" ? "billing cycle" : (window === "daily" ? "day" : "5-hour window")}`,
            {
              window,
              userId,
              availableMicros: balance.availableMicros,
              requestedMicros: estimation.reservedCostMicros,
              limitMicros,
              resetAt,
              supportedOutputTokens: affordableTokens >= 256 ? affordableTokens : 0,
            }
          );
        }
      }
    }

    // 5. Insert reservation into shadow_cost_ledger
    const reservationExpiresAt = new Date(now.getTime() + effectiveTtlMs);
    const rowMetadata = {
      ...metadata,
      estimatedInputTokens,
      maxOutputTokens,
      cappedOutputTokens,
      pinnedRates: metadata?.pinnedRates || estimation.rates,
      pricingVersionId: estimation.pricingVersionId,
      userPlan: balance.plan,
    };

    const [inserted] = await tx
      .insert(shadowCostLedger)
      .values({
        userId,
        requestId,
        attemptNumber: 1,
        operation,
        modality,
        modelKey,
        provider,
        pricingVersionId: estimation.pricingVersionId,
        pricingSource: estimation.pricingSource || "snapshot_contract",
        reservedCostMicros: estimation.reservedCostMicros,
        settledCostMicros: null,
        reservationExpiresAt,
        dispatchedAt: null,
        leaseExpiresAt: null,
        status: ALLOWANCE_LIFECYCLE_STATES.RESERVED,
        idempotencyKey,
        metadata: rowMetadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      reservationId: inserted.id,
      reservedCostMicros: inserted.reservedCostMicros,
      status: inserted.status,
      reservationExpiresAt: inserted.reservationExpiresAt,
      cappedOutputTokens,
      pricingVersionId: estimation.pricingVersionId,
      isDuplicate: false,
      row: inserted,
    };
  });
}

/**
 * Transitions a reservation to dispatched state and begins the worker lease.
 */
export async function markDispatched({
  reservationId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (row.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`);
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.SETTLED || row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED) {
      throw new AllowanceInvalidTransitionError(
        `Cannot dispatch reservation in terminal state: ${row.status}`,
        { reservationId, status: row.status }
      );
    }

    if (!row.dispatchedAt && row.reservationExpiresAt && new Date(row.reservationExpiresAt) <= now) {
      throw new AllowanceInvalidTransitionError(
        `Cannot dispatch an expired undispatched reservation: expired at ${new Date(row.reservationExpiresAt).toISOString()}`,
        { reservationId, status: row.status, code: "reservation_expired" }
      );
    }

    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const [updated] = await tx
      .update(shadowCostLedger)
      .set({
        status: ALLOWANCE_LIFECYCLE_STATES.DISPATCHED,
        dispatchedAt: row.dispatchedAt || now,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: updated.id,
      status: updated.status,
      dispatchedAt: updated.dispatchedAt,
      leaseExpiresAt: updated.leaseExpiresAt,
      row: updated,
    };
  });
}

export const dispatchAllowance = markDispatched;

/**
 * Extends the active worker lease during long streaming responses.
 */
export async function heartbeatReservation({
  reservationId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!existing) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (existing.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${existing.userId}))`);
    }

    if (existing.status !== ALLOWANCE_LIFECYCLE_STATES.DISPATCHED) {
      throw new AllowanceInvalidTransitionError(
        `Cannot heartbeat reservation with status: ${existing.status}`,
        { reservationId, status: existing.status }
      );
    }

    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const [updated] = await tx
      .update(shadowCostLedger)
      .set({
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: updated.id,
      status: updated.status,
      leaseExpiresAt: updated.leaseExpiresAt,
    };
  });
}

/**
 * Diagnostic and internal calculation helper for fallback token/byte estimation.
 * Pure function: does NOT perform database mutations or establish customer financial policy.
 */
export function calculateFallbackUsageEstimate({
  promptText = null,
  responseText = null,
  metadata = {},
} = {}) {
  let promptTokensEst = 0;
  let completionTokensEst = 0;

  if (promptText) {
    const promptBytes = Buffer.byteLength(promptText, "utf8");
    promptTokensEst = Math.ceil(promptBytes / 3.5);
  } else if (metadata?.estimatedInputTokens) {
    promptTokensEst = Number(metadata.estimatedInputTokens);
  } else {
    promptTokensEst = 256;
  }

  if (responseText) {
    completionTokensEst = Math.ceil(responseText.length / 3.5);
  } else if (metadata?.cappedOutputTokens) {
    completionTokensEst = Math.ceil(Number(metadata.cappedOutputTokens) * 0.75);
  } else if (metadata?.maxOutputTokens) {
    completionTokensEst = Math.ceil(Number(metadata.maxOutputTokens) * 0.75);
  } else {
    completionTokensEst = 256;
  }

  promptTokensEst = Math.ceil(promptTokensEst * 1.15);
  completionTokensEst = Math.ceil(completionTokensEst * 1.15);

  return {
    promptTokens: promptTokensEst,
    completionTokens: completionTokensEst,
    bufferMultiplier: 1.15,
    promptBytes: promptText ? Buffer.byteLength(promptText, "utf8") : null,
    responseChars: responseText ? responseText.length : null,
  };
}

/**
 * Settles a reservation against confirmed provider usage using the pricing snapshot pinned at reservation time.
 * If usage is missing or corrupt:
 * - Governed strictly by server-controlled ACTIVE_ESTIMATION_POLICY.
 * - When ACTIVE_ESTIMATION_POLICY === "disabled" (default): transitions the reservation to "uncertain",
 *   retaining the hold pending post-hoc reconciliation, preventing unconfirmed estimates from masquerading as confirmed charges.
 * - Caller booleans must never establish financial policy or force estimated charges.
 */
export async function settleAllowance({
  reservationId,
  usage = null,
  promptText = null,
  responseText = null,
  modelKey = null,
  modelIdentifier = null,
  provider = null,
  transport = null,
  attemptNumber = 1,
  isPartial = false,
  metadata = {},
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (row.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`);
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.SETTLED) {
      return {
        reservationId: row.id,
        status: row.status,
        settledCostMicros: row.settledCostMicros,
        rawCostMicros: row.rawCostMicros,
        shadowDeductionMicros: row.shadowDeductionMicros,
        isIdempotent: true,
        row,
      };
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED) {
      throw new AllowanceInvalidTransitionError(
        "Cannot settle an already released reservation",
        { reservationId, status: row.status }
      );
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RECONCILED) {
      throw new AllowanceInvalidTransitionError(
        "Cannot settle an already reconciled reservation",
        { reservationId, status: row.status }
      );
    }

    const effectiveModelKey = modelKey || row.modelKey;
    const effectiveModelIdentifier = modelIdentifier || row.metadata?.modelIdentifier;
    const effectiveProvider = provider || row.provider;
    const pinnedPricingVersionId = row.pricingVersionId;

    let effectiveUsage = usage;
    let isEstimated = false;

    const hasExplicitTokens = (
      usage &&
      (Number.isSafeInteger(Number(usage.prompt_tokens)) || Number.isSafeInteger(Number(usage.input_tokens))) &&
      (Number.isSafeInteger(Number(usage.completion_tokens)) || Number.isSafeInteger(Number(usage.output_tokens)))
    );

    let estimationProvenance = null;

    // If usage is missing or incomplete:
    // Strictly governed by server-controlled ACTIVE_ESTIMATION_POLICY
    if (!hasExplicitTokens) {
      if (ACTIVE_ESTIMATION_POLICY === ESTIMATION_POLICY_VERSIONS.DISABLED) {
        const updatedMetadata = {
          ...row.metadata,
          ...metadata,
          estimationPolicy: ACTIVE_ESTIMATION_POLICY,
          uncertainReason: "missing_provider_usage_at_settlement",
          markedUncertainAt: now.toISOString(),
        };

        const [uncertain] = await tx
          .update(shadowCostLedger)
          .set({
            status: ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN,
            leaseExpiresAt: null,
            metadata: updatedMetadata,
            updatedAt: now,
          })
          .where(eq(shadowCostLedger.id, reservationId))
          .returning();

        return {
          reservationId: uncertain.id,
          status: uncertain.status,
          reservedCostMicros: uncertain.reservedCostMicros,
          settledCostMicros: null,
          requiresReconciliation: true,
          row: uncertain,
        };
      }

      // If an approved server policy were active in the future:
      isEstimated = true;
      const estimate = calculateFallbackUsageEstimate({ promptText, responseText, metadata: row.metadata });
      estimationProvenance = {
        ...estimate,
        policyVersion: ACTIVE_ESTIMATION_POLICY,
      };

      effectiveUsage = {
        prompt_tokens: estimate.promptTokens,
        completion_tokens: estimate.completionTokens,
        estimated: true,
      };
    }

    let calculation;
    let costBasis = "repository_contract";
    const reportedMicros = row.modality === "image" || isEstimated ? null : providerReportedCostMicros(effectiveUsage);
    const pinnedCalculation = row.modality === "image" || isEstimated || !row.metadata?.pinnedRates
      ? null
      : calculateCostFromPinnedRates({ usage: effectiveUsage, rates: row.metadata.pinnedRates });
    if (reportedMicros !== null) {
      // The provider's own figure for this request is the actual cost.
      const parts = normalizedUsageComponents(effectiveUsage);
      costBasis = "provider_reported";
      calculation = {
        rawCostMicros: reportedMicros,
        inputTokens: parts.inputTokens,
        outputTokens: parts.outputTokens,
        cachedInputTokens: parts.cachedInputTokens,
        reasoningTokens: parts.reasoningTokens,
        usageConfidence: "measured",
        pricingConfidence: "provider_reported",
      };
    } else if (pinnedCalculation) {
      // The rates pinned at reservation, never a repository estimate.
      costBasis = "pinned_registry_rates";
      calculation = pinnedCalculation;
    } else if (row.modality === "image") {
      calculation = calculateImageCost({
        modelKey: effectiveModelKey,
        modelIdentifier: effectiveModelIdentifier,
        provider: effectiveProvider,
        transport,
        pricingVersionId: pinnedPricingVersionId,
      });
    } else {
      calculation = calculateInferenceCost({
        modelKey: effectiveModelKey,
        modelIdentifier: effectiveModelIdentifier,
        provider: effectiveProvider,
        transport,
        usage: effectiveUsage,
        pricingVersionId: pinnedPricingVersionId,
        isEstimatedOverride: isEstimated,
      });
    }

    // Authoritative policy: Deduct actual upstream AI cost attributable to the response.
    // No 10% platform markup in customer allowance deductions.
    let rawCostMicros = calculation.rawCostMicros;
    let settledCostMicros = calculation.rawCostMicros;

    if (settledCostMicros === null && row.metadata?.pinnedRates && hasExplicitTokens) {
      const inTokens = Number(effectiveUsage.prompt_tokens ?? effectiveUsage.input_tokens ?? 0);
      const outTokens = Number(effectiveUsage.completion_tokens ?? effectiveUsage.output_tokens ?? 0);
      const rateIn = row.metadata.pinnedRates.input ?? 0.30;
      const rateOut = row.metadata.pinnedRates.output ?? 2.50;
      const rateInPico = BigInt(Math.round(Number(rateIn) * 1_000_000));
      const rateOutPico = BigInt(Math.round(Number(rateOut) * 1_000_000));
      const rawPico = BigInt(inTokens) * rateInPico + BigInt(outTokens) * rateOutPico;
      const deductionPico = rawPico > 0n ? rawPico : 0n;
      rawCostMicros = Number((rawPico + 999_999n) / 1_000_000n);
      settledCostMicros = Number((deductionPico + 999_999n) / 1_000_000n);
    } else if (settledCostMicros === null) {
      settledCostMicros = 0;
      rawCostMicros = rawCostMicros ?? 0;
    }

    // Profit-protection invariant:
    // Actual customer deduction is capped at the authorized pre-flight hold.
    // The full internal vendor expense (rawCostMicros) is recorded without truncation.
    const authorizedReservedCostMicros = row.reservedCostMicros != null ? Number(row.reservedCostMicros) : null;
    const uncappedSettledCostMicros = settledCostMicros ?? 0;
    let overrunMicros = 0;

    if (authorizedReservedCostMicros !== null && uncappedSettledCostMicros > authorizedReservedCostMicros) {
      overrunMicros = uncappedSettledCostMicros - authorizedReservedCostMicros;
      settledCostMicros = authorizedReservedCostMicros;
    }

    const effectiveInputTokens = calculation.inputTokens ?? Number(effectiveUsage.prompt_tokens ?? effectiveUsage.input_tokens ?? 0);
    const effectiveOutputTokens = calculation.outputTokens ?? Number(effectiveUsage.completion_tokens ?? effectiveUsage.output_tokens ?? 0);

    const updatedMetadata = {
      ...row.metadata,
      ...metadata,
      settledAt: now.toISOString(),
      usageConfidence: calculation.usageConfidence !== "unknown" ? calculation.usageConfidence : (hasExplicitTokens ? "measured" : "unknown"),
      pricingConfidence: calculation.pricingConfidence !== "unknown" ? calculation.pricingConfidence : (row.metadata?.pinnedRates ? "verified" : "unknown"),
      isPartial,
      costBasis,
      fallbackUsed: isEstimated,
      estimationProvenance,
      overrunMicros,
      uncappedSettledCostMicros,
      authorizedReservedCostMicros,
      platformAbsorbedOverrun: overrunMicros > 0,
    };

    const [settled] = await tx
      .update(shadowCostLedger)
      .set({
        status: ALLOWANCE_LIFECYCLE_STATES.SETTLED,
        inputTokens: effectiveInputTokens,
        outputTokens: effectiveOutputTokens,
        cachedInputTokens: calculation.cachedInputTokens ?? 0,
        reasoningTokens: calculation.reasoningTokens ?? 0,
        rawCostMicros,
        settledCostMicros,
        shadowDeductionMicros: settledCostMicros,
        reservedCostMicros: 0,
        settledAt: now,
        reservationExpiresAt: null,
        leaseExpiresAt: null,
        metadata: updatedMetadata,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: settled.id,
      status: settled.status,
      settledCostMicros: settled.settledCostMicros,
      rawCostMicros: settled.rawCostMicros,
      shadowDeductionMicros: settled.shadowDeductionMicros,
      inputTokens: settled.inputTokens,
      outputTokens: settled.outputTokens,
      cachedInputTokens: settled.cachedInputTokens,
      reasoningTokens: settled.reasoningTokens,
      usageConfidence: calculation.usageConfidence,
      overrunMicros,
      uncappedSettledCostMicros,
      platformAbsorbedOverrun: overrunMicros > 0,
      isPartial,
      isIdempotent: false,
      row: settled,
    };
  });
}

/**
 * Safely releases an unused or failed reservation.
 * Once released, an operation cannot later be settled.
 *
 * Safety Invariant:
 * Dispatched operations (dispatchedAt !== null) CANNOT be released unless confirmedZeroUsage === true.
 * A 429/500 after dispatch only releases the hold if zero upstream billable usage is established;
 * otherwise it must transition to uncertain pending reconciliation.
 */
export async function releaseAllowance({
  reservationId,
  reason = "client_abort_or_provider_error",
  confirmedZeroUsage = false,
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (row.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`);
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED) {
      return {
        reservationId: row.id,
        status: row.status,
        releasedCostMicros: 0,
        isIdempotent: true,
        row,
      };
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.SETTLED) {
      throw new AllowanceInvalidTransitionError(
        "Cannot release an already settled reservation",
        { reservationId, status: row.status }
      );
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RECONCILED) {
      throw new AllowanceInvalidTransitionError(
        "Cannot release an already reconciled reservation",
        { reservationId, status: row.status }
      );
    }

    // Guard: Dispatched operations require verified zero upstream usage
    if ((row.dispatchedAt || row.status === ALLOWANCE_LIFECYCLE_STATES.DISPATCHED || row.status === ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN) && !confirmedZeroUsage) {
      throw new AllowanceInvalidTransitionError(
        "Cannot release a dispatched reservation without confirmed zero upstream usage; transition to uncertain or settle instead",
        { reservationId, status: row.status, dispatchedAt: row.dispatchedAt }
      );
    }

    const updatedMetadata = {
      ...row.metadata,
      releaseReason: reason,
      confirmedZeroUsage,
      releasedAt: now.toISOString(),
      previouslyReservedMicros: row.reservedCostMicros,
    };

    const [released] = await tx
      .update(shadowCostLedger)
      .set({
        status: ALLOWANCE_LIFECYCLE_STATES.RELEASED,
        reservedCostMicros: 0,
        settledCostMicros: 0,
        shadowDeductionMicros: 0,
        rawCostMicros: 0,
        releasedAt: now,
        reservationExpiresAt: null,
        leaseExpiresAt: null,
        metadata: updatedMetadata,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: released.id,
      status: released.status,
      releasedCostMicros: row.reservedCostMicros,
      isIdempotent: false,
      row: released,
    };
  });
}

/**
 * Marks a dispatched reservation uncertain when stream drops or worker disconnects.
 * Retains the reservation hold pending audit and post-hoc reconciliation.
 */
export async function markUncertain({
  reservationId,
  reason = "worker_disconnect_or_timeout",
  fallbackEstimateMicros = null,
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (row.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`);
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.SETTLED || row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED) {
      throw new AllowanceInvalidTransitionError(
        `Cannot mark reservation uncertain in terminal state: ${row.status}`,
        { reservationId, status: row.status }
      );
    }

    const updatedMetadata = {
      ...row.metadata,
      uncertainReason: reason,
      markedUncertainAt: now.toISOString(),
    };

    const newReservedCost = fallbackEstimateMicros !== null && fallbackEstimateMicros > 0
      ? fallbackEstimateMicros
      : row.reservedCostMicros;

    const [updated] = await tx
      .update(shadowCostLedger)
      .set({
        status: ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN,
        reservedCostMicros: newReservedCost,
        leaseExpiresAt: null,
        metadata: updatedMetadata,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: updated.id,
      status: updated.status,
      reservedCostMicros: updated.reservedCostMicros,
      row: updated,
    };
  });
}

/**
 * Resolves an uncertain or audited reservation against confirmed provider records.
 * Maintains an application-level append-only history of prior accounting states in metadata.auditLog.
 *
 * Account context is strictly required:
 * - When reconciling as a user, userId MUST be provided and match row.userId.
 * - Administrative reconciliation requires explicit adminOverride: true and adminContext.actorId.
 * - Omitting userId without adminOverride throws AllowanceError(missing_user_id).
 */
export async function reconcileAllowanceReservation({
  reservationId,
  userId = null,
  adminOverride = false,
  adminContext = null,
  confirmedUsage = {},
  confirmedRawCostMicros = null,
  confirmedCustomerDeductionMicros = null,
  reason = "audit_reconciliation",
  now = new Date(),
}, executor = null) {
  if (!reservationId) throw new AllowanceError("reservationId is required", { code: "missing_reservation_id" });

  if (!userId && !adminOverride) {
    throw new AllowanceError("userId is required for account reconciliation unless adminOverride is specified", {
      code: "missing_user_id",
    });
  }

  if (adminOverride) {
    if (!adminContext || !adminContext.actorId) {
      throw new AllowanceError("adminContext with actorId is required when adminOverride is enabled", {
        code: "invalid_admin_context",
      });
    }
  }

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, reservationId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AllowanceNotFoundError(`Reservation ${reservationId} not found`, { reservationId });
    }

    if (row.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`);
    }

    // Ownership check: Account-scoped unless explicit administrative override
    if (!adminOverride) {
      if (row.userId !== userId) {
        throw new AllowanceNotFoundError(`Reservation ${reservationId} not found for user ${userId}`, { reservationId, userId });
      }
    }

    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RELEASED) {
      throw new AllowanceInvalidTransitionError(
        "Cannot reconcile a released reservation",
        { reservationId, status: row.status }
      );
    }

    let finalRawCost = confirmedRawCostMicros;
    let finalCustomerCost = confirmedCustomerDeductionMicros;

    if (finalRawCost === null || finalCustomerCost === null) {
      const calc = calculateInferenceCost({
        modelKey: row.modelKey,
        usage: confirmedUsage,
        pricingVersionId: row.pricingVersionId,
      });
      if (finalRawCost === null) finalRawCost = calc.rawCostMicros ?? 0;
      if (finalCustomerCost === null) finalCustomerCost = calc.rawCostMicros ?? 0;
    }

    // Duplicate reconciliation idempotency check
    if (row.status === ALLOWANCE_LIFECYCLE_STATES.RECONCILED) {
      if (
        row.rawCostMicros === finalRawCost &&
        row.settledCostMicros === finalCustomerCost
      ) {
        return {
          reservationId: row.id,
          status: row.status,
          rawCostMicros: row.rawCostMicros,
          settledCostMicros: row.settledCostMicros,
          isIdempotent: true,
          row,
        };
      }
      throw new AllowanceInvalidTransitionError(
        "Reservation is already reconciled; conflicting adjustments require explicit administrative amendment",
        { reservationId, status: row.status, existingCost: row.settledCostMicros, requestedCost: finalCustomerCost }
      );
    }

    // Maintain application-level append-only history of prior values in metadata.auditLog
    const priorAuditLog = Array.isArray(row.metadata?.auditLog) ? row.metadata.auditLog : [];
    const auditEntry = {
      action: "reconciled",
      previousStatus: row.status,
      previousRawCostMicros: row.rawCostMicros,
      previousSettledCostMicros: row.settledCostMicros,
      previousReservedCostMicros: row.reservedCostMicros,
      confirmedUsage,
      confirmedRawCostMicros: finalRawCost,
      confirmedCustomerDeductionMicros: finalCustomerCost,
      reason,
      reconciledBy: adminOverride
        ? { type: "admin", actorId: adminContext.actorId, role: adminContext.role || "admin" }
        : { type: "user", userId },
      reconciledAt: now.toISOString(),
    };

    const updatedMetadata = {
      ...row.metadata,
      auditLog: [...priorAuditLog, auditEntry],
      reconcileReason: reason,
      reconciledAt: now.toISOString(),
      confirmedUsage,
    };

    const [reconciled] = await tx
      .update(shadowCostLedger)
      .set({
        status: ALLOWANCE_LIFECYCLE_STATES.RECONCILED,
        rawCostMicros: finalRawCost,
        settledCostMicros: finalCustomerCost,
        shadowDeductionMicros: finalCustomerCost,
        reservedCostMicros: 0,
        reconciledAt: now,
        reservationExpiresAt: null,
        leaseExpiresAt: null,
        metadata: updatedMetadata,
        updatedAt: now,
      })
      .where(eq(shadowCostLedger.id, reservationId))
      .returning();

    return {
      reservationId: reconciled.id,
      status: reconciled.status,
      rawCostMicros: reconciled.rawCostMicros,
      settledCostMicros: reconciled.settledCostMicros,
      isIdempotent: false,
      row: reconciled,
    };
  });
}

export const reconcileAllowance = reconcileAllowanceReservation;

/**
 * Records upstream provider cost incurred on a failed retry attempt.
 * The customer is charged 0 settled cost, preserving the single-bill guarantee.
 */
export async function recordAttemptCost({
  parentReservationId,
  attemptNumber = 1,
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  usage = {},
  isFailed = true,
  failureReason = "upstream_timeout",
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  now = new Date(),
}, executor = null) {
  if (!parentReservationId) throw new AllowanceError("parentReservationId is required", { code: "missing_parent_id" });

  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(shadowCostLedger)
      .where(eq(shadowCostLedger.id, parentReservationId))
      .for("update")
      .limit(1);

    if (!parent) {
      throw new AllowanceNotFoundError(`Parent reservation ${parentReservationId} not found`, { parentReservationId });
    }

    if (parent.userId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${parent.userId}))`);
    }

    const calc = calculateInferenceCost({
      modelKey,
      modelIdentifier,
      provider,
      transport,
      usage,
      pricingVersionId: parent.pricingVersionId || pricingVersionId,
    });

    const idempotencyKey = `${parentReservationId}-attempt-${attemptNumber}`;

    const [attempt] = await tx
      .insert(shadowCostLedger)
      .values({
        parentId: parentReservationId,
        userId: parent.userId,
        requestId: parent.requestId,
        attemptNumber,
        operation: `${parent.operation}:attempt`,
        modality: parent.modality,
        modelKey,
        provider,
        pricingVersionId: calc.pricingVersionId,
        pricingSource: calc.pricingSource || "attempt_tracking",
        inputTokens: calc.inputTokens ?? 0,
        outputTokens: calc.outputTokens ?? 0,
        cachedInputTokens: calc.cachedInputTokens ?? 0,
        reasoningTokens: calc.reasoningTokens ?? 0,
        rawCostMicros: calc.rawCostMicros ?? 0,
        settledCostMicros: 0,
        shadowDeductionMicros: 0,
        reservedCostMicros: 0,
        status: isFailed ? ALLOWANCE_LIFECYCLE_STATES.ATTEMPT_FAILED : ALLOWANCE_LIFECYCLE_STATES.SETTLED,
        idempotencyKey,
        metadata: {
          isRetryAttempt: true,
          parentReservationId,
          failureReason: isFailed ? failureReason : null,
          recordedAt: now.toISOString(),
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      attemptId: attempt.id,
      parentReservationId,
      attemptNumber,
      rawCostMicros: attempt.rawCostMicros,
      settledCostMicros: attempt.settledCostMicros,
      status: attempt.status,
      row: attempt,
    };
  });
}

/**
 * Sweeps stale reservations:
 * 1. Undispatched reservations past TTL -> safely released.
 * 2. Dispatched reservations past worker lease -> transitioned to uncertain (never silently released).
 * Uses transactional locking per affected user.
 */
export async function sweepStaleReservations({
  leaseGracePeriodMs = 60_000,
  reservationGracePeriodMs = 60_000,
  now = new Date(),
} = {}, executor = null) {
  const rootDb = executor || await getDefaultDb();

  return await rootDb.transaction(async (tx) => {
    const reservationCutoff = new Date(now.getTime() - reservationGracePeriodMs);
    const leaseCutoff = new Date(now.getTime() - leaseGracePeriodMs);

    // 1. Undispatched stale reservations
    const undispatchedStale = await tx
      .select()
      .from(shadowCostLedger)
      .where(
        and(
          eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.RESERVED),
          isNull(shadowCostLedger.dispatchedAt),
          lte(shadowCostLedger.reservationExpiresAt, reservationCutoff)
        )
      );

    let releasedCount = 0;
    for (const res of undispatchedStale) {
      if (res.userId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${res.userId}))`);
      }
      await tx
        .update(shadowCostLedger)
        .set({
          status: ALLOWANCE_LIFECYCLE_STATES.RELEASED,
          reservedCostMicros: 0,
          settledCostMicros: 0,
          shadowDeductionMicros: 0,
          rawCostMicros: 0,
          releasedAt: now,
          reservationExpiresAt: null,
          leaseExpiresAt: null,
          metadata: {
            ...res.metadata,
            sweepReason: "reservation_ttl_expired",
            sweptAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(shadowCostLedger.id, res.id),
            eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.RESERVED)
          )
        );
      releasedCount += 1;
    }

    // 2. Dispatched reservations with expired worker leases -> transition to UNCERTAIN
    const dispatchedStale = await tx
      .select()
      .from(shadowCostLedger)
      .where(
        and(
          eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.DISPATCHED),
          lte(shadowCostLedger.leaseExpiresAt, leaseCutoff)
        )
      );

    let uncertainCount = 0;
    for (const res of dispatchedStale) {
      if (res.userId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${res.userId}))`);
      }
      await tx
        .update(shadowCostLedger)
        .set({
          status: ALLOWANCE_LIFECYCLE_STATES.UNCERTAIN,
          leaseExpiresAt: null,
          metadata: {
            ...res.metadata,
            sweepReason: "lease_expired",
            sweptAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(shadowCostLedger.id, res.id),
            eq(shadowCostLedger.status, ALLOWANCE_LIFECYCLE_STATES.DISPATCHED)
          )
        );
      uncertainCount += 1;
    }

    return {
      releasedCount,
      uncertainCount,
      sweptAt: now,
    };
  });
}
