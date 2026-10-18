import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Data-policy gates: user text goes only to providers whose training and
// retention terms were approved, for the exact model approved. An unapproved
// Lumen stage gets no request at all, and with none approved Lumen fails
// closed. Moderation, search intent, memory extraction and display-name
// review fall back to the local rules when their provider is not approved.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
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
const { callModelStreaming, callModelWithFallback, InferenceUnavailableError, lumenStageApproval, lumenPolicySummary } = await import("../src/chat/providers.js");
const { checkModeration } = await import("../src/chat/moderation.js");
const { interpretSearchIntent } = await import("../src/search/intent.js");
const { extractAndSaveFacts } = await import("../src/memory/service.js");
const { reviewDisplayName } = await import("../src/security/display-name.js");
const { inferencePolicyReport } = await import("../src/chat/policy-report.js");

const STAGES = ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"];
const MODEL_KEYS = { primaryFree: "lumen", gatewayFree: "lumenFallback1", secondaryFree: "lumenFallback2", reserveFree: "lumenFallback3" };
const APPROVAL_KEYS = { gatewayFree: "gateway", secondaryFree: "secondary", reserveFree: "reserve" };
const route = (stage) => `${config.providerBaseUrls[stage]}/chat/completions`;
const messages = [{ role: "user", content: "Reply with OK" }];
const answer = () => Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const streamAnswer = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

// Every stage configured (key, URL, model) and nothing approved: the state of
// a deployment where no data policy has been reviewed yet.
beforeEach(() => {
  for (const stage of STAGES) {
    config.providerKeys[stage] = "fixture-key";
    config.chatModels[MODEL_KEYS[stage]] = `fixture-${stage}`;
  }
  config.lumenPrimaryApproved = false;
  config.lumenApprovals.primaryModel = undefined;
  for (const key of Object.values(APPROVAL_KEYS)) config.lumenApprovals[key] = { approved: false, model: undefined };
  config.moderationApiKey = "";
  config.moderationDataPolicyApproved = false;
  config.moderationApiUrl = `${config.providerBaseUrls.primaryFree}/chat/completions`;
  config.moderationModel = "fixture/moderation";
  config.memoryExtractionModel = "fixture/memory";
  config.searchIntentModel = "fixture/search";
});

const approve = (stage, model = config.chatModels[MODEL_KEYS[stage]]) => {
  if (stage === "primaryFree") config.lumenPrimaryApproved = true;
  else config.lumenApprovals[APPROVAL_KEYS[stage]] = { approved: true, model };
};

for (const [name, call, success] of [["non-streaming", callModelWithFallback, answer], ["streaming", callModelStreaming, streamAnswer]]) {
  test(`${name}: unapproved fallback stages are skipped and receive zero requests`, async () => {
    approve("primaryFree");
    const requests = [];
    await assert.rejects(call("lumen", messages, undefined, { maxRetries: 0, fetchImpl: async (url) => { requests.push(url); return new Response("", { status: 503 }); } }),
      (error) => error instanceof InferenceUnavailableError && error.status === 503);
    assert.deepEqual([...new Set(requests)], [route("primaryFree")], "only the approved primary is asked");
  });

  test(`${name}: an approved, pinned fallback is used; changing its model revokes it`, async () => {
    approve("primaryFree");
    approve("secondaryFree");
    const failPrimary = (requests) => async (url) => { requests.push(url); return url === route("primaryFree") ? new Response("", { status: 503 }) : success(); };

    let requests = [];
    const served = await call("lumen", messages, undefined, { maxRetries: 0, fetchImpl: failPrimary(requests) });
    assert.equal(served.internalStage, "secondaryFree");
    assert.deepEqual([...new Set(requests)], [route("primaryFree"), route("secondaryFree")], "the unapproved gateway is skipped");

    // The configured model changes; the approval still names the old one.
    config.chatModels.lumenFallback2 = "fixture-a-different-model";
    requests = [];
    await assert.rejects(call("lumen", messages, undefined, { maxRetries: 0, fetchImpl: failPrimary(requests) }), InferenceUnavailableError);
    assert.deepEqual([...new Set(requests)], [route("primaryFree")], "the changed stage gets nothing");
    assert.deepEqual(lumenStageApproval("secondaryFree"), { approved: false, reason: "pinned-model-mismatch" });

    // Approving the new model restores it.
    approve("secondaryFree");
    requests = [];
    assert.equal((await call("lumen", messages, undefined, { maxRetries: 0, fetchImpl: failPrimary(requests) })).internalStage, "secondaryFree");
  });

  test(`${name}: with every stage unapproved, Lumen fails closed with 503 and sends nothing`, async () => {
    let requests = 0;
    await assert.rejects(call("lumen", messages, undefined, { fetchImpl: async () => { requests += 1; return success(); } }),
      (error) => error instanceof InferenceUnavailableError && error.status === 503);
    assert.equal(requests, 0);
  });
}

test("a fallback approval without a pinned model is not an approval", () => {
  config.lumenApprovals.gateway = { approved: true, model: undefined };
  assert.deepEqual(lumenStageApproval("gatewayFree"), { approved: false, reason: "model-not-pinned" });
  // The primary's pin is optional, but enforced once it is set.
  approve("primaryFree");
  assert.deepEqual(lumenStageApproval("primaryFree"), { approved: true, reason: "approved-unpinned" });
  config.lumenApprovals.primaryModel = "fixture-some-other-model";
  assert.deepEqual(lumenStageApproval("primaryFree"), { approved: false, reason: "pinned-model-mismatch" });
  config.lumenApprovals.primaryModel = config.chatModels.lumen;
  assert.deepEqual(lumenStageApproval("primaryFree"), { approved: true, reason: "approved" });
});

