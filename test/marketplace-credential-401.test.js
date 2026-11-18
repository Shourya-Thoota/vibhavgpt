// Part B: the GLM marketplace 401 ("User not found.", production requestId 19c56dc6, deployment 1bc045fc). The marketplace route sends
// exactly the credential and Authorization header every home tier on the router sends (one key, resolveProviderTarget), so the 401 is
// the router rejecting that key, not anything the marketplace route does differently. These tests reproduce it on the market route and
// pin what must hold when it happens: the same header as the home tiers, the privacy pinning untouched, no retry, no fallback to any other
// host or tier, nothing charged, and one distinct log line naming the credential's variable (never its value).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { config } from "../src/config.js";
import { callModelStreaming, credentialVariable, getModelConfig, InferenceUnavailableError, isCredentialRejection, providerApiKey, providerEndpointUrl, resolveProviderTarget } from "../src/chat/providers.js";
import { marketplaceRoute, MARKETPLACE_CANDIDATES, resetMarketplacePricesForTests, resetMarketplaceReferencesForTests, setMarketplaceReferenceForTests } from "../src/models/marketplace.js";
import { resetRoutePolicyStateForTests } from "../src/chat/route-policy-guard.js";

const ROUTER_KEY = config.providerKeys.paid;
const DIRECT_KEY = config.providerKeys.direct;

function verifyRouterRoute(id) {
  const candidate = MARKETPLACE_CANDIDATES.find((c) => c.id === id);
  resetRoutePolicyStateForTests(marketplaceRoute(id), {
    status: "verified", reason: "verified", model: candidate.model, hosts: candidate.hosts.join("|"), checkedAt: Date.now(),
    evidence: { endpoint: { provider_name: candidate.hosts[0], pricing: { prompt: "0.0000012", completion: "0.000004", input_cache_read: "0.00000024" }, context_length: 202_752, supported_parameters: ["tools", "tool_choice"] }, inputModalities: ["image", "text"], dataPolicy: { training: false, retainsPrompts: false } },
    allowedHosts: [...candidate.hosts], positiveEvidence: false,
  });
}
function readDirectReference(id) {
  setMarketplaceReferenceForTests(id, {
    ok: true, reason: "read", checkedAt: Date.now(),
    evidence: { endpoint: { provider_name: "OpenAI", pricing: { prompt: "0.00000005", completion: "0.00000025", input_cache_read: "0.000000005" }, context_length: 1_050_000, supported_parameters: ["tools", "tool_choice"] }, inputModalities: ["file", "image", "text"] },
  });
}
const reset = () => { resetRoutePolicyStateForTests(); resetMarketplacePricesForTests(); resetMarketplaceReferencesForTests(); };

// The router's answer for a key it does not recognise, exactly as production logged it (providerStatus 401, "User not found.").
const userNotFound = () => new Response(JSON.stringify({ error: { message: "User not found.", code: 401 } }), { status: 401, headers: { "content-type": "application/json" } });

function captureLogs(t) {
  const lines = [];
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of Object.keys(original)) console[level] = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => Object.assign(console, original));
  return lines;
}
function fakeTracker() {
  const calls = { beforeCall: 0, record: 0, release: 0 };
  return { calls, tracker: { beforeCall: async () => { calls.beforeCall += 1; }, record: async () => { calls.record += 1; }, release: async () => { calls.release += 1; } } };
}

test("trace: the marketplace route sends the same credential, to the same router, as every home tier on the router", () => {
  const market = getModelConfig("glm-5.3").chain[0];
  const homeRouterEntries = ["nova", "nebula", "zenith"].map((key) => getModelConfig(key).chain[0]).filter((entry) => entry.provider === "paid");
  assert.ok(homeRouterEntries.length >= 2, "home router tiers to compare against");
  for (const entry of [market, ...homeRouterEntries]) {
    assert.equal(providerApiKey(entry), ROUTER_KEY.trim(), "one router key for all of them (INFERENCE_ROUTER_API_KEY)");
    assert.equal(resolveProviderTarget(entry).base, config.providerBaseUrls.paid.trim());
    assert.equal(credentialVariable(entry), "INFERENCE_ROUTER_API_KEY");
  }
  // Lumen's paid zero-retention route is the same transport too.
  assert.equal(providerApiKey({ provider: "paid", transport: "router" }), ROUTER_KEY.trim());
  // A direct GPT-6 entry sends Vulcan's direct credential, never the router's.
  const direct = getModelConfig("gpt-6-luna").chain[0];
  assert.equal(providerApiKey(direct), DIRECT_KEY.trim());
  assert.equal(credentialVariable(direct), "INFERENCE_DIRECT_API_KEY");
});

