/**
 * Slice 4: Lumen chat on the router's free endpoint, pinned to one provider, with the live policy guard. The real chat route on an
 * isolated database; the router and the policy sources are scripted stand-ins. The golden fixtures in test/fixtures/lumen-gateway are
 * the public endpoints JSON and an excerpt of the public providers page as fetched on 2026-11-11, so the guard's acceptance case is
 * reproducible offline. Nothing here reaches a real provider.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const MODEL = "google/gemma-4-31b-it:free";
const PROVIDER = "Google AI Studio";
const ENDPOINTS = JSON.parse(await readFile(new URL("./fixtures/lumen-gateway/endpoints.json", import.meta.url), "utf8"));
const PAGE = await readFile(new URL("./fixtures/lumen-gateway/providers-page.html", import.meta.url), "utf8");

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.paid = "fixture-router-key";
config.providerBaseUrls.paid = "http://router.fixture.invalid/api/v1";
const PRIMARY_BASE = "http://primary.fixture.invalid/v1";
config.providerKeys.primaryFree = "fixture-primary-key";
config.providerBaseUrls.primaryFree = PRIMARY_BASE;
config.lumenPrimaryApproved = true;
config.memoryExtractionModel = "";
Object.assign(config.chatModels, { lumen: "fixture-primary-lumen", lumenFallback1: MODEL, vesper: "fixture-vesper", nova: "fixture-nova" });
config.routeProviders.nova = ["route-a"];
config.vesperTransport = "router";
config.lumenApprovals.gateway = { approved: true, model: MODEL };
config.lumenGatewayProvider = PROVIDER;
config.lumenChatRoute = "gateway";

const guard = await import("../src/chat/lumen-gateway-guard.js");
const { inferencePolicyReport } = await import("../src/chat/policy-report.js");
const { inferenceUserHash } = await import("../src/chat/providers.js");

// Policy sources: tests swap these to simulate drift.
let endpointsDoc = ENDPOINTS;
let pageDoc = PAGE;
let policyFetchFails = false;
const policyFetch = async (url) => {
  if (policyFetchFails) return new Response("upstream down", { status: 503 });
  if (String(url).endsWith("/endpoints")) return Response.json(endpointsDoc);
  if (String(url).endsWith("/providers")) return new Response(pageDoc, { headers: { "Content-Type": "text/html" } });
  return new Response("not found", { status: 404 });
};
const logs = [];
const log = { info: (line) => logs.push(line), warn: (line) => logs.push(line) };
const verify = () => guard.verifyLumenGatewayPolicy({ model: MODEL, provider: PROVIDER, fetchImpl: policyFetch, log });

// Upstream chat: every request is recorded with the route it went to.
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const usage = { prompt_tokens: 30, completion_tokens: 8 };
const upstream = [];
let routerFailure = null;
let vesperFailure = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid) || href.startsWith(PRIMARY_BASE)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(init.body);
    upstream.push({ route: href.startsWith(PRIMARY_BASE) ? "primary" : "router", body });
    if (routerFailure && href.startsWith(config.providerBaseUrls.paid) && body.model === MODEL) return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), { status: routerFailure });
    if (vesperFailure && body.model === "fixture-vesper") return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), { status: vesperFailure });
    const reply = `Reply from ${body.model}.`;
    if (body.stream === false || body.stream === undefined) return Response.json({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage });
    return new Response([frame({ choices: [{ delta: { content: reply } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage })].join(""), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
let signedIn = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (signedIn) req.authSession = { user: { id: signedIn } }; next(); });
app.use("/api/chat", chatRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
test.after(async () => { globalThis.fetch = realFetch; guard.stopLumenGatewayGuard(); await new Promise((resolve) => server.close(resolve)); await client.close(); });

let n = 0;
async function person(tier = "free") {
  const id = `gateway-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled, memory_save_enabled) VALUES ($1, false, false) ON CONFLICT DO NOTHING", [id]);
  if (tier !== "free") await client.query("INSERT INTO subscriptions (user_id, tier, status, current_period_started_at, current_period_ends_at, billing_source) VALUES ($1, $2, 'active', now() - interval '5 days', now() + interval '25 days', 'stripe')", [id, tier]);
  return id;
}
async function say(userId, body) {
  signedIn = userId;
  const before = upstream.length;
  const response = await realFetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const raw = await response.text();
  const events = raw.split("\n\n").map((b) => ({ event: b.match(/^event:\s*(.+)$/m)?.[1], data: b.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
  return { error: events.find((e) => e.event === "error")?.data, done: events.find((e) => e.event === "complete")?.data, sent: upstream.slice(before) };
}

test("the golden fixture (today's live policy) verifies: provider serves it, it is free, training is false", async () => {
  const result = guard.evaluateLumenGatewayPolicy({ endpointsJson: ENDPOINTS, providersHtml: PAGE, model: MODEL, provider: PROVIDER });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.evidence.endpoint.provider_name, PROVIDER);
  assert.deepEqual(result.evidence.endpoint.pricing, { prompt: "0", completion: "0", discount: 0 });
  assert.equal(result.evidence.dataPolicy.training, false);
  assert.equal(result.evidence.dataPolicy.retainsPrompts, true);
  assert.equal(result.evidence.dataPolicy.retentionDays, 55);
});

const pricedEndpoints = () => ({ data: { ...ENDPOINTS.data, endpoints: ENDPOINTS.data.endpoints.map((e) => ({ ...e, pricing: { ...e.pricing, prompt: "0.0000002" } })) } });
const otherProvider = () => ({ data: { ...ENDPOINTS.data, endpoints: ENDPOINTS.data.endpoints.map((e) => ({ ...e, provider_name: "Another Host" })) } });
const trainingPage = () => PAGE.replace(/(dataPolicy\\":\{\\"training\\":)false/, "$1true");
for (const [name, setup, reason] of [
  ["the policy says training: true", () => { pageDoc = trainingPage(); }, "training-not-false"],
  ["the pinned provider no longer serves the model", () => { endpointsDoc = otherProvider(); }, "provider-not-serving"],
  ["the endpoint is no longer free", () => { endpointsDoc = pricedEndpoints(); }, "endpoint-not-free"],
  ["the policy is missing from the page", () => { pageDoc = "<html>no policy here</html>"; }, "policy-not-found"],
  ["the policy sources cannot be fetched", () => { policyFetchFails = true; }, "policy-fetch-failed"],
]) {
  test(`gateway OFF when ${name}: the log says why, and no Lumen chat request is attempted`, async () => {
    endpointsDoc = ENDPOINTS; pageDoc = PAGE; policyFetchFails = false;
    setup();
    logs.length = 0;
    const result = await verify();
    endpointsDoc = ENDPOINTS; pageDoc = PAGE; policyFetchFails = false;
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    const line = JSON.parse(logs.at(-1));
    assert.equal(line.event, "lumen_gateway_policy");
    assert.equal(line.approved, false);
    assert.equal(line.reason, reason, "the log names the condition that flipped");
    const stage = inferencePolicyReport().lumenStages.find((s) => s.stage === "gatewayFree");
    assert.equal(stage.approved, false);
    assert.equal(stage.reason, `policy-${reason}`);
    assert.equal(inferencePolicyReport().lumenAvailable, false);
    const turn = await say(await person(), { model: "lumen", message: "Hello there." });
    assert.ok(turn.error, "Lumen answers with the unavailable state");
    assert.deepEqual(turn.sent.filter((s) => s.body.model === MODEL || s.route === "primary"), [], "zero chat requests to the gateway or anywhere else for Lumen");
    assert.equal(turn.sent.length, 0, "no fallback to another tier either");
  });
}

test("production defaults to the gateway route; only an explicit CHAT_LUMEN_ROUTE=staged restores the old chain", async () => {
  const { lumenChatRouteFrom } = await import("../src/config.js");
  assert.equal(lumenChatRouteFrom({}), "gateway");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: "" }), "gateway");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: "anything-else" }), "gateway");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: "staged" }), "staged");
});

test("before the first check, and after the result goes stale, the gateway is closed", async () => {
  guard.resetLumenGatewayGuardForTests();
  assert.equal(guard.lumenGatewayPolicyState({ model: MODEL, provider: PROVIDER }).verified, false);
  await verify();
  assert.equal(guard.lumenGatewayPolicyState({ model: MODEL, provider: PROVIDER }).verified, true);
  assert.equal(guard.lumenGatewayPolicyState({ model: MODEL, provider: PROVIDER, now: Date.now() + guard.GUARD_MAX_AGE_MS + 1 }).reason, "stale");
  assert.equal(guard.lumenGatewayPolicyState({ model: "some/other-model:free", provider: PROVIDER }).verified, false, "a different configured model is not verified");
});

test("every Lumen chat request is pinned: order [provider], allow_fallbacks false, no data_collection; pseudonymous user; no tools or reasoning", async () => {
  await verify();
  const report = inferencePolicyReport();
  assert.equal(report.lumenAvailable, true);
  assert.equal(report.lumenStages.find((s) => s.stage === "gatewayFree").approved, true);
  assert.equal(JSON.parse(logs.at(-1)).approved, true);
  assert.equal(JSON.parse(logs.at(-1)).evidence.dataPolicy.training, false, "the log carries the policy evidence");
  const a = await person();
  const turn = await say(a, { model: "lumen", message: "What is a prime number?" });
  assert.equal(turn.error, undefined, JSON.stringify(turn.error));
  const chat = turn.sent.filter((s) => Array.isArray(s.body.messages) && s.body.model === MODEL);
  assert.ok(chat.length >= 1);
  for (const { route, body } of chat) {
    assert.equal(route, "router");
    assert.deepEqual(body.provider, { order: [PROVIDER], allow_fallbacks: false });
    assert.equal("data_collection" in body.provider, false);
    assert.equal(body.user, inferenceUserHash(a));
    assert.match(body.user, /^u_[0-9a-f]{32}$/);
    assert.ok(!body.user.includes(a), "never the raw account id");
    assert.equal(body.tools, undefined, "Lumen stays tool-free, as before");
    assert.equal(body.reasoning, undefined);
  }
  assert.equal(turn.sent.filter((s) => s.route === "primary" && s.body.model === config.chatModels.lumen).length, 0, "the old primary chat route is not used for Lumen");
  assert.notEqual(inferenceUserHash(a), inferenceUserHash(await person()), "different accounts get different hashes");
});

for (const status of [503, 429]) {
  test(`an upstream ${status} on the gateway is the unavailable state, with zero attempts anywhere else`, async () => {
    await verify();
    routerFailure = status;
    try {
      // A paying account: on Free every fallback candidate maps back to Lumen, so only a paid plan would ever move tiers.
      const turn = await say(await person("pro"), { model: "lumen", message: "Tell me about rivers." });
      assert.ok(turn.error, "unavailable");
      assert.ok(turn.sent.length >= 1);
      assert.ok(turn.sent.every((s) => s.route === "router" && s.body.model === MODEL && JSON.stringify(s.body.provider) === JSON.stringify({ order: [PROVIDER], allow_fallbacks: false })), `only the pinned gateway was tried: ${JSON.stringify(turn.sent.map((s) => [s.route, s.body.model]))}`);
    } finally {
      routerFailure = null;
    }
  });
}

for (const status of [503, 429]) {
  test(`a Vulcan ${status} is the unavailable state: the message is never re-sent to another tier's route`, async () => {
    await verify();
    config.chatModels.nebula = "fixture-nebula";
    config.routeProviders.nebula = ["route-b"];
    config.nebulaDataPolicyVerified = true;
    vesperFailure = status;
    try {
      const turn = await say(await person("max"), { model: "vesper", message: "A synthetic private question." });
      assert.ok(turn.error, "unavailable");
      assert.ok(turn.sent.length >= 1);
      assert.ok(turn.sent.every((s) => s.body.model === "fixture-vesper"), `only Vulcan's route was tried: ${JSON.stringify(turn.sent.map((s) => s.body.model))}`);
    } finally {
      vesperFailure = null;
    }
  });
}

test("Vulcan is unchanged: no fallbacks and data_collection deny", async () => {
  await verify();
  const turn = await say(await person("max"), { model: "vesper", message: "A synthetic question." });
  assert.equal(turn.error, undefined, JSON.stringify(turn.error));
  for (const { body } of turn.sent) assert.deepEqual(body.provider, { allow_fallbacks: false, data_collection: "deny" });
});
