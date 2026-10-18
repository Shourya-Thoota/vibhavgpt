import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// A streamed reply that stalls or fails before any output is tried again, and
// only the try that answers is counted. The usage tracker is the real one, on
// an in-memory database with every migration applied.
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { config } = await import("../src/config.js");
const { callModelStreaming, callModelWithFallback, InferenceUnavailableError } = await import("../src/chat/providers.js");
const { createUsageTracker } = await import("../src/usage/service.js");
const { responseError } = await import("../frontend/src/api.js");

const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
async function database(t) {
  const client = new PGlite();
  t.after(() => client.close());
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const usageRows = async (client) => (await client.query("SELECT model, input_tokens, output_tokens, reserved_tokens FROM usage_events ORDER BY created_at")).rows;

const encoder = new TextEncoder();
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
// An SSE body that sends each chunk after its delay, then ends.
function sse(chunks, signal) {
  return new Response(new ReadableStream({
    async start(controller) {
      for (const { delay = 0, chunk } of chunks) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (signal?.aborted) return;
        controller.enqueue(encoder.encode(frame(chunk)));
      }
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
const reply = (text = "Hi there", delay = 0) => [
  { delay, chunk: { id: "gen-ok", choices: [{ delta: { content: text } }] } },
  { chunk: { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
];
// Headers arrive, then only keep-alives: a stall before the first word.
const quiet = (init) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(": PROCESSING\n\n"));
    init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
  },
}), { headers: { "Content-Type": "text/event-stream" } });

function captureLogs(t) {
  const events = [];
  const originals = { info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(originals)) {
    console[level] = (line) => { try { events.push(JSON.parse(line)); } catch { /* not a log event */ } };
  }
  t.after(() => Object.assign(console, originals));
  return (name) => events.filter((event) => event.event === name);
}

const fast = { idleTimeoutMs: 400, firstOutputTimeoutMs: 60, overallTimeoutMs: 20_000, startRetryDelaysMs: [5, 10] };

beforeEach(() => {
  config.providerKeys.paid = "fixture-key";
  config.chatModels.nova = "fixture-nova";
  config.chatModels.vesper = "fixture-vesper";
  config.routeProviders.nova = ["fixture-route"];
  config.lumenPrimaryApproved = true;
  for (const key of ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"]) config.providerKeys[key] = "fixture-key";
  for (const key of ["lumen", "lumenFallback1", "lumenFallback2", "lumenFallback3"]) config.chatModels[key] = `fixture-${key}`;
});

test("a stall before any output is retried, and the reply that answers counts exactly once", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  let calls = 0;
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, requestId: "req-retry", usageTracker: createUsageTracker("user-a", "nova", "normal", db),
    fetchImpl: async (_url, init) => (++calls === 1 ? quiet(init) : sse(reply(), init.signal)),
  });
  assert.equal(calls, 2);
  assert.equal(data.choices[0].message.content, "Hi there");
  assert.deepEqual(await usageRows(client), [{ model: "nova", input_tokens: 10, output_tokens: 2, reserved_tokens: 0 }]);
  const [retry] = logs("inference_retry");
  assert.equal(logs("inference_retry").length, 1);
  assert.equal(retry.requestId, "req-retry");
  assert.equal(retry.attempt, 1);
  assert.equal(retry.reason, "provider-stalled");
  assert.ok(retry.elapsedMs >= 60 && retry.elapsedMs < 400, `stall caught by the first-output wait, not the idle wait (${retry.elapsedMs} ms)`);
  assert.deepEqual(logs("inference_exhausted"), []);
  assert.equal(logs("inference_stream_completed")[0].attempts, 2);
});

