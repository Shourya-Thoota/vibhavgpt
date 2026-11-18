import { modelTokenUsage } from "../../frontend/src/usage-percentage.js";
import { houseEffortFor } from "../../frontend/src/thinking-levels.js";
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { creditLedger, marketplaceCharges, subscriptions, usageEvents, shadowCostLedger } from "../db/schema.js";
import { COMPLIMENTARY_SUBSCRIPTION, isCompPlanAccount } from "../billing/comp-accounts.js";
import { rowMayGrant } from "../billing/plan-source.js";
import { isThirdPartyModel, thirdPartyModel, providerName, planIncludesThirdPartyModel, plansFrom, thirdPartyMinPlan } from "../../frontend/src/model-marketplace.js";
import { rawCostForTurn, settlementPrice, thirdPartyCharge } from "../models/marketplace.js";
import { accessError } from "../../frontend/src/access-status.js";
import { CREDIT_SPEND } from "../../frontend/src/flex-credits.js";
import { requestTokenEstimate } from "../chat/context-window.js";
import {
  calculateUnifiedLedgerDeductionMicros,
  calculateUsageMultiplier,
  PROFIT_MARGIN_MODIFIER,
  SUBSCRIPTION_PLAN_LIMITS,
} from "../models/pricing-engine.js";
import { findSeedModelByKey } from "../models/seed-catalog.js";
import { isModelEligibleForPlan } from "./plan-throttle-policy.js";
import { creditDenial, creditsSummary, evaluateCreditAdmission, resolveCreditsPolicy } from "./credits.js";
import { authorizeImageGeneration, utcWeekWindow } from "../generation/image-engine.js";
import {
  calculateImageCost,
  calculateInferenceCost,
  getShadowLedgerSummary,
  PRICING_SNAPSHOTS,
  reconcileShadowCostEvent,
  recordShadowCostEvent,
} from "./shadow-ledger.js";

export {
  calculateImageCost,
  calculateInferenceCost,
  getShadowLedgerSummary,
  PRICING_SNAPSHOTS,
  reconcileShadowCostEvent,
  recordShadowCostEvent,
};

import { TOKEN_QUOTAS, TOKEN_MODEL_NAMES, ROLLING_TOKEN_WINDOW_MS, canonicalModelKey } from "../../frontend/src/token-quotas.js";
export const LIMITS = { ...TOKEN_QUOTAS, paid: TOKEN_QUOTAS.pro, max: TOKEN_QUOTAS.max || TOKEN_QUOTAS.pro };
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
  nova: { input: 0.10, output: 0.50, cacheRead: 0.10 },
  study: { input: 0.10, output: 0.50, cacheRead: 0.01 },
  // Current Nebula endpoint prices: $0.75 input, $3.75 output, $0.075 cache read (per 1M tokens).
  nebula: { input: 0.75, output: 3.75, cacheRead: 0.075 },
  vesper: { input: 1.00, output: 5.00, cacheRead: 0.05 },
  // Zenith (Slice 7): the flagship house rate, set above Vulcan's at 1.5 times it. A house rate, not the engine's cost.
  zenith: { input: 1.50, output: 7.50, cacheRead: 0.075 },
  // Tecton (Build): a house rate just above its engine's published price ($0.66 input, $1.00 output per 1M tokens), which has no cache rate.
  tecton: { input: 0.80, output: 1.20, cacheRead: 0.80 },
});
export const THINKING_EFFORTS = ["normal", "low", "medium", "high", "xhigh", "max"];
const PAID_THINKING_MODELS = new Set(["nova", "nebula", "vesper", "zenith"]);
// Images are the numbers authorizeImageGeneration enforces (generation/image-engine.js): Free 2 per UTC week; Plus 100, Pro 400, and Max 1,500 per
// month. Free's is a weekly count, the others monthly. Max image limit confirmed by owner decision at 1,500/month.
// What one extra Plus document costs in purchased credits: the number the Usage screen, pricing and terms state, from one place.
const DOCUMENT_CREDIT_COST = CREDIT_SPEND.extraDocument;

export const GENERATION_LIMITS = {
  free: { images: 2, documents: 0 },
  plus: { images: 100, documents: 20 },
  pro: { images: 400, documents: Infinity },
  max: { images: 1500, documents: Infinity },
  paid: { images: 400, documents: Infinity },
};
// Compatibility alias for older callers; new code should use the per-kind map.
export const IMAGE_LIMITS = GENERATION_LIMITS;
// Voice has been retired, so nothing new is charged against these. They stay for
// the usage report and for settling a call that was already connected.
// Legacy transcription-request limits are retained separately from Live voice
// minutes; Live voice's monthly minute pool is enforced in voice/live-usage.
// This is the separate voice-dictation allowance. Live Comet has its own
// entitlement rules and Pro Comet access is unlimited.
// Max is enforced with Pro's limit (reserveVoiceUsage); the table says so too, so /api/usage reports the same number.
export const VOICE_LIMITS = { free: 0, plus: 10, pro: 30, paid: 30, max: 30 };

