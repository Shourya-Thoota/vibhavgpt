// GPT-6.2 Sol and Astra replace GPT-6.1 Sol and GPT-6 Astra (owner request, 2026-11-17). Mocked throughout: no request leaves the process.
// Routing, all three thinking levels, saved selections, streaming, tool calls and billing, each checked on the request actually built.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { config } = await import("../src/config.js");
const { callModelWithFallback, callModelStreaming, getModelConfig, providerEndpointUrl, credentialVariable } = await import("../src/chat/providers.js");
const marketplace = await import("../src/models/marketplace.js");
const mk = await import("../frontend/src/model-marketplace.js");
const { resolveExecutableModelKey } = await import("../src/chat/model-keys.js");
const { normalizedProviderUsage } = await import("../src/usage/service.js");
const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");

const MODELS = { "gpt-6.2-sol": "GPT-6.2 Sol", "gpt-6.2-astra": "GPT-6.2 Astra" };
// OpenAI's standard rows as the router published them on 2026-11-17 (the same rates as OpenAI's model pages).
const PRICING = {
  "gpt-6.2-sol": { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000025", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015", input_cache_read: "0.0000002", input_cache_write: "0.000005" }] },
  "gpt-6.2-astra": { prompt: "0.000008", completion: "0.00004", input_cache_read: "0.0000004", input_cache_write: "0.00001", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000016", completion: "0.00006", input_cache_read: "0.0000008", input_cache_write: "0.00002" }] },
};
const BASE = "https://openai-direct.test/v1";
let saved;
beforeEach(() => {
  saved = { verified: config.vesperDataPolicyVerified, key: config.providerKeys.study, base: config.providerBaseUrls.study };
  config.vesperDataPolicyVerified = true;
  config.providerKeys.study = "placeholder-study-key";
  config.providerBaseUrls.study = BASE;
  for (const id of Object.keys(MODELS)) {
    marketplace.setMarketplaceReferenceForTests(id, { ok: true, reason: "read", checkedAt: Date.now(), evidence: { endpoint: { provider_name: "OpenAI", tag: "openai", pricing: PRICING[id], context_length: 1050000, max_completion_tokens: 128000, supported_parameters: ["reasoning", "tools", "tool_choice", "reasoning_effort"] }, inputModalities: ["text", "image"] } });
  }
});
afterEach(() => {
  config.vesperDataPolicyVerified = saved.verified; config.providerKeys.study = saved.key; config.providerBaseUrls.study = saved.base;
  marketplace.resetMarketplaceReferencesForTests(); marketplace.resetMarketplacePricesForTests();
});

const okResponse = (extra = {}) => Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 2 }, ...extra });
function capture(responder = () => okResponse()) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers?.Authorization ?? init.headers?.authorization }); return responder(); } };
}

test("routing: each 6.2 model has one route, OpenAI's own Responses API with store: false, under its exact upstream id", async () => {
  for (const [id, name] of Object.entries(MODELS)) {
    const entry = mk.THIRD_PARTY_MODELS.find((m) => m.id === id);
    assert.deepEqual({ name: entry.name, provider: entry.provider, minPlan: entry.minPlan, vision: entry.vision }, { name, provider: "gpt-6", minPlan: "max", vision: true }, `${id}: branded name and the same plan`);
    const chain = getModelConfig(id).chain;
    assert.equal(chain.length, 1, `${id}: no fallback`);
    assert.deepEqual([chain[0].provider, chain[0].connection, chain[0].transport, chain[0].api, chain[0].store, chain[0].model], ["direct", "study", "direct", "responses", false, id]);
    assert.equal(providerEndpointUrl(chain[0]), `${BASE}/responses`);
    assert.equal(credentialVariable(chain[0]), "INFERENCE_DIRECT_API_KEY");
    const { calls, fetchImpl } = capture();
    await callModelWithFallback(id, [{ role: "user", content: "Hi" }], undefined, { fetchImpl });
    assert.equal(calls[0].url, `${BASE}/responses`);
    assert.equal(calls[0].body.model, id, "the upstream id is sent");
    assert.equal(calls[0].body.store, false, "nothing is stored at OpenAI");
    assert.ok(calls[0].body.include.includes("reasoning.encrypted_content"));
    assert.equal(calls[0].body.service_tier, undefined, "the standard tier billed at the read price");
    assert.equal(calls[0].body.prompt_cache_options, undefined, "no longer cache retention is requested");
  }
});

