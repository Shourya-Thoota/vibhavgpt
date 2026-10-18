import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { config } from "../src/config.js";
import { MODEL_CONFIGS, callModelWithFallback, callModelStreaming } from "../src/chat/providers.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";
import { providerTermsPattern } from "./provider-terms.js";
import { approveLumenStages } from "./lumen-approvals.js";

const NOVA_PROVIDERS = config.routeProviders.nova;
const NEBULA_PROVIDERS = config.routeProviders.nebula;
const endpoint = (stage) => `${config.providerBaseUrls[stage]}/chat/completions`;

beforeEach(() => {
  for (const key of Object.keys(MODEL_CONFIGS)) config.chatModels[key] = `fixture-${key}`;
  config.providerKeys.paid = "fixture-key";
  config.providerKeys.study = "fixture-key";
  config.lumenPrimaryApproved = true;
  for (const key of ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"]) config.providerKeys[key] = "fixture-key";
  for (const key of ["lumenFallback1", "lumenFallback2", "lumenFallback3"]) config.chatModels[key] = `fixture-${key}`;
  approveLumenStages(config);
  config.nebulaDataPolicyVerified = true;
});
const messages = [{ role: "user", content: "Reply with OK" }];
const answer = (usage = { prompt_tokens: 10, completion_tokens: 2 }) => Response.json({ choices: [{ message: { content: "OK" } }], usage });

const lumenEndpoints = ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"].map(endpoint);
const lumenModels = ["lumen", "lumenFallback1", "lumenFallback2", "lumenFallback3"];
function streamResponse(chunks) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const streamAnswer = () => streamResponse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]);

for (const [name, call, success] of [["non-streaming", callModelWithFallback, answer], ["streaming", callModelStreaming, streamAnswer]]) {
  for (const kind of ["http", "json", ...(name === "streaming" ? ["sse"] : [])]) {
    test(`Lumen ${name} advances immediately after ${kind} quota rejection and releases rejected holds`, async () => {
      const requests = [], recorded = [];
      let releases = 0;
      const result = await call("lumen", messages, undefined, {
        usageTracker: { beforeCall: async () => {}, record: async (usage) => { assert.ok(usage?.prompt_tokens); recorded.push(usage); }, release: async () => releases++ },
        fetchImpl: async (url) => {
          requests.push(url);
          if (requests.length === 4) return success();
          const error = { code: "RESOURCE_EXHAUSTED", message: "Provider quota exceeded" };
          if (kind === "http") return new Response("", { status: requests.length === 2 ? 402 : 429, headers: { "Retry-After": "3600" } });
          return kind === "json" ? Response.json({ error, usage: {} }) : streamResponse([{ error }]);
        },
      });
      assert.equal(result.data.choices[0].message.content, "OK");
      assert.deepEqual(requests, lumenEndpoints);
      assert.equal(releases, 3);
      assert.deepEqual(recorded, [{ prompt_tokens: 10, completion_tokens: 2 }]);
    });
  }
  test(`Lumen ${name} errors only after all four providers reject quota`, async () => {
    const requests = [];
    await assert.rejects(call("lumen", messages, undefined, {
      fetchImpl: async (url) => { requests.push(url); return new Response("", { status: 429 }); },
    }), /temporarily unavailable/);
    assert.deepEqual(requests, lumenEndpoints);
  });
}