test("stalls on every try end with a retryable error, release usage and log exhaustion", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  let calls = 0;
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, requestId: "req-stalled", usageTracker: createUsageTracker("user-b", "nova", "normal", db),
    fetchImpl: async (_url, init) => { calls += 1; return quiet(init); },
  }), (error) => error instanceof InferenceUnavailableError && error.exhausted === true
    && error.code === "inference-unavailable" && error.status === 503 && error.stageCode === "provider-stalled");
  assert.equal(calls, 3);
  assert.deepEqual(await usageRows(client), [], "no try is charged and no hold is left");
  assert.deepEqual(logs("inference_retry").map((event) => [event.attempt, event.reason, event.delayMs]), [[1, "provider-stalled", 5], [2, "provider-stalled", 10]]);
  const [exhausted] = logs("inference_exhausted");
  assert.equal(logs("inference_exhausted").length, 1);
  assert.equal(exhausted.requestId, "req-stalled");
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.reason, "provider-stalled");
  // Two 60 ms waits, then the last try waits the full 400 ms.
  assert.ok(exhausted.totalElapsedMs >= 520, `${exhausted.totalElapsedMs} ms`);
});

test("a transient 5xx before any output is retried the same way", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  let calls = 0;
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, usageTracker: createUsageTracker("user-c", "nova", "normal", db),
    fetchImpl: async (_url, init) => (++calls < 3 ? new Response("", { status: 502 }) : sse(reply(), init.signal)),
  });
  assert.equal(calls, 3);
  assert.equal(data.choices[0].message.content, "Hi there");
  assert.equal((await usageRows(client)).length, 1);
  assert.deepEqual(logs("inference_retry").map((event) => [event.reason, event.status]), [["provider-http-error", 502], ["provider-http-error", 502]]);

  calls = 0;
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, fetchImpl: async () => { calls += 1; return new Response("", { status: 503 }); },
  }), (error) => error.exhausted === true && error.stageCode === "provider-http-error");
  assert.equal(calls, 3);
});

test("only the last try waits the full idle time for its first output", async (t) => {
  captureLogs(t);
  let calls = 0;
  // Every try would answer after 150 ms: past the 60 ms first-output wait,
  // inside the 400 ms idle wait the last try gets.
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, fetchImpl: async (_url, init) => { calls += 1; return sse(reply("Slow start", 150), init.signal); },
  });
  assert.equal(calls, 3);
  assert.equal(data.choices[0].message.content, "Slow start");
});

test("a route with a configured fallback moves to it after its retry", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];
  const route = (stage) => `${config.providerBaseUrls[stage]}/chat/completions`;
  const { data, internalStage } = await callModelStreaming("lumen", [{ role: "user", content: "hi" }], undefined, {
    ...fast, usageTracker: createUsageTracker("user-d", "lumen", "normal", db),
    fetchImpl: async (url, init) => { requests.push(url); return url === route("primaryFree") ? quiet(init) : sse(reply("From the fallback"), init.signal); },
  });
  assert.deepEqual(requests, [route("primaryFree"), route("primaryFree"), route("gatewayFree")]);
  assert.equal(internalStage, "gatewayFree");
  assert.equal(data.choices[0].message.content, "From the fallback");
  assert.deepEqual((await usageRows(client)).map((row) => [row.input_tokens, row.output_tokens]), [[10, 2]]);
  assert.equal(logs("inference_retry").length, 1);
  assert.deepEqual(logs("inference_exhausted"), []);
});

test("nothing is retried once text has reached the user", async (t) => {
  const logs = captureLogs(t);
  let calls = 0;
  const seen = [];
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, overallTimeoutMs: 60_000, onDelta: (text) => { seen.push(text); return true; },
    fetchImpl: async (_url, init) => { calls += 1; return sse([{ chunk: { choices: [{ delta: { content: "Half a rep" } }] } }, { delay: 2_000, chunk: { choices: [{ delta: { content: "ly" } }] } }], init.signal); },
  }), (error) => error instanceof InferenceUnavailableError && !error.exhausted && error.stageCode === "provider-stalled");
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["Half a rep"]);
  assert.deepEqual(logs("inference_retry"), []);
  assert.deepEqual(logs("inference_exhausted"), []);
});