const emptyTokenBreakdown = () => Object.fromEntries(Object.keys(TOKEN_MODEL_NAMES).map((key) => [key, { input: 0, output: 0, total: 0 }]));
const emptyReservedBreakdown = () => Object.fromEntries(Object.keys(TOKEN_MODEL_NAMES).map((key) => [key, 0]));

export function normalizeThinkingEffort(value, defaultEffort = "low") {
  if (value === undefined || value === null || value === "") return defaultEffort;
  const effort = String(value).toLowerCase();
  return THINKING_EFFORTS.includes(effort) ? effort : defaultEffort;
}

export function thinkingUsageFor(modelKey, requestedEffort) {
  if (modelKey === "study") return { effort: "normal", providerEffort: "none" };
  const defaultEffort = PAID_THINKING_MODELS.has(modelKey) ? "low" : "normal";
  // The app's three levels (thinking-levels.js): Low, Medium, or High, which is the engine's highest (sent as "max" and narrowed by the
  // provider layer). Older stored values are read the same way (normal -> Medium; xhigh, max -> High).
  const effort = PAID_THINKING_MODELS.has(modelKey)
    ? houseEffortFor(requestedEffort) ?? normalizeThinkingEffort(requestedEffort, defaultEffort)
    : "normal";
  // The level is sent as chosen, Normal included; the provider layer turns it
  // into what the model accepts (chat/reasoning-effort.js).
  return { effort, providerEffort: effort };
}

export async function getActiveSubscription(userId, executor = db) {
  const [subscription] = await executor
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  // A complimentary account (COMP_PLAN_ACCOUNTS) is marked, so every plan read sees Max whatever the row says; without a row of its
  // own it is shown the complimentary subscription. No query is made when the list is empty.
  if (await isCompPlanAccount(userId, executor)) return { ...(subscription ?? COMPLIMENTARY_SUBSCRIPTION), compPlan: true };
  return subscription ?? null;
}