test("Lumen preserves Google's signed streaming tool calls only on Google replay", async () => {
  const signedCall = { index: 0, id: "call-google", type: "function", function: { name: "weather", arguments: '{ "location": "London" }' }, extra_content: { google: { thought_signature: "opaque-signature" } } };
  const result = await callModelStreaming("lumen", messages, undefined, {
    fetchImpl: async (url) => url === lumenEndpoints[3]
      ? streamResponse([{ choices: [{ delta: { tool_calls: [signedCall] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }])
      : new Response("", { status: 429 }),
  });
  const replayCall = result.data.choices[0].message.tool_calls[0];
  assert.deepEqual(replayCall.extra_content, signedCall.extra_content);
  const history = [...messages, { role: "assistant", content: null, tool_calls: [replayCall] }, { role: "tool", tool_call_id: replayCall.id, content: "Weather is sunny" }];
  for (const [call, success] of [[callModelWithFallback, answer], [callModelStreaming, streamAnswer]]) {
    await call("lumen", history, undefined, { fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === lumenEndpoints[0]) {
        assert.equal(body.messages[1].tool_calls, undefined);
        assert.equal(body.messages[2].role, "system");
      } else {
        assert.deepEqual(body.messages[1].tool_calls[0].extra_content, url === lumenEndpoints[3] ? signedCall.extra_content : undefined);
      }
      return url === lumenEndpoints[3] ? success() : new Response("", { status: 429 });
    } });
  }
});

for (const [name, call, success] of [["non-streaming", callModelWithFallback, answer], ["streaming", callModelStreaming, streamAnswer]]) {
  for (let successIndex = 0; successIndex < 4; successIndex++) {
    test(`Lumen ${name} reaches route ${successIndex + 1} in order and settles each attempt`, async () => {
      const requests = [], actions = [];
      const usageTracker = { beforeCall: async () => actions.push("reserve"), record: async (usage) => actions.push(usage), release: async () => actions.push("release") };
      const result = await call("lumen", messages, undefined, { maxRetries: 0, usageTracker,
        fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body), headers: init.headers }); return requests.length - 1 === successIndex ? success() : new Response("", { status: 503 }); },
      });
      assert.equal(result.data.choices[0].message.content, "OK");
      assert.deepEqual(requests.map((r) => r.url), lumenEndpoints.slice(0, successIndex + 1));
      assert.deepEqual(requests.map((r) => r.body.model), lumenModels.slice(0, successIndex + 1).map((key) => config.chatModels[key]));
      for (const r of requests) { assert.equal(r.body.provider, undefined); assert.equal(r.headers.Authorization, "Bearer fixture-key"); }
      if (successIndex > 0) assert.equal(requests[1].headers["X-Free-Fallback"], "false");
      assert.deepEqual(actions, [...Array.from({ length: successIndex }, () => ["reserve", "release"]).flat(), "reserve", { prompt_tokens: 10, completion_tokens: 2 }]);
    });
  }
  test(`Lumen ${name} has bounded retries across all four routes`, async () => {
    const requests = [];
    await assert.rejects(call("lumen", messages, undefined, { fetchImpl: async (url) => { requests.push(url); return new Response("", { status: 503 }); } }), /temporarily unavailable/);
    assert.deepEqual(requests, lumenEndpoints.flatMap((url) => [url, url]));
  });
  test(`Lumen ${name} stops before inference on cancellation, expiry, or quota denial`, async () => {
    let requests = 0;
    const fetchImpl = async () => { requests++; return success(); };
    await assert.rejects(call("lumen", messages, undefined, { signal: AbortSignal.abort(), fetchImpl }), /temporarily unavailable/);
    await assert.rejects(call("lumen", messages, undefined, { deadlineAt: Date.now() - 1, fetchImpl }), /temporarily unavailable/);
    const denied = new Error("quota fixture");
    await assert.rejects(call("lumen", messages, undefined, { fetchImpl, usageTracker: { beforeCall: async () => { throw denied; } } }), (e) => e === denied);
    assert.equal(requests, 0);
  });
}

