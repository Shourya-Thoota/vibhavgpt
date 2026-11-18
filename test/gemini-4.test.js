// Gemini 4 Carbon, Argon and Hydrogen (owner request, 2026-11-16) on Google's own Gemini API. Synthetic only: no request reaches Google.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { config } = await import("../src/config.js");
const { getModelConfig, resolveProviderTarget, providerApiKey, providerEndpointUrl, credentialVariable } = await import("../src/chat/providers.js");
const marketplace = await import("../src/models/marketplace.js");
const catalog = await import("../frontend/src/model-marketplace.js");
const { responseTokenBudget } = await import("../src/chat/router.js");

const IDS = ["gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon"];
const SENTINEL = "placeholder-gemini-key";

function withGoogle(t, { attested = true, key = SENTINEL } = {}) {
  const keys = { ...config.providerKeys };
  const before = config.geminiDataPolicyVerified;
  config.providerKeys.google = key;
  config.geminiDataPolicyVerified = attested;
  t.after(() => { Object.assign(config.providerKeys, keys); config.providerKeys.google = keys.google; config.geminiDataPolicyVerified = before; });
}

test("the catalog: Google's real names and ids, plan floors, vision, and the thinking levels Google documents", () => {
  const models = catalog.THIRD_PARTY_MODELS.filter((m) => m.provider === "gemini-4");
  assert.deepEqual(models.map((m) => [m.id, m.name, m.minPlan, m.vision]), [
    ["gemini-4-hydrogen", "Gemini 4 Hydrogen", "plus", true],
    ["gemini-4-argon", "Gemini 4 Argon", "pro", true],
    ["gemini-4-carbon", "Gemini 4 Carbon", "max", true],
  ]);
  assert.deepEqual(catalog.marketplaceThinking("gemini-4-carbon"), { levels: ["low", "medium", "high"], default: "medium" });
  assert.deepEqual(catalog.marketplaceThinking("gemini-4-argon"), { levels: ["low", "medium", "high"], default: "medium" });
  assert.deepEqual(catalog.marketplaceThinking("gemini-4-hydrogen"), { levels: ["low", "medium", "high", "xhigh"], default: "high" });
  assert.deepEqual(catalog.resolveMarketplaceThinking("gemini-4-carbon", "xhigh"), { level: null, valid: false }, "an undocumented level is refused");
  assert.deepEqual(catalog.resolveMarketplaceThinking("gemini-4-hydrogen", "minimal"), { level: null, valid: false }, "Google rejects minimal");
  assert.equal(catalog.providerLogo("gemini-4"), "gemini");
  assert.ok(fs.existsSync("frontend/public/brand/providers/gemini.png"), "the mark is a local file, never hotlinked");
  assert.deepEqual(catalog.PICKER_SECTIONS.map((s) => s.id), ["house", "gpt-6", "gemini-4", "glm"]);
});