test("the exhausted error reaches the user as the friendly message with its reference and a Retry", async () => {
  const router = await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8");
  // Other lines (a comment, the error report) may come before the send. The
  // conversation the user's saved message is in rides along (...saved).
  assert.match(router, /error instanceof InferenceUnavailableError && error\.exhausted\) \{\n(?:.*\n){1,4}?\s*send\("error", \{ error: failureMessage\(requestId\), code: error\.code, retryable: true, status: error\.status, requestId, \.\.\.saved \}\);/);
  assert.match(router, /const failureMessage = \(requestId\) => `We couldn't complete this response\. Please try again\. If it keeps happening, contact support and share reference \$\{requestId\}\.`;/);
  // The client shows the server's text for this code; it is not an access banner.
  const message = "We couldn't complete this response. Please try again. If it keeps happening, contact support and share reference ref-1.";
  const error = responseError({ error: message, code: "inference-unavailable", retryable: true, requestId: "ref-1" }, 503);
  assert.equal(error.message, message);
  assert.equal(error.access, null);
});

// Streamed thinking. The clock is mocked: setTimeout and Date move only when
// ticked, so these use the production waits (15 s first output, 20 s idle,
// 120 s per message) in simulated time.
const production = { idleTimeoutMs: 20_000, firstOutputTimeoutMs: 15_000, overallTimeoutMs: 120_000 };
const thinking = (text = "weighing the options") => ({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text }] } }] });
const answerChunks = (text) => [
  { chunk: { choices: [{ delta: { content: text } }] } },
  { chunk: { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
];

async function onMockClock(t, start, { stepMs = 10, maxMs = 200_000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let settled = false;
  const result = start();
  result.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; !settled && elapsed <= maxMs; elapsed += stepMs) {
    for (let flush = 0; flush < 5 && !settled; flush += 1) await new Promise((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(stepMs);
  }
  try { return await result; } finally { t.mock.timers.reset(); }
}

test("a reply that thinks for 20 s before its first word is not retried", async (t) => {
  const logs = captureLogs(t);
  let calls = 0;
  // Thinking every 2 s for 20 s: past the 15 s first-output wait, inside the
  // 20 s idle wait each time.
  const chunks = [...Array.from({ length: 10 }, () => ({ delay: 2_000, chunk: thinking() })), ...answerChunks("Final answer")];
  const { data } = await onMockClock(t, () => callModelStreaming("vesper", [{ role: "user", content: "hi" }], undefined, {
    ...production, fetchImpl: async (_url, init) => { calls += 1; return sse(chunks, init.signal); },
  }));
  assert.equal(calls, 1);
  assert.equal(data.choices[0].message.content, "Final answer");
  assert.deepEqual(logs("inference_retry"), []);
  const [completed] = logs("inference_stream_completed");
  assert.ok(completed.firstReasoningMs >= 2_000 && completed.firstReasoningMs < 2_100, `firstReasoningMs ${completed.firstReasoningMs}`);
  assert.ok(completed.firstOutputMs >= 20_000 && completed.firstOutputMs < 20_200, `firstOutputMs measures the first real text (${completed.firstOutputMs})`);
  assert.equal(completed.firstTokenMs, completed.firstOutputMs);
});

test("a stream that sends nothing is still retried at the 15 s first-output limit", async (t) => {
  const logs = captureLogs(t);
  let calls = 0;
  const { data } = await onMockClock(t, () => callModelStreaming("vesper", [{ role: "user", content: "hi" }], undefined, {
    ...production, fetchImpl: async (_url, init) => (++calls === 1 ? quiet(init) : sse(answerChunks("Second try"), init.signal)),
  }));
  assert.equal(calls, 2);
  assert.equal(data.choices[0].message.content, "Second try");
  const [retry] = logs("inference_retry");
  assert.equal(retry.reason, "provider-stalled");
  assert.ok(retry.elapsedMs >= 15_000 && retry.elapsedMs < 15_100, `stalled at the first-output limit (${retry.elapsedMs} ms)`);
  assert.equal(logs("inference_stream_completed")[0].firstReasoningMs, null);
});

test("streamed thinking never appears in the visible reply", async (t) => {
  captureLogs(t);
  const seen = [];
  const chunks = [{ chunk: thinking("SECRET-THOUGHT") }, { delay: 1_000, chunk: thinking("MORE-THOUGHT") }, ...answerChunks("Hello")];
  const { data } = await onMockClock(t, () => callModelStreaming("vesper", [{ role: "user", content: "hi" }], undefined, {
    ...production, onDelta: (text) => { seen.push(text); return true; },
    fetchImpl: async (_url, init) => sse(chunks, init.signal),
  }));
  assert.deepEqual(seen, ["Hello"]);
  assert.equal(data.choices[0].message.content, "Hello");
  assert.doesNotMatch(JSON.stringify(data), /SECRET-THOUGHT|MORE-THOUGHT/);
});

test("the 120 s per-message cap still ends a reply that only thinks", async (t) => {
  const logs = captureLogs(t);
  let calls = 0;
  // Thinking every 5 s for 200 s, never a word.
  const chunks = [...Array.from({ length: 40 }, () => ({ delay: 5_000, chunk: thinking() })), ...answerChunks("Too late")];
  const started = { at: null };
  await assert.rejects(onMockClock(t, () => {
    started.at = Date.now();
    return callModelStreaming("vesper", [{ role: "user", content: "hi" }], undefined, {
      ...production, fetchImpl: async (_url, init) => { calls += 1; return sse(chunks, init.signal); },
    }).finally(() => { started.elapsed = Date.now() - started.at; });
  }, { stepMs: 50 }), (error) => error instanceof InferenceUnavailableError);
  assert.equal(calls, 1);
  assert.ok(started.elapsed >= 120_000 && started.elapsed < 121_000, `ended at the cap (${started.elapsed} ms)`);
  assert.deepEqual(logs("inference_stream_failed").map((event) => event.code), ["provider-timeout"]);
  assert.deepEqual(logs("inference_retry"), []);
});

test("readable thinking goes to onReasoning; encrypted thinking and the reply never mix with it", async (t) => {
  captureLogs(t);
  const thought = [], seen = [];
  const chunks = [
    { chunk: { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "Looking at the question. " }] } }] } },
    { chunk: { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "OPAQUE-BLOB" }, { type: "reasoning.summary", summary: "Plan: answer briefly." }] } }] } },
    ...answerChunks("Short answer"),
  ];
  const { data } = await callModelStreaming("vesper", [{ role: "user", content: "hi" }], undefined, {
    ...fast, onReasoning: (text) => thought.push(text), onDelta: (text) => { seen.push(text); return true; },
    fetchImpl: async (_url, init) => sse(chunks, init.signal),
  });
  assert.deepEqual(thought, ["Looking at the question. ", "Plan: answer briefly."]);
  assert.deepEqual(seen, ["Short answer"]);
  assert.equal(data.choices[0].message.content, "Short answer");
  assert.doesNotMatch(JSON.stringify({ thought, data }), /OPAQUE-BLOB/);
});