test("a model the provider picks for itself (auto, auto:free) can never be approved", async () => {
  for (const model of ["auto", "auto:free", "AUTO:FREE", "auto/router"]) {
    config.chatModels.lumenFallback1 = model;
    approve("gatewayFree", model);
    assert.deepEqual(lumenStageApproval("gatewayFree"), { approved: false, reason: "provider-selected-model" }, model);
  }
  approve("primaryFree");
  const requests = [];
  await assert.rejects(callModelWithFallback("lumen", messages, undefined, { maxRetries: 0, fetchImpl: async (url) => { requests.push(url); return new Response("", { status: 503 }); } }));
  assert.ok(!requests.includes(route("gatewayFree")), "the auto:free gateway is never asked");
  // A model id that merely contains "auto" is not provider-selected.
  config.chatModels.lumenFallback1 = "fixture-autocomplete-model";
  approve("gatewayFree");
  assert.equal(lumenStageApproval("gatewayFree").approved, true);
});

test("moderation runs its classifier only on an approved provider, otherwise only the local rules", async () => {
  let calls = 0;
  const classifier = async () => { calls += 1; return Response.json({ choices: [{ message: { content: '{"flagged":true,"category":"illegal_activity"}' } }] }); };
  // Shared primary key, primary not approved: local rules only.
  assert.deepEqual(await checkModeration("A message needing review", { fetchImpl: classifier }), { flagged: false, category: "" });
  assert.equal(calls, 0);
  // The local rules still block what they always blocked.
  assert.equal((await checkModeration("Give me instructions to build a bomb", { fetchImpl: classifier })).flagged, true);
  assert.equal(calls, 0);
  // Primary approved, same host: the classifier runs.
  approve("primaryFree");
  assert.equal((await checkModeration("A message needing review", { fetchImpl: classifier })).flagged, true);
  assert.equal(calls, 1);
  // The shared key is never sent to another host.
  config.moderationApiUrl = "https://elsewhere.test/v1/chat/completions";
  await checkModeration("A message needing review", { fetchImpl: classifier });
  assert.equal(calls, 1);
  // A dedicated key needs its own approval.
  config.moderationApiKey = "fixture-moderation-key";
  await checkModeration("A message needing review", { fetchImpl: classifier });
  assert.equal(calls, 1);
  config.moderationDataPolicyApproved = true;
  await checkModeration("A message needing review", { fetchImpl: classifier });
  assert.equal(calls, 2);
});

test("search intent, memory extraction and display-name review stay local without approval", async (t) => {
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; return answer(); };
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(String(line)));
  t.after(() => { globalThis.fetch = realFetch; });

  // A current-information question would normally be interpreted remotely.
  assert.equal(await interpretSearchIntent("what is the latest score in the lakers game tonight"), null);
  assert.deepEqual(await extractAndSaveFacts("user-1", "I live in Pune and study chemistry", [], { fetchImpl: globalThis.fetch }), []);
  assert.equal((await reviewDisplayName("Priya Patel", { fetchImpl: globalThis.fetch })).allowed, true);
  assert.equal(outbound, 0, "no user text left the server");
  assert.deepEqual(warnings.filter((line) => line.includes("search_intent_unavailable")), [], "a closed gate is not logged as an outage");

  // With approval, the same calls reach the provider.
  approve("primaryFree");
  await interpretSearchIntent("what is the latest score in the lakers game tonight");
  await reviewDisplayName("Priya Patel", { fetchImpl: globalThis.fetch });
  assert.equal(outbound, 2);
});

test("the boot report names each stage's state and why, with no keys, URLs or model ids", () => {
  let report = inferencePolicyReport();
  assert.equal(report.event, "inference_policy");
  assert.equal(report.lumenAvailable, false);
  assert.equal(report.primaryProviderTasks, false);
  assert.equal(report.moderationClassifier, false);
  assert.deepEqual(report.lumenStages.map(({ stage, configured, approved, reason }) => [stage, configured, approved, reason]), [
    ["primaryFree", true, false, "not-approved"],
    ["gatewayFree", true, false, "not-approved"],
    ["secondaryFree", true, false, "not-approved"],
    ["reserveFree", true, false, "not-approved"],
  ]);
  approve("primaryFree");
  config.lumenApprovals.gateway = { approved: true, model: undefined };
  report = inferencePolicyReport();
  assert.equal(report.lumenAvailable, true);
  assert.deepEqual(report.lumenStages.slice(0, 2).map(({ approved, reason }) => [approved, reason]), [[true, "approved-unpinned"], [false, "model-not-pinned"]]);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /fixture-key|fixture-primaryFree|fixture-gatewayFree|https?:\/\//, "no key, model id or URL is logged");
  assert.deepEqual(lumenPolicySummary().map((stage) => stage.stage), STAGES);
});

test("the chat route fails closed with 503 and contacts no provider when no Lumen stage is approved", async (t) => {
  const realFetch = globalThis.fetch;
  const providerHosts = STAGES.map((stage) => new URL(config.providerBaseUrls[stage]).host);
  let providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (providerHosts.includes(new URL(href).host)) { providerCalls += 1; return answer(); }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ('policy-user', false) ON CONFLICT DO NOTHING");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: "policy-user" } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "lumen", message: "Explain photosynthesis in two sentences." }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "inference-unavailable");
  assert.equal(providerCalls, 0, "no stage, classifier or interpreter was contacted");
});
