import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { approveLumenStages } from "./lumen-approvals.js";

// usage/service.js loads the database client, which needs a URL; nothing here
// connects to it.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
const { callModelStreaming, callModelWithFallback } = await import("../src/chat/providers.js");
const { MODEL_REASONING, PROVIDER_EFFORTS, reasoningParameter } = await import("../src/chat/reasoning-effort.js");
const { thinkingUsageFor } = await import("../src/usage/service.js");

// The thinking levels the app offers (Normal, Low, High, Extra High,
// Maximum) reach each paid tier as a reasoning setting its model accepts.
// Normal is a real level, never left unset. Routes without the parameter
// (Lumen, Study) never get it.
const MODELS = { nova: "anthropic/claude-haiku-5.5", nebula: "google/gemini-3.8-flash", vesper: "gpt-6.1-terra" };
const LEVELS = ["low", "normal", "high", "xhigh", "max"];
const EXPECTED = {
  // Nova accepts low, medium, high, xhigh, max:
  // Unified levels (2026-11-16): High (and older Extra High and Max) is the engine's highest level.
  nova: { low: { effort: "low" }, normal: { effort: "medium" }, high: { effort: "max" }, xhigh: { effort: "max" }, max: { effort: "max" } },
  // Nebula (google/gemini-3.8-flash) accepts low, medium, high with mandatory thinking:
  nebula: { low: { effort: "low" }, normal: { effort: "medium" }, high: { effort: "high" }, xhigh: { effort: "high" }, max: { effort: "high" } },
  // Vulcan (gpt-6.1-terra) accepts none, low, medium, high, xhigh, max:
  vesper: { low: { effort: "low" }, normal: { effort: "medium" }, high: { effort: "max" }, xhigh: { effort: "max" }, max: { effort: "max" } },
};

beforeEach(() => {
  config.providerKeys.paid = "fixture-key";
  config.providerKeys.direct = "fixture-key";
  config.providerKeys.study = "fixture-key";
  for (const [key, model] of Object.entries(MODELS)) config.chatModels[key] = model;
  config.nebulaDataPolicyVerified = true;
  config.vesperDataPolicyVerified = true;
});

const answer = () => Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const streamAnswer = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

// The reasoning field of the request a tier sends for one level, the way the
// chat route passes it (thinkingUsageFor's providerEffort).
async function sentReasoning(tier, level, streaming) {
  let body;
  const reasoning = level === false ? false : thinkingUsageFor(tier, level).providerEffort;
  const call = streaming ? callModelStreaming : callModelWithFallback;
  await call(tier, [{ role: "user", content: "hi" }], undefined, {
    reasoning, onDelta: () => true, maxRetries: 0,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/generation")) return new Response("{}", { status: 404 });
      body = JSON.parse(init.body);
      return streaming ? streamAnswer() : answer();
    },
  });
  return body.reasoning;
}

for (const streaming of [false, true]) {
  test(`${streaming ? "streaming" : "non-streaming"}: every level maps to the setting each tier's model accepts`, async () => {
    for (const tier of Object.keys(MODELS)) {
      for (const level of LEVELS) {
        assert.deepEqual(await sentReasoning(tier, level, streaming), EXPECTED[tier][level], `${tier} ${level}`);
      }
    }
  });
}

test("Normal is never left unconfigured, and Vulcan gets the balanced medium level", async () => {
  for (const tier of Object.keys(MODELS)) {
    assert.equal(thinkingUsageFor(tier, "normal").providerEffort, "medium", `${tier}: an older Normal is sent as Medium, never dropped`);
    assert.notEqual(await sentReasoning(tier, "normal", true), undefined, `${tier} sends a reasoning setting`);
  }
  assert.deepEqual(await sentReasoning("vesper", "normal", false), { effort: "medium" });
  // A model not in the table gets the standard level: Normal is medium there too.
  assert.deepEqual(reasoningParameter("some/unlisted-model", "normal"), { effort: "medium" });
  assert.deepEqual(reasoningParameter("some/unlisted-model", null), { effort: "medium" });
});

test("no level ever sends an effort the model does not list", () => {
  for (const [model, capability] of Object.entries(MODEL_REASONING)) {
    for (const level of [...LEVELS, null, "medium", "unexpected"]) {
      const parameter = reasoningParameter(model, level);
      if (capability.efforts === null) assert.deepEqual(parameter, level === "low" ? { enabled: false, exclude: true } : { enabled: true }, `${model} ${level}`);
      else {
        assert.ok(capability.efforts.includes(parameter.effort), `${model} ${level} -> ${parameter.effort}`);
        assert.ok(PROVIDER_EFFORTS.includes(parameter.effort));
      }
    }
  }
});

test("an internal step that must not think turns thinking off, or to the lightest hidden level where it is mandatory", async () => {
  assert.deepEqual(await sentReasoning("nova", false, false), { effort: "none" });
  assert.deepEqual(await sentReasoning("nebula", false, false), { effort: "low", exclude: true });
  assert.deepEqual(await sentReasoning("vesper", false, false), { effort: "none" });
});