test("Lumen streaming clears partial output before falling back and starts a clean stream", async () => {
  let calls = 0;
  const seen = [];
  await callModelStreaming("lumen", messages, undefined, { maxRetries: 0,
    onDelta: (text, full) => { seen.push({ text, full }); return true; }, onReset: () => seen.push("reset"),
    fetchImpl: async () => ++calls === 1 ? streamResponse([
      { choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      { error: { code: 503 } },
    ]) : streamAnswer(),
  });
  assert.equal(calls, 2);
  assert.deepEqual(seen, [{ text: "partial", full: "partial" }, "reset", { text: "OK", full: "OK" }]);
});

test("Lumen streaming without reset support stops after partial delivery", async () => {
  let calls = 0;
  await assert.rejects(callModelStreaming("lumen", messages, undefined, {
    onDelta: () => true, fetchImpl: async () => { calls++; return streamResponse([{ choices: [{ delta: { content: "partial" } }] }, { error: { code: 503 } }]); },
  }), /temporarily unavailable/);
  assert.equal(calls, 1);
});

test("Lumen rejects an unapproved primary and skips missing routes without requesting them", async () => {
  config.lumenPrimaryApproved = false;
  config.chatModels.lumenFallback1 = undefined;
  const requests = [];
  await callModelWithFallback("lumen", messages, undefined, { fetchImpl: async (url) => { requests.push(url); return answer(); } });
  assert.deepEqual(requests, [lumenEndpoints[2]]);
});

test("a failed try without confirmed usage is released, never settled, and the Lumen fallback continues in both paths", async () => {
  for (const call of [callModelWithFallback, callModelStreaming]) {
    const urls = [];
    let reserves = 0, releases = 0;
    await assert.rejects(call("lumen", messages, undefined, { fetchImpl: async (url) => { urls.push(url); throw new Error("transport interrupted"); },
      usageTracker: { beforeCall: async () => { reserves++; }, record: async () => assert.fail("no usage was confirmed, so nothing is settled"), release: async () => releases++ },
    }), /temporarily unavailable/);
    // Every route is tried (a retry each), instead of stopping at the first.
    assert.deepEqual([...new Set(urls)], lumenEndpoints);
    assert.equal(releases, reserves, "every reservation is released");
  }
});

test("settlement failure after a successful reply stops both paths", async () => {
  for (const [call, success] of [[callModelWithFallback, answer], [callModelStreaming, streamAnswer]]) {
    let calls = 0;
    await assert.rejects(call("lumen", messages, undefined, { fetchImpl: async () => { calls++; return success(); },
      usageTracker: { beforeCall: async () => {}, record: async () => { throw new Error("settlement failed fixture"); }, release: async () => assert.fail("must retain hold") },
    }), /settlement failed fixture/);
    assert.equal(calls, 1);
  }
});

test("the legacy Spark key and unknown keys use Lumen's direct primary in both response paths", async () => {
  // "qwen" is a retired key with no alias left; it is routed like any unknown key.
  for (const key of ["spark", "qwen", "not-a-model"]) for (const [call, success] of [[callModelWithFallback, answer], [callModelStreaming, streamAnswer]]) {
    let request;
    await call(key, messages, undefined, { fetchImpl: async (url, init) => { request = { url, body: JSON.parse(init.body) }; return success(); } });
    assert.equal(request.url, lumenEndpoints[0]);
    assert.equal(request.body.model, config.chatModels.lumen);
  }
});

test("Nova allows exactly its configured route providers and ignores obsolete single-provider settings", async () => {
  assert.deepEqual(NOVA_PROVIDERS, process.env.CHAT_NOVA_ROUTE_PROVIDERS.split(","));
  config.novaProvider = "obsolete-provider";
  let body;
  await callModelWithFallback("nova", messages, undefined, { fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); } });
  assert.deepEqual(body.provider.only, [...NOVA_PROVIDERS]);
  assert.equal(body.provider.sort, "price");
  assert.equal(body.provider.allow_fallbacks, true);
  assert.equal(body.provider.data_collection, "deny");
  assert.equal(body.provider.order, undefined);
});

test("streaming Nova keeps its price-sorted no-training shortlist through retries", async () => {
  const requests = [];
  await assert.rejects(callModelStreaming("nova", messages, undefined, { imageInput: true,
    fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return new Response("", { status: 429 }); },
  }), /temporarily unavailable/);
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.url, endpoint("paid"));
    assert.deepEqual(r.body.provider, { only: [...NOVA_PROVIDERS], sort: "price", allow_fallbacks: true, data_collection: "deny" });
  }
});

test("Lumen's small primary omits unsupported tools and router-only parameters", async () => {
  let body;
  await callModelWithFallback("lumen", messages, [{ type: "function", function: { name: "fixture" } }], { reasoning: "high",
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); },
  });
  assert.equal(body.tools, undefined); assert.equal(body.reasoning, undefined); assert.equal(body.provider, undefined);
});

for (const key of ["nova"]) {
  for (const imageInput of [false, true]) {
    test(`${key} uses its approved provider shortlist for text and images, including rate-limit retries (${imageInput})`, async () => {
      const requests = [];
      await assert.rejects(callModelWithFallback(key, messages, undefined, { imageInput,
        fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return new Response("", { status: 429 }); },
      }), /temporarily unavailable/);
      assert.equal(requests.length, 2);
      for (const { url, body } of requests) {
        assert.equal(url, endpoint("paid"));
        assert.equal(body.model, config.chatModels[key]);
        assert.deepEqual(body.provider, { only: [...NOVA_PROVIDERS], sort: "price", allow_fallbacks: true, data_collection: "deny" });
      }
    });
  }
}

