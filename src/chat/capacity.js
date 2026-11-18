/**
 * Shared chat capacity: how many replies may be in flight at once, across every API replica.
 *
 * Layers, all in-flight caps (a cap of 0 means no cap at that layer):
 *   - global: every tier together;
 *   - per tier: Lumen, Nova, Nebula, Vulcan, Study, each separately;
 *   - per account;
 *   - per project, when the reply uses a project's shared context.
 *
 * Behaviour:
 *   - Room at every layer: the reply starts at once.
 *   - Full: the reply waits its turn (the person sees an honest "waiting for a free slot" state and can cancel).
 *   - The wait is full, or has gone on for maxWaitMs: the reply does not start, and the person is told the tier is in high demand.
 *     Nothing was reserved or sent, so nothing was used.
 *   - The capacity store cannot be read or written: fail closed, and say so.
 *
 * State lives in Postgres, never in one process's memory: one row per waiting or running reply in chat_capacity_leases. Every
 * admission decision runs in one transaction under one advisory lock, so two replicas cannot both take the last slot. A running
 * reply renews its row every few seconds; a row from a replica that stopped (crash, redeploy) expires after leaseTtlMs and is
 * deleted by the next decision on any replica.
 *
 * A slot is released exactly once: on completion, failure, timeout, cancel or disconnect, whichever comes first. A cancelled
 * reply's slot is freed at the moment of cancel, not when its upstream call unwinds, so a cancelled reply holds no capacity.
 * Retries of a model call inside one reply use the reply's one slot. A slot belongs to one tier: a reply that moves to another
 * tier gives its slot back and must win a slot on the new tier (tryAcquire), and a waiting reply can only be started by its own
 * tier's capacity.
 *
 * Fairness: among waiting replies that fit, the least-loaded account goes first (its running replies plus its other waiting
 * replies); waiting time counts in a reply's favour (aging), so none waits forever. Each account may have only a few
 * replies waiting at once, so no account can fill the line.
 *
 * Logs: counts, durations, tier and bottleneck only. Never message text, memory, keys, account ids or hashes of them.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { currentCapacityScope } from "./capacity-context.js";

export const CAPACITY_TIERS = Object.freeze(["lumen", "nova", "nebula", "vesper", "study", "zenith", "tecton", "marketplace"]);
const TIER_LABELS = Object.freeze({ lumen: "Lumen", nova: "Nova", nebula: "Nebula", vesper: "Vulcan", study: "Study", zenith: "Zenith", tecton: "Tecton", marketplace: "This model" });
export const tierLabel = (tier) => TIER_LABELS[tier] ?? "This model";

export const CAPACITY_CODES = Object.freeze({
  HIGH_DEMAND: "high_demand",
  USER_WAITING: "capacity_user_waiting",
  UNAVAILABLE: "capacity_unavailable",
  CANCELLED: "capacity_cancelled",
});

const MESSAGES = {
  [CAPACITY_CODES.HIGH_DEMAND]: (tier) => `${tierLabel(tier)} is in high demand right now, so this reply didn't start and nothing was used. Please try again in a minute.`,
  [CAPACITY_CODES.USER_WAITING]: () => "You already have replies waiting for a free slot. Wait for one of them to start, then send this message again.",
  [CAPACITY_CODES.UNAVAILABLE]: () => "We couldn't start this reply just now, and nothing was used. Please try again in a moment.",
  [CAPACITY_CODES.CANCELLED]: () => "The reply was cancelled before it started.",
};

export class CapacityError extends Error {
  constructor(code, { tier = null, layer = null, status = code === CAPACITY_CODES.CANCELLED ? 499 : 503, retryAfterSeconds = null } = {}) {
    super(MESSAGES[code](tier));
    this.name = "CapacityError";
    this.code = code;
    this.tier = tier;
    this.layer = layer;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = code !== CAPACITY_CODES.CANCELLED;
  }
}

// Timing. A running reply renews its row every heartbeatMs; a row not renewed for leaseTtlMs belongs to a replica that stopped.
const DEFAULT_TIMING = Object.freeze({
  heartbeatMs: 5_000,
  leaseTtlMs: 20_000,
  pollMs: 700,
  agingMs: 5_000,
  // A slot is never held past this, whatever happens to the reply (a guard against a leak, logged as one).
  maxHoldMs: 15 * 60_000,
  // Thresholds for naming the bottleneck in the release line.
  queuedMs: 250,
  slowFirstTokenMs: 12_000,
});

const rowsOf = (result) => result?.rows ?? result ?? [];
const countBy = (rows, key) => rows.reduce((map, row) => { if (row[key] != null) map.set(row[key], (map.get(row[key]) ?? 0) + 1); return map; }, new Map());
const capOpen = (cap, used) => !(cap > 0) || used < cap;

/** Which waiting replies start now: pure, so the fairness rule is testable on its own. */
export function chooseAdmissions(rows, limits, { agingMs = DEFAULT_TIMING.agingMs } = {}) {
  const active = rows.filter((row) => row.state === "active");
  const counts = {
    global: active.length,
    tier: countBy(active, "tier"),
    user: countBy(active, "user_id"),
    group: countBy(active, "group_id"),
  };
  const fits = (row) => capOpen(limits.global, counts.global)
    && capOpen(limits.tiers?.[row.tier] ?? 0, counts.tier.get(row.tier) ?? 0)
    && capOpen(limits.perUser, counts.user.get(row.user_id) ?? 0)
    && (row.group_id == null || capOpen(limits.perGroup, counts.group.get(row.group_id) ?? 0));
  const waiting = rows.filter((row) => row.state === "queued");
  const admitted = [];
  for (;;) {
    const candidates = waiting.filter((row) => !admitted.includes(row.id) && fits(row));
    if (!candidates.length) return admitted;
    // Least-loaded account first: an account's load is its running replies plus its other waiting replies, so an account with a
    // long line yields to one with a short line (within an account, the oldest goes first). Each agingMs of waiting takes one unit
    // off, so a long wait is never passed over for good. Then oldest; then id.
    const stillWaiting = waiting.filter((row) => !admitted.includes(row.id));
    const othersWaiting = (row) => stillWaiting.filter((other) => other.user_id === row.user_id && other.id !== row.id).length;
    const priority = (row) => (counts.user.get(row.user_id) ?? 0) + othersWaiting(row) - Math.floor(Number(row.waited_ms ?? 0) / agingMs);
    candidates.sort((a, b) => priority(a) - priority(b) || Number(b.waited_ms ?? 0) - Number(a.waited_ms ?? 0) || String(a.id).localeCompare(String(b.id)));
    const next = candidates[0];
    admitted.push(next.id);
    counts.global += 1;
    counts.tier.set(next.tier, (counts.tier.get(next.tier) ?? 0) + 1);
    counts.user.set(next.user_id, (counts.user.get(next.user_id) ?? 0) + 1);
    if (next.group_id != null) counts.group.set(next.group_id, (counts.group.get(next.group_id) ?? 0) + 1);
  }
}