test("a retry before any output is reported to onRetry with the attempt and the total", async (t) => {
  captureLogs(t);
  const retries = [];
  let calls = 0;
  await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, onRetry: (retry) => retries.push(retry),
    fetchImpl: async (_url, init) => (++calls < 3 ? quiet(init) : sse(reply(), init.signal)),
  });
  assert.deepEqual(retries, [
    { attempt: 2, maxAttempts: 3, reason: "provider-stalled" },
    { attempt: 3, maxAttempts: 3, reason: "provider-stalled" },
  ]);
});

// A provider error event inside the stream (for example a 502 from the
// upstream model) before any output: the eb239dbf failure.
const streamError = (code, message) => ({ chunk: { error: { code, message } } });

test("a 502 error event before any output is retried cleanly and the reply counts once", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  let calls = 0;
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, requestId: "req-502", usageTracker: createUsageTracker("user-502", "nova", "normal", db),
    fetchImpl: async (_url, init) => (++calls === 1
      ? sse([streamError(502, "Upstream failed for a.b@example.com with key sk-or-v1-secret1234567890")], init.signal)
      : sse(reply("After the retry"), init.signal)),
  });
  assert.equal(calls, 2);
  assert.equal(data.choices[0].message.content, "After the retry");
  assert.deepEqual((await usageRows(client)).map((row) => [row.input_tokens, row.output_tokens, row.reserved_tokens]), [[10, 2, 0]], "counted once, no hold left");
  const [failed] = logs("inference_stream_failed");
  assert.equal(failed.code, "provider-stream-error");
  assert.equal(failed.status, 502);
  assert.equal(failed.receivedChars, 0);
  assert.equal(failed.providerCode, "502");
  assert.equal(failed.providerMessage, "Upstream failed for [email] with key [redacted]", "the provider's message, without secrets");
  assert.deepEqual(logs("inference_retry").map((event) => [event.attempt, event.reason, event.status]), [[1, "provider-stream-error", 502]]);
});