test("a missing model ID makes no inference request", async () => {
  let calls = 0;
  config.chatModels.nova = undefined;
  await assert.rejects(callModelWithFallback("nova", messages, undefined, { fetchImpl: async () => { calls++; return answer(); } }), /temporarily unavailable/);
  assert.equal(calls, 0);
});

test("Nebula fails closed until its specific route's data policy is verified", async () => {
  config.nebulaDataPolicyVerified = false;
  let calls = 0;
  await assert.rejects(callModelWithFallback("nebula", messages, undefined, { fetchImpl: async () => { calls++; return answer(); } }), /temporarily unavailable/);
  assert.equal(calls, 0);
});

test("Study uses its configured direct API route, image input, function calls, and no reasoning", async () => {
  const vision = [{ role: "user", content: [{ type: "text", text: "Explain this" }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }];
  const tools = [{ type: "function", function: { name: "fixture_tool", parameters: { type: "object" } } }];
  let request;
  await callModelWithFallback("study", vision, tools, { maxTokens: 512, reasoning: "max", fetchImpl: async (url, init) => { request = { url, body: JSON.parse(init.body) }; return answer(); } });
  assert.equal(request.url, endpoint("study"));
  assert.equal(request.body.model, config.chatModels.study);
  assert.equal(request.body.reasoning_effort, "none");
  assert.equal(request.body.max_completion_tokens, 512);
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.messages, vision);
  assert.deepEqual(request.body.tools, tools);
  assert.equal(request.body.provider, undefined);
});

test("Nebula normal effort disables hidden reasoning in both response paths, while explicit effort is preserved", async () => {
  for (const streaming of [false, true]) for (const reasoning of [null, "high"]) {
    let body;
    const fetchImpl = async (_url, init) => {
      body = JSON.parse(init.body);
      return streaming ? streamResponse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]) : answer();
    };
    const call = streaming ? callModelStreaming : callModelWithFallback;
    await call("nebula", messages, undefined, { reasoning, fetchImpl, onDelta: () => true });
    assert.deepEqual(body.reasoning, reasoning === null ? { enabled: false, exclude: true } : { effort: "high" });
    assert.deepEqual(body.provider.only, NEBULA_PROVIDERS);
    assert.equal(body.provider.data_collection, "deny");
  }
});

test("a chosen thinking effort is requested with its thinking returned on every paid tier", async () => {
  for (const key of ["nova", "nebula", "vesper"]) {
    for (const reasoning of [null, "low", "medium", "high", "xhigh", "max"]) {
      let body;
      await callModelStreaming(key, messages, undefined, { reasoning, onDelta: () => true, fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return streamResponse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
      } });
      if (reasoning === null) {
        // Normal effort: Nebula keeps thinking off; the others use the model's default.
        assert.deepEqual(body.reasoning, key === "nebula" ? { enabled: false, exclude: true } : undefined, `${key} normal`);
      } else {
        assert.deepEqual(body.reasoning, { effort: reasoning }, `${key} ${reasoning}`);
      }
    }
  }
});

test("Nebula and Vesper use configured models with the no-collection filter", async () => {
  for (const key of ["nebula", "vesper"]) {
    let body;
    await callModelWithFallback(key, messages, undefined, { reasoning: false, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); } });
    assert.equal(body.model, config.chatModels[key]);
    assert.equal(body.provider.allow_fallbacks, key === "nebula");
    assert.equal(body.provider.data_collection, "deny");
    assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
  }
});