export function tierForSubscription(subscription, now = new Date()) {
  // Complimentary accounts are always Max: a cancelled, lapsed or missing subscription never lowers them.
  if (subscription?.compPlan === true) return "max";
  // A store (Android) row grants its tier only while it still verifies (src/billing/plan-source.js); a leftover grants nothing.
  if (subscription && !rowMayGrant(subscription, now)) return "free";
  const isCurrent =
    ["plus", "pro", "max", "paid"].includes(subscription?.tier) &&
    ["active", "trialing"].includes(subscription.status) &&
    (!subscription.currentPeriodEndsAt || new Date(subscription.currentPeriodEndsAt) > now);
  if (!isCurrent) return "free";
  if (subscription.tier === "max") return "max";
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
  // Prompt-cache writes (OpenAI's Responses usage input_tokens_details.cache_write_tokens), billed at the host's cache-write rate.
  const cacheWriteInputTokens = usageCount(details.cache_write_tokens ?? usage.cache_write_input_tokens);
  return {
    inputTokens: usageCount(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: usageCount(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens,
    cacheWriteInputTokens,
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

// A Plus account past its included documents with no image & document credits left: say which allowance ran out, that credits are what is
// empty, and when the allowance renews (resetAt is carried for the screen to word in the reader's own time).
export function documentCreditsError({ limit, resetAt }) {
  return accessError("credits", {
    feature: "Document generation",
    resetAt,
    publicMessage: `You've used your ${limit} documents for this period and have no image & document credits left. Your allowance renews on the date shown, or you can buy credits.`,
  });
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
  const monthlyPeriodStart = ["plus", "pro", "max"].includes(tier) && subscription
    ? monthlyEntitlementPeriodStart(subscription, now)
    : proMonth.start;
  const monthlyPeriodEnd = ["plus", "pro", "max"].includes(tier) && subscription
    ? monthlyEntitlementPeriodEnd(subscription, now)
    : proMonth.end;
  // Free's images are counted in the fixed UTC week (Monday 00:00 UTC); every other plan's in its month.
  const imageWeek = tier === "free" ? utcWeekWindow(now) : null;
  const reads = [
    () => countUsage(userId, textWindow.start, executor, now),
    () => countUsage(userId, rollingWindow.start, executor, now, true),
    () => countVoiceUsage(userId, monthlyPeriodStart, executor),
    () => getCreditBalance(userId, executor),
    () => countGenerationUsage(userId, imageWeek?.start ?? monthlyPeriodStart, executor),
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
    imagePeriod: imageWeek ? "week" : "month",
    imagePeriodStart: imageWeek?.start ?? monthlyPeriodStart,
    imagePeriodEndsAt: imageWeek?.end ?? monthlyPeriodEnd,
    imagesRemaining: Math.max(0, (GENERATION_LIMITS[tier]?.images ?? 0) - generationCount.images),
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
    const periodStart = ["plus", "pro", "max"].includes(tier) && subscription
      ? monthlyEntitlementPeriodStart(subscription, now)
      : utcMonthWindow(now).start;
    const used = await countVoiceUsage(userId, periodStart, tx);
    const limit = VOICE_LIMITS[tier] ?? (tier === "max" ? VOICE_LIMITS.pro : VOICE_LIMITS.free);
    if (limit === 0) throw accessError("plan", { feature: "Voice", requiredPlan: "Plus, Pro, or Max", code: "voice-limit" });
    if (used >= limit) {
      const error = accessError("quota", { feature: "voice", publicMessage: "You've reached your voice allowance for this month.", resetAt: ["plus", "pro", "max"].includes(tier) && subscription ? monthlyEntitlementPeriodEnd(subscription, now) : utcMonthWindow(now).end });
      error.code = "voice-limit";
      error.status = 429;
      throw error;
    }
    const [event] = await tx.insert(usageEvents).values({ userId, model: "__voice__" }).returning({ id: usageEvents.id });
    return event;
  });
}

// Whether a plan includes a model at all. A zero monthly cap means "not on this
// plan", so the token table doubles as the access table. Kept separate so plan
// access survives when the token limits themselves are replaced by credits.
export function assertModelPlanAccess(tier, modelKey) {
  modelKey = canonicalModelKey(modelKey);
  // Third-party models are metered per turn at cost plus 10%, and each is open from its plan floor up (model-marketplace.js: GLM and
  // GPT-6 Luna from Plus, GPT-6.1 Terra from Pro, GPT-6.1 Sol and Astra on Max). A complimentary account resolves to Max, so it has all.
  if (isThirdPartyModel(modelKey)) {
    if (planIncludesThirdPartyModel(tier, modelKey)) return;
    throw accessError("plan", { feature: thirdPartyModel(modelKey).name, requiredPlan: plansFrom(thirdPartyMinPlan(modelKey)) });
  }
  const caps = (LIMITS[tier] ?? LIMITS.free)[modelKey];
  const name = TOKEN_MODEL_NAMES[modelKey];
  if (!caps || !name) throw accessError("plan", { feature: "This model", requiredPlan: "Plus, Pro, or Max" });
  if (!caps.monthly) throw accessError("plan", { feature: name, requiredPlan: modelKey === "zenith" ? "Max" : modelKey === "vesper" || modelKey === "tecton" ? "Pro or Max" : "Plus, Pro, or Max" });
}

export function checkUsageLimit(usage, modelKey, tokenBudget = 0) {
  modelKey = canonicalModelKey(modelKey);
  assertModelPlanAccess(usage.tier, modelKey);
  // Third-party models have no token caps: they are metered per turn against the monthly budget (or credits).
  if (isThirdPartyModel(modelKey)) return { creditCost: 0 };
  const caps = (LIMITS[usage.tier] ?? LIMITS.free)[modelKey];
  const name = TOKEN_MODEL_NAMES[modelKey];
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

export const TWENTY_FOUR_HOUR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

// House models whose configured rate is already the customer's rate, so the ledger's 1.10 markup is not added on top. Tecton (owner decision,
// 2026-11-15) is a house model priced at $0.80 input / $1.20 output per 1M tokens, charged as that, not as a marketplace model at cost plus
// 10%. Every other model keeps the existing debit: its rate with the 1.10 markup applied once.
const UNMARKED_HOUSE_MODELS = new Set(["tecton"]);
export function ledgerDebitMicros(modelKey, rawCostMicros) {
  if (UNMARKED_HOUSE_MODELS.has(canonicalModelKey(modelKey ?? ""))) return Math.ceil(Math.max(0, Number(rawCostMicros) || 0));
  return calculateUnifiedLedgerDeductionMicros(rawCostMicros);
}

export function estimateTurnReservationHoldMicros(modelKey, tokenBudget = 0, options = {}) {
  const seed = findSeedModelByKey(modelKey);
  const inputTokens = options.estimatedInputTokens ? Math.max(0, Number(options.estimatedInputTokens)) + 512 : 500;
  const outputTokens = options.maxOutputTokens ? Math.max(0, Number(options.maxOutputTokens)) : Math.max(Number(tokenBudget) || 0, 1000);
  if (isThirdPartyModel(modelKey)) {
    // Held at the live price with the same markup as the settlement. With no price known (it is not admitted then anyway), held at the
    // highest house rate rather than at nothing.
    const turn = rawCostForTurn({ price: settlementPrice(modelKey), tokens: { inputTokens, outputTokens } });
    const raw = turn ? turn.rawCostMicros : Math.round(inputTokens * MODEL_TOKEN_PRICES.zenith.input + outputTokens * MODEL_TOKEN_PRICES.zenith.output);
    return calculateUnifiedLedgerDeductionMicros(raw);
  }

  if (seed) {
    const inRate = Number(seed.rawInput ?? seed.inputCostPerM ?? 0);
    const outRate = Number(seed.rawOutput ?? seed.outputCostPerM ?? 0);
    if (inRate === 0 && outRate === 0) return 0;
    const rawCostMicros = Math.round(inputTokens * inRate + outputTokens * outRate);
    return calculateUnifiedLedgerDeductionMicros(rawCostMicros);
  }
  const canonical = canonicalModelKey(modelKey);
  const prices = MODEL_TOKEN_PRICES[canonical];
  if (prices) {
    if (prices.input === 0 && prices.output === 0) return 0;
    const rawCostMicros = Math.round(inputTokens * prices.input + outputTokens * prices.output);
    return ledgerDebitMicros(modelKey, rawCostMicros);
  }
  const mu = getModelMu(modelKey);
  if (mu <= 0) return 0;
  const rawCostMicros = Math.round((inputTokens + outputTokens) * (mu / 1.10));
  return calculateUnifiedLedgerDeductionMicros(rawCostMicros);
}

// The one credit period every account uses: the UTC calendar month, half-open
// [1st 00:00, next 1st 00:00), with the fixed weekly windows anchored to the 1st. It does not
// depend on the plan or on a subscription's billing dates, so an annual subscriber receives one
// month of credits at a time (60 on Plus, never 720) and a subscriber who joins mid-month is on
// the same month as everyone else, not on a private period of their own.
export function creditsPeriodFor(now = new Date()) {
  const month = utcMonthWindow(now);
  return { start: month.start, end: month.end, basis: "utc-calendar-month" };
}

// Spend counts from the later of the month's start and the activation instant. Nothing before
// activation belongs to the credit period; no stored row is changed, moved or deleted to get that.
async function creditsPeriodEvents(userId, countFrom, executor) {
  return executor
    .select({
      model: usageEvents.model,
      costMicros: usageEvents.costMicros,
      reservedTokens: usageEvents.reservedTokens,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, countFrom)));
}

const countFromFor = (period, policy) => (policy.activatedAt && policy.activatedAt > period.start ? policy.activatedAt : period.start);

// The existing accounting, handed to the credits calculation unchanged: a
// settled call counts its raw cost with the 1.10 markup applied once, an
// unsettled one counts the hold estimate. Credits convert this; they add nothing.
const creditAccounting = Object.freeze({
  debitMicros: (rawCostMicros, event) => ledgerDebitMicros(event?.model, rawCostMicros),
  holdMicros: (event) => estimateTurnReservationHoldMicros(event.model, event.reservedTokens),
});

/** The customer-safe AI credits state for GET /api/usage, or null while credits are not active. */
export async function getCreditsSummary(userId, executor = db, now = new Date(), { flexCreditBalance = null } = {}) {
  const policy = resolveCreditsPolicy(undefined, now);
  if (!policy.active) return null;
  const subscription = await getActiveSubscription(userId, executor);
  const tier = tierForSubscription(subscription, now);
  const period = creditsPeriodFor(now);
  // A complimentary account's use is not counted against it, so its credits are always Max's full allocation (never used up).
  const complimentary = subscription?.compPlan === true;
  const events = complimentary ? [] : await creditsPeriodEvents(userId, countFromFor(period, policy), executor);
  const decision = evaluateCreditAdmission({ plan: tier, period, now, carryMode: policy.carryMode, activatedAt: policy.activatedAt, events, incomingHoldMicros: 0, ...creditAccounting });
  const summary = creditsSummary({
    policy, plan: tier, period, schedule: decision.schedule, balance: decision.balance,
    flexCreditBalance: flexCreditBalance ?? await getCreditBalance(userId, executor),
  });
  return complimentary ? { ...summary, complimentary: true } : summary;
}

export function getModelMu(modelKey) {
  const seed = findSeedModelByKey(modelKey);
  if (seed && Number.isFinite(Number(seed.multiplier))) {
    return Number(seed.multiplier);
  }
  let canonical = canonicalModelKey(modelKey);
  if (canonical.startsWith("vibhavgpt/")) canonical = canonical.slice(10);
  if (canonical === "nova") return 1.25;
  if (canonical === "nebula") return 2.475;
  if (canonical === "vesper") return 12.375;
  if (canonical === "lumen") return 0.124;
  const prices = MODEL_TOKEN_PRICES[canonical];
  if (prices) {
    return calculateUsageMultiplier(prices.input, prices.output);
  }
  return 0.5;
}

export async function countTierPromptsInWindow(userId, since, executor = db) {
  const rows = await executor
    .select({
      model: usageEvents.model,
      count: sql`count(*)::int`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        ne(usageEvents.model, "__image__"),
        ne(usageEvents.model, "__document__"),
        ne(usageEvents.model, "__voice__"),
        gte(usageEvents.createdAt, since),
      )
    )
    .groupBy(usageEvents.model);

  let shadowRows = [];
  try {
    const tableCheck = await executor.execute(sql`SELECT to_regclass('shadow_cost_ledger') AS tbl`);
    const exists = Boolean(tableCheck?.rows?.[0]?.tbl || tableCheck?.[0]?.tbl);
    if (exists) {
      shadowRows = await executor
        .select({
          model: shadowCostLedger.modelKey,
          count: sql`count(*)::int`,
        })
        .from(shadowCostLedger)
        .where(
          and(
            eq(shadowCostLedger.userId, userId),
            eq(shadowCostLedger.modality, "text"),
            isNull(shadowCostLedger.parentId),
            eq(shadowCostLedger.attemptNumber, 1),
            inArray(shadowCostLedger.status, ["settled", "dispatched", "uncertain", "reserved"]),
            gte(shadowCostLedger.createdAt, since),
          )
        )
        .groupBy(shadowCostLedger.modelKey);
    }
  } catch {
    shadowRows = [];
  }

  let highComputeCount = 0; // Yellow (1.0 < mu <= 2.0) + Orange (2.0 < mu <= 7.0)
  let extraHighCount = 0;   // Red (mu > 7.0)
  let totalPrompts = 0;

  for (const row of [...rows, ...shadowRows]) {
    const count = Number(row.count ?? 0);
    totalPrompts += count;
    const mu = getModelMu(row.model);
    if (mu > 7.00) {
      extraHighCount += count;
    } else if (mu > 1.00) {
      highComputeCount += count;
    }
  }

  return { totalPrompts, highComputeCount, extraHighCount };
}

// enforceLimits is false only for a tier whose spending the subscription allowance
// now governs; every other tier keeps its token limits.
// enforceThrottles enforces operational rolling throttles in legacy mode (Free 15/24h, Plus 40/5h, Pro 120/5h, Max 400/5h);
// when AI credits are active, plan usage is governed by spendable AI credits.
export async function reserveUsage(userId, modelKey, requestedEffort, tokenBudget = 0, executor = db, now = new Date(), { enforceLimits = true, enforceThrottles = true, enforceEligibility = true, estimatedInputTokens = 0, maxOutputTokens = 0 } = {}) {
  modelKey = canonicalModelKey(modelKey);
  return executor.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const subscription = await getActiveSubscription(userId, tx);
    const tier = tierForSubscription(subscription, now);
    // A complimentary account has unlimited AI usage: no credit, allowance or throttle limit is applied (the call is still recorded).
    // Abuse protection lives elsewhere (the chat burst and concurrency guard, capacity, upload sizes) and is unchanged.
    if (subscription?.compPlan === true) { enforceLimits = false; enforceThrottles = false; }
    const usage = await getCurrentUsage(userId, tx, now);
    const thinking = thinkingUsageFor(modelKey, requestedEffort);
    // Free keeps Low and the balanced level (Medium, formerly Normal); higher levels need a paid plan.
    if (usage.tier === "free" && !["low", "normal", "medium"].includes(thinking.effort)) {
      throw accessError("plan", { feature: "Thinking effort", requiredPlan: "Plus, Pro, or Max" });
    }

    const mu = getModelMu(modelKey);
    // When AI credits are the active policy they replace the daily and rolling
    // prompt throttles (step 2) and the monthly budget and per-model token
    // limits (step 3). Plan access (step 1 and the model check in step 3) stays.
    const creditsPolicy = resolveCreditsPolicy(undefined, now);

    // 1. Plan model eligibility check (Section 9 & Section 3.4.3)
    if (enforceEligibility) {
      const eligibility = isModelEligibleForPlan(tier, { calculatedMu: mu, modelKey });
      if (!eligibility.eligible) {
        // Vulcan is a Pro model: a Free account is told Pro, not "Plus or Pro". The wording changes; the rule does not.
        const vesperForFree = tier === "free" && canonicalModelKey(modelKey) === "vesper";
        const error = accessError("plan", {
          feature: "This model",
          requiredPlan: vesperForFree ? "Pro or Max" : tier === "free" ? "Plus or Pro" : "Pro or Max",
        });
        error.code = eligibility.reason || "plan_ineligible";
        error.status = 403;
        error.message = vesperForFree ? "Vulcan is available on Pro or Max." : eligibility.message;
        throw error;
      }
    }

    // 2. Operational Throttle Limits in legacy non-credits mode (Free 15/24h, Plus 40/5h, Pro 120/5h, Max 400/5h)
    // When AI credits are active, plan usage is governed by spendable AI credits instead of daily/rolling prompt caps.
    if (enforceThrottles && !creditsPolicy.active) {
      if (tier === "free") {
        const twentyFourHoursAgo = new Date(now.getTime() - TWENTY_FOUR_HOUR_WINDOW_MS);
        const { totalPrompts } = await countTierPromptsInWindow(userId, twentyFourHoursAgo, tx);
        if (totalPrompts >= 15) {
          const error = accessError("quota", {
            feature: "Daily prompts",
            publicMessage: "You have reached the Daily Volatile Allowance soft throttle of 15 prompts per 24 hours.",
            resetAt: new Date(now.getTime() + TWENTY_FOUR_HOUR_WINDOW_MS),
          });
          error.code = "free_daily_prompts_exceeded";
          error.status = 429;
          throw error;
        }
      } else if (tier === "plus") {
        if (mu > 1.00) {
          const fiveHoursAgo = new Date(now.getTime() - FIVE_HOUR_WINDOW_MS);
          const { highComputeCount } = await countTierPromptsInWindow(userId, fiveHoursAgo, tx);
          if (highComputeCount >= 40) {
            const error = accessError("quota", {
              feature: "High compute prompts",
              publicMessage: "You have reached the 5-hour rolling throttle of 40 high-compute prompts for Plus.",
              resetAt: new Date(now.getTime() + FIVE_HOUR_WINDOW_MS),
            });
            error.code = "plus_high_compute_throttled";
            error.status = 429;
            throw error;
          }
        }
      } else if (tier === "pro") {
        if (mu > 1.00 && mu <= 7.00) {
          const fiveHoursAgo = new Date(now.getTime() - FIVE_HOUR_WINDOW_MS);
          const { highComputeCount } = await countTierPromptsInWindow(userId, fiveHoursAgo, tx);
          if (highComputeCount >= 120) {
            const error = accessError("quota", {
              feature: "High compute prompts",
              publicMessage: "You have reached the 5-hour rolling throttle of 120 high-compute prompts for Pro.",
              resetAt: new Date(now.getTime() + FIVE_HOUR_WINDOW_MS),
            });
            error.code = "pro_high_compute_throttled";
            error.status = 429;
            throw error;
          }
        }
      } else if (tier === "max") {
        if (mu > 7.00) {
          const fiveHoursAgo = new Date(now.getTime() - FIVE_HOUR_WINDOW_MS);
          const { extraHighCount } = await countTierPromptsInWindow(userId, fiveHoursAgo, tx);
          if (extraHighCount >= 400) {
            const error = accessError("quota", {
              feature: "Extra-High compute prompts",
              publicMessage: "You have reached the 5-hour rolling throttle of 400 Extra-High prompts for Max.",
              resetAt: new Date(now.getTime() + FIVE_HOUR_WINDOW_MS),
            });
            error.code = "max_extra_high_throttled";
            error.status = 429;
            throw error;
          }
        }
      }
    }

    // 3. Financial Limits: Monthly MTAB Allowance & Legacy Token Limits
    // Bypassed when enforceLimits is false (when the subscription allowance gateway manages financial allowance).
    if (enforceLimits && creditsPolicy.active) {
      // AI credits: the same accounted spend as the monthly budget below, held to
      // this week's allocation (or the month's allocation so far, by policy).
      // It runs inside this transaction under the same per-user lock, so the
      // check and the hold below are one atomic step.
      const period = creditsPeriodFor(now);
      const events = await creditsPeriodEvents(userId, countFromFor(period, creditsPolicy), tx);
      const incomingHold = estimateTurnReservationHoldMicros(modelKey, tokenBudget, { estimatedInputTokens, maxOutputTokens });
      const decision = evaluateCreditAdmission({
        plan: tier, period, now, carryMode: creditsPolicy.carryMode, activatedAt: creditsPolicy.activatedAt, events, incomingHoldMicros: incomingHold, ...creditAccounting,
      });
      if (!decision.ok) throw creditDenial({ balance: decision.balance, incomingHoldMicros: incomingHold });
      // Per-model token caps are gone, but a model the plan does not include is still refused.
      if (!findSeedModelByKey(modelKey)) assertModelPlanAccess(usage.tier, modelKey);
    } else if (enforceLimits) {
      const planLimits = SUBSCRIPTION_PLAN_LIMITS[tier] || SUBSCRIPTION_PLAN_LIMITS.free;
      const periodStart = ["plus", "pro", "max"].includes(tier) && subscription
        ? monthlyEntitlementPeriodStart(subscription, now)
        : utcMonthWindow(now).start;
      
      const periodEvents = await tx
        .select({
          id: usageEvents.id,
          model: usageEvents.model,
          costMicros: usageEvents.costMicros,
          reservedTokens: usageEvents.reservedTokens,
          reservationExpiresAt: usageEvents.reservationExpiresAt,
          inputTokens: usageEvents.inputTokens,
          outputTokens: usageEvents.outputTokens,
        })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, userId),
            gte(usageEvents.createdAt, periodStart),
          )
        );

      let totalCommittedMicros = 0;
      for (const ev of periodEvents) {
        if (ev.costMicros > 0) {
          // Settled customer debit: raw wholesale cost with the approved 1.10 markup applied
          totalCommittedMicros += ledgerDebitMicros(ev.model, ev.costMicros);
        } else {
          // In-flight or uncertain hold: remains committed until authoritative settlement or confirmed-zero release.
          // Dispatched or ambiguous executions NEVER regain spendable budget merely because five minutes elapsed.
          totalCommittedMicros += estimateTurnReservationHoldMicros(ev.model, ev.reservedTokens);
        }
      }

      const incomingHold = estimateTurnReservationHoldMicros(modelKey, tokenBudget, { estimatedInputTokens, maxOutputTokens });
      if (totalCommittedMicros + incomingHold > planLimits.mtabMicros) {
        const error = accessError("quota", {
          feature: "Monthly Token Allowance Budget (MTAB)",
          publicMessage: "Your included AI allowance is used up for this period.",
          resetAt: ["plus", "pro", "max"].includes(tier) && subscription ? monthlyEntitlementPeriodEnd(subscription, now) : utcMonthWindow(now).end,
        });
        error.code = "allowance_exceeded";
        error.status = 429;
        throw error;
      }

      const isSeedModel = Boolean(findSeedModelByKey(modelKey));
      if (!isSeedModel) {
        checkUsageLimit(usage, modelKey, tokenBudget);
      }
    }

    const [event] = await tx.insert(usageEvents).values({
      userId,
      model: modelKey,
      thinkingEffort: thinking.effort,
      reservedTokens: tokenBudget || 1000,
      reservationExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      createdAt: now,
    }).returning({ id: usageEvents.id });

    return { ...event, creditCost: 0, thinkingEffort: thinking.effort, providerEffort: thinking.providerEffort, userPlan: usage.tier };
  });
}

