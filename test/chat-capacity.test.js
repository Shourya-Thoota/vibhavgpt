// PR 4: shared chat capacity (src/chat/capacity.js). Every test runs against a real Postgres (PGlite) with the real migrations, and
// two capacity instances stand in for two API replicas sharing one database: nothing is held in one process's memory.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:9/unused";
const { createChatCapacity, chooseAdmissions, CapacityError, CAPACITY_CODES } = await import("../src/chat/capacity.js");
const { runWithCapacityScope } = await import("../src/chat/capacity-context.js");
const { callModelStreaming, RATE_LIMIT_MAX_WAIT_MS } = await import("../src/chat/providers.js");
const { config } = await import("../src/config.js");

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const database = drizzle(client);

const saved = { paid: config.providerKeys.paid, nova: config.chatModels.nova };
config.chatModels.nova = "fixture/nova-model";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leaseRows = async () => (await client.query("SELECT tier, user_id, group_id, state FROM chat_capacity_leases ORDER BY enqueued_at")).rows;
const limits = (over = {}) => ({
  enabled: true, global: 0, tiers: { lumen: 0, nova: 0, nebula: 0, vesper: 0, study: 0 }, perUser: 0, perGroup: 0,
  maxQueuedPerTier: 40, maxQueuedPerUser: 5, maxWaitMs: 5_000, ...over, tiers: { lumen: 0, nova: 0, nebula: 0, vesper: 0, study: 0, ...over.tiers },
});
const FAST = { pollMs: 20, heartbeatMs: 50, leaseTtlMs: 2_000, agingMs: 200, queuedMs: 15, slowFirstTokenMs: 200 };
function replica(settings, { lines = [] } = {}) {
  const sink = (line) => lines.push(JSON.parse(line));
  return createChatCapacity({ database, settings: () => settings.current, timing: FAST, log: sink, warn: sink });
}
const settingsOf = (over) => ({ current: limits(over) });

beforeEach(async () => { await client.exec("DELETE FROM chat_capacity_leases"); });
after(async () => { config.chatModels.nova = saved.nova; await client.close(); });

test("fairness rule: the account with the fewest replies running goes first, and a long wait beats any newer arrival", () => {
  const rows = [
    { id: "h-run-1", tier: "nova", user_id: "heavy", state: "active" },
    { id: "h-run-2", tier: "nova", user_id: "heavy", state: "active" },
    { id: "h-wait", tier: "nova", user_id: "heavy", state: "queued", waited_ms: 900 },
    { id: "l-wait", tier: "nova", user_id: "light", state: "queued", waited_ms: 100 },
  ];
  const one = limits({ tiers: { nova: 3 } });
  assert.deepEqual(chooseAdmissions(rows, one, { agingMs: 5_000 }), ["l-wait"], "the light account goes first although it arrived later");
  // After waiting long enough (two running replies' worth of aging), the heavy account's oldest reply is not passed over again.
  const aged = rows.map((r) => (r.id === "h-wait" ? { ...r, waited_ms: 15_000 } : r));
  assert.deepEqual(chooseAdmissions(aged, one, { agingMs: 5_000 }), ["h-wait"]);
  // A full tier admits nobody on it, but a waiting reply on another tier with room starts.
  const mixed = [...rows, { id: "x-run", tier: "nova", user_id: "x", state: "active" }, { id: "neb", tier: "nebula", user_id: "heavy", state: "queued", waited_ms: 1 }];
  assert.deepEqual(chooseAdmissions(mixed, limits({ tiers: { nova: 3, nebula: 1 } })), ["neb"]);
});

test("below pressure a reply starts at once and its row is gone on release; the release line has timings and no account id", async () => {
  const lines = [];
  const cap = replica(settingsOf({ tiers: { nova: 2 } }), { lines });
  const lease = await cap.acquire({ tier: "nova", userId: "user-secret-1" });
  assert.equal(lease.enabled, true);
  assert.deepEqual((await leaseRows()).map((r) => [r.tier, r.state]), [["nova", "active"]]);
  await sleep(5);
  lease.markFirstToken();
  await lease.release("completed");
  await lease.release("completed"); // a second release (finish and close both fire) does nothing
  assert.deepEqual(await leaseRows(), []);
  const released = lines.filter((l) => l.event === "chat_capacity_release");
  assert.equal(released.length, 1, "released exactly once");
  assert.equal(released[0].outcome, "completed");
  assert.equal(released[0].queued, false);
  assert.ok(Number.isInteger(released[0].firstTokenMs) && released[0].firstTokenMs >= 0);
  assert.doesNotMatch(JSON.stringify(lines), /user-secret-1/, "no account id in any line");
});