test("tries with no tokens never surface as usage-unavailable, and leave no hold", async (t) => {
  const { client, db } = await database(t);
  captureLogs(t);
  const notUsageUnavailable = (error) => error instanceof InferenceUnavailableError && error.code === "inference-unavailable";

  // A 502 error event on every try.
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, usageTracker: createUsageTracker("user-x", "nova", "normal", db),
    fetchImpl: async (_url, init) => sse([streamError(502, "Upstream failed")], init.signal),
  }), (error) => notUsageUnavailable(error) && error.exhausted === true && error.stageCode === "provider-stream-error");

  // The connection drops before anything arrives.
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, usageTracker: createUsageTracker("user-x", "nova", "normal", db),
    fetchImpl: async () => { throw new Error("socket hang up"); },
  }), notUsageUnavailable);

  // The user leaves while the provider is still silent.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    ...fast, signal: controller.signal, usageTracker: createUsageTracker("user-x", "nova", "normal", db),
    fetchImpl: async (_url, init) => quiet(init),
  }), notUsageUnavailable);

  assert.deepEqual(await usageRows(client), [], "every reservation was released");
});

// Why a provider refused a request: the start of its 4xx body, scrubbed.
const lumenRoute = (stage) => `${config.providerBaseUrls[stage]}/chat/completions`;
const PRIVATE_PROMPT = "please summarise my private medical history notes";
const refusals = {
  // An OpenAI-style body that quotes the request back.
  [lumenRoute("primaryFree")]: () => Response.json({ error: {
    code: "context_length_exceeded",
    message: `Please reduce the length of the messages for someone@example.com (key sk-abcdef1234567890) near "${PRIVATE_PROMPT}"`,
  } }, { status: 400 }),
  // Plain text.
  [lumenRoute("gatewayFree")]: () => new Response("Forbidden: this key may not use the requested model", { status: 403 }),
  // A list of errors, as some providers send.
  [lumenRoute("secondaryFree")]: () => Response.json([{ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }], { status: 401 }),
};
const expectedRefusals = [
  ["primaryFree", 400, "context_length_exceeded", "Please reduce the length of the messages for [email] (key [redacted]) near [quoted]"],
  ["gatewayFree", 403, null, "Forbidden: this key may not use the requested model"],
  ["secondaryFree", 401, "401", "API key not valid. Please pass a valid API key."],
];

