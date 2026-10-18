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
const MODELS = { nova: "deepseek/deepseek-v4.1-flash", nebula: "moonshotai/kimi-k2.6", vesper: "x-ai/grok-4.7" };
const LEVELS = ["low", "normal", "high", "xhigh", "max"];
const EXPECTED = {
  // Nova accepts low, high, max: Normal (medium) goes to the nearest, high;
  // Extra High (between high and max) goes up to max.
  nova: { low: { effort: "low" }, normal: { effort: "high" }, high: { effort: "high" }, xhigh: { effort: "max" }, max: { effort: "max" } },
  // Nebula's thinking is only on or off: every level thinks.
  nebula: { low: { enabled: true }, normal: { enabled: true }, high: { enabled: true }, xhigh: { enabled: true }, max: { enabled: true } },
  // Vesper accepts low to xhigh: Normal is medium; Maximum goes to xhigh.
  vesper: { low: { effort: "low" }, normal: { effort: "medium" }, high: { effort: "high" }, xhigh: { effort: "xhigh" }, max: { effort: "xhigh" } },
};

beforeEach(() => {
  config.providerKeys.paid = "fixture-key";
  for (const [key, model] of Object.entries(MODELS)) config.chatModels[key] = model;
  config.nebulaDataPolicyVerified = true;
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

test("Normal is never left unconfigured, and Vesper gets the balanced medium level", async () => {
  for (const tier of Object.keys(MODELS)) {
    assert.equal(thinkingUsageFor(tier, "normal").providerEffort, "normal", `${tier}: Normal is passed on, not dropped`);
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
      if (capability.efforts === null) assert.deepEqual(parameter, { enabled: true }, model);
      else {
        assert.ok(capability.efforts.includes(parameter.effort), `${model} ${level} -> ${parameter.effort}`);
        assert.ok(PROVIDER_EFFORTS.includes(parameter.effort));
      }
    }
  }
});

test("an internal step that must not think turns thinking off, or to the lightest hidden level where it is mandatory", async () => {
  assert.deepEqual(await sentReasoning("nova", false, false), { enabled: false, exclude: true });
  assert.deepEqual(await sentReasoning("nebula", false, false), { enabled: false, exclude: true });
  // Vesper's model cannot turn thinking off.
  assert.deepEqual(await sentReasoning("vesper", false, false), { effort: "low", exclude: true });
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
  assert.deepEqual(MODEL_REASONING["deepseek/deepseek-v4.1-flash"], { efforts: ["low", "high", "max"], mandatory: false });
  assert.deepEqual(MODEL_REASONING["moonshotai/kimi-k2.6"], { efforts: null, mandatory: false });
  assert.deepEqual(MODEL_REASONING["x-ai/grok-4.7"], { efforts: ["low", "medium", "high", "xhigh"], mandatory: true });
});
