import { and, eq, gte, lte, sql } from "drizzle-orm";
import { shadowCostLedger } from "../db/schema.js";
import { config } from "../config.js";
import { logFailure } from "../security/error-log.js";
import { canonicalModelKey } from "../../frontend/src/token-quotas.js";

let defaultDb = null;
async function getDefaultDb() {
  if (!defaultDb) {
    const clientModule = await import("../db/client.js");
    defaultDb = clientModule.db;
  }
  return defaultDb;
}

// Who bears a recorded model call. Background helpers (safety classification,
// search-intent interpretation, image-prompt rewriting, automatic memory
// extraction) are platform overhead: recorded here for expense accounting,
// never deducted from a customer's allowance. A customer-requested generation
// or tool-response call is the customer's, and is accounted by the allowance
// reservation and settlement path instead of by this shadow record.
export const ACCOUNTING_CLASSES = Object.freeze({
  PLATFORM_OVERHEAD: "platform_overhead",
  CUSTOMER_USAGE: "customer_usage",
});
export const PLATFORM_OVERHEAD_OPERATIONS = Object.freeze(new Set(["moderation", "search_intent", "image_prompt_rewrite", "memory_extraction"]));
export function accountingClassFor(operation) {
  return PLATFORM_OVERHEAD_OPERATIONS.has(operation) ? ACCOUNTING_CLASSES.PLATFORM_OVERHEAD : ACCOUNTING_CLASSES.CUSTOMER_USAGE;
}

export const ACTIVE_PRICING_VERSION_ID = "pricing_snapshot_2026_10";
export const ACTIVE_PRICING_SOURCE = "configured_provider_rates_v1";