for (const [name, call, event, success] of [
  ["streaming", callModelStreaming, "inference_stream_failed", (init) => sse(reply(), init.signal)],
  ["non-streaming", callModelWithFallback, "inference_stage_failed", () => Response.json({ choices: [{ message: { content: "Hi there" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })],
]) {
  test(`${name}: a provider's 4xx reason is read, scrubbed and logged, and the chain moves on`, async (t) => {
    const logs = captureLogs(t);
    const result = await call("lumen", [{ role: "user", content: PRIVATE_PROMPT }], undefined, {
      ...fast, maxRetries: 0, requestId: "req-refused",
      fetchImpl: async (url, init) => refusals[url]?.() ?? success(init),
    });
    assert.equal(result.internalStage, "reserveFree");
    const failures = logs(event).map((entry) => [entry.stage, entry.providerStatus, entry.providerCode, entry.providerMessage]);
    assert.deepEqual(failures, expectedRefusals);
    assert.doesNotMatch(JSON.stringify(logs(event)), /medical|someone@|sk-abc/, "no prompt text, email or key reaches the log");
  });
}

test("a 5xx body is not read; its status alone is logged", async (t) => {
  const logs = captureLogs(t);
  await callModelStreaming("lumen", [{ role: "user", content: "hi" }], undefined, {
    ...fast, maxRetries: 0,
    fetchImpl: async (url, init) => url === lumenRoute("primaryFree")
      ? Response.json({ error: { code: "upstream", message: "Upstream detail" } }, { status: 503 })
      : sse(reply(), init.signal),
  });
  const [failed] = logs("inference_stream_failed");
  assert.deepEqual([failed.stage, failed.providerStatus, failed.providerCode, failed.providerMessage], ["primaryFree", 503, null, null]);
});

// A reply that reached the user is never turned into an error afterwards.
test("a reply that finishes without token counts completes and is settled at an estimate", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const text = "Here is the whole answer, delivered.";
  const noUsage = [
    { chunk: { id: "gen-1", choices: [{ delta: { content: text } }] } },
    { chunk: { choices: [{ delta: {}, finish_reason: "stop" }] } },
  ];
  const prompt = [{ role: "user", content: "hi" }];
  const delivered = [];
  const { data, internalStage } = await callModelStreaming("lumen", prompt, undefined, {
    ...fast, requestId: "req-unreported", usageTracker: createUsageTracker("user-u", "lumen", "normal", db),
    onDelta: (delta) => { delivered.push(delta); return true; },
    fetchImpl: async (_url, init) => sse(noUsage, init.signal),
  });
  assert.equal(internalStage, "primaryFree");
  assert.equal(data.choices[0].message.content, text);
  assert.equal(delivered.join(""), text);
  const { requestTokenEstimate, replyTokenEstimate } = await import("../src/chat/context-window.js");
  const estimate = { prompt_tokens: requestTokenEstimate(prompt), completion_tokens: replyTokenEstimate({ content: text }) };
  assert.deepEqual(logs("usage_unreported_on_success").map(({ requestId, stage, prompt_tokens, completion_tokens }) => ({ requestId, stage, prompt_tokens, completion_tokens })),
    [{ requestId: "req-unreported", stage: "primaryFree", ...estimate }]);
  const rows = await usageRows(client);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].input_tokens, rows[0].output_tokens], [estimate.prompt_tokens, estimate.completion_tokens], "settled at the estimate, not left as a hold");

  // The same for a reply that arrives whole.
  const whole = await callModelWithFallback("lumen", prompt, undefined, {
    usageTracker: createUsageTracker("user-u", "lumen", "normal", db),
    fetchImpl: async () => Response.json({ choices: [{ message: { content: text } }] }),
  });
  assert.equal(whole.data.choices[0].message.content, text);
  assert.equal((await usageRows(client)).length, 2);
  assert.equal(logs("usage_unreported_on_success").length, 2);
});

test("a reply with real token counts is settled at those counts, with no estimate", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  await callModelStreaming("lumen", [{ role: "user", content: "hi" }], undefined, {
    ...fast, usageTracker: createUsageTracker("user-c", "lumen", "normal", db),
    fetchImpl: async (_url, init) => sse(reply(), init.signal),
  });
  const [row] = await usageRows(client);
  assert.deepEqual([row.input_tokens, row.output_tokens], [10, 2]);
  assert.deepEqual(logs("usage_unreported_on_success"), []);
});