test("every layer holds: global, per tier, per account and per project each make a reply wait, and say which layer did", async () => {
  const lines = [];
  const settings = settingsOf({ global: 4, tiers: { nova: 2, nebula: 4, lumen: 4 }, perUser: 2, perGroup: 1 });
  const cap = replica(settings, { lines });
  const queuedLayer = async (request, holders) => {
    const controller = new AbortController();
    const waiting = cap.acquire({ ...request, signal: controller.signal });
    await sleep(60);
    const layer = lines.filter((l) => l.event === "chat_capacity_queued").at(-1)?.layer;
    controller.abort();
    await assert.rejects(waiting, (error) => error instanceof CapacityError && error.code === CAPACITY_CODES.CANCELLED);
    for (const lease of holders) await lease.release();
    return layer;
  };
  // Per tier: Nova's two slots are taken by two other accounts.
  let held = [await cap.acquire({ tier: "nova", userId: "a" }), await cap.acquire({ tier: "nova", userId: "b" })];
  assert.equal(await queuedLayer({ tier: "nova", userId: "c" }, held), "tier");
  // Per account: this account already has two replies running (on other tiers).
  held = [await cap.acquire({ tier: "nebula", userId: "a" }), await cap.acquire({ tier: "lumen", userId: "a" })];
  assert.equal(await queuedLayer({ tier: "nebula", userId: "a" }, held), "user");
  // Per project: one reply already uses this project's shared context.
  held = [await cap.acquire({ tier: "nebula", userId: "a", groupId: "project-1" })];
  assert.equal(await queuedLayer({ tier: "nebula", userId: "b", groupId: "project-1" }, held), "group");
  // Global: four replies across tiers fill the service.
  held = [await cap.acquire({ tier: "nebula", userId: "a" }), await cap.acquire({ tier: "nebula", userId: "b" }), await cap.acquire({ tier: "lumen", userId: "c" }), await cap.acquire({ tier: "lumen", userId: "d" })];
  assert.equal(await queuedLayer({ tier: "nova", userId: "e" }, held), "global");
  assert.deepEqual(await leaseRows(), [], "nothing left behind");
});

test("state is shared across replicas: a reply waiting on one replica starts when a reply on another releases", async () => {
  const settings = settingsOf({ tiers: { nova: 1 } });
  const replicaA = replica(settings);
  const replicaB = replica(settings);
  assert.notEqual(replicaA.instanceId, replicaB.instanceId);
  const held = await replicaA.acquire({ tier: "nova", userId: "a" });
  const waits = [];
  const waiting = replicaB.acquire({ tier: "nova", userId: "b", onWaiting: (w) => waits.push(w) });
  await sleep(80);
  assert.deepEqual((await leaseRows()).map((r) => r.state), ["active", "queued"], "replica B could not take replica A's slot");
  assert.equal(waits[0].tier, "nova");
  await held.release();
  const started = await waiting;
  assert.equal(started.enabled, true);
  assert.deepEqual((await leaseRows()).map((r) => [r.user_id, r.state]), [["b", "active"]]);
  await started.release();
});

test("a replica that stops (no more renewals) loses its slots after the lease time; nothing leaks", async () => {
  const settings = settingsOf({ tiers: { nova: 1 } });
  const cap = replica(settings);
  // A row left by a replica that crashed: never renewed, already past its expiry.
  await client.query("INSERT INTO chat_capacity_leases (id, tier, user_id, state, instance_id, expires_at) VALUES (gen_random_uuid(), 'nova', 'gone', 'active', 'dead-replica', now() - interval '1 second')");
  const lines = [];
  const fresh = createChatCapacity({ database, settings: () => settings.current, timing: FAST, log: (l) => lines.push(JSON.parse(l)) });
  const lease = await fresh.acquire({ tier: "nova", userId: "b" });
  assert.equal(lease.enabled, true, "the dead replica's slot was reclaimed");
  assert.equal(lines.find((l) => l.event === "chat_capacity_expired")?.active, 1);
  await lease.release();
  // A live reply keeps renewing its row, so it is never reclaimed while it runs.
  const live = await cap.acquire({ tier: "nova", userId: "c" });
  const before = (await client.query("SELECT expires_at FROM chat_capacity_leases")).rows[0].expires_at;
  await sleep(150);
  const after = (await client.query("SELECT expires_at FROM chat_capacity_leases")).rows[0].expires_at;
  assert.ok(new Date(after) > new Date(before), "the heartbeat renewed the row");
  await live.release();
});