test("permanent errors and exhausted deadlines do not retry or expose upstream errors", async () => {
  for (const status of [401, 422]) {
    let calls = 0;
    await assert.rejects(callModelWithFallback("vesper", messages, undefined, { fetchImpl: async () => { calls++; return new Response("secret upstream fixture", { status }); } }), (error) => error.message === "VibhavGPT is temporarily unavailable. Please try again shortly.");
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(callModelWithFallback("nova", messages, undefined, { deadlineAt: Date.now() - 1, fetchImpl: async () => { calls++; return answer(); } }), /temporarily unavailable/);
  assert.equal(calls, 0);
});

test("all public identities and product facts contain only branded model names and token allowances", () => {
  assert.deepEqual(Object.keys(MODEL_CONFIGS), ["lumen", "nova", "study", "nebula", "vesper"]);
  for (const [key, model] of Object.entries(MODEL_CONFIGS)) {
    const prompt = buildIdentitySystemPrompt(key);
    assert.ok(prompt.includes(model.displayName));
    assert.match(prompt, /rolling 5-hour token caps/);
    assert.doesNotMatch(prompt, /Halo|\u2014/);
    assert.doesNotMatch(prompt, providerTermsPattern);
  }
});

for (const [name, call, success] of [["non-streaming", callModelWithFallback, answer], ["streaming", callModelStreaming, streamAnswer]]) {
  test(`Lumen ${name}: a small-context primary gets an output ceiling that fits its window, or is not asked at all`, async () => {
    const { requestTokenEstimate } = await import("../src/chat/context-window.js");
    config.chatModels.lumen = "allam-2-7b";
    const send = async (prompt, maxTokens) => {
      const requests = [];
      await call("lumen", prompt, undefined, { maxTokens, maxRetries: 0, fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return success(); } });
      return requests;
    };
    // Plenty of room: the configured budget is kept.
    let [request] = await send(messages, 2_048);
    assert.equal(request.url, lumenEndpoints[0]);
    assert.equal(request.body.max_tokens, 2_048);
    // Input plus output may not pass 4,096: the budget shrinks to what is left after a margin.
    const medium = [{ role: "system", content: "x".repeat(9_000) }, ...messages];
    [request] = await send(medium, 2_048);
    assert.equal(request.body.max_tokens, 4_096 - requestTokenEstimate(medium) - 256);
    assert.ok(request.body.max_tokens >= 256 && request.body.max_tokens < 2_048);
    // A prompt that cannot fit is not sent; the next route answers with its full budget.
    const large = [{ role: "system", content: "x".repeat(18_000) }, ...messages];
    const requests = await send(large, 2_048);
    assert.deepEqual(requests.map((r) => r.url), [lumenEndpoints[1]]);
    assert.equal(requests[0].body.max_tokens, 2_048);
    // Other models keep whatever budget they are given.
    config.chatModels.lumen = "fixture-lumen";
    [request] = await send(large, 6_000);
    assert.equal(request.body.max_tokens, 6_000);
  });
}

test("the generated-image byline follows the model naming and is never a model key", async () => {
  const { IMAGE_DISPLAY_NAME, getModelConfig } = await import("../src/chat/providers.js");
  assert.equal(IMAGE_DISPLAY_NAME, "VibhavGPT Image");
  for (const model of Object.values(MODEL_CONFIGS)) assert.match(model.displayName, /^VibhavGPT [A-Z][a-z]+$/);
  assert.match(IMAGE_DISPLAY_NAME, /^VibhavGPT [A-Z][a-z]+$/);
  assert.doesNotMatch(IMAGE_DISPLAY_NAME, providerTermsPattern);
  // A chat that asks for "image" is routed like any unknown key, never to an image model.
  assert.equal(Object.keys(MODEL_CONFIGS).includes("image"), false);
  assert.equal(getModelConfig("image"), MODEL_CONFIGS.lumen);
  const { readFile } = await import("node:fs/promises");
  const router = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(router, /model: IMAGE_DISPLAY_NAME,/);
  assert.doesNotMatch(router, /"VibhavGPT Image"/, "the label is defined once, beside the model names");
});

test("every actual attempt reserves and settles its own API usage, including empty-response retries", async () => {
  const actions = [];
  let calls = 0;
  const usageTracker = { beforeCall: async () => actions.push("reserve"), record: async (usage) => actions.push(usage.prompt_tokens), release: async () => actions.push("release") };
  await callModelWithFallback("nova", messages, undefined, { usageTracker, fetchImpl: async () => ++calls === 1 ? Response.json({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } }) : answer() });
  assert.deepEqual(actions, ["reserve", 7, "release", "reserve", 10]);
});

