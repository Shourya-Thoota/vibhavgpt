// Nova was this suite's enforced tier; it was retired on 2026-11-14, so the suite runs on Vulcan (Pro and up), the router-served paid
// tier that remains enforceable. The behaviour under test is unchanged.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { approveLumenStages } from "./lumen-approvals.js";

// The real /api/chat routes and generateChat handler on an in-memory database,
// with only the upstream model providers faked. Registry rows below are TEST
// FIXTURES (active, approved, priced); they say nothing about production data.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
const schema = await import("../src/db/schema.js");
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { getActiveHeartbeatTimerCount, clearAllHeartbeatTimers } = await import("../src/models/execution-coordinator.js");
const { getAllowanceSummary } = await import("../src/usage/allowance-summary.js");
// The suite's account is on Pro (Vulcan's plan), so amounts are read from Pro's allowance rather than written by hand.
const { PLAN_ALLOWANCES } = await import("../src/usage/allowance-service.js");
const ALLOWANCE = PLAN_ALLOWANCES.pro.monthlyAllowanceMicros;
const gateway = await import("../src/chat/allowance-gateway.js");

config.moderationApiKey = "";
config.providerKeys.primaryFree = "fixture-key";
config.providerKeys.paid = "fixture-key";
config.chatModels.vesper = "fixture/vesper-model";
config.chatModels.lumen = "fixture/lumen-model";
approveLumenStages(config);

const PERIOD_START = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
const REPLY = "Here is your answer.";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const encoder = new TextEncoder();
const reservedId = (n) => `gen-fixture-${n}`;
// The content-safety classifier is platform overhead; it is not the customer's model call.
const isClassifier = (request) => String(request.messages?.[0]?.content ?? "").startsWith("You are a strict content-safety classifier");
const customerRequests = (requests) => requests.filter((request) => !isClassifier(request));

// --- Fixture registry (test only) ----------------------------------------
async function seedRegistry() {
  const [vesperFamily] = await db.insert(schema.modelFamilies).values({ slug: "vibhavgpt/vesper", displayName: "VibhavGPT Vulcan", familyGroup: "native", sortOrder: 20 }).returning();
  const [vesperVersion] = await db.insert(schema.modelVersions).values({
    familyId: vesperFamily.id, versionTag: "fixture/vesper-model", aliases: ["vesper"], planEligibility: "paid", lifecycleState: "active",
    capabilitiesDocumented: { vision: true, tools: true, streaming: true, structuredOutputs: true },
  }).returning();
  const [vesperEndpoint] = await db.insert(schema.modelEndpoints).values({
    versionId: vesperVersion.id, providerName: "paid", transportType: "router", adapterType: "chat_completions",
    endpointUrl: "https://router.test/api/v1", endpointState: "active", sortPriority: 1,
    capabilitiesVerified: { vision: true, tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
  }).returning();
  await db.insert(schema.modelPricingSnapshots).values({
    endpointId: vesperEndpoint.id, pricingVersionId: "fixture_vesper_v1", effectiveFrom: new Date("2026-01-01"),
    inputPriceMicrosPerM: 174_000, outputPriceMicrosPerM: 586_000, cachedReadPriceMicrosPerM: 18_000,
    consumptionCategory: "low", pricingConfidence: "verified", provenance: "test_fixture",
  });

  const [lumenFamily] = await db.insert(schema.modelFamilies).values({ slug: "vibhavgpt/lumen", displayName: "VibhavGPT Lumen", familyGroup: "native", sortOrder: 10 }).returning();
  const [lumenVersion] = await db.insert(schema.modelVersions).values({
    familyId: lumenFamily.id, versionTag: "fixture/lumen-model", aliases: ["lumen"], planEligibility: "free", lifecycleState: "active",
    capabilitiesDocumented: { vision: false, tools: true, streaming: true },
  }).returning();
  const [lumenEndpoint] = await db.insert(schema.modelEndpoints).values({
    versionId: lumenVersion.id, providerName: "primaryFree", transportType: "primaryFree", adapterType: "chat_completions",
    endpointUrl: "https://primary.test/v1", endpointState: "active", sortPriority: 1,
    capabilitiesVerified: { tools: true, streaming: true },
    privacyReview: { privacyApproved: true, scope: "default", zeroDataRetention: true, trainingPolicy: "denied" },
  }).returning();
  await db.insert(schema.modelPricingSnapshots).values({
    endpointId: lumenEndpoint.id, pricingVersionId: "fixture_lumen_v1", effectiveFrom: new Date("2026-01-01"),
    inputPriceMicrosPerM: 0, outputPriceMicrosPerM: 0, cachedReadPriceMicrosPerM: 0,
    consumptionCategory: "low", pricingConfidence: "verified", provenance: "test_fixture",
  });
  return { vesperEndpoint };
}
const { vesperEndpoint } = await seedRegistry();
const setVesperApproved = (approved) => client.query(
  `UPDATE model_endpoints SET privacy_review = jsonb_set(privacy_review, '{privacyApproved}', $1::jsonb) WHERE id = $2`, [JSON.stringify(approved), vesperEndpoint.id]);

async function addUser(userId, tier = "pro") { // Vulcan (the enforced tier here) is Pro and up
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({ userId, tier, status: "active", currentPeriodStartedAt: PERIOD_START, currentPeriodEndsAt: PERIOD_END });
  }
}
let settledSeq = 0;
async function spend(userId, micros) {
  settledSeq += 1;
  await db.insert(schema.shadowCostLedger).values({
    userId, requestId: `seed_${settledSeq}`, attemptNumber: 1, operation: "inference", modelKey: "vibhavgpt/vesper", pricingVersionId: "fixture_vesper_v1",
    pricingSource: "test", reservedCostMicros: 0, settledCostMicros: micros, status: "settled", idempotencyKey: `seed_key_${settledSeq}`,
  });
}

