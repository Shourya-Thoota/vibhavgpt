import { modelTokenUsage } from "../../frontend/src/usage-percentage.js";
import { and, desc, eq, gt, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { creditLedger, subscriptions, usageEvents } from "../db/schema.js";
import { accessError } from "../../frontend/src/access-status.js";
import { requestTokenEstimate } from "../chat/context-window.js";

import { TOKEN_QUOTAS, TOKEN_MODEL_NAMES, ROLLING_TOKEN_WINDOW_MS, canonicalModelKey } from "../../frontend/src/token-quotas.js";
export const LIMITS = { ...TOKEN_QUOTAS, paid: TOKEN_QUOTAS.pro };
export const MODEL_DISPLAY_NAMES = Object.fromEntries(Object.entries(TOKEN_MODEL_NAMES).map(([key, name]) => [key, `VibhavGPT ${name}`]));
export const CREDIT_COSTS = {};
export const CREDITS_PER_DOLLAR = 100;
export const CREDIT_MARKUP = 300;
const RESERVATION_TTL_MS = 5 * 60 * 1000;
const TOKENS_PER_MILLION = 1_000_000;
export const MODEL_TOKEN_PRICES = Object.freeze({
  // Lumen estimate: the reserve stage's standard paid rates (USD / 1M).
  // Do not assume a cache discount across direct providers. Some stages do
  // not publish a token price or bill by inference time, so this is not
  // a guaranteed chain-wide cost ceiling. Review it whenever a stage changes.
  lumen: { input: 0.30, output: 2.50, cacheRead: 0.30 },
  nova: { input: 0.14, output: 0.42, cacheRead: 0.0042 },
  study: { input: 0.10, output: 0.50, cacheRead: 0.01 },
  // Highest verified Nebula route rates; assume no cache discount across providers.
  nebula: { input: 0.65, output: 3.41, cacheRead: 0.65 },
  vesper: { input: 2, output: 6, cacheRead: 0.5 },
});
export const THINKING_EFFORTS = ["normal", "low", "medium", "high", "xhigh", "max"];
const PAID_THINKING_MODELS = new Set(["nova", "nebula", "vesper"]);
export const GENERATION_LIMITS = {
  free: { images: 0, documents: 0 },
  plus: { images: 25, documents: 20 },
  pro: { images: 60, documents: Infinity },
  paid: { images: 60, documents: Infinity },
};
// Compatibility alias for older callers; new code should use the per-kind map.
export const IMAGE_LIMITS = GENERATION_LIMITS;
// Legacy transcription-request limits are retained separately from Live voice
// minutes; Live voice's monthly minute pool is enforced in voice/live-usage.
// This is the separate voice-dictation allowance. Live Comet has its own
// entitlement rules and Pro Comet access is unlimited.
export const VOICE_LIMITS = { free: 0, plus: 10, pro: 30, paid: 30 };

const emptyTokenBreakdown = () => Object.fromEntries(Object.keys(TOKEN_MODEL_NAMES).map((key) => [key, { input: 0, output: 0, total: 0 }]));
const emptyReservedBreakdown = () => Object.fromEntries(Object.keys(TOKEN_MODEL_NAMES).map((key) => [key, 0]));

export function normalizeThinkingEffort(value) {
  const effort = String(value ?? "normal").toLowerCase();
  return THINKING_EFFORTS.includes(effort) ? effort : "normal";
}

export function thinkingUsageFor(modelKey, requestedEffort = "normal") {
  if (modelKey === "study") return { effort: "normal", providerEffort: "none" };
  const effort = PAID_THINKING_MODELS.has(modelKey) ? normalizeThinkingEffort(requestedEffort) : "normal";
  // The level is sent as chosen, Normal included; the provider layer turns it
  // into what the model accepts (chat/reasoning-effort.js).
  return { effort, providerEffort: effort };
}

async function getActiveSubscription(userId, executor = db) {
  const [subscription] = await executor
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  return subscription ?? null;
}

function tierForSubscription(subscription, now = new Date()) {
  const isCurrent =
    ["plus", "pro", "paid"].includes(subscription?.tier) &&
    ["active", "trialing"].includes(subscription.status) &&
    (!subscription.currentPeriodEndsAt || new Date(subscription.currentPeriodEndsAt) > now);
  if (!isCurrent) return "free";
  return subscription.tier === "plus" ? "plus" : "pro";
}

function monthlyAnchorAt(anchor, monthsAfterAnchor) {
  const monthIndex = anchor.getUTCMonth() + monthsAfterAnchor;
  const year = anchor.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const finalDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(anchor.getUTCDate(), finalDay),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ));
}