test("reproduced: a 401 \"User not found.\" on the GLM market route fails closed, once, with nothing charged and the privacy pinning intact", async (t) => {
  t.after(reset);
  reset();
  verifyRouterRoute("glm-5.3");
  const logs = captureLogs(t);
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return userNotFound(); };
  const { calls, tracker } = fakeTracker();

  await assert.rejects(
    callModelStreaming("glm-5.3", [{ role: "user", content: "hello" }], null, { fetchImpl, usageTracker: tracker, requestId: "test-401", maxRetries: 1, startRetryDelaysMs: [0, 0] }),
    (error) => error instanceof InferenceUnavailableError,
  );

  // One request: a 401 is not retried and there is no other route to fall back to.
  assert.equal(requests.length, 1, "no retry, no fallback");
  const [{ url, init }] = requests;
  assert.equal(url, providerEndpointUrl(getModelConfig("glm-5.3").chain[0]));
  assert.equal(init.headers.Authorization, `Bearer ${ROUTER_KEY.trim()}`, "the router key, exactly as the home tiers send it");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "z-ai/glm-5.3");
  assert.deepEqual(body.provider, { order: ["Z.AI"], only: ["Z.AI"], allow_fallbacks: false, data_collection: "deny" }, "the privacy pinning is untouched");
  assert.equal("user" in body, false, "no per-user field on the market route");

  // Nothing charged: the hold is released and no usage is recorded.
  assert.equal(calls.record, 0);
  assert.ok(calls.release >= 1);

  // One distinct line says it is the credential, by its variable's name; the key itself is never logged.
  const rejected = logs.filter((line) => line.includes("\"inference_credential_rejected\"")).map((line) => JSON.parse(line));
  assert.equal(rejected.length, 1);
  assert.deepEqual(
    { stage: rejected[0].stage, transport: rejected[0].transport, status: rejected[0].status, credential: rejected[0].credential, modelKey: rejected[0].modelKey, message: rejected[0].providerMessage },
    { stage: "paid", transport: "router", status: 401, credential: "INFERENCE_ROUTER_API_KEY", modelKey: "glm-5.3", message: "User not found." },
  );
  assert.equal(logs.some((line) => line.includes(ROUTER_KEY)), false, "the key value never reaches a log");
});

test("a 401 on a direct GPT-6 route is reported against the direct credential, also once and uncharged", async (t) => {
  t.after(reset);
  t.after(() => { config.vesperDataPolicyVerified = before; });
  const before = config.vesperDataPolicyVerified;
  config.vesperDataPolicyVerified = true;
  reset();
  readDirectReference("gpt-6-luna");
  const logs = captureLogs(t);
  const requests = [];
  const { calls, tracker } = fakeTracker();
  await assert.rejects(
    callModelStreaming("gpt-6-luna", [{ role: "user", content: "hello" }], null, { fetchImpl: async (url, init) => { requests.push({ url, init }); return userNotFound(); }, usageTracker: tracker, requestId: "test-401-direct", maxRetries: 1, startRetryDelaysMs: [0, 0] }),
    (error) => error instanceof InferenceUnavailableError,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${config.providerBaseUrls.direct}/responses`);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${DIRECT_KEY.trim()}`);
  assert.equal(JSON.parse(requests[0].init.body).store, false);
  assert.equal(calls.record, 0);
  const rejected = logs.filter((line) => line.includes("\"inference_credential_rejected\"")).map((line) => JSON.parse(line));
  assert.deepEqual(rejected.map((line) => [line.credential, line.status, line.transport]), [["INFERENCE_DIRECT_API_KEY", 401, "direct"]]);
  assert.equal(logs.some((line) => line.includes(DIRECT_KEY)), false);
});

test("only an HTTP 401 or 403 is a credential rejection; rate limits and outages are not", () => {
  assert.equal(isCredentialRejection({ code: "provider-http-error", status: 401 }), true);
  assert.equal(isCredentialRejection({ code: "provider-http-error", status: 403 }), true);
  for (const status of [400, 408, 429, 500, 503]) assert.equal(isCredentialRejection({ code: "provider-http-error", status }), false, `${status}`);
  assert.equal(isCredentialRejection({ code: "provider-stream-error", status: 401 }), false);
});

test("the chat pre-flight checks the chosen model's own route, and its refusal names no credential or variable", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(router, /const isConfigured = \(modelConfig\.chain \?\? \[\]\)\.some\(\(entry\) => providerApiKey\(entry\) && providerEndpointUrl\(entry\)\);/);
  assert.doesNotMatch(router, /requires INFERENCE_ROUTER_API_KEY/);
});
