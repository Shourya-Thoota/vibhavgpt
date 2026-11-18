// Owner decisions of 2026-11-14:
//   1. Nova and Nebula are retired: not offered, never chosen by Auto, a request naming one refused (model_retired) before inference or
//      any credit hold, a stale saved selection never routed elsewhere, and replies they wrote keep their names. Lumen, Vulcan, Zenith,
//      Study and the marketplace keep working.
//   2. Marketplace thinking levels: only the levels each exact model documents, validated before inference or billing, sent exactly.
//   3. Greetings never trigger web research.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CUSTOMER_CHAT_MODEL_IDS, isCustomerSelectableModel, retiredModelUnavailable } from "../src/models/customer-catalog.js";
import { isRetiredCustomerModel, normalizeModelKey, resolveExecutableModelKey } from "../src/chat/model-keys.js";
import { HOUSE_MODELS, HOUSE_MODEL_IDS, MARKETPLACE_THINKING, RETIRED_HOUSE_NAMES, resolveMarketplaceThinking } from "../frontend/src/model-marketplace.js";
import { ENFORCEABLE_TIERS } from "../src/usage/chat-allowance-policy.js";
import { reasoningParameter } from "../src/chat/reasoning-effort.js";
import { createReplyLabels } from "../frontend/src/model-labels.js";
import { requiresFreshWebSearch, buildConversationSearchPlan } from "../src/chat/web-search.js";

const RETIRED = ["nova", "nebula", "ultra", "NOVA", " Nebula "];

test("1. Nova and Nebula are absent from every selectable lineup", () => {
  assert.deepEqual(HOUSE_MODEL_IDS, ["lumen", "vesper", "zenith"]);
  assert.deepEqual(HOUSE_MODELS.map((m) => m.id), ["lumen", "vesper", "zenith"]);
  // Tecton (Build, 2026-11-14) is a customer model too; it is chosen by Build, not the picker.
  assert.deepEqual(CUSTOMER_CHAT_MODEL_IDS, ["lumen", "vesper", "zenith", "tecton"]);
  for (const key of RETIRED) assert.equal(isCustomerSelectableModel(key), false, key);
  assert.equal(ENFORCEABLE_TIERS.includes("nova") || ENFORCEABLE_TIERS.includes("nebula"), false);
});

test("2. Auto never selects a retired tier (and its fallback mapping cannot produce one)", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(router, /modelKey = brokered\.multiplier > 7\.0 && \(plan === "pro" \|\| plan === "max"\) \? "vesper" : "lumen";/);
  assert.match(router, /const fallbackKey = candidate\.multiplier > 7 && \(plan === "pro" \|\| plan === "max"\) \? "vesper" : "lumen";/);
  assert.doesNotMatch(router, /modelKey = "nova"|modelKey = "nebula"|\? "nebula"|\? "nova"/);
});

test("3. a stale or explicit request for a retired tier is refused by name, never routed to another tier", () => {
  for (const key of RETIRED) {
    assert.equal(isRetiredCustomerModel(key), true, key);
    const resolved = resolveExecutableModelKey(key);
    assert.equal(resolved.available, false, key);
    assert.equal(resolved.code, "model_retired", key);
    assert.match(resolved.message, /has been retired\. Choose an available model to continue\./);
    assert.doesNotMatch(String(resolved.modelKey), /lumen|vesper|zenith/, `${key}: no replacement tier`);
  }
  assert.equal(retiredModelUnavailable("nebula").code, "model_retired");
});

test("3b. the chat route refuses a retired tier before any usage reservation (no inference, no credit hold)", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const refuse = router.indexOf("if (requestedRawModel && isRetiredCustomerModel(requestedRawModel)) {");
  const reserve = router.indexOf("usageEvent = await reserveUsage(");
  assert.ok(refuse > 0 && reserve > refuse, "the retired check comes before the usage reservation");
});

test("4. replies written by a retired tier keep their original label", () => {
  const labels = createReplyLabels([
    ...HOUSE_MODELS.map((m) => ({ value: m.id, label: m.name, full: `VibhavGPT ${m.name}` })),
    ...Object.entries(RETIRED_HOUSE_NAMES).map(([value, name]) => ({ value, label: name, full: `VibhavGPT ${name}` })),
  ]);
  assert.equal(labels.modelLabel("nova"), "VibhavGPT Nova");
  assert.equal(labels.modelLabel("nebula"), "VibhavGPT Nebula");
  assert.equal(normalizeModelKey("nova"), "nova", "the stored key is kept, not rewritten to another tier");
  assert.equal(normalizeModelKey("ultra"), "nebula");
});