test("simulated burst across tiers and accounts: caps never exceeded, every account served, nothing left behind", async () => {
  const settings = settingsOf({ global: 6, tiers: { lumen: 2, nova: 3, nebula: 2 }, perUser: 2, maxQueuedPerTier: 100, maxQueuedPerUser: 8, maxWaitMs: 20_000 });
  const replicas = [replica(settings), replica(settings)];
  const running = { all: 0, tier: {}, user: {} };
  const peak = { all: 0, tier: {}, user: {} };
  const served = {};
  const waitsByUser = {};
  const tiers = ["lumen", "nova", "nebula"];
  const users = ["u1", "u2", "u3", "u4", "u5", "u6"];
  const jobs = [];
  for (let round = 0; round < 3; round += 1) {
    for (const [index, user] of users.entries()) {
      const tier = tiers[(index + round) % tiers.length];
      const cap = replicas[(index + round) % 2];
      jobs.push((async () => {
        const startedAt = Date.now();
        const lease = await cap.acquire({ tier, userId: user });
        (waitsByUser[user] ??= []).push(Date.now() - startedAt);
        running.all += 1; running.tier[tier] = (running.tier[tier] ?? 0) + 1; running.user[user] = (running.user[user] ?? 0) + 1;
        peak.all = Math.max(peak.all, running.all);
        peak.tier[tier] = Math.max(peak.tier[tier] ?? 0, running.tier[tier]);
        peak.user[user] = Math.max(peak.user[user] ?? 0, running.user[user]);
        await sleep(15 + ((index * 7 + round * 11) % 25));
        running.all -= 1; running.tier[tier] -= 1; running.user[user] -= 1;
        served[user] = (served[user] ?? 0) + 1;
        await lease.release();
      })());
    }
  }
  await Promise.all(jobs);
  assert.ok(peak.all <= 6, `global peak ${peak.all}`);
  assert.ok(peak.tier.lumen <= 2 && peak.tier.nova <= 3 && peak.tier.nebula <= 2, JSON.stringify(peak.tier));
  for (const user of users) {
    assert.equal(served[user], 3, `${user} had every reply served`);
    assert.ok(peak.user[user] <= 2, `${user} never had more than 2 running`);
  }
  assert.deepEqual(await leaseRows(), [], "no slot leaked");
  const worst = Math.max(...Object.values(waitsByUser).flat());
  assert.ok(worst < 20_000, `nobody waited out the limit (worst ${worst} ms)`);
});

test("fairness under load: a light account is not starved by a heavy one filling the line", async () => {
  const settings = settingsOf({ tiers: { nova: 1 }, perUser: 1, maxQueuedPerUser: 3 });
  const cap = replica(settings);
  const order = [];
  const run = async (user) => {
    const lease = await cap.acquire({ tier: "nova", userId: user });
    order.push(user);
    await sleep(30);
    await lease.release();
  };
  const first = run("heavy");
  await sleep(20);
  const heavy = [run("heavy"), run("heavy"), run("heavy")];
  await sleep(20);
  const light = run("light");
  await Promise.all([first, ...heavy, light]);
  assert.ok(order.indexOf("light") <= 2, `the light account went second or third, not last: ${order.join(",")}`);
  assert.equal(order.filter((u) => u === "heavy").length, 4, "and the heavy account still had every reply served");
  // And the line has a per-account limit: a fifth waiting reply from the heavy account is refused, honestly, with its own message.
  const held = await cap.acquire({ tier: "nova", userId: "x" });
  const queued = [1, 2, 3].map(() => cap.acquire({ tier: "nova", userId: "heavy" }).then((l) => l.release(), () => null));
  await sleep(60);
  await assert.rejects(cap.acquire({ tier: "nova", userId: "heavy" }), (error) => error.code === CAPACITY_CODES.USER_WAITING && /already have replies waiting/.test(error.message));
  await held.release();
  await Promise.all(queued);
});