test("a quota denial prevents inference and propagates unchanged", async () => {
  const denial = Object.assign(new Error("You've reached your Nova limit"), { reason: "quota", status: 429 });
  let calls = 0;
  await assert.rejects(callModelWithFallback("nova", messages, undefined, { usageTracker: { beforeCall: async () => { throw denial; } }, fetchImpl: async () => { calls++; return answer(); } }), (error) => error === denial);
  assert.equal(calls, 0);
});

test("streaming Study preserves its request settings and settles the final usage chunk", async () => {
  const actions = [];
  let body;
  const encoder = new TextEncoder();
  await callModelStreaming("study", messages, undefined, {
    usageTracker: { beforeCall: async () => actions.push("reserve"), record: async (usage) => actions.push(usage), release: async () => actions.push("release") },
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return new Response(new ReadableStream({ start(controller) {
      for (const chunk of [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.close();
    } })); },
  });
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.stream_options.include_usage, true);
  assert.deepEqual(actions, ["reserve", { prompt_tokens: 9, completion_tokens: 1 }]);
});

test("Nebula passes structured output schemas without exposing the backing route", async () => {
  const schema = { type: "json_schema", json_schema: { name: "practice", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } };
  let body;
  await callModelWithFallback("nebula", messages, undefined, { responseFormat: schema, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return answer(); } });
  assert.deepEqual(body.response_format, schema);
  assert.deepEqual(body.provider.only, NEBULA_PROVIDERS);
});
test("an interrupted transport with no confirmed usage releases its reservation and reports the provider failure", async () => {
  for (const call of [callModelWithFallback, callModelStreaming]) {
    let calls = 0;
    let reserves = 0;
    let releases = 0;
    let records = 0;
    await assert.rejects(call("study", messages, undefined, {
      fetchImpl: async () => { calls++; throw Object.assign(new Error("interrupted"), { name: "TimeoutError" }); },
      usageTracker: {
        beforeCall: async () => { reserves++; },
        record: async () => { records++; throw new Error("Token usage could not be confirmed."); },
        release: async () => { releases++; },
      },
    }), (error) => error.code === "inference-unavailable", "the provider failure is reported, not usage-unavailable");
    assert.ok(calls >= 1);
    assert.equal(records, 0, "nothing is settled without confirmed counts");
    assert.equal(releases, reserves, "every reservation is released");
  }
});

for (const [name, call, success] of [["non-streaming", callModelWithFallback, answer], ["streaming", callModelStreaming, streamAnswer]]) {
  test(`Nebula route-provider privacy policy survives ${name} retries`, async () => {
    const expected = process.env.CHAT_NEBULA_ROUTE_PROVIDERS.split(",");
    assert.deepEqual(NEBULA_PROVIDERS, expected);
    let calls = 0;
    await call("nebula", messages, undefined, { fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(url, endpoint("paid"));
      assert.equal(body.model, config.chatModels.nebula);
      assert.deepEqual(body.provider, { only: expected, sort: "price", allow_fallbacks: true, data_collection: "deny" });
      return ++calls === 1 ? new Response("", { status: 503 }) : success();
    } });
    assert.equal(calls, 2);
  });
}

test("Vesper recovers finalized usage when the last SSE frame omits it", async () => {
  const recorded = [];
  const result = await callModelStreaming("vesper", messages, undefined, {
    usageTracker: { beforeCall: async () => {}, record: async (usage) => recorded.push(usage) },
    fetchImpl: async (url, init) => {
      if (url.includes("/generation?")) {
        assert.equal(init.headers.Authorization, "Bearer fixture-key");
        return Response.json({ data: { finish_reason: "stop", native_tokens_prompt: 123, native_tokens_completion: 12 } });
      }
      // The final frame is valid even without a trailing newline.
      return new Response('data: ' + JSON.stringify({ id: "gen-fixture", choices: [{ delta: { content: "complete code" }, finish_reason: "stop" }] }));
    },
  });
  assert.equal(result.data.choices[0].message.content, "complete code");
  assert.deepEqual(recorded, [{ prompt_tokens: 123, completion_tokens: 12 }]);
});