export function monthlyEntitlementPeriodStart(subscription, now = new Date()) {
  // Stripe supplies the subscription-cycle anchor. For older rows populated
  // before this column existed, createdAt is the best available stable anchor.
  const anchor = subscription?.currentPeriodStartedAt ?? subscription?.createdAt ?? now;
  const anchorDate = new Date(anchor);
  const estimatedMonths = Math.max(
    0,
    (now.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12 + now.getUTCMonth() - anchorDate.getUTCMonth(),
  );
  let start = monthlyAnchorAt(anchorDate, estimatedMonths);
  if (start > now && estimatedMonths > 0) start = monthlyAnchorAt(anchorDate, estimatedMonths - 1);
  return start;
}

export function monthlyEntitlementPeriodEnd(subscription, now = new Date()) {
  const anchor = subscription?.currentPeriodStartedAt ?? subscription?.createdAt ?? now;
  const anchorDate = new Date(anchor);
  const start = monthlyEntitlementPeriodStart(subscription, now);
  let monthsAfterAnchor = Math.max(
    1,
    (start.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12 + start.getUTCMonth() - anchorDate.getUTCMonth() + 1,
  );
  let end = monthlyAnchorAt(anchorDate, monthsAfterAnchor);
  while (end <= now) {
    monthsAfterAnchor += 1;
    end = monthlyAnchorAt(anchorDate, monthsAfterAnchor);
  }
  return end;
}

export function utcMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function usageCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

export function normalizedProviderUsage(usage = {}) {
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? usage.promptTokensDetails ?? {};
  const completionDetails = usage.completion_tokens_details ?? usage.completionTokensDetails ?? {};
  const cachedInputTokens = usageCount(
    details.cached_tokens ?? details.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cache_read_input_tokens,
  );
  const reasoningTokens = usageCount(
    completionDetails.reasoning_tokens ?? usage.reasoning_tokens,
  );
  return {
    inputTokens: usageCount(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: usageCount(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens,
    reasoningTokens,
  };
}

export function actualApiCostUsd(modelKey, usage = {}) {
  const prices = MODEL_TOKEN_PRICES[modelKey];
  if (!prices) return 0;
  const { inputTokens, outputTokens, cachedInputTokens } = normalizedProviderUsage(usage);
  return ((Math.max(0, inputTokens - cachedInputTokens) * prices.input) + (outputTokens * prices.output) + (Math.min(inputTokens, cachedInputTokens) * prices.cacheRead)) / TOKENS_PER_MILLION;
}

export function creditsForApiCost(actualCostUsd) {
  return Math.max(1, Math.ceil(Math.max(0, Number(actualCostUsd) || 0) * CREDIT_MARKUP));
}

export function creditsForModelUsage(modelKey, usage = {}) {
  return creditsForApiCost(actualApiCostUsd(modelKey, usage));
}

export function creditsForImage() {
  return creditsForApiCost(0.01);
}

export function creditsForVoiceSeconds(seconds) {
  return Math.max(1, Math.ceil((Math.max(0, Number(seconds) || 0) * 15) / 60));
}

function insufficientCreditsError() {
  return accessError("credits");
}

export function rollingTokenWindow(now = new Date()) {
  return { start: new Date(now.getTime() - ROLLING_TOKEN_WINDOW_MS), end: now };
}

async function countUsage(userId, periodStart, executor = db, now = new Date(), rolling = false) {
  const within = and(rolling ? gt(usageEvents.createdAt, periodStart) : gte(usageEvents.createdAt, periodStart), lte(usageEvents.createdAt, now));
  // Legacy unconfirmed holds lost their expiry. Bound those by the same TTL
  // as new reservations, rather than retaining them for a month or 5 hours.
  const expiresAt = sql`coalesce(${usageEvents.reservationExpiresAt}, ${usageEvents.createdAt} + interval '5 minutes')`;
  const active = and(gt(usageEvents.reservedTokens, 0), lte(usageEvents.createdAt, now), sql`${expiresAt} > ${now}`);
  const rows = await executor.select({
    model: usageEvents.model,
    inputTokens: sql`coalesce(sum(case when ${within} then ${usageEvents.inputTokens} else 0 end), 0)::double precision`,
    outputTokens: sql`coalesce(sum(case when ${within} then ${usageEvents.outputTokens} else 0 end), 0)::double precision`,
    reservedTokens: sql`coalesce(sum(case when ${active} then ${usageEvents.reservedTokens} else 0 end), 0)::double precision`,
    nextReleaseAt: sql`min(case when ${active} then ${expiresAt} ${rolling ? sql`when ${within} and (${usageEvents.inputTokens} + ${usageEvents.outputTokens}) > 0 then ${usageEvents.createdAt} + interval '5 hours'` : sql``} end)`,
  }).from(usageEvents).where(and(eq(usageEvents.userId, userId), or(within, active))).groupBy(usageEvents.model);
  const tokens = emptyTokenBreakdown();
  const reserved = emptyReservedBreakdown();
  const releases = {};
  for (const row of rows) {
    const modelKey = canonicalModelKey(row.model);
    if (!Object.hasOwn(tokens, modelKey)) continue;
    const input = Number(row.inputTokens);
    const output = Number(row.outputTokens);
    tokens[modelKey].input += input;
    tokens[modelKey].output += output;
    tokens[modelKey].total += input + output;
    reserved[modelKey] += Number(row.reservedTokens);
    if (row.nextReleaseAt && (!releases[modelKey] || new Date(row.nextReleaseAt) < new Date(releases[modelKey]))) releases[modelKey] = new Date(row.nextReleaseAt);
  }
  return { periodStart, tokens, reserved, releases, total: Object.values(tokens).reduce((sum, value) => sum + value.total, 0) };
}

async function countVoiceUsage(userId, periodStart, executor = db) {
  const rows = await executor.select({ count: sql`count(*)::int` }).from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.model, "__voice__"), gte(usageEvents.createdAt, periodStart)));
  return Number(rows[0]?.count ?? 0);
}

async function countGenerationUsage(userId, periodStart, executor = db) {
  const rows = await executor
    .select({ model: usageEvents.model, count: sql`count(*)::int` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), inArray(usageEvents.model, ["__image__", "__document__", "__generation__"]), gte(usageEvents.createdAt, periodStart)))
    .groupBy(usageEvents.model);
  const result = { images: 0, documents: 0, total: 0 };
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (row.model === "__image__") result.images += count;
    else if (row.model === "__document__") result.documents += count;
    else result.images += count; // legacy combined events are retained safely.
  }
  result.total = result.images + result.documents;
  return result;
}

