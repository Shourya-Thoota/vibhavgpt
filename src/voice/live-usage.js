import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { creditLedger, usageEvents, userProfiles, voiceLiveSessions } from "../db/schema.js";
import { creditsForVoiceSeconds, getCreditBalance, getCurrentUsage } from "../usage/service.js";
import { accessError } from "../../frontend/src/access-status.js";
import { logFailure } from "../security/error-log.js";

export const LIVE_SESSION_CAP_SECONDS = 15 * 60;
export const MINI_POOL_SECONDS = { free: 0, plus: 10 * 60 };
// Pro includes unlimited Comet time. Each individual signaling reservation is
// still bounded by LIVE_SESSION_CAP_SECONDS so an abandoned client cannot
// hold an unbounded server-side session open.
export const PRO_FLAGSHIP_MONTHLY_SECONDS = Infinity;
export const PRO_FLAGSHIP_DAILY_SECONDS = Infinity;
// VOICE_REALTIME_MODEL; recorded on each session and usage event.
export const LIVE_VOICE_MODEL = config.voice.realtimeModel;
export const REALTIME_MODELS = { mini: LIVE_VOICE_MODEL, flagship: LIVE_VOICE_MODEL };
const MIN_SESSION_SECONDS = 60;
const RECONCILE_GRACE_SECONDS = 120;
export const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const SUSPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUSPEND_INCOMPLETE_SECONDS_MULTIPLIER = 2;
const SUSPEND_INCOMPLETE_COUNT_THRESHOLD = 3;
const VOICE_UNAVAILABLE_MESSAGE = "Voice is temporarily unavailable. Please try again shortly.";

export class VoiceSessionError extends Error {
  constructor(message = VOICE_UNAVAILABLE_MESSAGE, code = "voice-unavailable") {
    super(message); this.code = code; this.status = 429;
  }
}

async function sumSeconds(tx, conditions) {
  const [row] = await tx.select({ total: sql`coalesce(sum(coalesce(${voiceLiveSessions.actualSeconds}, ${voiceLiveSessions.reservedSeconds})), 0)::int` }).from(voiceLiveSessions).where(and(...conditions));
  return Number(row?.total ?? 0);
}

function asDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

// A browser-reported duration is never used for billing. A normal /end is
// server-observed activity; reconciliation stops at the last authenticated
// heartbeat. Sessions that never connected are abandoned without a charge.
export function liveSessionSettlement(session, now = new Date(), { useLastActivity = false, status = "completed" } = {}) {
  if (!session.connectedAt) return { status: "abandoned", actualSeconds: 0 };
  const settledAt = asDate(now, new Date());
  const connectedAt = asDate(session.connectedAt, settledAt);
  const observedAt = useLastActivity
    ? asDate(session.lastActivityAt ?? connectedAt, connectedAt)
    : settledAt;
  const endAt = new Date(Math.max(connectedAt.getTime(), Math.min(observedAt.getTime(), settledAt.getTime())));
  const elapsed = Math.floor((endAt.getTime() - connectedAt.getTime()) / 1_000);
  return { status, actualSeconds: Math.max(0, Math.min(elapsed, session.reservedSeconds)) };
}

export function creditsForLiveSessionSettlement(settlement, tier = null) {
  if (tier === "pro" || settlement.status === "abandoned") return 0;
  return creditsForVoiceSeconds(settlement.actualSeconds);
}

export function creditsForLiveSessionReservation(tier, reservedSeconds) {
  return tier === "pro" ? 0 : creditsForVoiceSeconds(reservedSeconds);
}

const TOKEN_COST_PER_MILLION = {
  inputText: 0.6, cachedInputText: 0.06,
  inputAudio: 10, cachedInputAudio: 0.3,
  inputImage: 0.8, cachedInputImage: 0.08,
  outputText: 2.4, outputAudio: 20,
  transcriptionInputAudio: 1.25, transcriptionOutputText: 5,
};
const MAX_REPORTED_VOICE_TOKENS = 5_000_000;

export function realtimeUsageCost(usage) {
  if (!usage || typeof usage !== "object") return null;
  const keys = Object.keys(TOKEN_COST_PER_MILLION);
  const tokens = Object.fromEntries(keys.map((key) => [key, usage[key] ?? 0]));
  if (keys.some((key) => !Number.isSafeInteger(tokens[key]) || tokens[key] < 0 || tokens[key] > MAX_REPORTED_VOICE_TOKENS)) return null;
  const inputTokens = tokens.inputText + tokens.cachedInputText + tokens.inputAudio + tokens.cachedInputAudio + tokens.inputImage + tokens.cachedInputImage + tokens.transcriptionInputAudio;
  const outputTokens = tokens.outputText + tokens.outputAudio + tokens.transcriptionOutputText;
  if (inputTokens + outputTokens === 0 || inputTokens + outputTokens > MAX_REPORTED_VOICE_TOKENS) return null;
  const costMicros = Math.round(keys.reduce((sum, key) => sum + tokens[key] * TOKEN_COST_PER_MILLION[key], 0));
  return { inputTokens, outputTokens, costMicros };
}