test("routes and models without the reasoning parameter never get it", async () => {
  // Lumen's stages and Study send no reasoning object.
  for (const key of ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"]) config.providerKeys[key] = "fixture-key";
  for (const key of ["lumen", "lumenFallback1", "lumenFallback2", "lumenFallback3"]) config.chatModels[key] = `fixture-${key}`;
  approveLumenStages(config);
  config.providerKeys.study = "fixture-key";
  config.chatModels.study = "fixture-study";
  for (const [tier, level] of [["lumen", "high"], ["study", thinkingUsageFor("study", "high").providerEffort]]) {
    let body;
    await callModelWithFallback(tier, [{ role: "user", content: "hi" }], undefined, { reasoning: level, maxRetries: 0, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); } });
    assert.equal(body.reasoning, undefined, `${tier} sends no reasoning object`);
  }
  // A paid model marked as not supporting the parameter gets none either.
  MODEL_REASONING["fixture/no-reasoning-model"] = { reasoning: false };
  try {
    for (const level of [...LEVELS, null, false]) assert.equal(reasoningParameter("fixture/no-reasoning-model", level), undefined, String(level));
    config.chatModels.nova = "fixture/no-reasoning-model";
    let body;
    await callModelWithFallback("nova", [{ role: "user", content: "hi" }], undefined, { reasoning: "high", maxRetries: 0, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); } });
    assert.equal("reasoning" in body, false);
  } finally {
    delete MODEL_REASONING["fixture/no-reasoning-model"];
  }
});

test("the capability table matches what the production models list", () => {
  // From the router's model list (reasoning.supported_efforts / mandatory),
  // checked when this table was written. A model change needs a new entry.
  assert.deepEqual(MODEL_REASONING["anthropic/claude-haiku-5.5"], { efforts: ["none", "low", "medium", "high", "xhigh", "max"], mandatory: false });
  assert.deepEqual(MODEL_REASONING["google/gemini-3.8-flash"], { efforts: ["low", "medium", "high"], mandatory: true });
  assert.deepEqual(MODEL_REASONING["gpt-6.1-terra"], { efforts: ["none", "low", "medium", "high", "xhigh", "max"], mandatory: false });
  assert.deepEqual(MODEL_REASONING["openai/gpt-6.1-terra"], { efforts: ["minimal", "low", "medium", "high", "xhigh"], mandatory: false });
  assert.deepEqual(MODEL_REASONING["deepseek/deepseek-v4.1-flash"], { efforts: ["low", "high", "max"], mandatory: false });
  assert.deepEqual(MODEL_REASONING["moonshotai/kimi-k2.6"], { efforts: null, mandatory: false });
  assert.deepEqual(MODEL_REASONING["x-ai/grok-4.7"], { efforts: ["low", "medium", "high", "xhigh"], mandatory: true });
});

test("absent thinking preference defaults to low for supported tiers, while explicit normal and other levels are preserved", () => {
  for (const tier of ["nova", "nebula", "vesper"]) {
    assert.deepEqual(thinkingUsageFor(tier), { effort: "low", providerEffort: "low" }, `${tier} absent defaults to low`);
    assert.deepEqual(thinkingUsageFor(tier, undefined), { effort: "low", providerEffort: "low" }, `${tier} undefined defaults to low`);
    assert.deepEqual(thinkingUsageFor(tier, null), { effort: "low", providerEffort: "low" }, `${tier} null defaults to low`);
    assert.deepEqual(thinkingUsageFor(tier, ""), { effort: "low", providerEffort: "low" }, `${tier} empty defaults to low`);
  }

  for (const tier of ["nova", "nebula", "vesper"]) {
    assert.deepEqual(thinkingUsageFor(tier, "normal"), { effort: "medium", providerEffort: "medium" }, `${tier} an explicit older Normal is Medium`);
    assert.deepEqual(thinkingUsageFor(tier, "medium"), { effort: "medium", providerEffort: "medium" }, `${tier} Medium`);
  }

  for (const tier of ["nova", "nebula", "vesper"]) {
    // High (and an older Extra High or Max) asks for the engine's highest level.
    for (const level of ["high", "xhigh", "max"]) assert.deepEqual(thinkingUsageFor(tier, level), { effort: "max", providerEffort: "max" }, `${tier} ${level} is High`);
  }

  assert.deepEqual(thinkingUsageFor("lumen"), { effort: "normal", providerEffort: "normal" });
  assert.deepEqual(thinkingUsageFor("lumen", "high"), { effort: "normal", providerEffort: "normal" });
  assert.deepEqual(thinkingUsageFor("study"), { effort: "normal", providerEffort: "none" });
  assert.deepEqual(thinkingUsageFor("study", "high"), { effort: "normal", providerEffort: "none" });
});

test("normalizeThinkingEffort defaults to low when absent, and preserves valid efforts", async () => {
  const { normalizeThinkingEffort } = await import("../src/usage/service.js");
  assert.equal(normalizeThinkingEffort(undefined), "low");
  assert.equal(normalizeThinkingEffort(null), "low");
  assert.equal(normalizeThinkingEffort(""), "low");
  assert.equal(normalizeThinkingEffort("normal"), "normal");
  assert.equal(normalizeThinkingEffort("low"), "low");
  assert.equal(normalizeThinkingEffort("medium"), "medium");
  assert.equal(normalizeThinkingEffort("high"), "high");
  assert.equal(normalizeThinkingEffort("xhigh"), "xhigh");
  assert.equal(normalizeThinkingEffort("max"), "max");
  assert.equal(normalizeThinkingEffort("invalid", "low"), "low");
  assert.equal(normalizeThinkingEffort("invalid", "normal"), "normal");
});

test("a model whose thinking is only on or off answers directly on Low and thinks on every other level", () => {
  // Nebula's model in production (2026-11-09) is on/off only; Low is its default level.
  const model = "moonshotai/kimi-k2.6";
  assert.deepEqual(MODEL_REASONING[model], { efforts: null, mandatory: false });
  assert.deepEqual(reasoningParameter(model, "low"), { enabled: false, exclude: true }, "Low: no silent thinking before the answer");
  for (const level of ["normal", "high", "xhigh", "max", null]) assert.deepEqual(reasoningParameter(model, level), { enabled: true }, String(level));
  assert.deepEqual(reasoningParameter(model, false), { enabled: false, exclude: true }, "internal steps stay off");
});
