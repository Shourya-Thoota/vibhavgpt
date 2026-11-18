// Part C: the marketplace catalog. Exact names; plan floors (GLM and GPT-6 Luna from Plus, GPT-6.1 Terra from Pro, GPT-6.2 Sol and Astra
// on Max; complimentary accounts see all); GLM 5.3 and GLM 5.3 Flash omitted because both fail the live privacy check (Z.AI's host
// retains prompts); GPT-6 on the maker's own API under the documented manual-verification pattern Vulcan and Study use, never on the
// router; a retired id read as its replacement; real brand names only in the marketplace.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HOUSE_MODELS, RETIRED_THIRD_PARTY_IDS, RETIRED_THIRD_PARTY_NAMES, THIRD_PARTY_MODELS, THIRD_PARTY_PROVIDERS, currentThirdPartyKey, isThirdPartyModel, planIncludesThirdPartyModel,
  plansFrom, thirdPartyModel, thirdPartyPlanCopy,
} from "../frontend/src/model-marketplace.js";
import {
  CAPABILITY_WAIVERS, DIRECT_MARKETPLACE_CANDIDATES, MARKETPLACE_CANDIDATES, ROUTER_MARKETPLACE_CANDIDATES, buildPickerLineup, capabilityCheck,
  checkMarketplaceReference, directRouteOpen, marketplaceListing, resetMarketplacePricesForTests, resetMarketplaceReferencesForTests,
  setMarketplaceReferenceForTests,
} from "../src/models/marketplace.js";
import { GUARD_MAX_AGE_MS, resetRoutePolicyStateForTests } from "../src/chat/route-policy-guard.js";
import { guardedRoutes, routeInventory } from "../src/chat/route-inventory.js";
import { normalizeModelKey, resolveExecutableModelKey } from "../src/chat/model-keys.js";
import { assertModelPlanAccess, tierForSubscription } from "../src/usage/service.js";
import { config } from "../src/config.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";

const PLANS = ["free", "plus", "pro", "max"];
const reset = () => { resetRoutePolicyStateForTests(); resetMarketplacePricesForTests(); resetMarketplaceReferencesForTests(); };
const openaiEndpoint = (pricing = { prompt: "0.00000005", completion: "0.00000025", input_cache_read: "0.000000005", overrides: [{ min_prompt_tokens: 272000, prompt: "0.0000001", completion: "0.000000375", input_cache_read: "0.00000001" }] }) => ({
  // The standard tier's row, tagged as the router tags it ("openai"; Flex is "openai/flex").
  provider_name: "OpenAI", tag: "openai", model_id: "openai/gpt-6-luna", pricing, context_length: 1_050_000, supported_parameters: ["reasoning", "tools", "tool_choice"],
});
const reference = (overrides = {}) => ({ ok: true, reason: "read", checkedAt: Date.now(), evidence: { endpoint: openaiEndpoint(), inputModalities: ["file", "image", "text"] }, ...overrides });
async function withAttestation(value, fn) {
  const before = config.vesperDataPolicyVerified;
  config.vesperDataPolicyVerified = value;
  try { return await fn(); } finally { config.vesperDataPolicyVerified = before; }
}