test("the upstream ids stay on the server: the app's catalog carries only ids and branded names, never a route", () => {
  for (const entry of mk.THIRD_PARTY_MODELS.filter((m) => m.provider === "gpt-6")) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "id", "intelligence", "minPlan", "name", "provider", "vision"].sort());
  }
  const catalogSource = fs.readFileSync("frontend/src/model-marketplace.js", "utf8");
  assert.doesNotMatch(catalogSource, /openai\/gpt-6\.2/, "the router reference is server-only");
  assert.match(fs.readFileSync("src/models/marketplace.js", "utf8"), /"gpt-6\.2-sol": Object\.freeze\(\{ transport: "direct", model: "gpt-6\.2-sol"/);
});

test("all three thinking levels: what each actually sends (Low low, Medium medium, High max); none is never sent", async () => {
  for (const id of Object.keys(MODELS)) {
    for (const [unified, effort] of [["low", "low"], ["medium", "medium"], ["high", "max"]]) {
      const resolved = mk.resolveMarketplaceThinking(id, unified);
      assert.deepEqual(resolved, { level: effort, valid: true }, `${id} ${unified}`);
      const { calls, fetchImpl } = capture();
      // The chat route passes the validated level exactly (router.js: { exact: true, effort }).
      await callModelWithFallback(id, [{ role: "user", content: "Think" }], undefined, { fetchImpl, reasoning: { exact: true, effort: resolved.level } });
      assert.deepEqual(calls[0].body.reasoning, { effort }, `${id} ${unified} sends ${effort}`);
    }
    assert.deepEqual(mk.resolveMarketplaceThinking(id, "none"), { level: null, valid: false }, `${id}: none is refused before any request`);
    assert.deepEqual(mk.resolveMarketplaceThinking(id, null), { level: "medium", valid: true }, `${id}: nothing chosen is Medium`);
  }
});

test("saved selections: GPT-6 Sol, GPT-6.1 Sol and GPT-6 Astra open as their 6.2 successors with a notice; their levels carry; old replies keep their names", () => {
  for (const [old, now, oldName, newName] of [["gpt-6-sol", "gpt-6.2-sol", "GPT-6 Sol", "GPT-6.2 Sol"], ["gpt-6.1-sol", "gpt-6.2-sol", "GPT-6.1 Sol", "GPT-6.2 Sol"], ["gpt-6-astra", "gpt-6.2-astra", "GPT-6 Astra", "GPT-6.2 Astra"]]) {
    assert.equal(mk.currentThirdPartyKey(old), now, old);
    assert.equal(resolveExecutableModelKey(old).modelKey, now, `${old}: an old client's request runs the successor`);
    assert.deepEqual(mk.thirdPartyReplacement(old), { from: old, to: now, fromName: oldName, toName: newName });
    assert.equal(mk.RETIRED_THIRD_PARTY_NAMES[old], oldName, `${old}: replies it wrote keep its name`);
    assert.equal(mk.THIRD_PARTY_MODELS.some((m) => m.id === old), false, `${old} is no longer offered`);
  }
  assert.equal(mk.inheritedThinkingLevel("gpt-6.1-sol", "xhigh"), "xhigh", "a remembered level the successor also has carries over");
  assert.equal(mk.inheritedThinkingLevel("gpt-6-sol", "none"), "low", "GPT-6 Sol's none becomes low (6.2 refuses none)");
  for (const id of Object.keys(MODELS)) assert.equal(mk.marketplaceThinking(id).levels.includes("none"), false);
});

test("streaming: text arrives as it is written, and the usage keeps cache reads and cache writes apart", async () => {
  for (const id of Object.keys(MODELS)) {
    const frames = [
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "there." },
      { type: "response.completed", response: { usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 700 }, output_tokens_details: { reasoning_tokens: 12 } } } },
    ];
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    const sent = [];
    const deltas = [];
    const { data } = await callModelStreaming(id, [{ role: "user", content: "Hi" }], undefined, {
      fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); },
      onDelta: (text) => deltas.push(text),
      reasoning: { exact: true, effort: "medium" },
    });
    assert.equal(sent[0].stream, true);
    assert.equal(sent[0].model, id);
    assert.equal(deltas.join(""), "Hello there.");
    assert.equal(data.choices[0].message.content, "Hello there.");
    assert.equal(data.usage.prompt_tokens_details.cached_tokens, 300);
    assert.equal(data.usage.prompt_tokens_details.cache_write_tokens, 700, "cache writes reach billing");
    assert.deepEqual(normalizedProviderUsage(data.usage), { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 300, cacheWriteInputTokens: 700, reasoningTokens: 12 });
  }
});