export async function finalizeUsage(eventId, usage = {}, executor = db, modelKey = "", { userId = null } = {}) {
  const normalized = normalizedProviderUsage(usage);
  if (isThirdPartyModel(modelKey)) return finalizeThirdPartyUsage(eventId, usage, normalized, executor, modelKey, userId);
  let costMicros = Math.round(actualApiCostUsd(modelKey, usage) * 1_000_000);
  if (!costMicros) {
    if (usage.cost !== undefined && usage.cost !== null && Number.isFinite(Number(usage.cost))) {
      costMicros = Math.round(Number(usage.cost) * 1_000_000);
    } else {
      const seedModel = findSeedModelByKey(modelKey);
      if (seedModel && seedModel.rawInput !== null && seedModel.rawOutput !== null) {
        const inCost = (normalized.inputTokens * seedModel.rawInput) / Number(TOKENS_PER_MILLION);
        const outCost = (normalized.outputTokens * seedModel.rawOutput) / Number(TOKENS_PER_MILLION);
        costMicros = Math.round((inCost + outCost) * 1_000_000);
      }
    }
  }
  await executor.update(usageEvents).set({
    inputTokens: Math.round(normalized.inputTokens),
    outputTokens: Math.round(normalized.outputTokens),
    costMicros,
    reservedTokens: 0, reservationExpiresAt: null,
  }).where(eq(usageEvents.id, eventId));
}

