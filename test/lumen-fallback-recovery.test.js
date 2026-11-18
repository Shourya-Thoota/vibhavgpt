import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { approveLumenStages } from "./lumen-approvals.js";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { config } = await import("../src/config.js");
const { callModelStreaming, callModelWithFallback, InferenceUnavailableError } = await import("../src/chat/providers.js");
const { createUsageTracker } = await import("../src/usage/service.js");

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

function sse(chunks, signal) {
  return new Response(new ReadableStream({
    async start(controller) {
      for (const { delay = 0, chunk } of chunks) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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

const fast = { idleTimeoutMs: 300, firstOutputTimeoutMs: 60, overallTimeoutMs: 20_000, startRetryDelaysMs: [5, 10] };
const route = (stage) => `${config.providerBaseUrls[stage]}/chat/completions`;

beforeEach(() => {
  for (const key of ["primaryFree", "gatewayFree", "secondaryFree", "reserveFree"]) {
    config.providerKeys[key] = "fixture-key";
    config.providerBaseUrls[key] = `https://${key.toLowerCase()}.fixture.test/v1`;
  }
  for (const key of ["lumen", "lumenFallback1", "lumenFallback2", "lumenFallback3"]) {
    config.chatModels[key] = `fixture-${key}`;
  }
  approveLumenStages(config);
  config.lumenApprovals.secondary = { approved: false, model: undefined };
  config.lumenApprovals.reserve = { approved: false, model: undefined };
});

test("primary endpoint returns 429 -> automatic switch to approved fallback -> successful stream", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];

  const { data, internalStage } = await callModelStreaming("lumen", [{ role: "user", content: "Ping #2. Reply with one short word." }], undefined, {
    ...fast,
    requestId: "req-fallback-429",
    usageTracker: createUsageTracker("user-1", "lumen", "normal", db),
    fetchImpl: async (url, init) => {
      requests.push(url);
      const model = JSON.parse(init.body).model;
      if (model === config.chatModels.lumen) {
        return Response.json({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: 429 } }, { status: 429 });
      }
      return sse(reply("Fallback-Word"), init.signal);
    },
  });

  assert.equal(internalStage, "gatewayFree");
  assert.equal(data.choices[0].message.content, "Fallback-Word");
  assert.deepEqual(requests, [route("primaryFree"), route("gatewayFree")]);

  const fallbackLogs = logs("inference_internal_fallback");
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0].fromStage, "primaryFree");
  assert.equal(fallbackLogs[0].toStage, "gatewayFree");
  assert.equal(fallbackLogs[0].status, 429);

  const completed = logs("inference_stream_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].stage, "gatewayFree");

  assert.deepEqual((await usageRows(client)).map((r) => [r.input_tokens, r.output_tokens]), [[10, 2]]);
});

test("primary stalls before output -> fallback succeeds", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];

  const { data, internalStage } = await callModelStreaming("lumen", [{ role: "user", content: "hi" }], undefined, {
    ...fast,
    requestId: "req-stall-fallback",
    usageTracker: createUsageTracker("user-2", "lumen", "normal", db),
    fetchImpl: async (url, init) => {
      requests.push(url);
      const model = JSON.parse(init.body).model;
      if (model === config.chatModels.lumen) return quiet(init);
      return sse(reply("Recovered"), init.signal);
    },
  });

  assert.equal(internalStage, "gatewayFree");
  assert.equal(data.choices[0].message.content, "Recovered");
  assert.deepEqual(requests, [route("primaryFree"), route("primaryFree"), route("gatewayFree")]);

  const fallbackLogs = logs("inference_internal_fallback");
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0].fromStage, "primaryFree");
  assert.equal(fallbackLogs[0].toStage, "gatewayFree");
  assert.equal(fallbackLogs[0].reason, "provider-stalled");
});

test("primary returns reasoning-only empty content -> fallback succeeds", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];

  const emptyReasoningStream = (init) => sse([
    { chunk: { choices: [{ delta: { reasoning: "Thinking deeply about ping..." } }] } },
    { chunk: { choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 20 } } },
  ], init.signal);

  const { data, internalStage } = await callModelStreaming("lumen", [{ role: "user", content: "Ping" }], undefined, {
    ...fast,
    requestId: "req-empty-recovery",
    usageTracker: createUsageTracker("user-3", "lumen", "normal", db),
    fetchImpl: async (url, init) => {
      requests.push(url);
      const model = JSON.parse(init.body).model;
      if (model === config.chatModels.lumen) return emptyReasoningStream(init);
      return sse(reply("Valid-Word"), init.signal);
    },
  });

  assert.equal(internalStage, "gatewayFree");
  assert.equal(data.choices[0].message.content, "Valid-Word");
  assert.deepEqual(requests, [route("primaryFree"), route("primaryFree"), route("gatewayFree")]);

  const fallbackLogs = logs("inference_internal_fallback");
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0].reason, "provider-empty-response");
});

