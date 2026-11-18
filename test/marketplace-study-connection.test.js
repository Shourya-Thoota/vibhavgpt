// Owner correction (2026-11-13): the four GPT-6 marketplace models use the same API key and direct connection Study mode's Luna uses,
// traced from Study's own implementation: its chain entry is { provider: "study" }, so resolveProviderTarget reads config.providerKeys.study
// and config.providerBaseUrls.study (src/config.js: INFERENCE_DIRECT_API_KEY and INFERENCE_DIRECT_BASE_URL), sent by the shared request
// client as a Bearer header. The marketplace entries reuse that connection (connection: "study") and never the router credential, while
// keeping their own model ids, plan floors, privacy listing and cost x 1.10 settlement, and none of Study's request, prompt or billing
// behaviour. Every value here is a test placeholder; no real key is read or printed.
import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { callModelStreaming, credentialVariable, getModelConfig, providerApiKey, providerEndpointUrl, resolveProviderTarget } from "../src/chat/providers.js";
import { DIRECT_MARKETPLACE_CANDIDATES, directRouteOpen, resetMarketplacePricesForTests, resetMarketplaceReferencesForTests, setMarketplaceReferenceForTests } from "../src/models/marketplace.js";
import { planIncludesThirdPartyModel, thirdPartyMinPlan } from "../frontend/src/model-marketplace.js";
import { assertModelPlanAccess } from "../src/usage/service.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";

const GPT6 = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"];
// Distinct placeholders per slot, so a route that read the wrong slot is caught (in the real config, study and direct read the same
// variable, which would hide that mistake).
const SENTINELS = { study: "placeholder-study-connection", direct: "placeholder-direct-slot", paid: "placeholder-router-slot" };
const BASES = { study: "https://study-connection.test/v1", direct: "https://direct-slot.test/v1", paid: "https://router-slot.test/api/v1" };

function withSlots(t, { routerKey = SENTINELS.paid } = {}) {
  const keys = { ...config.providerKeys };
  const bases = { ...config.providerBaseUrls };
  const attested = config.vesperDataPolicyVerified;
  Object.assign(config.providerKeys, { study: SENTINELS.study, direct: SENTINELS.direct, paid: routerKey });
  Object.assign(config.providerBaseUrls, BASES);
  config.vesperDataPolicyVerified = true;
  t.after(() => {
    Object.assign(config.providerKeys, keys);
    Object.assign(config.providerBaseUrls, bases);
    config.vesperDataPolicyVerified = attested;
    resetMarketplaceReferencesForTests();
    resetMarketplacePricesForTests();
  });
  for (const id of GPT6) {
    setMarketplaceReferenceForTests(id, { ok: true, reason: "read", checkedAt: Date.now(), evidence: { endpoint: { provider_name: "OpenAI", pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001" }, context_length: 1_050_000, supported_parameters: ["tools"] }, inputModalities: ["image", "text"] } });
  }
}

test("traced: Study mode's own connection is config.providerKeys.study and config.providerBaseUrls.study (INFERENCE_DIRECT_*)", (t) => {
  withSlots(t);
  const study = getModelConfig("study").chain[0];
  assert.equal(study.provider, "study");
  assert.deepEqual(resolveProviderTarget(study), { base: BASES.study, apiKey: SENTINELS.study });
  assert.equal(credentialVariable(study), "INFERENCE_DIRECT_API_KEY");
});

test("all four GPT-6 marketplace routes resolve to Study's connection: same key slot, same base URL, never the router or another slot", (t) => {
  withSlots(t);
  const study = resolveProviderTarget(getModelConfig("study").chain[0]);
  assert.deepEqual(DIRECT_MARKETPLACE_CANDIDATES.filter((c) => c.connection === "study").map((c) => c.id), GPT6);
  for (const id of GPT6) {
    const entry = getModelConfig(id).chain[0];
    assert.equal(getModelConfig(id).chain.length, 1, `${id}: one route, no fallback`);
    assert.deepEqual(resolveProviderTarget(entry), study, `${id}: Study's base URL and key`);
    assert.equal(providerApiKey(entry), SENTINELS.study, id);
    assert.notEqual(providerApiKey(entry), SENTINELS.paid, `${id}: never the router credential`);
    assert.notEqual(providerApiKey(entry), SENTINELS.direct, `${id}: not a separate slot either`);
    assert.equal(providerEndpointUrl(entry), `${BASES.study}/responses`);
    assert.equal(credentialVariable(entry), "INFERENCE_DIRECT_API_KEY");
    assert.notEqual(entry.transport, "router");
    assert.equal(entry.providerRouting, undefined, `${id}: no router routing block`);
  }
  assert.equal(directRouteOpen(), true);
});

test("the GPT-6 routes need no router credential at all: with the router key unset they still list and resolve", (t) => {
  withSlots(t, { routerKey: undefined });
  for (const id of GPT6) {
    assert.equal(getModelConfig(id).chain[0].approved(), true, `${id}: listed without a router key`);
    assert.equal(providerApiKey(getModelConfig(id).chain[0]), SENTINELS.study);
  }
});

test("a real request: each GPT-6 model is sent to Study's base URL with Study's Bearer credential, under its own model id, without Study's behaviour", async (t) => {
  withSlots(t);
  for (const id of GPT6) {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      const events = [
        { type: "response.output_text.delta", delta: "Hi." },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 }, output: [] } },
      ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await callModelStreaming(id, [{ role: "user", content: "hello" }], null, { fetchImpl, requestId: `t-${id}` }).catch(() => null);
    assert.equal(requests.length >= 1, true, `${id}: a request was made`);
    const [{ url, init }] = requests;
    assert.equal(url, `${BASES.study}/responses`, id);
    assert.equal(init.headers.Authorization, `Bearer ${SENTINELS.study}`, `${id}: Study's credential`);
    assert.ok(!JSON.stringify(init.headers).includes(SENTINELS.paid) && !url.includes("router"), `${id}: never the router`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, id, `${id}: its own model id, not Study's configured model`);
    assert.equal(body.store, false);
    assert.equal("reasoning_effort" in body, false, `${id}: Study's reasoning setting is not applied`);
    assert.equal("max_completion_tokens" in body, false, `${id}: Study's token field is not applied`);
  }
});

test("sharing Study's connection changes nothing else: own plan floors, own identity prompt, metered at cost x 1.10, not Study's billing", () => {
  assert.deepEqual(GPT6.map(thirdPartyMinPlan), ["plus", "pro", "max", "max"]);
  assert.equal(planIncludesThirdPartyModel("plus", "gpt-6.1-terra"), false);
  assert.throws(() => assertModelPlanAccess("pro", "gpt-6-sol"), (error) => error.reason === "plan");
  for (const id of GPT6) {
    const config = getModelConfig(id);
    assert.equal(config.thirdParty, true, `${id}: billed as a marketplace model (cost x 1.10), never as Study`);
    assert.notEqual(config.chain[0].provider, "study", `${id}: not Study's provider, so none of its request behaviour`);
    const prompt = buildIdentitySystemPrompt(id);
    assert.match(prompt, new RegExp(`^You are ${getModelConfig(id).displayName.replace(/\./g, "\\.")}, a model made by OpenAI`), `${id}: its own identity`);
    assert.notEqual(prompt.split("\n")[0], buildIdentitySystemPrompt("study").split("\n")[0], `${id}: not Study's prompt`);
    assert.match(prompt, /You are not one of VibhavGPT's own models/);
  }
});