test("Vesper premature EOF is a failure, but confirmed consumed tokens are settled", async () => {
  const recorded = [], visible = [];
  await assert.rejects(callModelStreaming("vesper", messages, undefined, {
    onDelta: (text) => { visible.push(text); return true; },
    usageTracker: { beforeCall: async () => {}, record: async (usage) => recorded.push(usage), release: async () => {} },
    fetchImpl: async (url) => url.includes("/generation?")
      ? Response.json({ data: { cancelled: true, native_tokens_prompt: 30, native_tokens_completion: 8 } })
      : streamResponse([{ id: "gen-broken", choices: [{ delta: { content: "partial code" } }] }]),
  }), (error) => error.stageCode === "provider-stream-incomplete");
  assert.deepEqual(visible, ["partial code"]);
  assert.deepEqual(recorded, [{ prompt_tokens: 30, completion_tokens: 8 }]);
});

test("completed Vesper code survives a 404 followed by delayed finalized usage", async () => {
  let inferenceCalls = 0, lookups = 0;
  const recorded = [];
  const result = await callModelStreaming("vesper", messages, undefined, {
    usageTracker: { beforeCall: async () => {}, record: async (usage) => recorded.push(usage) },
    fetchImpl: async (url) => {
      if (url.includes("/generation?")) {
        lookups++;
        if (lookups === 1) return Response.json({ error: "not found yet" }, { status: 404 });
        if (lookups === 2) return Response.json({ data: { native_tokens_prompt: 10, native_tokens_completion: 5 } });
        return Response.json({ data: { native_finish_reason: "stop", native_tokens_prompt: 42, native_tokens_completion: 123 } });
      }
      inferenceCalls++;
      return streamResponse([{ id: "gen-chess", choices: [{ delta: { content: "```html\n<html>chess game</html>\n```" }, finish_reason: "stop" }] }]);
    },
  });
  assert.equal(inferenceCalls, 1);
  assert.equal(lookups, 3);
  assert.match(result.data.choices[0].message.content, /chess game/);
  assert.deepEqual(recorded, [{ prompt_tokens: 42, completion_tokens: 123 }]);
});

test("metadata recovery stops on cancellation and does not retry authentication failures", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let lookups = 0;
    const result = await callModelStreaming("vesper", messages, undefined, {
      signal: controller.signal,
      fetchImpl: async (url) => {
        if (url.includes("/generation?")) {
          lookups++;
          if (cancel) controller.abort();
          return Response.json({}, { status: cancel ? 404 : 401 });
        }
        return streamResponse([{ id: "gen-unavailable", choices: [{ delta: { content: "code" }, finish_reason: "stop" }] }]);
      },
    });
    assert.equal(lookups, 1);
    assert.deepEqual(result.data.usage, {});
  }
});

test("metadata recovery shares the inference deadline and never estimates missing usage", async () => {
  let lookups = 0;
  const result = await callModelStreaming("vesper", messages, undefined, {
    deadlineAt: Date.now() + 80,
    fetchImpl: async (url) => {
      if (url.includes("/generation?")) { lookups++; return Response.json({}, { status: 404 }); }
      return streamResponse([{ id: "gen-deadline", choices: [{ delta: { content: "code" }, finish_reason: "stop" }] }]);
    },
  });
  assert.equal(lookups, 1);
  assert.deepEqual(result.data.usage, {});
});

test("running or unavailable metadata never turns unconfirmed consumption into free inference: a delivered reply is settled at an estimate", async () => {
  const { replyTokenEstimate, requestTokenEstimate } = await import("../src/chat/context-window.js");
  for (const data of [{ native_tokens_prompt: 30, native_tokens_completion: 8 }, { finish_reason: "stop", native_tokens_prompt: null, native_tokens_completion: null }]) {
    const settled = [];
    const result = await callModelStreaming("vesper", messages, undefined, {
      usageTracker: { beforeCall: async () => {}, record: async (usage) => { settled.push(usage); }, release: async () => assert.fail("a delivered reply is settled, not released") },
      fetchImpl: async (url) => url.includes("/generation?") ? Response.json({ data }) : streamResponse([{ id: "gen-pending", choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }]),
    });
    assert.equal(result.data.choices[0].message.content, "partial");
    assert.deepEqual(settled, [{ prompt_tokens: requestTokenEstimate(messages), completion_tokens: replyTokenEstimate({ content: "partial" }), estimated: true }]);
  }
});