// --- Upstream fakes --------------------------------------------------------
let upstream = { paid: [], primaryFree: [] };
let paidRequests = [];
let lumenRequests = [];
let generation = { status: 400, body: "{}" };
const usageChunk = ({ prompt = 1000, completion = 500, cost, id = reservedId(1) } = {}) => ({
  id, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: prompt, completion_tokens: completion, ...(cost === undefined ? {} : { cost }) },
});
const answer = (options = {}) => () => new Response([{ id: options.id ?? reservedId(1), choices: [{ delta: { content: options.text ?? REPLY } }] }, usageChunk(options)].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const toolCall = (options = {}) => () => new Response([
  { id: reservedId(2), choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "utc_time", arguments: "{}" } }] } }] },
  { id: reservedId(2), choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: options.prompt ?? 800, completion_tokens: options.completion ?? 20, cost: options.cost ?? 0.0002 } },
].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const rejected = (status = 503) => () => new Response("", { status });
const dropsAfterStart = () => () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(frame({ id: reservedId(3), choices: [{ delta: { content: "Partial" } }] })));
    setTimeout(() => controller.error(new Error("connection dropped")), 20);
  },
}), { headers: { "Content-Type": "text/event-stream" } });
const hangsUntilAborted = () => (init) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(frame({ id: reservedId(4), choices: [{ delta: { content: "Partial" } }] })));
    init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
  },
}), { headers: { "Content-Type": "text/event-stream" } });

function fakeFetch(realFetch) {
  return async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response(generation.body, { status: generation.status });
      paidRequests.push(JSON.parse(init.body));
      return (upstream.paid.shift() ?? answer({ cost: 0.0003 }))(init);
    }
    if (href.startsWith(config.providerBaseUrls.primaryFree)) {
      lumenRequests.push(JSON.parse(init.body));
      return (upstream.primaryFree.shift() ?? answer())(init);
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
}

async function serve(t, userId) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(realFetch);
  upstream = { paid: [], primaryFree: [] };
  paidRequests = [];
  lumenRequests = [];
  generation = { status: 400, body: "{}" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; clearAllHeartbeatTimers(); return new Promise((resolve) => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, realFetch };
}
function enforce(t, { tiers = ["vesper"], activatedAt = new Date("2026-01-01T00:00:00Z"), on = true } = {}) {
  const original = [config.featureChatAllowanceEnforcement, config.chatAllowanceActivatedAt, config.chatAllowanceEnforcedTiers];
  config.featureChatAllowanceEnforcement = on;
  config.chatAllowanceActivatedAt = activatedAt;
  config.chatAllowanceEnforcedTiers = tiers;
  t.after(() => { [config.featureChatAllowanceEnforcement, config.chatAllowanceActivatedAt, config.chatAllowanceEnforcedTiers] = original; });
}
const parseEvents = (text) => text.split("\n\n").map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1],
})).filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
async function stream(base, body, signal) {
  const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "vesper", ...body }), signal });
  return parseEvents(await response.text());
}
const eventOf = (events, name) => events.find((item) => item.event === name)?.data;
const ledger = async (userId) => (await client.query(
  `SELECT request_id, status, reserved_cost_micros, settled_cost_micros, raw_cost_micros, metadata FROM shadow_cost_ledger WHERE user_id = $1 AND request_id NOT LIKE 'seed_%' ORDER BY request_id`, [userId])).rows;