async function settleLiveReservation(tx, row, settlement, realtimeUsage = null) {
  const [updated] = await tx.update(voiceLiveSessions)
    .set({ actualSeconds: settlement.actualSeconds, status: settlement.status, updatedAt: new Date() })
    .where(and(eq(voiceLiveSessions.id, row.id), eq(voiceLiveSessions.status, "reserved")))
    .returning();
  if (!updated) return null;

  const [reservation] = await tx.select().from(creditLedger)
    .where(eq(creditLedger.externalReference, `voice-reservation:${row.id}`)).limit(1);
  const chargedCredits = creditsForLiveSessionSettlement(settlement, row.tier);
  const refund = Math.max(0, Math.max(0, -(reservation?.credits ?? 0)) - chargedCredits);
  if (refund) {
    await tx.insert(creditLedger).values({
      userId: row.userId,
      credits: refund,
      kind: "voice_refund",
      usageEventId: reservation?.usageEventId ?? null,
      externalReference: `voice-refund:${row.id}`,
    }).onConflictDoNothing();
  }
  if (reservation?.usageEventId) {
    const measured = realtimeUsageCost(realtimeUsage);
    if (measured) await tx.update(usageEvents)
      .set({ inputTokens: measured.inputTokens, outputTokens: measured.outputTokens, costMicros: measured.costMicros })
      .where(eq(usageEvents.id, reservation.usageEventId));
  }
  if (settlement.status !== "abandoned" && chargedCredits > 0) {
    console.info("Voice credit charged", { userId: row.userId, tier: row.tier, seconds: settlement.actualSeconds, creditsCharged: chargedCredits });
  }
  return updated;
}

// Reserve maximum allowance and credits before signaling. Settlement refunds
// unused seconds; a rejected signaling request refunds the full reservation.
export async function reserveLiveSession(userId) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const [profile] = await tx.select({ voiceSuspendedAt: userProfiles.voiceSuspendedAt }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    if (profile?.voiceSuspendedAt) throw accessError("restricted", { code: "voice-restricted", feature: "Live Comet", status: 403 });
    const usage = await getCurrentUsage(userId, tx);
    const used = await sumSeconds(tx, [eq(voiceLiveSessions.userId, userId), gte(voiceLiveSessions.createdAt, usage.voicePeriodStart)]);
    const monthlyLimit = usage.tier === "pro" ? PRO_FLAGSHIP_MONTHLY_SECONDS : (MINI_POOL_SECONDS[usage.tier] ?? MINI_POOL_SECONDS.free);
    const remainingSeconds = monthlyLimit - used;
    if (monthlyLimit === 0) throw accessError("plan", { feature: "Live Comet", requiredPlan: "Plus or Pro" });
    if (remainingSeconds < MIN_SESSION_SECONDS) throw accessError("quota", { feature: "Live Comet", publicMessage: "You've used your Live Comet allowance for this month.", resetAt: usage.voicePeriodEndsAt });
    const reservedSeconds = Math.min(LIVE_SESSION_CAP_SECONDS, remainingSeconds);
    const reservedCredits = creditsForLiveSessionReservation(usage.tier, reservedSeconds);
    if (reservedCredits > 0 && (await getCreditBalance(userId, tx)) < reservedCredits) throw accessError("credits", { feature: "Live Comet", publicMessage: `Live Comet needs ${reservedCredits} Flex Credits to reserve this call. Unused credits are returned when the call ends.` });
    const [row] = await tx.insert(voiceLiveSessions).values({ userId, tier: usage.tier, requestedModel: LIVE_VOICE_MODEL, actualModel: LIVE_VOICE_MODEL, fairUseFallback: false, reservedSeconds }).returning();
    const [event] = await tx.insert(usageEvents).values({ userId, model: LIVE_VOICE_MODEL }).returning({ id: usageEvents.id });
    let creditReservationId = null;
    if (reservedCredits > 0) {
      const [creditReservation] = await tx.insert(creditLedger).values({ userId, credits: -reservedCredits, kind: "voice_reservation", usageEventId: event.id, externalReference: `voice-reservation:${row.id}` }).returning({ id: creditLedger.id });
      creditReservationId = creditReservation.id;
    }
    return { id: row.id, model: LIVE_VOICE_MODEL, reservedSeconds, fairUseFallback: false, notice: null, creditReservationId, creditCost: reservedCredits };
  });
}

export async function finalizeLiveSession(userId, sessionId, now = new Date(), options = {}) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(voiceLiveSessions).where(and(eq(voiceLiveSessions.id, sessionId), eq(voiceLiveSessions.userId, userId))).limit(1);
    if (!row || row.status !== "reserved") return null;
    return settleLiveReservation(tx, row, liveSessionSettlement(row, now, options), options.realtimeUsage);
  });
}