/**
 * A third-party call (Slice 7): the usage row records the provider's real cost (the credits engine debits it at cost plus 10%, the
 * ledger's one markup), and a marketplace_charges row itemizes the model, the provider's cost, the upcharge and the credits.
 */
async function finalizeThirdPartyUsage(eventId, usage, normalized, executor, modelKey, userId) {
  const turn = rawCostForTurn({ reportedCostUsd: usage.cost ?? null, price: settlementPrice(modelKey), tokens: normalized });
  // Neither a reported cost nor a price: the call keeps its hold (still committed) rather than settling as free.
  if (!turn) {
    console.warn(JSON.stringify({ event: "marketplace_settlement_unpriced", model: modelKey }));
    await executor.update(usageEvents).set({ inputTokens: Math.round(normalized.inputTokens), outputTokens: Math.round(normalized.outputTokens) }).where(eq(usageEvents.id, eventId));
    return null;
  }
  const charge = thirdPartyCharge(turn.rawCostMicros);
  await executor.update(usageEvents).set({
    inputTokens: Math.round(normalized.inputTokens),
    outputTokens: Math.round(normalized.outputTokens),
    costMicros: charge.rawCostMicros,
    reservedTokens: 0, reservationExpiresAt: null,
  }).where(eq(usageEvents.id, eventId));
  if (userId) {
    const entry = thirdPartyModel(modelKey);
    await executor.insert(marketplaceCharges).values({
      usageEventId: eventId,
      userId,
      model: entry.id,
      provider: providerName(entry.provider),
      rawCostMicros: charge.rawCostMicros,
      upchargeMicros: charge.upchargeMicros,
      chargedMicros: charge.chargedMicros,
      credits: String(charge.credits),
      costSource: turn.source,
      inputTokens: Math.round(normalized.inputTokens),
      outputTokens: Math.round(normalized.outputTokens),
    }).onConflictDoNothing();
  }
  return { ...charge, costSource: turn.source };
}