const legacyEvents = async (userId) => (await client.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [userId])).rows[0].n;
const messageRows = async (userId) => (await client.query(
  `SELECT m.role FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1`, [userId])).rows;
async function waitFor(check, { tries = 120, delay = 50 } = {}) {
  for (let i = 0; i < tries; i += 1) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, delay)); }
  return null;
}

// --------------------------------------------------------------------------

test("enforcement is decided by gate, cutover time, tier and plan, and defaults to off", () => {
  const base = { featureChatAllowanceEnforcement: true, chatAllowanceActivatedAt: new Date("2026-06-01T00:00:00Z"), chatAllowanceEnforcedTiers: ["vesper"] };
  const now = new Date("2026-10-01T00:00:00Z");
  const decide = (over = {}) => gateway.chatAllowanceEnforcement({ modelKey: "vesper", plan: "plus", now, settings: { ...base, ...over } });
  assert.deepEqual(decide(), { enforced: true, reason: "enforced" });
  assert.equal(decide({ featureChatAllowanceEnforcement: false }).reason, "gate_off");
  assert.equal(decide({ chatAllowanceActivatedAt: null }).reason, "before_cutover");
  assert.equal(decide({ chatAllowanceActivatedAt: new Date("2026-12-01T00:00:00Z") }).reason, "before_cutover", "no retroactive or early enforcement");
  assert.equal(decide({ chatAllowanceEnforcedTiers: [] }).reason, "tier_not_enforced");
  assert.equal(gateway.chatAllowanceEnforcement({ modelKey: "zenith", plan: "plus", now, settings: base }).reason, "tier_not_enforced");
  assert.equal(gateway.chatAllowanceEnforcement({ modelKey: "vesper", plan: "free", now, settings: base }).reason, "plan_not_subscribed");
  assert.equal(gateway.chatAllowanceEnforcement({ modelKey: "lumen", plan: "pro", now, settings: base }).reason, "tier_not_enforced", "the approved free model is never enforced");
  const fresh = { featureChatAllowanceEnforcement: false, chatAllowanceActivatedAt: null, chatAllowanceEnforcedTiers: [] };
  assert.equal(gateway.chatAllowanceEnforcement({ modelKey: "vesper", plan: "pro", now, settings: fresh }).enforced, false);
});

test("settlement usage: router tiers need a provider-reported cost; estimates and missing counts stay uncertain", () => {
  const withCost = { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 };
  assert.deepEqual(gateway.settlementUsage(withCost, { reportsCost: true }), { ...withCost, costBasis: "provider_reported" });
  assert.equal(gateway.settlementUsage({ prompt_tokens: 10, completion_tokens: 5 }, { reportsCost: true }), null, "tokens alone are not billed on a router tier");
  assert.equal(gateway.settlementUsage({ prompt_tokens: 10, completion_tokens: 5, cost: -1 }, { reportsCost: true }), null);
  assert.equal(gateway.settlementUsage({ prompt_tokens: 10 }, { reportsCost: false }), null, "missing completion count");
  assert.equal(gateway.settlementUsage({ prompt_tokens: 10, completion_tokens: 5, estimated: true }, { reportsCost: false }), null, "estimates are never settled");
  assert.deepEqual(gateway.settlementUsage({ prompt_tokens: 10, completion_tokens: 5 }, { reportsCost: false }), { prompt_tokens: 10, completion_tokens: 5 });
});

test("gate off: the existing path runs unchanged (legacy usage recorded, no allowance rows)", async (t) => {
  const userId = "legacy-user";
  await addUser(userId);
  enforce(t, { on: false });
  const { base } = await serve(t, userId);
  const events = await stream(base, { message: "Hello there" });
  assert.equal(eventOf(events, "complete")?.reply, REPLY);
  assert.equal((await ledger(userId)).length, 0, "no allowance reservation without the gate");
  assert.equal(await legacyEvents(userId), 1, "the legacy token accounting still records the request");
});