export async function markLiveSessionConnected(userId, sessionId, now = new Date()) {
  const [updated] = await db.update(voiceLiveSessions)
    .set({
      connectedAt: sql`coalesce(${voiceLiveSessions.connectedAt}, ${now}::timestamptz)`,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(and(eq(voiceLiveSessions.id, sessionId), eq(voiceLiveSessions.userId, userId), eq(voiceLiveSessions.status, "reserved")))
    .returning({ id: voiceLiveSessions.id });
  return Boolean(updated);
}

export async function recordLiveSessionActivity(userId, sessionId, now = new Date()) {
  const [updated] = await db.update(voiceLiveSessions)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(and(
      eq(voiceLiveSessions.id, sessionId),
      eq(voiceLiveSessions.userId, userId),
      eq(voiceLiveSessions.status, "reserved"),
      isNotNull(voiceLiveSessions.connectedAt),
    ))
    .returning({ id: voiceLiveSessions.id });
  return Boolean(updated);
}

export async function cancelLiveSession(userId, sessionId) {
  return db.transaction(async (tx) => {
    const [removed] = await tx.delete(voiceLiveSessions).where(and(eq(voiceLiveSessions.id, sessionId), eq(voiceLiveSessions.userId, userId), eq(voiceLiveSessions.status, "reserved"))).returning({ id: voiceLiveSessions.id });
    if (removed) {
      const [reservation] = await tx.select().from(creditLedger).where(eq(creditLedger.externalReference, `voice-reservation:${sessionId}`)).limit(1);
      if (reservation?.credits < 0) await tx.insert(creditLedger).values({ userId, credits: -reservation.credits, kind: "voice_refund", usageEventId: reservation.usageEventId, externalReference: `voice-refund:${sessionId}` }).onConflictDoNothing();
    }
    return Boolean(removed);
  });
}

export function staleLiveSessionCondition(now = new Date()) {
  // Cast the bound value explicitly. Otherwise Postgres may infer `$now -
  // interval` as interval arithmetic and reject the timestamp comparison.
  return sql`${voiceLiveSessions.createdAt} < (${now}::timestamptz - (${voiceLiveSessions.reservedSeconds} + ${RECONCILE_GRACE_SECONDS}) * interval '1 second')`;
}

export async function reconcileStaleLiveSessions(now = new Date()) {
  const stale = await db.select({
    id: voiceLiveSessions.id,
    userId: voiceLiveSessions.userId,
    reservedSeconds: voiceLiveSessions.reservedSeconds,
    connectedAt: voiceLiveSessions.connectedAt,
    lastActivityAt: voiceLiveSessions.lastActivityAt,
  }).from(voiceLiveSessions).where(and(eq(voiceLiveSessions.status, "reserved"), staleLiveSessionCondition(now)));
  const finalizedUserIds = new Set();
  for (const session of stale) {
    const updated = await finalizeLiveSession(session.userId, session.id, now, {
      useLastActivity: true,
      status: session.connectedAt ? "incomplete" : "abandoned",
    });
    if (updated?.status === "incomplete") finalizedUserIds.add(session.userId);
  }
  const suspended = [], windowStart = new Date(now.getTime() - SUSPEND_WINDOW_MS);
  for (const userId of finalizedUserIds) {
    const [profile] = await db.select({ voiceSuspendedAt: userProfiles.voiceSuspendedAt }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    if (profile?.voiceSuspendedAt) continue;
    const [row] = await db.select({
      count: sql`count(*)::int`,
      totalActual: sql`coalesce(sum(coalesce(${voiceLiveSessions.actualSeconds}, 0)), 0)::int`,
    }).from(voiceLiveSessions).where(and(eq(voiceLiveSessions.userId, userId), eq(voiceLiveSessions.status, "incomplete"), gte(voiceLiveSessions.createdAt, windowStart)));
    const usage = await getCurrentUsage(userId).catch(() => ({ tier: "free" }));
    const allowance = usage.tier === "pro" ? PRO_FLAGSHIP_DAILY_SECONDS : (MINI_POOL_SECONDS[usage.tier] ?? MINI_POOL_SECONDS.free);
    if (Number(row.totalActual) > allowance * SUSPEND_INCOMPLETE_SECONDS_MULTIPLIER || Number(row.count) >= SUSPEND_INCOMPLETE_COUNT_THRESHOLD) {
      await db.insert(userProfiles).values({ userId, voiceSuspendedAt: now }).onConflictDoUpdate({ target: userProfiles.userId, set: { voiceSuspendedAt: now, updatedAt: now } }); suspended.push(userId);
    }
  }
  return { finalized: stale.length, suspended };
}

let reconcileTimer = null;
export function startLiveUsageReconciliationJob({ reconcile = reconcileStaleLiveSessions } = {}) { if (reconcileTimer) return reconcileTimer; reconcileTimer = setInterval(() => { reconcile().catch((error) => logFailure("voice_usage_reconciliation_failed", error)); }, RECONCILE_INTERVAL_MS); reconcileTimer.unref?.(); return reconcileTimer; }
export function stopLiveUsageReconciliationJob() { if (reconcileTimer) clearInterval(reconcileTimer); reconcileTimer = null; }