test("5. Lumen, Vulcan, Zenith, Study and the marketplace keep resolving", () => {
  for (const key of ["lumen", "vesper", "zenith", "study"]) assert.equal(resolveExecutableModelKey(key).available, true, key);
  for (const key of ["gpt-6-luna", "glm-5.3"]) assert.equal(isRetiredCustomerModel(key), false, key);
});

test("thinking levels: exactly the documented levels per model; anything else is refused; defaults where documented", () => {
  assert.deepEqual(MARKETPLACE_THINKING["gpt-6-luna"].levels, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(MARKETPLACE_THINKING["gpt-6.1-terra"].levels, ["none", "low", "medium", "high", "xhigh", "max"]);
  // GPT-6.2 Sol (replaced GPT-6 Sol, 2026-11-15) documents low to max, default medium, and no "none" (OpenAI model page).
  assert.deepEqual(MARKETPLACE_THINKING["gpt-6.2-sol"].levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(MARKETPLACE_THINKING["gpt-6.2-sol"].default, "medium");
  assert.equal(MARKETPLACE_THINKING["gpt-6-sol"], undefined, "the retired id has no levels of its own");
  assert.deepEqual(resolveMarketplaceThinking("gpt-6.2-sol", "none"), { level: null, valid: false }, "none is refused before inference");
  assert.deepEqual(MARKETPLACE_THINKING["gpt-6.2-astra"].levels, ["low", "medium", "high", "xhigh", "max"], "Astra refuses none");
  assert.deepEqual(MARKETPLACE_THINKING["glm-5.3"].levels, ["low", "high"]);
  assert.deepEqual(MARKETPLACE_THINKING["glm-5.3-flash"].levels, ["low", "high"]);
  assert.deepEqual(resolveMarketplaceThinking("gpt-6-luna"), { level: "medium", valid: true });
  assert.deepEqual(resolveMarketplaceThinking("glm-5.3"), { level: "high", valid: true });
  assert.deepEqual(resolveMarketplaceThinking("gpt-6.2-astra", "none"), { level: null, valid: false });
  // The unified Medium (2026-11-16) is accepted for every model: GLM has no medium, so it gets the next level up.
  assert.deepEqual(resolveMarketplaceThinking("glm-5.3", "medium"), { level: "high", valid: true });
  assert.deepEqual(resolveMarketplaceThinking("glm-5.3-flash", "max"), { level: null, valid: false }, "not offered until verified through the router");
  assert.deepEqual(resolveMarketplaceThinking("gpt-6-sol", "XHIGH"), { level: "xhigh", valid: true });
});

test("thinking levels: an unsupported level is refused before the usage reservation; the exact value is what is sent", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const refuse = router.indexOf(`"thinking_level_unsupported"`);
  const reserve = router.indexOf("usageEvent = await reserveUsage(");
  assert.ok(refuse > 0 && reserve > refuse, "refused before inference or any credit hold");
  // The provider parameter is the level itself, never remapped; on the router the reasoning text is not requested back.
  assert.deepEqual(reasoningParameter("openai/gpt-6-luna", { exact: true, effort: "none" }), { effort: "none" });
  assert.deepEqual(reasoningParameter("gpt-6.2-astra", { exact: true, effort: "xhigh" }), { effort: "xhigh" });
  assert.deepEqual(reasoningParameter("z-ai/glm-5.3", { exact: true, effort: "low", exclude: true }), { effort: "low", exclude: true });
});

test("Zenith's engine is sent only levels it accepts (low, medium, high)", () => {
  assert.deepEqual(["low", "normal", "high", "xhigh", "max"].map((level) => reasoningParameter("mistralai/mistral-large-4-0", level).effort), ["low", "medium", "high", "high", "high"]);
});

test("greetings and acknowledgments never trigger web research", () => {
  for (const message of ["hi", "hello!", "hey there", "Good morning", "thanks", "ok cool", "how are you?"]) {
    assert.equal(requiresFreshWebSearch(message), false, message);
    assert.equal(buildConversationSearchPlan(message, []).current, false, message);
  }
  assert.equal(requiresFreshWebSearch("what is the weather today"), true, "a real current-information question still searches");
});