test("the shipped catalog: exact names, in picker order; GLM 5.3 and GLM 5.3 Flash replace GLM-5V Turbo and FlashX", () => {
  assert.deepEqual(THIRD_PARTY_MODELS.map((m) => [m.id, m.name, m.provider, m.minPlan]), [
    ["glm-5.3", "GLM 5.3", "glm", "plus"],
    ["glm-5.3-flash", "GLM 5.3 Flash", "glm", "plus"],
    ["gpt-6-luna", "GPT-6 Luna", "gpt-6", "plus"],
    ["gpt-6.1-terra", "GPT-6.1 Terra", "gpt-6", "pro"],
    ["gpt-6.2-sol", "GPT-6.2 Sol", "gpt-6", "max"],
    ["gpt-6.2-astra", "GPT-6.2 Astra", "gpt-6", "max"],
    ["gemini-4-hydrogen", "Gemini 4 Hydrogen", "gemini-4", "plus"],
    ["gemini-4-argon", "Gemini 4 Argon", "gemini-4", "pro"],
    ["gemini-4-carbon", "Gemini 4 Carbon", "gemini-4", "max"],
  ]);
  for (const gone of ["z-ai/glm-5v-turbo", "z-ai/glm-5.3-flashx"]) {
    assert.equal(MARKETPLACE_CANDIDATES.some((c) => c.model === gone), false, `${gone}: no route, so nothing is sent to it`);
  }
  assert.deepEqual(THIRD_PARTY_PROVIDERS.map((p) => [p.id, p.name, p.maker, p.logo, p.headerMinEntries]), [["glm", "GLM", "Z.AI", "zai", 1], ["gpt-6", "GPT-6", "OpenAI", "openai", 2], ["gemini-4", "Gemini 4", "Google", "gemini", 2]]);
  // A model's one line says honestly whether it reads images: GLM 5.3 is text only; GLM 5.3 Flash and every GPT-6 model read images.
  for (const model of THIRD_PARTY_MODELS) {
    assert.equal(/Reads images/.test(model.description), model.vision, model.id);
    assert.equal(/Text only/.test(model.description), !model.vision, model.id);
  }
  assert.equal(thirdPartyModel("glm-5.3").vision, false);
});

test("plan floors: each plan sees everything at or below its floor; Max (and so every complimentary account) sees all", () => {
  const matrix = Object.fromEntries(THIRD_PARTY_MODELS.map((m) => [m.id, PLANS.map((plan) => planIncludesThirdPartyModel(plan, m.id))]));
  assert.deepEqual(matrix, {
    "glm-5.3": [false, true, true, true],
    "glm-5.3-flash": [false, true, true, true],
    "gpt-6-luna": [false, true, true, true],
    "gpt-6.1-terra": [false, false, true, true],
    "gpt-6.2-sol": [false, false, false, true],
    "gpt-6.2-astra": [false, false, false, true],
    "gemini-4-hydrogen": [false, true, true, true],
    "gemini-4-argon": [false, false, true, true],
    "gemini-4-carbon": [false, false, false, true],
  });
  // A complimentary account resolves to Max, even with a stale store row behind it, so it has every model.
  const comp = tierForSubscription({ compPlan: true, tier: "pro", status: "active", billingSource: "google_play" });
  assert.equal(comp, "max");
  for (const model of THIRD_PARTY_MODELS) assert.doesNotThrow(() => assertModelPlanAccess(comp, model.id), model.id);
  // The legacy "paid" plan name is Pro.
  assert.equal(planIncludesThirdPartyModel("paid", "gpt-6.1-terra"), true);
  assert.equal(planIncludesThirdPartyModel("paid", "gpt-6-sol"), false);
  // The refusal and the locked row name the right plans.
  assert.throws(() => assertModelPlanAccess("plus", "gpt-6.1-terra"), (error) => error.reason === "plan" && /Pro or Max/.test(JSON.stringify(error)));
  assert.throws(() => assertModelPlanAccess("pro", "gpt-6.2-astra"), (error) => error.reason === "plan" && /Max/.test(JSON.stringify(error)));
  assert.deepEqual(["plus", "pro", "max"].map(plansFrom), ["Plus, Pro, or Max", "Pro or Max", "Max"]);
  assert.deepEqual(THIRD_PARTY_MODELS.map((m) => thirdPartyPlanCopy(m.id)), [
    "Available with Plus, Pro, or Max.", "Available with Plus, Pro, or Max.", "Available with Plus, Pro, or Max.", "Available with Pro or Max.", "Available with Max.", "Available with Max.",
    "Available with Plus, Pro, or Max.", "Available with Pro or Max.", "Available with Max.",
  ]);
});