test("primary fails mid-stream after partial output reached client -> NO silent replay or restart", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];
  const seenDeltas = [];

  await assert.rejects(
    callModelStreaming("lumen", [{ role: "user", content: "tell story" }], undefined, {
      ...fast,
      requestId: "req-midstream-fail",
      usageTracker: createUsageTracker("user-4", "lumen", "normal", db),
      onDelta: (text) => { seenDeltas.push(text); return true; },
      fetchImpl: async (url, init) => {
        requests.push(url);
        return sse([
          { chunk: { choices: [{ delta: { content: "Beginning of story..." } }] } },
          { delay: 10, chunk: { error: { message: "Internal server error", code: 503 } } },
        ], init.signal);
      },
    }),
    (err) => err instanceof InferenceUnavailableError && err.status === 503,
  );

  assert.deepEqual(seenDeltas, ["Beginning of story..."]);
  assert.deepEqual(requests, [route("primaryFree")]);
  assert.deepEqual(logs("inference_internal_fallback"), []);
  assert.equal(logs("inference_midstream_failure_no_fallback").length, 1);
});

test("unapproved candidates receive ZERO requests when approved candidates fail", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];

  await assert.rejects(
    callModelStreaming("lumen", [{ role: "user", content: "test" }], undefined, {
      ...fast,
      maxRetries: 0,
      requestId: "req-exhaustion",
      usageTracker: createUsageTracker("user-5", "lumen", "normal", db),
      fetchImpl: async (url, init) => {
        requests.push(url);
        return new Response("", { status: 503 });
      },
    }),
    (err) => err instanceof InferenceUnavailableError && err.exhausted === true,
  );

  assert.deepEqual(requests, [route("primaryFree"), route("gatewayFree")]);
  assert.equal(logs("inference_exhausted").length, 1);
});

test("sequential requests: turn 1 primary succeeds, turn 2 primary 429 recovers on fallback", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);

  const res1 = await callModelStreaming("lumen", [{ role: "user", content: "Ping #1. Reply with one short word." }], undefined, {
    ...fast,
    requestId: "req-turn-1",
    usageTracker: createUsageTracker("user-6", "lumen", "normal", db),
    fetchImpl: async (_url, init) => sse(reply("Hi"), init.signal),
  });
  assert.equal(res1.internalStage, "primaryFree");
  assert.equal(res1.data.choices[0].message.content, "Hi");

  const res2 = await callModelStreaming("lumen", [
    { role: "user", content: "Ping #1. Reply with one short word." },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Ping #2. Reply with one short word." },
  ], undefined, {
    ...fast,
    requestId: "req-turn-2",
    usageTracker: createUsageTracker("user-6", "lumen", "normal", db),
    fetchImpl: async (url, init) => {
      const model = JSON.parse(init.body).model;
      if (model === config.chatModels.lumen) {
        return Response.json({ error: { message: "Too many requests", type: "rate_limit_error", code: 429 } }, { status: 429 });
      }
      return sse(reply("Pong"), init.signal);
    },
  });
  assert.equal(res2.internalStage, "gatewayFree");
  assert.equal(res2.data.choices[0].message.content, "Pong");
});

test("non-streaming callModelWithFallback: 429 on primary recovers on approved fallback", async (t) => {
  const { client, db } = await database(t);
  const logs = captureLogs(t);
  const requests = [];

  const res = await callModelWithFallback("lumen", [{ role: "user", content: "test" }], undefined, {
    ...fast,
    requestId: "req-nonstream-fallback",
    usageTracker: createUsageTracker("user-7", "lumen", "normal", db),
    fetchImpl: async (url, init) => {
      requests.push(url);
      const model = JSON.parse(init.body).model;
      if (model === config.chatModels.lumen) {
        return Response.json({ error: { message: "Rate limit exceeded" } }, { status: 429 });
      }
      return Response.json({ choices: [{ message: { content: "Non-streaming success" } }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
    },
  });

  assert.equal(res.internalStage, "gatewayFree");
  assert.equal(res.data.choices[0].message.content, "Non-streaming success");
  assert.deepEqual(requests, [route("primaryFree"), route("gatewayFree")]);
  assert.equal(logs("inference_internal_fallback").length, 1);
});