export async function cancelUsageReservation(eventId, creditReservationId = null, executor = db, { confirmedZeroUsage = true, deleteRow = true } = {}) {
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
    // Zero recorded tokens alone must not authorize deletion without confirmed-zero-usage evidence.
    // Dispatched requests with unverified upstream usage retain their hold.
    if (confirmedZeroUsage) {
      if (deleteRow) {
        await tx.delete(usageEvents).where(and(eq(usageEvents.id, eventId), eq(usageEvents.inputTokens, 0), eq(usageEvents.outputTokens, 0)));
      }
      await tx.update(usageEvents).set({ reservedTokens: 0, reservationExpiresAt: null }).where(eq(usageEvents.id, eventId));
    }
  });
}

export function inferenceTokenBudget(messages, tools, maxTokens) {
  // A hold, not the final charge: the reply settles at the provider's real
  // counts. Text and images use the same estimates as the context window
  // (UTF-8 bytes / 3, a fixed size per image); uploads are normalized to a
  // bounded size before reaching inference.
  return requestTokenEstimate(messages, tools) + maxTokens + 512;
}

export function createUsageTracker(userId, modelKey, effort, executor = db, { requestId = null, operation = "chat_stream", attemptNumber = 1 } = {}) {
  let pending = null;
  let attemptSequence = (Number(attemptNumber) || 1) - 1;
  const serverRequestId = requestId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "unknown");

  return {
    async beforeCall(messages, tools, maxTokens) {
      if (pending) throw new Error("An inference reservation is already active.");
      attemptSequence += 1;
      pending = await reserveUsage(userId, modelKey, effort, inferenceTokenBudget(messages, tools, maxTokens), executor, new Date(), { enforceThrottles: false, enforceEligibility: false });
    },
    async record(usage, { entry = null, attemptNumber: explicitAttempt = null } = {}) {
      if (!pending) return;
      if (![usage?.prompt_tokens ?? usage?.input_tokens, usage?.completion_tokens ?? usage?.output_tokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        // Keep a conservative hold only until its original deadline. Never
        // remove its expiry or restart the clock after a failed confirmation.
        pending = null;
        throw Object.assign(new Error("VibhavGPT could not confirm token usage. Please try again shortly."), { code: "usage-unavailable", status: 503 });
      }
      const event = pending; pending = null;
      // A failed settlement leaves the existing bounded hold intact.
      await finalizeUsage(event.id, usage, executor, modelKey, { userId });

      const resolvedAttempt = explicitAttempt ?? attemptSequence ?? 1;
      void recordShadowCostEvent({
        userId,
        requestId: serverRequestId,
        attemptNumber: Math.max(1, Number(resolvedAttempt) || 1),
        operation,
        modelKey,
        modelIdentifier: entry?.model,
        provider: entry?.provider,
        transport: entry?.transport,
        usage,
        isEstimated: Boolean(usage?.estimated),
        metadata: {
          usageEventId: event.id,
          effort,
          providerStage: entry?.provider,
          executedModel: entry?.model,
        },
      }, executor).catch(() => {});
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

// Free gets 2 images per UTC week and no documents. Plus and Pro have monthly image allowances (see GENERATION_LIMITS) and Plus has 20
// documents a month; Pro documents are unlimited. Only Plus documents beyond the included quota reserve one Flex Credit. Images never
// use credits: at the limit the request is refused. A failure refunds the slot.
export async function reserveGeneration(userId, model = "__generation__") {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const subscription = await getActiveSubscription(userId, tx);
    const tier = tierForSubscription(subscription);
    const now = new Date();
    const kind = model === "__document__" ? "documents" : "images";
    let documentCreditCost = 0;

    if (kind === "images") {
      // The count includes images still being made: a reservation is a row, written under this user's lock, so two requests at
      // once cannot both take the last slot. A failed one is deleted (cancelUsageReservation) and gives the slot back.
      const periodStart = tier === "free"
        ? utcWeekWindow(now).start
        : ["plus", "pro", "max"].includes(tier) && subscription
          ? monthlyEntitlementPeriodStart(subscription, now)
          : utcMonthWindow(now).start;
      const used = await countGenerationUsage(userId, periodStart, tx);
      const authResult = authorizeImageGeneration(tier, used.images, { now });
      if (!authResult.authorized) {
        throw authResult.error;
      }
    } else {
      const includedLimit = GENERATION_LIMITS[tier]?.[kind] ?? 0;
      // Set below for a Plus document past the included number; the debit is written with the usage row, further down.
      if (includedLimit === 0) {
        const error = accessError("plan", { feature: "Document generation", requiredPlan: "Plus, Pro, or Max" });
        error.code = "usage-limit";
        error.status = 429;
        throw error;
      }
      const periodStart = ["plus", "pro", "max"].includes(tier) && subscription
        ? monthlyEntitlementPeriodStart(subscription, now)
        : utcMonthWindow(now).start;
      const used = await countGenerationUsage(userId, periodStart, tx);
      documentCreditCost = Number.isFinite(includedLimit) && used.documents >= includedLimit
        ? DOCUMENT_CREDIT_COST
        : 0;
      const creditCost = documentCreditCost;
      if (creditCost) {
        const balance = await getCreditBalance(userId, tx);
        if (balance < creditCost) {
          const resetAt = ["plus", "pro", "max"].includes(tier) && subscription ? monthlyEntitlementPeriodEnd(subscription, now) : utcMonthWindow(now).end;
          throw documentCreditsError({ limit: includedLimit, resetAt });
        }
      }
    }

    const [event] = await tx.insert(usageEvents).values({ userId, model, createdAt: now }).returning({ id: usageEvents.id });
    // The debit goes in the same transaction, under the same per-user lock, as the balance check above and the usage row: a request that
    // sees the balance has already seen every earlier request's debit, so two cannot spend the same credit. The key makes it one debit
    // per document; the refund written by cancelUsageReservation is likewise one per reservation, so releasing twice returns it once.
    let creditReservationId = null;
    if (documentCreditCost) {
      const [debit] = await tx.insert(creditLedger).values({
        userId,
        credits: -documentCreditCost,
        kind: "generation_reservation",
        usageEventId: event.id,
        externalReference: `document-credit:${event.id}`,
      }).returning({ id: creditLedger.id });
      creditReservationId = debit.id;
    }
    return { ...event, creditReservationId, creditCost: documentCreditCost, tier, includedLimit: GENERATION_LIMITS[tier]?.[kind] ?? 0 };
  });
}

export const reserveImageGeneration = (userId) => reserveGeneration(userId, "__image__");
export const reserveDocumentGeneration = (userId) => reserveGeneration(userId, "__document__");