// Rates are defined in USD per 1,000,000 tokens (or USD per item).
// In pico-dollar arithmetic ($10^-12 USD), 1 USD / 1M tokens = 1,000,000 pico-dollars / token.
// 1 USD per item = 1,000,000,000,000 pico-dollars / item.
export const PRICING_SNAPSHOTS = Object.freeze({
  [ACTIVE_PRICING_VERSION_ID]: Object.freeze({
    id: ACTIVE_PRICING_VERSION_ID,
    source: ACTIVE_PRICING_SOURCE,
    markupNumerator: 11n,
    markupDenominator: 10n,
    effectiveFrom: "2026-10-01T00:00:00Z",
    effectiveTo: "2026-12-31T23:59:59Z",
    contracts: Object.freeze({
      // Lumen: primary fallback reserve rates ($0.30 in, $2.50 out, $0.30 cache)
      lumen: Object.freeze({
        contractId: "lumen_reserve_v1",
        tier: "lumen",
        provider: "reserveFree",
        modelPattern: /^fixture\/|^qwen|^lumen/i,
        input: 0.30,
        output: 2.50,
        cacheRead: 0.30,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
      // Nova: balanced model ($0.10 in, $0.50 out, $0.10 cache)
      nova: Object.freeze({
        contractId: "nova_router_v1",
        tier: "nova",
        provider: "paid",
        modelPattern: /^fixture\/|^route-|^google\/|^nova/i,
        input: 0.10,
        output: 0.50,
        cacheRead: 0.10,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
      // Study: direct OpenAI Luna ($0.10 in, $0.50 out, $0.01 cache)
      study: Object.freeze({
        contractId: "study_direct_v1",
        tier: "study",
        provider: "study",
        modelPattern: /^fixture\/|^openai\/|^study/i,
        input: 0.10,
        output: 0.50,
        cacheRead: 0.01,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
      // Nebula: high reasoning tier ($0.75 in, $3.75 out, $0.075 cache)
      nebula: Object.freeze({
        contractId: "nebula_router_v1",
        tier: "nebula",
        provider: "paid",
        modelPattern: /^fixture\/|^route-|^anthropic\/|^nebula/i,
        input: 0.75,
        output: 3.75,
        cacheRead: 0.075,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
      // Vulcan (router): OpenRouter transport ($1.00 in, $5.00 out, $0.05 cache)
      "vesper:router": Object.freeze({
        contractId: "vesper_router_v1",
        tier: "vesper",
        transport: "router",
        provider: "paid",
        approvedModels: Object.freeze(["openai/gpt-6.1-terra", "x-ai/grok-4.7", "fixture/vesper-router"]),
        input: 1.00,
        output: 5.00,
        cacheRead: 0.05,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
      // Vulcan (direct): Direct OpenAI transport (gpt-6.1-terra via responses API) ($1.00 in, $5.00 out, $0.05 cache)
      "vesper:direct": Object.freeze({
        contractId: "vesper_direct_v1",
        tier: "vesper",
        transport: "direct",
        provider: "direct",
        approvedModels: Object.freeze(["gpt-6.1-terra", "fixture/vesper-direct"]),
        input: 1.00,
        output: 5.00,
        cacheRead: 0.05,
        reasoningIncludedInOutput: true,
        billingUnit: "usd_per_1m_tokens",
        currency: "USD",
        provenance: "repository_configuration_estimate",
        pricingConfidence: "unverified",
      }),
    }),
  }),
});

const PICO_PER_MICRO = 1_000_000n;
const PICO_PER_USD = 1_000_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

// Maximum concurrent shadow database writes to prevent connection pool exhaustion
const MAX_CONCURRENT_SHADOW_WRITES = 10;
let activeShadowWrites = 0;

// Convert rate in USD per 1M tokens to integer pico-dollars per token:
function ratePicoPerToken(usdPerMillion) {
  if (typeof usdPerMillion !== "number" || !Number.isFinite(usdPerMillion) || usdPerMillion < 0) return null;
  return BigInt(Math.round(usdPerMillion * 1_000_000));
}

// Convert USD per item to integer pico-dollars:
function ratePicoPerItem(usdPerItem) {
  if (typeof usdPerItem !== "number" || !Number.isFinite(usdPerItem) || usdPerItem < 0) return null;
  return BigInt(Math.round(usdPerItem * 1_000_000_000_000));
}

function safeIntegerCount(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

export function normalizedUsageComponents(usage = {}) {
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details ?? usage?.promptTokensDetails ?? {};
  const completionDetails = usage?.completion_tokens_details ?? usage?.completionTokensDetails ?? {};

  const inputTokens = safeIntegerCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = safeIntegerCount(usage?.completion_tokens ?? usage?.output_tokens);
  const cachedInputTokens = safeIntegerCount(
    details.cached_tokens ?? details.cache_read_input_tokens ?? usage?.cached_input_tokens ?? usage?.cache_read_input_tokens ?? 0,
  );
  const reasoningTokens = safeIntegerCount(
    completionDetails.reasoning_tokens ?? usage?.reasoning_tokens ?? 0,
  );

  return {
    valid: inputTokens !== null && outputTokens !== null,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    isEstimated: Boolean(usage?.estimated === true),
  };
}

/**
 * Resolves a pricing contract binding tier, model identifier, provider, and transport.
 * Never reuses a tier's price after its configured model changes.
 */
export function resolvePricingContract({
  tier,
  modelIdentifier = null,
  provider = null,
  transport = null,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
} = {}) {
  const snapshot = PRICING_SNAPSHOTS[pricingVersionId];
  if (!snapshot) return null;
  const canonicalKey = canonicalModelKey(tier);

  // Vulcan separation: router vs direct transport
  if (canonicalKey === "vesper") {
    let isDirect = false;
    if (transport === "direct" || provider === "direct") {
      if (transport === "router" || provider === "paid") {
        return null; // Conflicting execution metadata
      }
      isDirect = true;
    } else if (transport === "router" || provider === "paid") {
      isDirect = false;
    } else {
      // Must have explicit transport or provider in execution metadata;
      // never fall back to ambient mutable config!
      return null;
    }

    const contractKey = isDirect ? "vesper:direct" : "vesper:router";
    const contract = snapshot.contracts[contractKey];
    if (!contract) return null;

    if (contract.approvedModels) {
      if (!modelIdentifier || !contract.approvedModels.includes(modelIdentifier)) {
        return null;
      }
    } else if (modelIdentifier && contract.modelPattern && !contract.modelPattern.test(modelIdentifier)) {
      return null;
    }
    return contract;
  }

  const contract = snapshot.contracts[canonicalKey];
  if (!contract) return null;

  // Verify provider stage compatibility if provided
  if (provider && contract.provider && provider !== contract.provider && !["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"].includes(provider)) {
    return null;
  }

  // Model change guard: never reuse price if configured model identifier mismatches expected pattern
  if (modelIdentifier && contract.modelPattern && !contract.modelPattern.test(modelIdentifier)) {
    return null;
  }

  return contract;
}

/**
 * Calculates raw cost and 10% marked-up shadow deduction in micro-dollars
 * using exact BigInt pico-dollar fixed-precision arithmetic.
 * Retains exact pico-dollar strings in return object.
 */
export function calculateInferenceCost({
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  usage = {},
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  isEstimatedOverride = null,
} = {}) {
  const canonicalKey = canonicalModelKey(modelKey);
  const snapshot = PRICING_SNAPSHOTS[pricingVersionId];
  const contract = resolvePricingContract({
    tier: canonicalKey,
    modelIdentifier,
    provider,
    transport,
    pricingVersionId,
  });

  const components = normalizedUsageComponents(usage);
  const isEstimated = isEstimatedOverride !== null ? isEstimatedOverride : components.isEstimated;

  const usageConfidence = !components.valid
    ? "unknown"
    : isEstimated
      ? "estimated"
      : "measured";

  const pricingConfidence = contract ? contract.pricingConfidence : "unknown";

  // If model is unpriced or usage is invalid/missing:
  if (!contract || !components.valid) {
    const status = !components.valid ? "unknown" : "unpriced";
    return {
      status,
      usageConfidence,
      pricingConfidence,
      pricingVersionId: snapshot?.id ?? "unknown",
      pricingSource: contract?.provenance ?? snapshot?.source ?? "unknown",
      pricingContract: contract?.contractId ?? "none",
      billingUnit: contract?.billingUnit ?? "unknown",
      currency: contract?.currency ?? "USD",
      modelKey: canonicalKey,
      modelIdentifier: modelIdentifier ?? null,
      inputTokens: components.inputTokens,
      outputTokens: components.outputTokens,
      cachedInputTokens: components.cachedInputTokens,
      reasoningTokens: components.reasoningTokens,
      rawCostMicros: null,
      shadowDeductionMicros: null,
      rawCostPico: null,
      shadowDeductionPico: null,
    };
  }

  const rateIn = ratePicoPerToken(contract.input);
  const rateOut = ratePicoPerToken(contract.output);
  const rateCache = ratePicoPerToken(contract.cacheRead ?? contract.input);

  if (rateIn === null || rateOut === null || rateCache === null) {
    return {
      status: "unpriced",
      usageConfidence,
      pricingConfidence: "unknown",
      pricingVersionId: snapshot.id,
      pricingSource: contract.provenance,
      pricingContract: contract.contractId,
      billingUnit: contract.billingUnit,
      currency: contract.currency,
      modelKey: canonicalKey,
      modelIdentifier: modelIdentifier ?? null,
      inputTokens: components.inputTokens,
      outputTokens: components.outputTokens,
      cachedInputTokens: components.cachedInputTokens,
      reasoningTokens: components.reasoningTokens,
      rawCostMicros: null,
      shadowDeductionMicros: null,
      rawCostPico: null,
      shadowDeductionPico: null,
    };
  }

  // Exact BigInt pico-dollar token arithmetic:
  const totalIn = BigInt(components.inputTokens);
  const cachedIn = BigInt(Math.min(components.inputTokens, components.cachedInputTokens));
  const uncachedIn = totalIn > cachedIn ? totalIn - cachedIn : 0n;

  // Reasoning tokens: under standard provider definitions (OpenAI/xAI/Anthropic router),
  // completion_tokens already includes reasoning_tokens. Do not double count!
  const billableOut = BigInt(components.outputTokens);

  // Exact pico-dollar raw cost:
  const uncachedInCostPico = uncachedIn * rateIn;
  const cachedInCostPico = cachedIn * rateCache;
  const outCostPico = billableOut * rateOut;
  const rawPico = uncachedInCostPico + cachedInCostPico + outCostPico;

  // Exact 10% marked-up deduction in pico-dollars: ceil(rawPico * 11 / 10)
  const deductionPico = rawPico > 0n
    ? (rawPico * snapshot.markupNumerator + (snapshot.markupDenominator - 1n)) / snapshot.markupDenominator
    : 0n;

  // Convert to integer micro-dollars at ledger boundary (ceil to nearest micro-dollar):
  const rawCostMicros = rawPico > 0n
    ? Number((rawPico + (PICO_PER_MICRO - 1n)) / PICO_PER_MICRO)
    : 0;

  const shadowDeductionMicros = deductionPico > 0n
    ? Number((deductionPico + (PICO_PER_MICRO - 1n)) / PICO_PER_MICRO)
    : 0;

  return {
    status: isEstimated ? "estimated" : "measured",
    usageConfidence,
    pricingConfidence,
    pricingVersionId: snapshot.id,
    pricingSource: contract.provenance,
    pricingContract: contract.contractId,
    billingUnit: contract.billingUnit,
    currency: contract.currency,
    modelKey: canonicalKey,
    modelIdentifier: modelIdentifier ?? null,
    inputTokens: components.inputTokens,
    outputTokens: components.outputTokens,
    cachedInputTokens: Number(cachedIn),
    reasoningTokens: components.reasoningTokens,
    rawCostMicros,
    shadowDeductionMicros,
    rawCostPico: rawPico.toString(),
    shadowDeductionPico: deductionPico.toString(),
  };
}

/**
 * Calculates raw cost and 10% marked-up shadow deduction for image generation.
 * Generic __image__ pricing remains unknown unless provider-confirmed cost or
 * an exact documented model and settings contract is provided.
 */
export function calculateImageCost({
  modelKey = "__image__",
  modelIdentifier = null,
  provider = "paid",
  imagesCount = 1,
  costUsd = null,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  metadata = {},
} = {}) {
  const snapshot = PRICING_SNAPSHOTS[pricingVersionId];

  // If provider confirmed costUsd is provided:
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
    const rawPico = ratePicoPerItem(costUsd);
    const deductionPico = rawPico > 0n
      ? (rawPico * snapshot.markupNumerator + (snapshot.markupDenominator - 1n)) / snapshot.markupDenominator
      : 0n;

    const rawCostMicros = rawPico > 0n
      ? Number((rawPico + (PICO_PER_MICRO - 1n)) / PICO_PER_MICRO)
      : 0;

    const shadowDeductionMicros = deductionPico > 0n
      ? Number((deductionPico + (PICO_PER_MICRO - 1n)) / PICO_PER_MICRO)
      : 0;

    return {
      status: "measured",
      usageConfidence: "measured",
      pricingConfidence: "provider_reported_item_cost",
      pricingVersionId: snapshot.id,
      pricingSource: "provider_api_reported_cost",
      pricingContract: "provider_image_cost",
      billingUnit: "usd_per_generation",
      currency: "USD",
      modelKey,
      modelIdentifier: modelIdentifier ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      rawCostMicros,
      shadowDeductionMicros,
      rawCostPico: rawPico.toString(),
      shadowDeductionPico: deductionPico.toString(),
    };
  }

  // Generic __image__ without documented pricing contract or provider cost is UNKNOWN
  return {
    status: "unknown",
    usageConfidence: imagesCount > 0 ? "measured" : "unknown",
    pricingConfidence: "unknown",
    pricingVersionId: snapshot?.id ?? "unknown",
    pricingSource: snapshot?.source ?? "unknown",
    pricingContract: "none",
    billingUnit: "unknown",
    currency: "USD",
    modelKey,
    modelIdentifier: modelIdentifier ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    rawCostMicros: null,
    shadowDeductionMicros: null,
    rawCostPico: null,
    shadowDeductionPico: null,
  };
}

/**
 * Records an additive shadow cost observation into PostgreSQL.
 * Completely non-blocking and safe: when the feature flag is false,
 * it returns null immediately without performing I/O.
 * Bound by a concurrency ceiling to prevent saturating the database pool.
 */
export async function recordShadowCostEvent({
  userId = null,
  requestId = null,
  attemptNumber = 1,
  operation = "chat_stream",
  modality = "text",
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  usage = {},
  isEstimated = false,
  costUsd = null,
  imagesCount = 1,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  idempotencyKey = null,
  metadata = {},
} = {}, executor = null) {
  // Feature flag gate: non-disruptive when disabled.
  // Performs no I/O and only this minimal local check.
  if (config.featureAllowanceLedgerShadow !== true) {
    return null;
  }

  // Guard against database pool saturation under extreme load
  if (activeShadowWrites >= MAX_CONCURRENT_SHADOW_WRITES) {
    logFailure("shadow_ledger_concurrency_dropped", new Error("concurrency_ceiling_exceeded"), { requestId, operation }, "warn");
    return { status: "dropped_concurrency_ceiling" };
  }

  activeShadowWrites += 1;
  let resolvedIdempotencyKey = idempotencyKey;
  try {
    const targetDb = executor || (await getDefaultDb());
    const costDetails = modality === "image"
      ? calculateImageCost({ modelKey, modelIdentifier, provider, imagesCount, costUsd, pricingVersionId, metadata })
      : calculateInferenceCost({ modelKey, modelIdentifier, provider, transport, usage, pricingVersionId, isEstimatedOverride: isEstimated });

    resolvedIdempotencyKey = idempotencyKey || `${requestId || "req"}:${operation}:${attemptNumber}:${costDetails.modelKey}`;
    const finalIdempotencyKey = resolvedIdempotencyKey;

    // Account deletion race protection:
    // If a userId is present, verify that the user still exists in the "user" table.
    // Never resurrect user-linked data after account deletion!
    if (userId) {
      const userCheck = await targetDb.execute(sql`SELECT 1 FROM "user" WHERE id = ${userId} LIMIT 1`);
      const userExists = ((userCheck?.rows ?? userCheck)?.length ?? 0) > 0;
      if (!userExists) {
        return { status: "user_deleted", idempotencyKey: resolvedIdempotencyKey };
      }
    }

    const mergedMetadata = {
      ...metadata,
      accountingClass: accountingClassFor(operation),
      exactRawCostPico: costDetails.rawCostPico,
      exactShadowDeductionPico: costDetails.shadowDeductionPico,
      usageConfidence: costDetails.usageConfidence,
      pricingConfidence: costDetails.pricingConfidence,
      pricingContract: costDetails.pricingContract,
      billingUnit: costDetails.billingUnit,
      currency: costDetails.currency,
      modelIdentifier: costDetails.modelIdentifier,
    };

    const [row] = await targetDb.insert(shadowCostLedger).values({
      userId,
      requestId,
      attemptNumber: Math.max(1, Number(attemptNumber) || 1),
      operation,
      modality,
      modelKey: costDetails.modelKey,
      provider: provider || costDetails.modelIdentifier || null,
      pricingVersionId: costDetails.pricingVersionId,
      pricingSource: costDetails.pricingSource,
      inputTokens: costDetails.inputTokens,
      outputTokens: costDetails.outputTokens,
      cachedInputTokens: costDetails.cachedInputTokens,
      reasoningTokens: costDetails.reasoningTokens,
      rawCostMicros: costDetails.rawCostMicros,
      shadowDeductionMicros: costDetails.shadowDeductionMicros,
      status: costDetails.status,
      idempotencyKey: finalIdempotencyKey,
      metadata: mergedMetadata,
    }).onConflictDoNothing({ target: shadowCostLedger.idempotencyKey }).returning();

    return row ?? { status: "duplicate", idempotencyKey: finalIdempotencyKey };
  } catch (error) {
    // Foreign key constraint violation (SQLSTATE 23503) indicates account was deleted
    // at the database boundary while this write was in flight. Cleanly drop the write
    // without converting to an anonymous event.
    const underlying = error?.cause || error;
    if (
      error?.code === "23503" ||
      underlying?.code === "23503" ||
      /foreign key/i.test(error?.message || "") ||
      /foreign key/i.test(underlying?.message || "") ||
      /23503/.test(error?.message || "") ||
      /23503/.test(underlying?.message || "")
    ) {
      return { status: "user_deleted", idempotencyKey: resolvedIdempotencyKey };
    }

    // Sanitized diagnostics: never log sensitive prompt, tokens, or raw user objects
    logFailure("shadow_ledger_write_failed", error, {
      requestId: requestId ?? null,
      operation: operation ?? null,
      modelKey: modelKey ?? null,
    }, "warn");
    return { success: false, error: error?.message ?? "ledger_write_failed" };
  } finally {
    activeShadowWrites -= 1;
  }
}

/**
 * Reconciles an estimated shadow cost record with actual confirmed usage.
 * Updates the existing record in-place and marks status as "reconciled" so it is
 * never counted as a duplicate deduction.
 * Protects against late-arriving estimated events overwriting measured records,
 * and ensures tenant identity (userId) is immutable.
 */
export async function reconcileShadowCostEvent({
  idempotencyKey,
  userId = null,
  modelKey,
  modelIdentifier = null,
  provider = null,
  transport = null,
  usage,
  pricingVersionId = ACTIVE_PRICING_VERSION_ID,
  metadata = {},
} = {}, executor = null) {
  if (config.featureAllowanceLedgerShadow !== true) return null;

  try {
    const targetDb = executor || (await getDefaultDb());
    const costDetails = calculateInferenceCost({
      modelKey,
      modelIdentifier,
      provider,
      transport,
      usage,
      pricingVersionId,
      isEstimatedOverride: false,
    });

    const mergedMetadata = {
      ...metadata,
      exactRawCostPico: costDetails.rawCostPico,
      exactShadowDeductionPico: costDetails.shadowDeductionPico,
      usageConfidence: "measured",
      pricingConfidence: costDetails.pricingConfidence,
      pricingContract: costDetails.pricingContract,
      billingUnit: costDetails.billingUnit,
      currency: costDetails.currency,
      reconciledAt: new Date().toISOString(),
    };

    // Atomic concurrency guarantee:
    // 1. Only rows currently with status = 'estimated' can be reconciled.
    //    An estimated event arriving late or out-of-order cannot overwrite measured data!
    // 2. Tenant identity (userId) is immutable.
    const conditions = [
      eq(shadowCostLedger.idempotencyKey, idempotencyKey),
      eq(shadowCostLedger.status, "estimated"),
    ];
    if (userId) {
      conditions.push(eq(shadowCostLedger.userId, userId));
    }

    const [updated] = await targetDb.update(shadowCostLedger).set({
      inputTokens: costDetails.inputTokens,
      outputTokens: costDetails.outputTokens,
      cachedInputTokens: costDetails.cachedInputTokens,
      reasoningTokens: costDetails.reasoningTokens,
      rawCostMicros: costDetails.rawCostMicros,
      shadowDeductionMicros: costDetails.shadowDeductionMicros,
      status: "reconciled",
      metadata: sql`${shadowCostLedger.metadata} || ${JSON.stringify(mergedMetadata)}::jsonb`,
      updatedAt: new Date(),
    }).where(and(...conditions)).returning();

    return updated ?? null;
  } catch (error) {
    logFailure("shadow_ledger_reconciliation_failed", error, {
      idempotencyKey: idempotencyKey ?? null,
    }, "warn");
    return { success: false, error: error?.message ?? "ledger_reconcile_failed" };
  }
}

/**
 * Audit query: aggregates recorded shadow costs for a user across a time period.
 */
export async function getShadowLedgerSummary(userId, { periodStart, periodEnd } = {}, executor = null) {
  const targetDb = executor || (await getDefaultDb());
  const conditions = [eq(shadowCostLedger.userId, userId)];
  if (periodStart) conditions.push(gte(shadowCostLedger.createdAt, periodStart));
  if (periodEnd) conditions.push(lte(shadowCostLedger.createdAt, periodEnd));

  const [row] = await targetDb.select({
    totalRawCostMicros: sql`coalesce(sum(${shadowCostLedger.rawCostMicros}), 0)::bigint`,
    totalShadowDeductionMicros: sql`coalesce(sum(${shadowCostLedger.shadowDeductionMicros}), 0)::bigint`,
    eventCount: sql`count(*)::int`,
    measuredCount: sql`count(*) filter (where ${shadowCostLedger.status} in ('measured', 'reconciled'))::int`,
    estimatedCount: sql`count(*) filter (where ${shadowCostLedger.status} = 'estimated')::int`,
    unknownCount: sql`count(*) filter (where ${shadowCostLedger.status} in ('unknown', 'unpriced'))::int`,
  }).from(shadowCostLedger).where(and(...conditions));

  return {
    userId,
    totalRawCostMicros: Number(row?.totalRawCostMicros ?? 0),
    totalShadowDeductionMicros: Number(row?.totalShadowDeductionMicros ?? 0),
    eventCount: Number(row?.eventCount ?? 0),
    measuredCount: Number(row?.measuredCount ?? 0),
    estimatedCount: Number(row?.estimatedCount ?? 0),
    unknownCount: Number(row?.unknownCount ?? 0),
  };
}