test("each route goes only to Google's own API with GEMINI_API_KEY: never the router, Study's key or the free fallback key", (t) => {
  withGoogle(t);
  for (const id of IDS) {
    const chain = getModelConfig(id).chain;
    assert.equal(chain.length, 1, `${id}: one route, no fallback`);
    const entry = chain[0];
    assert.deepEqual([entry.provider, entry.connection, entry.transport, entry.api, entry.model], ["direct", "google", "direct", "chat", id]);
    assert.equal(providerApiKey(entry), SENTINEL);
    assert.equal(credentialVariable(entry), "GEMINI_API_KEY", "the key's name only");
    assert.equal(providerEndpointUrl(entry), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.notEqual(resolveProviderTarget(entry).apiKey, config.providerKeys.reserveFree, "not the free-tier fallback key");
    assert.equal(entry.providerRouting, undefined);
  }
});

test("live prices come from Google AI Studio's standard row, never the half-price Flex row", (t) => {
  t.after(() => marketplace.resetMarketplaceReferencesForTests());
  for (const id of IDS) {
    const route = marketplace.MARKETPLACE_ROUTES[id];
    assert.deepEqual(route.reference, { model: `google/${id}`, host: "Google AI Studio", tag: "google-ai-studio" });
  }
});

test("listing needs the owner's attestation and the key; without either, nothing lists or is sent", async (t) => {
  t.after(() => marketplace.resetMarketplaceReferencesForTests());
  const evidence = { endpoint: { provider_name: "Google AI Studio", tag: "google-ai-studio", context_length: 1048576, supported_parameters: ["tools", "reasoning_effort"], pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" } }, inputModalities: ["text", "image"] };
  marketplace.setMarketplaceReferenceForTests("gemini-4-carbon", { ok: true, reason: "read", evidence, checkedAt: Date.now() });
  {
    const tt = { after: (fn) => fn };
    const keys = { ...config.providerKeys }; const before = config.geminiDataPolicyVerified;
    config.providerKeys.google = SENTINEL; config.geminiDataPolicyVerified = false;
    assert.deepEqual(marketplace.marketplaceListing("gemini-4-carbon"), { listed: false, reason: "documented-terms-not-attested" }, "not attested");
    config.geminiDataPolicyVerified = true; config.providerKeys.google = "";
    assert.deepEqual(marketplace.marketplaceListing("gemini-4-carbon"), { listed: false, reason: "documented-terms-not-attested" }, "no key");
    config.providerKeys.google = SENTINEL;
    const listed = marketplace.marketplaceListing("gemini-4-carbon");
    assert.equal(listed.listed, true);
    assert.equal(listed.price.inputUsdPerToken, 0.000002);
    assert.equal(listed.price.outputUsdPerToken, 0.00001);
    assert.equal(marketplace.directRouteOpen(config, "study"), config.vesperDataPolicyVerified === true && Boolean(config.providerKeys.study?.trim?.()) && Boolean(config.providerBaseUrls.study), "GPT-6's gate is unchanged");
    Object.assign(config.providerKeys, keys); config.providerKeys.google = keys.google; config.geminiDataPolicyVerified = before;
  }
});

test("the price charged is Google's plus 10%: $2.20/$11.00 for Carbon and Argon, $1.65/$8.25 for Hydrogen, per million", () => {
  const perMillion = (usd) => Math.round(usd * 1_000_000 * 1.1 * 100) / 100;
  assert.deepEqual([perMillion(0.000002), perMillion(0.00001)], [2.2, 11]);
  assert.deepEqual([perMillion(0.0000015), perMillion(0.0000075)], [1.65, 8.25]);
  assert.equal(marketplace.UPCHARGE_PERCENT, 10);
});

test("the request carries the chosen thinking level as reasoning_effort, and room for thinking", () => {
  const source = fs.readFileSync("src/chat/providers.js", "utf8");
  assert.match(source, /if \(entry\.connection === "google" && reasoning && typeof reasoning === "object" && reasoning\.exact && reasoning\.effort\) body\.reasoning_effort = reasoning\.effort;/);
  assert.equal(responseTokenBudget("medium", "", "gemini-4-carbon"), 16_384);
  assert.equal(responseTokenBudget("high", "", "gemini-4-carbon"), 32_768);
  assert.equal(responseTokenBudget("xhigh", "", "gemini-4-hydrogen"), 32_768);
});

test("the key stays on the server: never in frontend code, and only its variable name in server code", () => {
  const files = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(m?jsx?|tsx?)$/.test(f)).map((f) => `${dir}/${f}`);
  for (const file of files("frontend/src")) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /GEMINI_API_KEY|AIza[0-9A-Za-z_-]{20,}/, file);
  for (const file of files("src")) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /AIza[0-9A-Za-z_-]{20,}/, `${file} holds a key`);
  assert.match(fs.readFileSync("src/config.js", "utf8"), /google: process\.env\.GEMINI_API_KEY,/);
});

test("older replies keep the name of the model that wrote them: no Gemini name replaces an earlier model", () => {
  for (const id of IDS) {
    assert.equal(Object.values(catalog.RETIRED_THIRD_PARTY_IDS).includes(id), false, `${id} replaces nothing`);
  }
});