export async function getCreditBalance(userId, executor = db) {
  const [row] = await executor
    .select({ balance: sql`coalesce(sum(${creditLedger.credits}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.balance ?? 0);
}

export async function getCurrentUsage(userId, executor = db, now = new Date()) {
  const subscription = await getActiveSubscription(userId, executor);
  const tier = tierForSubscription(subscription, now);
  const textWindow = utcMonthWindow(now);
  const rollingWindow = rollingTokenWindow(now);
  const proMonth = utcMonthWindow(now);
  const monthlyPeriodStart = tier === "plus"
    ? monthlyEntitlementPeriodStart(subscription, now)
    : tier === "pro"
      ? proMonth.start
      : proMonth.start;
  const monthlyPeriodEnd = tier === "plus"
    ? monthlyEntitlementPeriodEnd(subscription, now)
    : tier === "pro"
      ? proMonth.end
      : proMonth.end;
  const reads = [
    () => countUsage(userId, textWindow.start, executor, now),
    () => countUsage(userId, rollingWindow.start, executor, now, true),
    () => countVoiceUsage(userId, monthlyPeriodStart, executor),
    () => getCreditBalance(userId, executor),
    () => countGenerationUsage(userId, monthlyPeriodStart, executor),
  ];
  // The pool can run these side by side. A transaction is one client, which
  // must run one query at a time.
  const results = [];
  if (executor === db) results.push(...await Promise.all(reads.map((read) => read())));
  else for (const read of reads) results.push(await read());
  const [usage, rollingUsage, voiceExchangesThisPeriod, creditBalance, generationCount] = results;
  return {
    tier,
    tokensThisPeriod: usage.total,
    tokenBreakdown: usage.tokens,
    rollingTokenBreakdown: rollingUsage.tokens,
    reservedTokenBreakdown: usage.reserved,
    rollingReservedTokenBreakdown: rollingUsage.reserved,
    nextMonthlyTokenReleaseAt: usage.releases,
    nextRollingTokenReleaseAt: rollingUsage.releases,
    periodStart: textWindow.start,
    periodEndsAt: textWindow.end,
    rollingPeriodStart: rollingWindow.start,
    rollingWindowHours: 5,
    periodType: "calendar-month",
    voiceExchangesThisWeek: voiceExchangesThisPeriod,
    voiceExchangesThisPeriod,
    voiceLimit: VOICE_LIMITS[tier] ?? VOICE_LIMITS.free,
    generationCount: generationCount.total,
    generationLimit: GENERATION_LIMITS[tier]?.images ?? 0,
    imageGenerationsThisPeriod: generationCount.images,
    imageLimit: GENERATION_LIMITS[tier]?.images ?? 0,
    documentGenerationsThisPeriod: generationCount.documents,
    documentLimit: GENERATION_LIMITS[tier]?.documents ?? 0,
    generationBreakdown: generationCount,
    imagePeriodStart: monthlyPeriodStart,
    imagePeriodEndsAt: monthlyPeriodEnd,
    voicePeriodStart: monthlyPeriodStart,
    voicePeriodEndsAt: monthlyPeriodEnd,
    creditBalance,
  };
}

export async function reserveVoiceUsage(userId) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const subscription = await getActiveSubscription(userId, tx);
    const tier = tierForSubscription(subscription);
    const now = new Date();
    const periodStart = tier === "plus"
      ? monthlyEntitlementPeriodStart(subscription, now)
      : utcMonthWindow(now).start;
    const used = await countVoiceUsage(userId, periodStart, tx);
    const limit = VOICE_LIMITS[tier] ?? VOICE_LIMITS.free;
    if (limit === 0) throw accessError("plan", { feature: "Voice", requiredPlan: "Plus or Pro", code: "voice-limit" });
    if (used >= limit) {
      const error = accessError("quota", { feature: "voice", publicMessage: "You've reached your voice allowance for this month.", resetAt: tier === "plus" ? monthlyEntitlementPeriodEnd(subscription, now) : utcMonthWindow(now).end });
      error.code = "voice-limit";
      error.status = 429;
      throw error;
    }
    const [event] = await tx.insert(usageEvents).values({ userId, model: "__voice__" }).returning({ id: usageEvents.id });
    return event;
  });
}

export function checkUsageLimit(usage, modelKey, tokenBudget = 0) {
  modelKey = canonicalModelKey(modelKey);
  const caps = (LIMITS[usage.tier] ?? LIMITS.free)[modelKey];
  const name = TOKEN_MODEL_NAMES[modelKey];
  if (!caps || !name) throw accessError("plan", { feature: "This model", requiredPlan: "Plus or Pro" });
  if (!caps.monthly) throw accessError("plan", { feature: name, requiredPlan: "Plus or Pro" });
  const { monthly, rolling, monthlyPending, rollingPending } = modelTokenUsage(usage, modelKey);
  const monthlyBlocked = monthly >= caps.monthly || monthly + tokenBudget > caps.monthly;
  const rollingBlocked = rolling >= caps.rolling || rolling + tokenBudget > caps.rolling;
  if (monthlyBlocked || rollingBlocked) {
    const window = monthlyBlocked ? "monthly" : "rolling";
    const requestTooLarge = (window === "monthly" ? monthly : rolling) < caps[window];
    const publicMessage = requestTooLarge
      ? `This request exceeds your remaining ${name} limit for the ${window === "monthly" ? "month" : "5-hour window"}. Try a shorter conversation or wait for tokens to free up.`
      : `Your ${name} limit for the ${window === "monthly" ? "month" : "5-hour window"} is in use.`;
    const resetAt = window === "monthly" ? usage.nextMonthlyTokenReleaseAt?.[modelKey] ?? usage.periodEndsAt : usage.nextRollingTokenReleaseAt?.[modelKey];
    throw Object.assign(accessError("quota", { feature: name, publicMessage, resetAt, window, requestTooLarge,
      pending: window === "monthly" ? monthlyPending : rollingPending,
      used: window === "monthly" ? monthly : rolling, limit: caps[window] }), { code: "usage-limit", status: 429, window });
  }
  return { creditCost: 0 };
}

export async function reserveUsage(userId, modelKey, requestedEffort = "normal", tokenBudget = 0, executor = db, now = new Date()) {
  modelKey = canonicalModelKey(modelKey);
  return executor.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const usage = await getCurrentUsage(userId, tx, now);
    const thinking = thinkingUsageFor(modelKey, requestedEffort);
    if (usage.tier === "free" && thinking.effort !== "normal") throw accessError("plan", { feature: "Thinking effort", requiredPlan: "Plus or Pro" });
    checkUsageLimit(usage, modelKey, tokenBudget);
    const [event] = await tx.insert(usageEvents).values({
      userId, model: modelKey, thinkingEffort: thinking.effort,
      reservedTokens: tokenBudget,
      reservationExpiresAt: tokenBudget ? new Date(now.getTime() + RESERVATION_TTL_MS) : null,
      createdAt: now,
    }).returning({ id: usageEvents.id });
    return { ...event, creditCost: 0, thinkingEffort: thinking.effort, providerEffort: thinking.providerEffort };
  });
}

export async function finalizeUsage(eventId, usage = {}, executor = db, modelKey = "") {
  const normalized = normalizedProviderUsage(usage);
  await executor.update(usageEvents).set({
    inputTokens: Math.round(normalized.inputTokens),
    outputTokens: Math.round(normalized.outputTokens),
    costMicros: Math.round(actualApiCostUsd(modelKey, usage) * 1_000_000),
    reservedTokens: 0, reservationExpiresAt: null,
  }).where(eq(usageEvents.id, eventId));
}

export async function cancelUsageReservation(eventId, creditReservationId = null, executor = db) {
  await executor.transaction(async (tx) => {
    if (creditReservationId) {
      const [reservation] = await tx.select().from(creditLedger).where(eq(creditLedger.id, creditReservationId)).limit(1);
      if (reservation?.credits < 0) {
        await tx.insert(creditLedger).values({
          userId: reservation.userId,
          credits: -reservation.credits,
          kind: "usage_refund",
          externalReference: `refund:${reservation.id}`,
        }).onConflictDoNothing();
      }
    }
    // Settled inference remains counted even if a later tool or save fails.
    await tx.delete(usageEvents).where(and(eq(usageEvents.id, eventId), eq(usageEvents.inputTokens, 0), eq(usageEvents.outputTokens, 0)));
    await tx.update(usageEvents).set({ reservedTokens: 0, reservationExpiresAt: null }).where(eq(usageEvents.id, eventId));
  });
}

export function inferenceTokenBudget(messages, tools, maxTokens) {
  // A hold, not the final charge: the reply settles at the provider's real
  // counts. Text and images use the same estimates as the context window
  // (UTF-8 bytes / 3, a fixed size per image); uploads are normalized to a
  // bounded size before reaching inference.
  return requestTokenEstimate(messages, tools) + maxTokens + 512;
}

export function createUsageTracker(userId, modelKey, effort, executor = db) {
  let pending = null;
  return {
    async beforeCall(messages, tools, maxTokens) {
      if (pending) throw new Error("An inference reservation is already active.");
      pending = await reserveUsage(userId, modelKey, effort, inferenceTokenBudget(messages, tools, maxTokens), executor);
    },
    async record(usage) {
      if (!pending) return;
      if (![usage?.prompt_tokens ?? usage?.input_tokens, usage?.completion_tokens ?? usage?.output_tokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        // Keep a conservative hold only until its original deadline. Never
        // remove its expiry or restart the clock after a failed confirmation.
        pending = null;
        throw Object.assign(new Error("VibhavGPT could not confirm token usage. Please try again shortly."), { code: "usage-unavailable", status: 503 });
      }
      const event = pending; pending = null;
      // A failed settlement leaves the existing bounded hold intact.
      await finalizeUsage(event.id, usage, executor, modelKey);
    },
    async release() {
      if (pending) { const event = pending; pending = null; await cancelUsageReservation(event.id, null, executor); }
    },
  };
}

// One-off generation jobs (for example image generation) consume credits without
// pretending to be a chat-model usage event. The same reservation/refund
// ledger semantics apply, so a failed provider call never burns credits.
export async function reserveGenerationCredits(userId, creditCost, model = "__generation__") {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const usage = await getCurrentUsage(userId, tx);
    if ((usage.creditBalance ?? 0) < creditCost) {
      throw insufficientCreditsError();
    }
    const [event] = await tx.insert(usageEvents).values({ userId, model }).returning({ id: usageEvents.id });
    const [reservation] = await tx.insert(creditLedger).values({ userId, credits: -creditCost, kind: "generation_reservation", usageEventId: event.id }).returning({ id: creditLedger.id });
    return { ...event, creditReservationId: reservation.id, creditCost };
  });
}

// Free has no generation access, Plus includes 20 combined image/document
// generations per billing month, and Pro is unlimited. Only Plus generations
// beyond its included quota reserve one Flex Credit; failures refund it.
export async function reserveGeneration(userId, model = "__generation__") {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const usage = await getCurrentUsage(userId, tx);
    const kind = model === "__document__" ? "documents" : "images";
    const includedLimit = GENERATION_LIMITS[usage.tier]?.[kind] ?? 0;
    if (includedLimit === 0) {
      const error = accessError("plan", { feature: kind === "images" ? "Image generation" : "Document generation", requiredPlan: "Plus or Pro" });
      error.code = "usage-limit";
      error.status = 429;
      throw error;
    }
    const used = usage.generationBreakdown?.[kind] ?? 0;
    const creditCost = Number.isFinite(includedLimit) && used >= includedLimit
      ? (kind === "images" ? creditsForImage() : 1)
      : 0;
    if (creditCost && usage.creditBalance < creditCost) {
      throw insufficientCreditsError();
    }
    const [event] = await tx.insert(usageEvents).values({ userId, model }).returning({ id: usageEvents.id });
    let creditReservationId = null;
    if (creditCost) {
      const [reservation] = await tx.insert(creditLedger).values({ userId, credits: -creditCost, kind: "generation_reservation", usageEventId: event.id }).returning({ id: creditLedger.id });
      creditReservationId = reservation.id;
    }
    return { ...event, creditReservationId, creditCost, tier: usage.tier, includedLimit };
  });
}

export const reserveImageGeneration = (userId) => reserveGeneration(userId, "__image__");
export const reserveDocumentGeneration = (userId) => reserveGeneration(userId, "__document__");