test("the chat route refuses a model below its floor before anything is sent", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(router, /if \(isThirdPartyModel\(modelKey\) && !planIncludesThirdPartyModel\(plan, modelKey\)\) \{\n\s+throw new ChatRequestError\(403,/);
  const at = router.indexOf("planIncludesThirdPartyModel(plan, modelKey)");
  assert.ok(at > 0 && at < router.indexOf("const modelConfig = getModelConfig(modelKey);"), "the floor is checked before the model is prepared");
});

test("GPT-6 follows the Vulcan/Study pattern: the maker's own API, store: false, documented terms; never on the router, never guard-decided", (t) => {
  t.after(reset);
  reset();
  assert.deepEqual(DIRECT_MARKETPLACE_CANDIDATES.map((c) => [c.id, c.model, c.reference.model, c.reference.host]), [
    ["gpt-6-luna", "gpt-6-luna", "openai/gpt-6-luna", "OpenAI"],
    ["gpt-6.1-terra", "gpt-6.1-terra", "openai/gpt-6.1-terra", "OpenAI"],
    ["gpt-6.2-sol", "gpt-6.2-sol", "openai/gpt-6.2-sol", "OpenAI"],
    ["gpt-6.2-astra", "gpt-6.2-astra", "openai/gpt-6.2-astra", "OpenAI"],
    ["gemini-4-hydrogen", "gemini-4-hydrogen", "google/gemini-4-hydrogen", "Google AI Studio"],
    ["gemini-4-argon", "gemini-4-argon", "google/gemini-4-argon", "Google AI Studio"],
    ["gemini-4-carbon", "gemini-4-carbon", "google/gemini-4-carbon", "Google AI Studio"],
  ]);
  // The guard checks only router routes: GLM 5.3. GPT-6 is never guard-checked (so it can never be a route_policy line), and the
  // GLM 5.3 Flash route that fails in production today is gone from the boot checks.
  const cfg = { ...config, providerBaseUrls: { ...config.providerBaseUrls, paid: "https://openrouter.ai/api/v1", study: "https://api.openai.com/v1", google: "https://generativelanguage.googleapis.com/v1beta/openai" } };
  const guarded = guardedRoutes(cfg).map((r) => r.route).filter((r) => r.startsWith("market:"));
  assert.deepEqual(guarded, ROUTER_MARKETPLACE_CANDIDATES.map((c) => `market:${c.id}`));
  assert.deepEqual(guarded, ["market:glm-5.3", "market:glm-5.3-flash"]);
  const inventory = Object.fromEntries(routeInventory(cfg).map((r) => [r.route, r]));
  for (const candidate of DIRECT_MARKETPLACE_CANDIDATES) {
    const route = inventory[`market:${candidate.id}`];
    const host = candidate.connection === "google" ? "generativelanguage.googleapis.com" : "api.openai.com";
    assert.deepEqual([route.host, route.mode, route.verifiable], [host, "direct", false], candidate.id);
  }
  // The privacy evidence is the documented terms, recorded with Vulcan's and Study's.
});

test("a GPT-6 model lists only while the documented terms are attested, its transport is configured, and its live reference read is fresh", async (t) => {
  t.after(reset);
  reset();
  await withAttestation(false, async () => {
    setMarketplaceReferenceForTests("gpt-6-luna", reference());
    assert.deepEqual(marketplaceListing("gpt-6-luna"), { listed: false, reason: "documented-terms-not-attested" });
    assert.equal(directRouteOpen(), false);
  });
  await withAttestation(true, async () => {
    reset();
    assert.deepEqual(marketplaceListing("gpt-6-luna"), { listed: false, reason: "reference-unread" });
    setMarketplaceReferenceForTests("gpt-6-luna", reference({ ok: false, reason: "reference-fetch-failed", evidence: null }));
    assert.equal(marketplaceListing("gpt-6-luna").listed, false);
    setMarketplaceReferenceForTests("gpt-6-luna", reference({ checkedAt: Date.now() - GUARD_MAX_AGE_MS - 1 }));
    assert.deepEqual(marketplaceListing("gpt-6-luna"), { listed: false, reason: "reference-stale" });
    setMarketplaceReferenceForTests("gpt-6-luna", reference({ evidence: { endpoint: openaiEndpoint({ prompt: "0.00000005" }), inputModalities: ["image", "text"] } }));
    assert.deepEqual(marketplaceListing("gpt-6-luna"), { listed: false, reason: "price-unknown" });
    setMarketplaceReferenceForTests("gpt-6-luna", reference({ evidence: { endpoint: openaiEndpoint(), inputModalities: ["text"] } }));
    assert.equal(marketplaceListing("gpt-6-luna").reason, "capability-vision");

    setMarketplaceReferenceForTests("gpt-6-luna", reference());
    const listing = marketplaceListing("gpt-6-luna");
    assert.equal(listing.listed, true);
    assert.equal(listing.transport, "direct");
    assert.deepEqual(listing.price, {
      inputUsdPerToken: 0.00000005, outputUsdPerToken: 0.00000025, cacheReadUsdPerToken: 0.000000005, cacheWriteUsdPerToken: 0.00000005,
      tiers: [{ fromPromptTokens: 272000, inputUsdPerToken: 0.0000001, outputUsdPerToken: 0.000000375, cacheReadUsdPerToken: 0.00000001, cacheWriteUsdPerToken: 0.0000001 }],
    });
    assert.deepEqual(resolveExecutableModelKey("gpt-6-luna"), { available: true, modelKey: "gpt-6-luna", thirdParty: true });

    // Lineup: GPT-6's header shows from two listed models up; one alone has its rows but no header.
    const one = buildPickerLineup({ plan: "max" }).providers.find((p) => p.id === "gpt-6");
    assert.deepEqual([one.models.length, one.showHeader], [1, false]);
    setMarketplaceReferenceForTests("gpt-6.2-sol", reference());
    const two = buildPickerLineup({ plan: "plus" }).providers.find((p) => p.id === "gpt-6");
    assert.deepEqual(two.models.map((m) => [m.name, m.allowed, m.logo]), [["GPT-6 Luna", true, "openai"], ["GPT-6.2 Sol", false, "openai"]]);
    assert.equal(two.showHeader, true);
  });
});

test("the reference read: the maker's own endpoint from public metadata, no key sent, logged as market_reference (never route_policy)", async () => {
  const requests = [];
  const lines = [];
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ data: { architecture: { input_modalities: ["file", "image", "text"] }, endpoints: [{ ...openaiEndpoint(), provider_name: "Azure" }, { ...openaiEndpoint({ prompt: "0.00000001", completion: "0.00000002" }), tag: "openai/flex" }, openaiEndpoint()] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const candidate = DIRECT_MARKETPLACE_CANDIDATES[0];
  const result = await checkMarketplaceReference(candidate, { fetchImpl, log, apiBase: "https://router.example/api/v1" });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.endpoint.provider_name, "OpenAI", "the maker's own endpoint, not a reseller's");
  assert.equal(result.evidence.endpoint.tag, "openai", "the standard tier we are billed at, not the cheaper Flex row listed before it");
  assert.equal(requests[0].url, "https://router.example/api/v1/models/openai/gpt-6-luna/endpoints");
  assert.equal(requests[0].init.headers.Authorization, undefined, "public metadata: no credential is sent");
  const line = JSON.parse(lines[0]);
  assert.equal(line.event, "market_reference");
  assert.equal(line.privacy, "documented-terms");
  assert.deepEqual(line.price, { input: 0.00000005, output: 0.00000025, cacheRead: 0.000000005, tiers: 1 });
  assert.doesNotMatch(lines.join("\n"), /route_policy/);

  const missing = await checkMarketplaceReference(candidate, { fetchImpl: async () => new Response(JSON.stringify({ data: { endpoints: [] } }), { status: 200 }), log });
  assert.deepEqual([missing.ok, missing.reason], [false, "maker-endpoint-missing"]);
  const failed = await checkMarketplaceReference(candidate, { fetchImpl: async () => { throw new Error("offline"); }, log });
  assert.deepEqual([failed.ok, failed.reason], [false, "reference-fetch-failed"]);
  resetMarketplaceReferencesForTests();
});

test("a retired id is read as its replacement everywhere; nothing stored is rewritten; old replies keep their own names", () => {
  assert.deepEqual(RETIRED_THIRD_PARTY_IDS, { "glm-5v-turbo": "glm-5.3", "glm-5.3-flashx": "glm-5.3-flash", "gpt-6-sol": "gpt-6.2-sol", "gpt-6.1-sol": "gpt-6.2-sol", "gpt-6-astra": "gpt-6.2-astra" });
  for (const [old, now, name] of [["glm-5v-turbo", "glm-5.3", "GLM 5.3"], ["GLM-5.3-FlashX", "glm-5.3-flash", "GLM 5.3 Flash"], ["gpt-6-sol", "gpt-6.2-sol", "GPT-6.2 Sol"], ["gpt-6.1-sol", "gpt-6.2-sol", "GPT-6.2 Sol"], ["GPT-6-ASTRA", "gpt-6.2-astra", "GPT-6.2 Astra"]]) {
    assert.equal(currentThirdPartyKey(old), now, old);
    assert.equal(isThirdPartyModel(old), true, old);
    assert.equal(thirdPartyModel(old).name, name, old);
    assert.equal(normalizeModelKey(old), now, old);
    assert.equal(resolveExecutableModelKey(old).modelKey, now, old);
  }
  for (const id of ["glm-5.3", "glm-5.3-flash"]) assert.equal(currentThirdPartyKey(id), id, "a current id is unchanged");
  assert.deepEqual(RETIRED_THIRD_PARTY_NAMES, { "glm-5v-turbo": "GLM-5V Turbo", "glm-5.3-flashx": "GLM-5.3 FlashX", "gpt-6-sol": "GPT-6 Sol", "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-astra": "GPT-6 Astra" }, "old replies keep the name of the model that wrote them");
});

test("a capability can be waived only for the entry the owner named (GLM 5.3: vision), and is then reported as waived", () => {
  assert.deepEqual(CAPABILITY_WAIVERS, { "glm-5.3": ["vision"] }, "one entry, one capability");
  assert.deepEqual(MARKETPLACE_CANDIDATES.filter((c) => c.waivers.length).map((c) => [c.id, c.waivers]), [["glm-5.3", ["vision"]]]);
  const textOnly = { inputModalities: ["text"], hostParameters: ["tools"], contextLength: 1_048_576 };
  assert.deepEqual(capabilityCheck(textOnly).missing, ["vision"]);
  const waived = capabilityCheck({ ...textOnly, waive: ["vision"] });
  assert.deepEqual([waived.ok, waived.vision, waived.waived], [true, false, ["vision"]], "listed, but honestly without vision");
  assert.equal(capabilityCheck({ ...textOnly, hostParameters: [], waive: ["vision"] }).ok, false, "a waiver covers only what it names");
});

test("real brand and model names appear only in the marketplace; the house tiers stay masked", () => {
  const makers = /OpenAI|GPT|GLM|Z\.AI|z-ai|Mistral|DeepSeek|Kimi|Gemma/i;
  for (const model of HOUSE_MODELS) assert.doesNotMatch(`${model.name} ${model.description}`, makers, model.id);
  const lineup = buildPickerLineup({ plan: "max" });
  assert.doesNotMatch(JSON.stringify(lineup.house), makers);
  for (const id of ["lumen", "nova", "nebula", "vesper", "zenith"]) assert.doesNotMatch(buildIdentitySystemPrompt(id).split("\n")[0], /OpenAI|GPT-6|Z\.AI/);
  assert.match(buildIdentitySystemPrompt("gpt-6-luna"), /^You are GPT-6 Luna, a model made by OpenAI/);
});