test("cancel: a waiting reply that is cancelled leaves the line at once; a running one frees its slot at the moment of cancel", async () => {
  const lines = [];
  const settings = settingsOf({ tiers: { nebula: 1 } });
  const cap = replica(settings, { lines });
  const runningCancel = new AbortController();
  const running = await cap.acquire({ tier: "nebula", userId: "a", signal: runningCancel.signal });
  const waitingCancel = new AbortController();
  const waiting = cap.acquire({ tier: "nebula", userId: "b", signal: waitingCancel.signal });
  await sleep(50);
  waitingCancel.abort();
  await assert.rejects(waiting, (error) => error.code === CAPACITY_CODES.CANCELLED);
  assert.deepEqual((await leaseRows()).map((r) => r.user_id), ["a"], "the cancelled reply is no longer waiting");
  // A third reply waits; the running one is cancelled (the person pressed stop, or disconnected): its slot goes to the third at once,
  // although the running reply's own code has not finished unwinding.
  const third = cap.acquire({ tier: "nebula", userId: "c" });
  await sleep(50);
  runningCancel.abort();
  const startedThird = await third;
  assert.equal(startedThird.enabled, true);
  assert.equal(running.released, true);
  await running.release("completed"); // the reply's own finally, later: no second release
  assert.deepEqual(lines.filter((l) => l.event === "chat_capacity_release").map((l) => l.outcome), ["cancelled"]);
  assert.equal(lines.find((l) => l.event === "chat_capacity_rejected")?.reason, "cancelled-waiting");
  await startedThird.release();
  assert.deepEqual(await leaseRows(), []);
});

test("saturation and waiting too long are told honestly by tier name, and leave nothing waiting", async () => {
  const settings = settingsOf({ tiers: { vesper: 1 }, maxQueuedPerTier: 0 });
  const cap = replica(settings);
  const held = await cap.acquire({ tier: "vesper", userId: "a" });
  await assert.rejects(cap.acquire({ tier: "vesper", userId: "b" }), (error) => {
    assert.equal(error.code, CAPACITY_CODES.HIGH_DEMAND);
    assert.equal(error.message, "Vulcan is in high demand right now, so this reply didn't start and nothing was used. Please try again in a minute.");
    return true;
  });
  settings.current = limits({ tiers: { vesper: 1 }, maxWaitMs: 120 });
  const startedAt = Date.now();
  await assert.rejects(cap.acquire({ tier: "vesper", userId: "b" }), (error) => error.code === CAPACITY_CODES.HIGH_DEMAND);
  assert.ok(Date.now() - startedAt >= 100, "it waited its turn first");
  assert.deepEqual((await leaseRows()).map((r) => r.user_id), ["a"]);
  await held.release();
});

test("fail closed: if the shared store cannot be reached, the reply does not start and the person is told so", async () => {
  const lines = [];
  const broken = { transaction: async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2"), { name: "ConnectionError" }); }, execute: async () => { throw new Error("down"); } };
  const cap = createChatCapacity({ database: broken, settings: () => limits({ tiers: { nova: 4 } }), timing: FAST, log: (l) => lines.push(l), warn: (l) => lines.push(l) });
  await assert.rejects(cap.acquire({ tier: "nova", userId: "a" }), (error) => {
    assert.equal(error.code, CAPACITY_CODES.UNAVAILABLE);
    assert.equal(error.message, "We couldn't start this reply just now, and nothing was used. Please try again in a moment.");
    return true;
  });
  const text = lines.join("\n");
  assert.match(text, /chat_capacity_unavailable/);
  assert.doesNotMatch(text, /ECONNREFUSED|hunter2|10\.0\.0\.1/, "only the error type is logged");
});

test("tier containment: a waiting reply is started only by its own tier's capacity, and a switch must win a slot on the new tier", async () => {
  const settings = settingsOf({ tiers: { nova: 1, nebula: 2 } });
  const cap = replica(settings);
  const novaHeld = await cap.acquire({ tier: "nova", userId: "a" });
  const waitingNova = cap.acquire({ tier: "nova", userId: "b" });
  await sleep(80);
  // Nebula has room; that does not start the waiting Nova reply.
  const nebulaHeld = await cap.acquire({ tier: "nebula", userId: "c" });
  await sleep(80);
  assert.deepEqual((await leaseRows()).filter((r) => r.user_id === "b").map((r) => [r.tier, r.state]), [["nova", "queued"]]);
  // A reply moving to Nova does not get a slot there by bringing one from elsewhere: Nova is full, so tryAcquire gives nothing.
  assert.equal(await cap.tryAcquire({ tier: "nova", userId: "c" }), null);
  // Moving to Nebula (one slot left) succeeds without waiting.
  const moved = await cap.tryAcquire({ tier: "nebula", userId: "d" });
  assert.equal(moved.tier, "nebula");
  assert.equal(await cap.tryAcquire({ tier: "nebula", userId: "e" }), null, "Nebula is now full too");
  await Promise.all([novaHeld.release(), nebulaHeld.release(), moved.release()]);
  (await waitingNova).release();
  await sleep(20);
  assert.deepEqual(await leaseRows(), []);
});

// The model call inside a reply: retries use the reply's one slot, and an upstream 429 is backed off within a small bound.
const encoder = new TextEncoder();
const okStream = (text = "OK") => new Response(new ReadableStream({ start(c) {
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`));
  c.close();
} }), { headers: { "Content-Type": "text/event-stream" } });


test("an upstream 429 is retried once inside the reply's one slot, after the host's Retry-After with jitter; the release names the upstream", async () => {
  config.providerKeys.paid = "fixture-key";
  const lines = [];
  const cap = replica(settingsOf({ tiers: { nova: 4 } }), { lines });
  const slotsSeen = [];
  const callTimes = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("/generation")) return new Response("{}", { status: 404 });
    slotsSeen.push((await leaseRows()).length);
    callTimes.push(Date.now());
    return callTimes.length === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : okStream();
  };
  const retries = [];
  await runWithCapacityScope(async () => {
    const lease = await cap.acquire({ tier: "nova", userId: "a" });
    const result = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, { fetchImpl, onRetry: (r) => retries.push(r), startRetryDelaysMs: [0] });
    assert.equal(result.data.choices[0].message.content, "OK");
    await lease.release("completed");
  });
  config.providerKeys.paid = saved.paid;
  assert.deepEqual(slotsSeen, [1, 1], "both tries ran inside one slot");
  const waited = callTimes[1] - callTimes[0];
  assert.ok(waited >= 480 && waited <= 1_200, `waited about the host's 1 s with jitter (equal jitter: 0.5 to 1 s), got ${waited} ms`);
  assert.equal(retries[0].rateLimited, true);
  const release = lines.find((l) => l.event === "chat_capacity_release");
  assert.equal(release.bottleneck, "upstream-saturation");
  assert.equal(release.upstream429, 1);
});

test("a host that asks to wait longer than the bound is not retried inside the reply: it fails closed as rate-limited, once", async () => {
  config.providerKeys.paid = "fixture-key";
  let calls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/generation")) return new Response("{}", { status: 404 });
    calls += 1;
    return new Response("{}", { status: 429, headers: { "retry-after": String(Math.ceil(RATE_LIMIT_MAX_WAIT_MS / 1000) + 26) } });
  };
  const startedAt = Date.now();
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, { fetchImpl, startRetryDelaysMs: [0] }), (error) => {
    assert.equal(error.exhausted, true);
    assert.equal(error.rateLimited, true);
    return true;
  });
  config.providerKeys.paid = saved.paid;
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 1_000, "it did not sit out the host's 30 s");
});