test("before the cutover time the legacy path is used and nothing is charged retroactively", async (t) => {
  const userId = "precutover-user";
  await addUser(userId);
  enforce(t, { activatedAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  const { base } = await serve(t, userId);
  const events = await stream(base, { message: "Hello" });
  assert.ok(eventOf(events, "complete"));
  assert.equal((await ledger(userId)).length, 0);
  assert.equal(await legacyEvents(userId), 1);
});

test("enforced request: reserved, dispatched and settled once at the provider-reported cost, with no second accounting", async (t) => {
  const userId = "enforced-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  upstream.paid.push(answer({ cost: 0.000321, prompt: 1000, completion: 500 }));
  const events = await stream(base, { message: "Explain photosynthesis briefly." });

  const complete = eventOf(events, "complete");
  assert.equal(complete.reply, REPLY);
  assert.equal(eventOf(events, "error"), undefined);
  assert.equal(paidRequests.length, 1);
  assert.equal(paidRequests[0].provider.data_collection, "deny", "the pinned privacy routing is unchanged");
  assert.ok(paidRequests[0].max_tokens > 0);

  const rows = await ledger(userId);
  assert.equal(rows.length, 1, "exactly one allowance row for one upstream call");
  assert.match(rows[0].request_id, /^[0-9a-f-]{36}:g1$/);
  assert.equal(rows[0].status, "settled");
  assert.equal(rows[0].settled_cost_micros, 321, "the reported $0.000321 is exactly 321 micro-dollars");
  assert.equal(rows[0].reserved_cost_micros, 0, "the hold is released into the settlement");
  assert.equal(rows[0].metadata.costBasis, "provider_reported");
  assert.equal(JSON.stringify(rows[0]).includes(REPLY), false, "the reply text is not copied into the ledger");
  assert.equal(await legacyEvents(userId), 0, "legacy token accounting is not applied on top");

  const summary = await getAllowanceSummary({ userId, db });
  assert.equal(summary.allowance.confirmedMicros, 321);
  assert.equal(summary.allowance.pendingMicros, 0);
  assert.equal(summary.allowance.availableMicros, ALLOWANCE - 321);
  assert.equal(getActiveHeartbeatTimerCount(), 0, "no lease timers are left running");
});

test("tool loop: multiple calls per turn are each accounted once; the raw reply never reaches the client", async (t) => {
  const userId = "toolloop-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  upstream.paid.push(toolCall({ cost: 0.0002 }), answer({ cost: 0.0004, prompt: 900, completion: 40 }));
  const events = await stream(base, { message: "Please check the clock and answer." });

  assert.equal(eventOf(events, "complete")?.reply, REPLY);
  assert.equal(paidRequests.length, 2, "one upstream call for the tool request, one for the answer");
  const second = paidRequests[1].messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 40) : ""}`).join("|");
  assert.match(second, /tool|Trusted server tool result/, "the internal tool result reached the second call");

  const rows = await ledger(userId);
  assert.deepEqual(rows.map((row) => row.request_id.split(":")[1]), ["g1", "t1"], "generation and tool-response calls are attributed separately");
  assert.deepEqual(rows.map((row) => row.settled_cost_micros), [200, 400]);
  const summary = await getAllowanceSummary({ userId, db });
  assert.equal(summary.allowance.confirmedMicros, 600, "the turn's two calls are charged once each");

  const wire = JSON.stringify(events);
  assert.doesNotMatch(wire, /tool_calls|call_1|"usage"|cost|fixture\/nova-model|router\.test|data_collection/, "no raw provider data is exposed");
});

test("a provider reply without a cost leaves the hold uncertain: the reply is delivered, nothing is invented", async (t) => {
  const userId = "nocost-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  upstream.paid.push(answer({ prompt: 1000, completion: 500 }));
  const events = await stream(base, { message: "Hello" });
  assert.equal(eventOf(events, "complete")?.reply, REPLY);
  const rows = await ledger(userId);
  assert.equal(rows[0].status, "uncertain");
  assert.equal(rows[0].settled_cost_micros, null, "no charge is invented");
  const summary = await getAllowanceSummary({ userId, db });
  assert.equal(summary.allowance.confirmedMicros, 0, "an uncertain operation is not shown as final spending");
  assert.ok(summary.allowance.pendingMicros > 0, "it stays visible as pending");
});

test("disconnect with late usage: the stream is cancelled, final usage is collected under a bounded lookup and settled", async (t) => {
  const userId = "disconnect-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  generation = { status: 200, body: JSON.stringify({ data: { finish_reason: "stop", native_tokens_prompt: 700, native_tokens_completion: 20, total_cost: 0.000099 } }) };
  upstream.paid.push(hangsUntilAborted());
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ model: "vesper", message: "Write a long story." }) });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("Partial")) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();

  const settled = await waitFor(async () => (await ledger(userId)).find((row) => row.status === "settled"));
  assert.ok(settled, "the late usage was collected and settled");
  assert.equal(settled.settled_cost_micros, 99);
  assert.equal(settled.metadata.isPartial, true);
  assert.equal(settled.metadata.costBasis, "provider_reported");
  assert.equal(paidRequests.length, 1, "nothing was sent again");
  assert.equal(await waitFor(async () => getActiveHeartbeatTimerCount() === 0), true, "lease timers stop on every path");
});

test("disconnect with no obtainable usage stays uncertain: no charge, no release, a reconciliation path remains", async (t) => {
  const userId = "disconnect-unknown-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  generation = { status: 400, body: "{}" };
  upstream.paid.push(hangsUntilAborted());
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ model: "vesper", message: "Write a long story." }) });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("Partial")) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();

  const uncertain = await waitFor(async () => (await ledger(userId)).find((row) => row.status === "uncertain"));
  assert.ok(uncertain, "the operation is retained as uncertain");
  assert.equal(uncertain.settled_cost_micros, null);
  const summary = await getAllowanceSummary({ userId, db });
  assert.equal(summary.allowance.confirmedMicros, 0);
  assert.ok(summary.allowance.pendingMicros > 0, "the hold is not released on a timer");
  assert.equal(await waitFor(async () => getActiveHeartbeatTimerCount() === 0), true);
});

test("retry rules: a rejection before any inference is retried; a failure after the request started is never resent", async (t) => {
  const userId = "retry-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);

  upstream.paid.push(rejected(503), answer({ cost: 0.0001 }));
  let events = await stream(base, { message: "First question" });
  assert.equal(eventOf(events, "complete")?.reply, REPLY);
  assert.equal(paidRequests.length, 2, "zero billable usage was established, so one more attempt was allowed");
  let rows = await ledger(userId);
  assert.deepEqual(rows.map((row) => row.status).sort(), ["released", "settled"]);

  upstream.paid.length = 0;
  paidRequests = [];
  upstream.paid.push(dropsAfterStart());
  events = await stream(base, { message: "Second question" });
  assert.ok(eventOf(events, "error"), "the failure is reported");
  assert.equal(paidRequests.length, 1, "no automatic redispatch after a possibly billed request");
  rows = await ledger(userId);
  assert.equal(rows.filter((row) => row.status === "uncertain").length, 1, "the unknown operation keeps its hold");
});

test("exhaustion is refused before anything is saved or sent; the customer then explicitly chooses the included model", async (t) => {
  const userId = "exhausted-user";
  await addUser(userId);
  await spend(userId, ALLOWANCE);
  enforce(t);
  const { base } = await serve(t, userId);

  const events = await stream(base, { message: "Can I still use Vulcan?" });
  const failure = eventOf(events, "error");
  assert.equal(failure.code, "allowance_exceeded");
  assert.equal(failure.status, 429);
  assert.equal(failure.allowance.paidModelRestricted, true);
  assert.ok(Date.parse(failure.allowance.resetAt) > Date.now());
  assert.deepEqual(failure.allowance.freeChoices.map((choice) => [choice.modelKey, choice.available]), [["lumen", true]]);
  assert.equal(paidRequests.length + customerRequests(lumenRequests).length, 0, "rejected before any dispatch, with no automatic switch to another model");
  assert.equal((await messageRows(userId)).length, 0, "nothing was saved or sent on the customer's behalf");
  assert.equal((await ledger(userId)).length, 0);

  // The customer explicitly selects the included model; it needs no remaining allowance.
  const free = await stream(base, { model: "lumen", message: "Can I still use Vulcan?" });
  assert.equal(eventOf(free, "complete")?.reply, REPLY);
  assert.equal(customerRequests(lumenRequests).length, 1);
  assert.equal(paidRequests.length, 0, "no paid fallback");
  const summary = await getAllowanceSummary({ userId, db });
  assert.equal(summary.allowance.confirmedMicros, ALLOWANCE, "included-model use does not touch the paid allowance");
  assert.equal(summary.paidUsage.reason, "allowance_exhausted");
});

test("allowance running out mid-turn: the next call is rejected before dispatch and nothing is resent", async (t) => {
  const userId = "midturn-user";
  await addUser(userId);
  await spend(userId, ALLOWANCE - 2_600);
  enforce(t);
  const { base } = await serve(t, userId);
  // Call 1 reports more than its hold, so it settles at the hold (no customer debt).
  upstream.paid.push(toolCall({ cost: 0.01 }), answer({ cost: 0.0004 }));
  const events = await stream(base, { message: "Please check the clock and answer." });
  assert.equal(eventOf(events, "error")?.code, "allowance_exceeded");
  assert.equal(eventOf(events, "complete"), undefined);
  assert.equal(paidRequests.length, 1, "the second call never reached the provider");
  const rows = await ledger(userId);
  assert.deepEqual(rows.map((row) => row.status), ["settled"]);
  assert.equal(rows[0].settled_cost_micros, rows[0].metadata.authorizedReservedCostMicros, "capped at the hold; never negative");
  assert.equal(rows[0].metadata.platformAbsorbedOverrun, true, "the platform absorbs the overrun, not the customer");
  const summary = await getAllowanceSummary({ userId, db });
  assert.ok(summary.allowance.availableMicros >= 0);
});

test("fail closed: an endpoint without privacy approval is refused with no legacy fallback", async (t) => {
  const userId = "unapproved-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  await setVesperApproved(false);
  t.after(() => setVesperApproved(true));
  const events = await stream(base, { message: "Hello" });
  const failure = eventOf(events, "error");
  assert.equal(failure.code, "inference-unavailable");
  assert.equal(failure.status, 503);
  assert.equal(paidRequests.length, 0, "no request was sent through any path");
  assert.equal(await legacyEvents(userId), 0);
  assert.equal((await ledger(userId)).length, 0);
});

test("a replayed request id is never dispatched twice", async (t) => {
  const userId = "duplicate-user";
  await addUser(userId);
  const { realFetch } = await serve(t, userId);
  const requestId = "00000000-0000-4000-8000-0000000000aa";
  const run = () => gateway.createChatAllowanceGateway({ userId, requestId, modelKey: "vesper", plan: "plus", db, fetchImpl: globalThis.fetch })
    .call({ purpose: "generation", messages: [{ role: "user", content: "hi" }], tools: undefined, stream: true, options: { maxTokens: 400, onDelta: () => true, idleTimeoutMs: 2000 } });
  upstream.paid.push(answer({ cost: 0.0001 }));
  const first = await run();
  assert.equal(first.data.choices[0].message.content, REPLY);
  await assert.rejects(run(), (error) => error.code === "inference-unavailable");
  assert.equal(paidRequests.length, 1);
  assert.equal(realFetch !== undefined, true);
});

test("accounts are isolated and each resets with its own subscription period", async (t) => {
  const alpha = "iso-alpha";
  const beta = "iso-beta";
  await addUser(alpha, "max");
  await addUser(beta, "plus");
  enforce(t);
  const { base } = await serve(t, alpha);
  upstream.paid.push(answer({ cost: 0.001 }));
  await stream(base, { message: "Alpha question" });
  const a = await getAllowanceSummary({ userId: alpha, db });
  const b = await getAllowanceSummary({ userId: beta, db });
  assert.equal(a.allowance.includedMicros, 30_000_000);
  assert.equal(a.allowance.confirmedMicros, 1_000);
  assert.equal(b.allowance.confirmedMicros, 0, "another account's usage never affects this one");
  assert.equal((await ledger(beta)).length, 0);

  const nextPeriod = new Date(PERIOD_END.getTime() + 24 * 60 * 60 * 1000);
  await db.update(schema.subscriptions).set({ currentPeriodEndsAt: new Date(nextPeriod.getTime() + 30 * 24 * 60 * 60 * 1000) }).where(sql`user_id = ${alpha}`);
  const later = await getAllowanceSummary({ userId: alpha, db, now: nextPeriod });
  assert.equal(later.allowance.confirmedMicros, 0, "a new monthly entitlement period starts with the full allowance");
  assert.equal(later.allowance.availableMicros, 30_000_000);
});

test("platform overhead is recorded as overhead and never touches the allowance", async () => {
  const { accountingClassFor, ACCOUNTING_CLASSES } = await import("../src/usage/shadow-ledger.js");
  for (const operation of ["moderation", "search_intent", "image_prompt_rewrite", "memory_extraction"]) {
    assert.equal(accountingClassFor(operation), ACCOUNTING_CLASSES.PLATFORM_OVERHEAD, operation);
  }
  assert.equal(accountingClassFor("chat_stream"), ACCOUNTING_CLASSES.CUSTOMER_USAGE);
  const source = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  const gatewaySource = await readFile(new URL("../src/chat/allowance-gateway.js", import.meta.url), "utf8");
  assert.doesNotMatch(gatewaySource, /from "\.\.\/(memory|search)\/|from "\.\/moderation\.js"|callSearchIntentModel|callImagePromptModel/, "helper calls never pass through the customer gateway");
  assert.match(source, /checkModeration\(content, \{ userId, requestId/);
});

test("the gateway returns raw replies only to the internal tool loop, and never an error naming a vendor", async (t) => {
  const userId = "privacy-user";
  await addUser(userId);
  enforce(t);
  const { base } = await serve(t, userId);
  upstream.paid.push(rejected(503), rejected(503), rejected(503));
  const events = await stream(base, { message: "Hello" });
  const wire = JSON.stringify(events);
  assert.doesNotMatch(wire, /examplevendor|example router|fixturemodel|router\.test|primary\.test|fixture\/nova-model|openrouter/i);
  assert.equal(eventOf(events, "error")?.code, "inference-unavailable");
});

test("the summary reports enforcement per account: only models that truly consume the allowance, only when ready", async (t) => {
  const userId = "summary-enforcement-user";
  await addUser(userId, "pro");
  const on = { featureChatAllowanceEnforcement: true, chatAllowanceActivatedAt: new Date("2026-01-01T00:00:00Z"), chatAllowanceEnforcedTiers: ["nova", "vesper"] };

  const connected = await getAllowanceSummary({ userId, db, settings: on });
  assert.equal(connected.enforcementConnected, true);
  assert.deepEqual(connected.enforcedModels, [{ modelKey: "vesper", displayName: "VibhavGPT Vulcan" }], "vesper is listed but has no eligible endpoint, so it is not claimed");

  assert.equal((await getAllowanceSummary({ userId, db, settings: { ...on, featureChatAllowanceEnforcement: false } })).enforcementConnected, false, "gate off");
  assert.equal((await getAllowanceSummary({ userId, db, settings: { ...on, chatAllowanceActivatedAt: new Date(Date.now() + 86_400_000) } })).enforcementConnected, false, "before the cutover");
  assert.equal((await getAllowanceSummary({ userId, db, settings: { ...on, chatAllowanceEnforcedTiers: [] } })).enforcementConnected, false, "no tier listed");

  await setVesperApproved(false);
  t.after(() => setVesperApproved(true));
  assert.equal((await getAllowanceSummary({ userId, db, settings: on })).enforcementConnected, false, "an unapproved endpoint is never claimed as enforced");

  const free = "summary-enforcement-free";
  await addUser(free, "free");
  assert.deepEqual((await getAllowanceSummary({ userId: free, db, settings: on })).enforcedModels, []);
});

test("enforcement follows the deployment's Vulcan transport: a router-only registry is enforced only while Vulcan is configured for the router", async (t) => {
  const userId = "transport-follow-user";
  await addUser(userId, "pro");
  const on = { featureChatAllowanceEnforcement: true, chatAllowanceActivatedAt: new Date("2026-01-01T00:00:00Z"), chatAllowanceEnforcedTiers: ["vesper"] };
  const original = config.vesperTransport;
  t.after(() => { config.vesperTransport = original; });
  config.vesperTransport = "router";
  assert.deepEqual((await getAllowanceSummary({ userId, db, settings: on })).enforcedModels.map((m) => m.modelKey), ["vesper"]);
  // Configured for the direct transport, the router endpoint is not used for Vulcan, and nothing claims it is enforced.
  config.vesperTransport = "direct";
  assert.deepEqual((await getAllowanceSummary({ userId, db, settings: on })).enforcedModels, []);
  enforce(t);
  const { base } = await serve(t, userId);
  const events = await stream(base, { message: "Hello" });
  assert.equal(eventOf(events, "error")?.code, "inference-unavailable", "no other route is used instead");
  assert.equal(paidRequests.length, 0, "nothing was sent to the router");
});
