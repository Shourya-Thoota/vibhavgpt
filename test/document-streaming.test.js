import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { callModelStreaming } from "../src/chat/providers.js";

// An SSE response that sends each chunk after its delay, then ends.
function sse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const { delay = 0, line } of chunks) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        controller.enqueue(encoder.encode(`${line}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const delta = (content, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content }, ...extra }] })}`;

async function withKey(run) {
  const original = config.providerKeys.paid;
  config.providerKeys.paid = "test-key";
  config.chatModels.nova = "fixture-nova";
  config.chatModels.nebula = "fixture-nebula";
  config.novaProvider = "obsolete-provider";
  config.nebulaDataPolicyVerified = true;
  try { return await run(); } finally { config.providerKeys.paid = original; }
}

// Runs a streaming call on a mocked clock: setTimeout and Date only move when
// this ticks them, so the stream's chunk delays and the idle timer are
// measured in exact simulated milliseconds and a busy machine cannot stretch
// a gap. Between ticks it lets real I/O callbacks and promises settle, so
// each chunk is read before the clock moves on.
async function onMockClock(t, start, { stepMs = 10, maxMs = 10_000 } = {}) {
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

test("a long document that keeps streaming is never cut off by the idle timeout", (t) => withKey(async () => {
  let body;
  // 8 x 90ms = 720ms in total, far past the 100ms idle limit, but no gap ever
  // reaches it. The clock is mocked, so every gap is exactly 90ms.
  const chunks = Array.from({ length: 8 }, (_, i) => ({ delay: 90, line: delta(`part${i} `) }));
  chunks.push({ line: delta("", { finish_reason: "stop" }) }, { line: `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 42 } })}` }, { line: "data: [DONE]" });
  const { data } = await onMockClock(t, () => callModelStreaming("nebula", [{ role: "user", content: "doc" }], undefined, {
    idleTimeoutMs: 100,
    overallTimeoutMs: 5_000,
    reasoning: false,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return sse(chunks); },
  }));
  assert.equal(data.choices[0].message.content.trim(), "part0 part1 part2 part3 part4 part5 part6 part7");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.usage.completion_tokens, 42);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
}));

test("a stream that goes silent mid-document still hits the idle timeout", (t) => withKey(async () => {
  // Same 100ms limit and 90ms rhythm, then one 150ms gap: that gap must stop it.
  const chunks = [
    ...Array.from({ length: 3 }, (_, i) => ({ delay: 90, line: delta(`part${i} `) })),
    { delay: 150, line: delta("too late") },
    { line: "data: [DONE]" },
  ];
  await assert.rejects(onMockClock(t, () => callModelStreaming("nebula", [{ role: "user", content: "doc" }], undefined, {
    idleTimeoutMs: 100,
    overallTimeoutMs: 5_000,
    reasoning: false,
    fetchImpl: async () => sse(chunks),
  })), (error) => error.stageCode === "provider-stalled");
}));

test("a provider that goes quiet fails fast instead of holding the request", () => withKey(async () => {
  const started = Date.now();
  await assert.rejects(callModelStreaming("nebula", [{ role: "user", content: "doc" }], undefined, {
    idleTimeoutMs: 80,
    overallTimeoutMs: 5_000,
    // Keep-alive comments are not progress.
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      setTimeout(() => resolve(sse([{ line: ": ROUTER PROCESSING" }, { delay: 2_000, line: delta("late") }])), 10);
    }).then((response) => response),
  }), (error) => error.stageCode === "provider-stalled");
  assert.ok(Date.now() - started < 1_500);
}));

test("chat replies stream visible text and tool calls; a stall before any text retries once, a stall after text does not", () => withKey(async () => {
  const seen = [];
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], [{ type: "function", function: { name: "web_search" } }], {
    overallTimeoutMs: 60_000,
    onDelta: (text) => { seen.push(text); return true; },
    fetchImpl: async () => sse([
      { line: delta("Hel") }, { line: delta("lo") },
      { line: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"q' } }] } }] })}` },
      { line: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }, finish_reason: "tool_calls" }] })}` },
    ]),
  });
  assert.deepEqual(seen, ["Hel", "lo"]);
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"q":1}');

  const quiet = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    resolve(sse([{ delay: 2_000, line: delta("late") }]));
  });
  let calls = 0;
  const { data: retried } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    idleTimeoutMs: 60, overallTimeoutMs: 60_000,
    fetchImpl: async (_url, init) => (++calls === 1 ? quiet(init) : sse([{ line: delta("Hi there") }, { line: `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}` }])),
  });
  assert.equal(calls, 2);
  assert.equal(retried.choices[0].message.content, "Hi there");

  calls = 0;
  await assert.rejects(callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    idleTimeoutMs: 60, overallTimeoutMs: 60_000, onDelta: () => true,
    fetchImpl: async () => { calls += 1; return sse([{ line: delta("Half a rep") }, { delay: 2_000, line: delta("ly") }]); },
  }));
  assert.equal(calls, 1);
}));
