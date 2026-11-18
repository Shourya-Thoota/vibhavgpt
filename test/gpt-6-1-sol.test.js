import test from "node:test";
import assert from "node:assert/strict";

// GPT-6 Sol was replaced by GPT-6.1 Sol (owner request 2026-11-15), which GPT-6.2 Sol replaces in turn (2026-11-17): a saved GPT-6 Sol
// selection now opens as GPT-6.2 Sol. Exact id gpt-6.2-sol on OpenAI's own Responses API (direct route). OpenAI's model page: "none" is
// rejected; tool calling with the Responses API; 1,050,000 context; 128,000 output. The live price is read from OpenAI's own row in the
// router's public metadata, at the standard tier our direct requests are billed at (no service_tier is sent).
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const marketplace = await import("../src/models/marketplace.js");
const { resolveExecutableModelKey } = await import("../src/chat/model-keys.js");
const mk = await import("../frontend/src/model-marketplace.js");

const endpointsFor = (model, rows) => ({ data: { id: model, architecture: { input_modalities: ["file", "image", "text"] }, endpoints: rows } });
const row = (tag, prompt, completion) => ({ provider_name: "OpenAI", tag, context_length: 1050000, max_completion_tokens: 128000, status: 0,
  supported_parameters: ["reasoning", "tools", "tool_choice", "structured_outputs", "response_format", "reasoning_effort"],
  pricing: { prompt, completion, input_cache_read: "0.0000001", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015", input_cache_read: "0.0000002" }] } });

test("GPT-6.2 Sol is listed in place of GPT-6 Sol, on Max, on OpenAI's own direct route with its exact id", () => {
  const entry = mk.THIRD_PARTY_MODELS.find((m) => m.id === "gpt-6.2-sol");
  assert.deepEqual({ name: entry.name, provider: entry.provider, minPlan: entry.minPlan, vision: entry.vision }, { name: "GPT-6.2 Sol", provider: "gpt-6", minPlan: "max", vision: true });
  assert.equal(mk.THIRD_PARTY_MODELS.some((m) => m.id === "gpt-6-sol"), false, "GPT-6 Sol is no longer offered");
  const candidate = marketplace.marketplaceCandidate("gpt-6.2-sol");
  assert.deepEqual({ transport: candidate.transport, model: candidate.model, reference: candidate.reference }, { transport: "direct", model: "gpt-6.2-sol", reference: { model: "openai/gpt-6.2-sol", host: "OpenAI", tag: "openai" } });
  assert.equal(marketplace.marketplaceCandidate("gpt-6-sol").id, "gpt-6.2-sol", "an old id runs the model that replaced it");
});

test("the live price is read from the standard tier OpenAI bills our requests at, never the discounted Flex row listed first", async () => {
  const candidate = marketplace.marketplaceCandidate("gpt-6.2-sol");
  const fetchImpl = async () => Response.json(endpointsFor("openai/gpt-6.2-sol", [row("openai/flex", "0.000001", "0.000005"), row("openai", "0.000002", "0.00001"), row("openai/fast", "0.000004", "0.00002")]));
  const result = await marketplace.checkMarketplaceReference(candidate, { fetchImpl, log: { info() {}, warn() {} } });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.endpoint.tag, "openai");
  assert.deepEqual([result.evidence.endpoint.pricing.prompt, result.evidence.endpoint.pricing.completion], ["0.000002", "0.00001"]);
  const price = marketplace.livePriceFromEvidence(result.evidence);
  assert.deepEqual([price.inputUsdPerToken, price.outputUsdPerToken], [0.000002, 0.00001]);
  // Every GPT-6 route is read the same way.
  for (const id of ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"]) assert.equal(marketplace.marketplaceCandidate(id).reference.tag, "openai", id);
});

test("with no standard-tier row, the model is not listed: a price is never guessed from another tier", async () => {
  const candidate = marketplace.marketplaceCandidate("gpt-6.2-sol");
  const fetchImpl = async () => Response.json(endpointsFor("openai/gpt-6.2-sol", [row("openai/flex", "0.000001", "0.000005")]));
  const result = await marketplace.checkMarketplaceReference(candidate, { fetchImpl, log: { info() {}, warn() {} } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "maker-endpoint-missing");
});

test("thinking: GPT-6.2 Sol's own levels; none is refused; a remembered GPT-6 Sol 'none' becomes low, other levels carry over", () => {
  assert.deepEqual(mk.MARKETPLACE_THINKING["gpt-6.2-sol"], { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" });
  assert.deepEqual(mk.resolveMarketplaceThinking("gpt-6.2-sol", "none"), { level: null, valid: false });
  assert.deepEqual(mk.resolveMarketplaceThinking("gpt-6.2-sol", undefined), { level: "medium", valid: true });
  assert.equal(mk.inheritedThinkingLevel("gpt-6-sol", "none"), "low");
  assert.equal(mk.inheritedThinkingLevel("gpt-6-sol", "xhigh"), "xhigh");
  assert.equal(mk.inheritedThinkingLevel("gpt-6-sol", "nonsense"), null);
  assert.equal(mk.inheritedThinkingLevel("gpt-6.1-terra", "high"), null, "only a replaced model hands its level on");
});

test("a saved GPT-6 Sol selection moves to GPT-6.2 Sol and says so; GPT-6 Sol replies keep their own name", () => {
  assert.equal(mk.currentThirdPartyKey("GPT-6-Sol"), "gpt-6.2-sol");
  assert.deepEqual(mk.thirdPartyReplacement("gpt-6-sol"), { from: "gpt-6-sol", to: "gpt-6.2-sol", fromName: "GPT-6 Sol", toName: "GPT-6.2 Sol" });
  assert.equal(mk.thirdPartyReplacement("gpt-6.2-sol"), null, "a current model is not a replacement");
  assert.equal(mk.RETIRED_THIRD_PARTY_NAMES["gpt-6-sol"], "GPT-6 Sol", "a reply recorded as GPT-6 Sol is labelled GPT-6 Sol");
  assert.equal(mk.isThirdPartyModel("gpt-6-sol"), true, "an old client's id is still understood (as its replacement)");
  assert.equal(mk.planIncludesThirdPartyModel("pro", "gpt-6.2-sol"), false);
  assert.equal(mk.planIncludesThirdPartyModel("max", "gpt-6.2-sol"), true);
  assert.equal(resolveExecutableModelKey("gpt-6-sol").modelKey, "gpt-6.2-sol", "the server runs the replacement for an old id");
});