/** Why a reply is waiting: the first layer that is full for it. For the rejection line only. */
function fullLayer(row, rows, limits) {
  const active = rows.filter((r) => r.state === "active");
  if (limits.perUser > 0 && active.filter((r) => r.user_id === row.user_id).length >= limits.perUser) return "user";
  if (row.group_id != null && limits.perGroup > 0 && active.filter((r) => r.group_id === row.group_id).length >= limits.perGroup) return "group";
  if ((limits.tiers?.[row.tier] ?? 0) > 0 && active.filter((r) => r.tier === row.tier).length >= limits.tiers[row.tier]) return "tier";
  if (limits.global > 0 && active.length >= limits.global) return "global";
  return "queue";
}

const NOOP_LEASE = Object.freeze({
  enabled: false, id: null, tier: null,
  markFirstToken() {}, noteUpstream() {}, async release() {},
});

export function createChatCapacity({
  database = null,
  settings = () => config.chatCapacity,
  timing = {},
  instanceId = randomUUID(),
  log = (line) => console.info(line),
  warn = (line) => console.warn(line),
  random = Math.random,
} = {}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  let resolvedDb = database;
  const getDb = async () => {
    if (!resolvedDb) resolvedDb = (await import("../db/client.js")).db;
    return resolvedDb;
  };
  const waiters = new Set();
  const wakeLocal = () => { for (const wake of [...waiters]) wake(); };
  const counters = { admitted: 0, queued: 0, released: {}, rejected: {} };
  const bump = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  const emit = (fields) => log(JSON.stringify(fields));
  const ttlSeconds = () => Math.max(1, Math.ceil(t.leaseTtlMs / 1000));

  /** One admission decision, in one transaction under the one lock. */
  async function decide({ insert = null, ownId = null, renew = false, limits }) {
    const store = await getDb();
    return store.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('chat_capacity_admission'))`);
      const expired = rowsOf(await tx.execute(sql`DELETE FROM chat_capacity_leases WHERE expires_at < now() RETURNING state`));
      if (expired.length) emit({ event: "chat_capacity_expired", leases: expired.length, active: expired.filter((r) => r.state === "active").length });
      if (renew && ownId) await tx.execute(sql`UPDATE chat_capacity_leases SET expires_at = now() + make_interval(secs => ${ttlSeconds()}) WHERE id = ${ownId}`);
      if (insert) {
        await tx.execute(sql`INSERT INTO chat_capacity_leases (id, tier, user_id, group_id, state, instance_id, expires_at)
          VALUES (${insert.id}, ${insert.tier}, ${insert.userId}, ${insert.groupId}, 'queued', ${instanceId}, now() + make_interval(secs => ${ttlSeconds()}))`);
      }
      const rows = rowsOf(await tx.execute(sql`SELECT id, tier, user_id, group_id, state,
        (extract(epoch from (now() - enqueued_at)) * 1000)::float8 AS waited_ms FROM chat_capacity_leases`));
      const admitted = chooseAdmissions(rows, limits, { agingMs: t.agingMs });
      if (admitted.length) {
        await tx.execute(sql`UPDATE chat_capacity_leases SET state = 'active', accepted_at = now() WHERE id IN (${sql.join(admitted.map((id) => sql`${id}`), sql`, `)})`);
      }
      const id = insert?.id ?? ownId;
      const own = rows.find((row) => row.id === id) ?? null;
      const ownState = !own ? null : own.state === "active" || admitted.includes(id) ? "active" : "queued";
      let rejection = null;
      if (insert && ownState === "queued") {
        // Room in the line? Others waiting for the same tier, and this account's other waiting replies, not counting this one.
        const waiting = rows.filter((row) => row.state === "queued" && !admitted.includes(row.id) && row.id !== id);
        const layer = fullLayer(own, rows, limits);
        if (waiting.filter((row) => row.user_id === own.user_id).length >= limits.maxQueuedPerUser) rejection = { code: CAPACITY_CODES.USER_WAITING, layer: "user-queue" };
        else if (waiting.filter((row) => row.tier === own.tier).length >= limits.maxQueuedPerTier) rejection = { code: CAPACITY_CODES.HIGH_DEMAND, layer };
        if (rejection) await tx.execute(sql`DELETE FROM chat_capacity_leases WHERE id = ${id}`);
      }
      // Admissions this decision made for replies on other replicas' (or this one's) waiting lists: they find out on their next poll.
      return { ownState: rejection ? null : ownState, rejection, layer: own ? fullLayer(own, rows, limits) : null };
    });
  }

  async function drop(id) {
    const store = await getDb();
    await store.execute(sql`DELETE FROM chat_capacity_leases WHERE id = ${id}`);
  }

  function pause(ms, signal) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener?.("abort", done); resolve(); };
      timer = setTimeout(done, ms);
      timer.unref?.();
      waiters.add(done);
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  function makeLease({ id, tier, signal, startedAt, acceptedAt, queued }) {
    let released = false;
    let firstTokenAt = null;
    const upstream = { rateLimited: 0, serverErrors: 0 };
    let heartbeat = null;
    let holdTimer = null;
    const onAbort = () => { void lease.release("cancelled"); };
    const lease = {
      enabled: true, id, tier,
      markFirstToken() { if (firstTokenAt === null) firstTokenAt = Date.now(); },
      noteUpstream(status) {
        if (status === 429) upstream.rateLimited += 1;
        else if (status >= 500) upstream.serverErrors += 1;
      },
      get released() { return released; },
      async release(outcome = "completed") {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        clearTimeout(holdTimer);
        signal?.removeEventListener?.("abort", onAbort);
        const scope = currentCapacityScope();
        if (scope?.lease === lease) scope.lease = null;
        try {
          await drop(id);
        } catch (error) {
          // The row expires on its own within leaseTtlMs; the slot is not lost for longer than that.
          warn(JSON.stringify({ event: "chat_capacity_release_failed", tier, errorType: String(error?.name ?? "Error").slice(0, 60) }));
        }
        wakeLocal();
        const now = Date.now();
        const waitMs = acceptedAt - startedAt;
        const ttftMs = firstTokenAt === null ? null : firstTokenAt - acceptedAt;
        const holdMs = now - acceptedAt;
        const bottleneck = upstream.rateLimited > 0 ? "upstream-saturation"
          : waitMs >= t.queuedMs ? "own-limit"
            : (ttftMs ?? (outcome === "completed" ? 0 : holdMs)) >= t.slowFirstTokenMs ? "slow-model"
              : null;
        bump(counters.released, outcome);
        emit({
          event: "chat_capacity_release", tier, outcome, queued, waitMs, firstTokenMs: ttftMs, holdMs, bottleneck,
          upstream429: upstream.rateLimited, upstream5xx: upstream.serverErrors,
        });
      },
    };
    heartbeat = setInterval(async () => {
      try {
        const store = await getDb();
        await store.execute(sql`UPDATE chat_capacity_leases SET expires_at = now() + make_interval(secs => ${ttlSeconds()}) WHERE id = ${id}`);
      } catch (error) {
        warn(JSON.stringify({ event: "chat_capacity_heartbeat_failed", tier, errorType: String(error?.name ?? "Error").slice(0, 60) }));
      }
    }, t.heartbeatMs);
    heartbeat.unref?.();
    holdTimer = setTimeout(() => {
      warn(JSON.stringify({ event: "chat_capacity_hold_limit", tier, holdMs: t.maxHoldMs }));
      void lease.release("timeout");
    }, t.maxHoldMs);
    holdTimer.unref?.();
    if (signal?.aborted) void lease.release("cancelled");
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    const scope = currentCapacityScope();
    if (scope) scope.lease = lease;
    return lease;
  }

  function reject(code, { tier, layer, startedAt, reason }) {
    bump(counters.rejected, reason);
    emit({ event: "chat_capacity_rejected", tier, reason, layer: layer ?? null, waitMs: Date.now() - startedAt,
      bottleneck: code === CAPACITY_CODES.UNAVAILABLE ? "capacity-store" : "own-limit" });
    return new CapacityError(code, { tier, layer });
  }

  /**
   * Wait for, and take, a slot on this tier. onWaiting is called when the reply has to wait (and every few seconds while it does)
   * with { tier, waitedMs, maxWaitMs }. Rejects with CapacityError.
   */
  async function acquire({ tier, userId, groupId = null, signal, onWaiting = () => {}, wait = true } = {}) {
    const limits = settings();
    if (!limits?.enabled) return NOOP_LEASE;
    if (!CAPACITY_TIERS.includes(tier)) return NOOP_LEASE;
    const id = randomUUID();
    const startedAt = Date.now();
    if (signal?.aborted) throw new CapacityError(CAPACITY_CODES.CANCELLED, { tier });
    let decision;
    try {
      decision = await decide({ insert: { id, tier, userId: String(userId), groupId: groupId ? String(groupId) : null }, limits });
    } catch (error) {
      warn(JSON.stringify({ event: "chat_capacity_unavailable", tier, stage: "admit", errorType: String(error?.name ?? "Error").slice(0, 60) }));
      await drop(id).catch(() => {});
      throw reject(CAPACITY_CODES.UNAVAILABLE, { tier, startedAt, reason: "unavailable" });
    }
    if (decision.rejection) throw reject(decision.rejection.code, { tier, layer: decision.rejection.layer, startedAt, reason: decision.rejection.code === CAPACITY_CODES.USER_WAITING ? "user-queue-full" : "queue-full" });
    if (decision.ownState === "active") {
      counters.admitted += 1;
      return makeLease({ id, tier, signal, startedAt, acceptedAt: Date.now(), queued: false });
    }
    if (!wait) {
      await drop(id).catch(() => {});
      return null;
    }
    counters.queued += 1;
    emit({ event: "chat_capacity_queued", tier, layer: decision.layer });
    const maxWaitMs = limits.maxWaitMs;
    onWaiting({ tier, waitedMs: 0, maxWaitMs });
    let lastReport = startedAt;
    for (;;) {
      if (signal?.aborted) {
        await drop(id).catch(() => {});
        throw reject(CAPACITY_CODES.CANCELLED, { tier, layer: decision.layer, startedAt, reason: "cancelled-waiting" });
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        await drop(id).catch(() => {});
        wakeLocal();
        throw reject(CAPACITY_CODES.HIGH_DEMAND, { tier, layer: decision.layer, startedAt, reason: "wait-timeout" });
      }
      // Jittered, so waiting replies on several replicas do not poll in step.
      const remaining = maxWaitMs - (Date.now() - startedAt);
      await pause(Math.min(remaining, Math.round(t.pollMs * (0.75 + random() * 0.5))), signal);
      if (signal?.aborted) continue;
      try {
        decision = await decide({ ownId: id, renew: true, limits: settings() });
      } catch (error) {
        warn(JSON.stringify({ event: "chat_capacity_unavailable", tier, stage: "wait", errorType: String(error?.name ?? "Error").slice(0, 60) }));
        await drop(id).catch(() => {});
        throw reject(CAPACITY_CODES.UNAVAILABLE, { tier, startedAt, reason: "unavailable" });
      }
      if (decision.ownState === "active") {
        counters.admitted += 1;
        return makeLease({ id, tier, signal, startedAt, acceptedAt: Date.now(), queued: true });
      }
      if (decision.ownState === null) {
        // This reply's row is gone (it expired: this replica could not renew it in time). Fail closed rather than guess.
        throw reject(CAPACITY_CODES.UNAVAILABLE, { tier, startedAt, reason: "lease-lost" });
      }
      if (Date.now() - lastReport >= 1_000) {
        lastReport = Date.now();
        onWaiting({ tier, waitedMs: lastReport - startedAt, maxWaitMs });
      }
    }
  }

  /** A slot on another tier only if one is free now; null if not. Never waits. */
  const tryAcquire = (options) => acquire({ ...options, wait: false });

  /** Queue depth and in-flight per tier, from the shared store (all replicas), plus this replica's counters. */
  async function snapshot() {
    const store = await getDb();
    const rows = rowsOf(await store.execute(sql`SELECT tier, state, count(*)::int AS n,
      max(extract(epoch from (now() - enqueued_at)) * 1000)::float8 AS oldest_ms FROM chat_capacity_leases WHERE expires_at >= now() GROUP BY tier, state`));
    const tiers = {};
    for (const row of rows) {
      tiers[row.tier] ??= { active: 0, queued: 0, oldestWaitMs: 0 };
      tiers[row.tier][row.state === "active" ? "active" : "queued"] = row.n;
      if (row.state === "queued") tiers[row.tier].oldestWaitMs = Math.round(row.oldest_ms ?? 0);
    }
    const total = (state) => rows.filter((row) => row.state === state).reduce((sum, row) => sum + row.n, 0);
    return { tiers, active: total("active"), queued: total("queued"), replica: { ...counters, released: { ...counters.released }, rejected: { ...counters.rejected } } };
  }

  let reporter = null;
  function startReporter(intervalMs = 60_000) {
    if (reporter || !settings()?.enabled) return;
    reporter = setInterval(async () => {
      try { emit({ event: "chat_capacity_snapshot", ...(await snapshot()) }); } catch (error) {
        warn(JSON.stringify({ event: "chat_capacity_unavailable", stage: "snapshot", errorType: String(error?.name ?? "Error").slice(0, 60) }));
      }
    }, intervalMs);
    reporter.unref?.();
  }
  const stopReporter = () => { clearInterval(reporter); reporter = null; };

  return { acquire, tryAcquire, snapshot, startReporter, stopReporter, instanceId, counters };
}

export const chatCapacity = createChatCapacity();