test("the snapshot reports queue depth and in-flight per tier from the shared store, counts only", async () => {
  const settings = settingsOf({ tiers: { study: 1 } });
  const cap = replica(settings);
  const held = await cap.acquire({ tier: "study", userId: "student-1" });
  const waiting = cap.acquire({ tier: "study", userId: "student-2" });
  await sleep(60);
  const snap = await cap.snapshot();
  assert.equal(snap.tiers.study.active, 1);
  assert.equal(snap.tiers.study.queued, 1);
  assert.ok(snap.tiers.study.oldestWaitMs >= 0);
  assert.doesNotMatch(JSON.stringify(snap), /student-/);
  await held.release();
  (await waiting).release();
});

test("off means off: no rows, no waiting", async () => {
  const cap = replica({ current: { ...limits(), enabled: false } });
  const lease = await cap.acquire({ tier: "nova", userId: "a" });
  assert.equal(lease.enabled, false);
  assert.deepEqual(await leaseRows(), []);
  await lease.release();
});

test("the labels say what is happening, by tier name, with the real figures", async () => {
  const { liveStatusLabel } = await import("../frontend/src/live-status.js");
  assert.equal(liveStatusLabel({ phase: "queued", tier: "Nova", seconds: 7.9 }), "Nova is in high demand. Waiting for a free slot... (7 s)");
  assert.equal(liveStatusLabel({ phase: "busy", attempt: 2, maxAttempts: 2 }), "High demand, trying again (attempt 2 of 2)");
  assert.equal(liveStatusLabel({ phase: "retrying", attempt: 2, maxAttempts: 3 }), "Provider was slow, trying again (attempt 2 of 3)", "the existing label is unchanged");
  const { createThinkingRelay } = await import("../src/chat/reasoning-stream.js");
  const statuses = [];
  const relay = createThinkingRelay({ onDelta() {}, onStatus: (phase, details) => statuses.push([phase, details]) });
  relay.retry({ attempt: 2, maxAttempts: 2, rateLimited: true });
  relay.retry({ attempt: 2, maxAttempts: 2 });
  assert.deepEqual(statuses.map(([phase]) => phase), ["busy", "retrying"]);
});