test("tool calls: tools go through the Responses API (never Chat Completions), and the model's call comes back as a tool call", async () => {
  const tools = CHAT_TOOLS.slice(0, 2);
  assert.ok(tools.length >= 1);
  for (const id of Object.keys(MODELS)) {
    const { calls, fetchImpl } = capture(() => Response.json({
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: tools[0].function.name, arguments: "{}" }],
      usage: { input_tokens: 50, output_tokens: 8 },
    }));
    const { data } = await callModelWithFallback(id, [{ role: "user", content: "Use a tool" }], tools, { fetchImpl, reasoning: { exact: true, effort: "medium" } });
    assert.equal(calls[0].url, `${BASE}/responses`, "tools on the Responses API");
    assert.equal(calls[0].body.tool_choice, "auto");
    assert.deepEqual(calls[0].body.tools.map((t) => [t.type, t.name]), tools.map((t) => ["function", t.function.name]), "every tool is kept");
    assert.equal(calls[0].body.store, false, "tools do not change storage");
    assert.deepEqual(calls[0].body.reasoning, { effort: "medium" }, "and reasoning stays on with tools");
    const call = data.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, tools[0].function.name);
    assert.equal(call.id, "call_1");
  }
});

test("billing: documented rates, cache reads and writes, the long-context tier, and the 10% markup, exactly", () => {
  const exact = (pricing, { input, output, cached = 0, writes = 0 }) => {
    const rates = input >= 272000 ? pricing.overrides[0] : pricing;
    const pico = (usd) => BigInt(Math.round(Number(usd) * 1e12));
    const total = BigInt(input - cached - writes) * pico(rates.prompt) + BigInt(cached) * pico(rates.input_cache_read) + BigInt(writes) * pico(rates.input_cache_write) + BigInt(output) * pico(rates.completion);
    return Number((total + 500_000n) / 1_000_000n);
  };
  for (const id of Object.keys(MODELS)) {
    const price = marketplace.livePriceFromEvidence({ endpoint: { pricing: PRICING[id] } });
    assert.equal(price.cacheWriteUsdPerToken, Number(PRICING[id].input_cache_write), `${id}: the write rate is read, not assumed`);
    for (const tokens of [{ input: 10_000, output: 500 }, { input: 50_000, output: 1_000, cached: 10_000, writes: 30_000 }, { input: 300_001, output: 2_222, cached: 100_000, writes: 50_000 }]) {
      const raw = marketplace.rawCostMicrosFromPrice(price, { inputTokens: tokens.input, outputTokens: tokens.output, cachedInputTokens: tokens.cached ?? 0, cacheWriteInputTokens: tokens.writes ?? 0 });
      assert.equal(raw, exact(PRICING[id], tokens), `${id} ${JSON.stringify(tokens)}`);
      assert.equal(marketplace.thirdPartyCharge(raw).chargedMicros, Math.ceil(raw * 1.1 - 1e-9), "cost plus 10%, once");
    }
  }
  // Astra 6.2 is cheaper than GPT-6 Astra (OpenAI: 20% lower input and output, 60% lower cached input): $8 / $40 / $0.40 per million.
  const astra = marketplace.livePriceFromEvidence({ endpoint: { pricing: PRICING["gpt-6.2-astra"] } });
  assert.deepEqual([astra.inputUsdPerToken * 1e6, astra.outputUsdPerToken * 1e6, Number((astra.cacheReadUsdPerToken * 1e6).toFixed(4))], [8, 40, 0.4]);
  // Before this change a cache-write token was billed at the input rate: 1.10x input against a 1.25x cost. It is now 1.25x, then +10%.
  const one = marketplace.rawCostMicrosFromPrice(marketplace.livePriceFromEvidence({ endpoint: { pricing: PRICING["gpt-6.2-sol"] } }), { inputTokens: 200_000, cacheWriteInputTokens: 200_000 });
  assert.equal(one, 500_000, "200,000 written tokens cost $0.50 on Sol ($2.50 per million), not $0.40");
  const long = marketplace.rawCostMicrosFromPrice(marketplace.livePriceFromEvidence({ endpoint: { pricing: PRICING["gpt-6.2-sol"] } }), { inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000 });
  assert.equal(long, 5_000_000, "above 272K prompt tokens the write rate doubles ($5.00 per million)");
});
