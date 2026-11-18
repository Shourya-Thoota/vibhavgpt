import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);

// Close shared PGlite client after all tests complete
after(async () => {
  await client.close?.();
});

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => {
      const user = req.get("x-test-user") || "tool-loop-user";
      req.authSession = { user: { id: user } };
      next();
    },
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");

const SYNTHETIC_SIGNATURE = "synthetic-google-thought-signature-gemini-3.8-flash-loop-test-123456";
const TOKYO_WEATHER_MOCK = {
  name: "Tokyo",
  sys: { country: "JP" },
  dt: 1700000000,
  main: { temp: 18, feels_like: 18 },
  weather: [{ description: "clear sky" }],
};

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;

async function executeChatRequest({
  base,
  streaming = true,
  body,
  userId = "tool-loop-user",
}) {
  const url = `${base}/api/chat${streaming ? "/stream" : ""}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user": userId,
    },
    body: JSON.stringify(body),
  });

  if (streaming) {
    const rawText = await response.text();
    const events = rawText
      .split("\n\n")
      .map((block) => ({
        event: block.match(/^event:\s*(.+)$/m)?.[1],
        data: block.match(/^data:\s*(.+)$/m)?.[1],
      }))
      .filter((item) => item.event && item.data)
      .map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
    const complete = events.find((e) => e.event === "complete")?.data;
    const error = events.find((e) => e.event === "error")?.data;
    const text = events
      .filter((e) => e.event === "delta" && typeof e.data.text === "string")
      .map((e) => e.data.text)
      .join("");
    return {
      status: response.status,
      streaming: true,
      rawText,
      events,
      complete,
      error,
      text,
    };
  }

  const json = await response.json();
  return {
    status: response.status,
    streaming: false,
    data: json,
    text: json.reply,
  };
}

async function createHarness(t, { userId = "tool-loop-user", streaming = true } = {}) {
  const originalFetch = globalThis.fetch;
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const outboundModelRequests = [];
  let weatherCalls = 0;
  let capturedLogs = "";

  const recordLog = (...args) => {
    capturedLogs += args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n";
  };
  console.log = recordLog;
  console.info = recordLog;
  console.warn = recordLog;
  console.error = recordLog;

  // Snapshot exact original config properties (including existence / undefined status)
  const snapshot = {
    providerKeys_primaryFree: config.providerKeys?.primaryFree,
    has_providerKeys_primaryFree: "primaryFree" in (config.providerKeys ?? {}),
    providerKeys_paid: config.providerKeys?.paid,
    has_providerKeys_paid: "paid" in (config.providerKeys ?? {}),
    chatModels_vesper: config.chatModels?.vesper,
    has_chatModels_vesper: "vesper" in (config.chatModels ?? {}),
    chatModels_lumenFallback1: config.chatModels?.lumenFallback1,
    has_chatModels_lumenFallback1: "lumenFallback1" in (config.chatModels ?? {}),
    vesperTransport: config.vesperTransport,
    has_vesperTransport: "vesperTransport" in config,
    lumenChatRoute: config.lumenChatRoute,
    has_lumenChatRoute: "lumenChatRoute" in config,
    lumenPaidZdrProviders: Array.isArray(config.lumenPaidZdrProviders) ? [...config.lumenPaidZdrProviders] : config.lumenPaidZdrProviders,
    has_lumenPaidZdrProviders: "lumenPaidZdrProviders" in config,
    weatherApiKey: config.weatherApiKey,
    has_weatherApiKey: "weatherApiKey" in config,
    weatherApiUrl: config.weatherApiUrl,
    has_weatherApiUrl: "weatherApiUrl" in config,
  };

  const restoreConfig = () => {
    if (!snapshot.has_providerKeys_primaryFree) delete config.providerKeys.primaryFree;
    else config.providerKeys.primaryFree = snapshot.providerKeys_primaryFree;

    if (!snapshot.has_providerKeys_paid) delete config.providerKeys.paid;
    else config.providerKeys.paid = snapshot.providerKeys_paid;

    if (!snapshot.has_chatModels_vesper) delete config.chatModels.vesper;
    else config.chatModels.vesper = snapshot.chatModels_vesper;

    if (!snapshot.has_chatModels_lumenFallback1) delete config.chatModels.lumenFallback1;
    else config.chatModels.lumenFallback1 = snapshot.chatModels_lumenFallback1;

    if (!snapshot.has_vesperTransport) delete config.vesperTransport;
    else config.vesperTransport = snapshot.vesperTransport;

    if (!snapshot.has_lumenChatRoute) delete config.lumenChatRoute;
    else config.lumenChatRoute = snapshot.lumenChatRoute;

    if (!snapshot.has_lumenPaidZdrProviders) delete config.lumenPaidZdrProviders;
    else config.lumenPaidZdrProviders = snapshot.lumenPaidZdrProviders;

    if (!snapshot.has_weatherApiKey) delete config.weatherApiKey;
    else config.weatherApiKey = snapshot.weatherApiKey;

    if (!snapshot.has_weatherApiUrl) delete config.weatherApiUrl;
    else config.weatherApiUrl = snapshot.weatherApiUrl;
  };

  config.providerKeys.primaryFree = "";
  config.providerKeys.paid = "fixture-router-key";
  // The tool loop runs on Vulcan over the router with a Google engine, which sends a thought_signature with each tool call; the
  // follow-up turn runs on Lumen's paid zero-retention route. (This suite used Nebula and Nova until they were retired on 2026-11-14;
  // the signature handling it tests is engine-level and unchanged.)
  config.chatModels.vesper = "google/gemini-3.8-flash";
  config.vesperTransport = "router";
  config.chatModels.lumenFallback1 = "fixture-lumen";
  config.lumenChatRoute = "paid-zdr";
  config.lumenPaidZdrProviders = ["route-a/fp4"];
  config.weatherApiKey = "fixture-weather-key";
  config.weatherApiUrl = "https://mock-weather.test/weather";

  let server = null;
  // Register cleanup immediately after installing shared replacements
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    restoreConfig();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  globalThis.fetch = async (url, init) => {
    const href = String(url?.url ?? url);

    if (href.startsWith("http://127.0.0.1")) {
      return originalFetch(url, init);
    }

    if (href.startsWith(config.weatherApiUrl)) {
      weatherCalls += 1;
      return new Response(JSON.stringify(TOKYO_WEATHER_MOCK), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) {
        return new Response("{}", { status: 404 });
      }

      const parsedBody = JSON.parse(init.body);
      outboundModelRequests.push(parsedBody);

      // Turn 1: Model requests weather tool with Google thought signature
      if (outboundModelRequests.length === 1) {
        if (streaming) {
          const sseBody = [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-gemini-synth-weather",
                    type: "function",
                    function: { name: "weather", arguments: '{"location":"Tokyo"}' },
                    extra_content: { google: { thought_signature: SYNTHETIC_SIGNATURE } },
                  }],
                },
                finish_reason: "tool_calls",
              }],
              usage: { prompt_tokens: 30, completion_tokens: 15 },
            },
          ].map(frame).join("");
          return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
        }

        const jsonBody = {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-gemini-synth-weather",
                type: "function",
                function: { name: "weather", arguments: '{"location":"Tokyo"}' },
                extra_content: { google: { thought_signature: SYNTHETIC_SIGNATURE } },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 30, completion_tokens: 15 },
        };
        return new Response(JSON.stringify(jsonBody), { headers: { "Content-Type": "application/json" } });
      }

      // Turn 2: Model returns final answer after observing tool execution
      if (outboundModelRequests.length === 2) {
        const finalReply = "The weather in Tokyo is currently 18°C and clear sky.";
        if (streaming) {
          const sseBody = [
            { choices: [{ delta: { content: finalReply } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 65, completion_tokens: 14 } },
          ].map(frame).join("");
          return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
        }

        const jsonBody = {
          choices: [{
            message: {
              role: "assistant",
              content: finalReply,
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 65, completion_tokens: 14 },
        };
        return new Response(JSON.stringify(jsonBody), { headers: { "Content-Type": "application/json" } });
      }

      // Turn 3+ (Unrelated request)
      const genericReply = "I am ready to help.";
      if (streaming) {
        const sseBody = [
          { choices: [{ delta: { content: genericReply } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
        ].map(frame).join("");
        return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: genericReply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 6 },
      }), { headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Unexpected outbound network request in test: ${href}`);
  };

  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, true) ON CONFLICT DO NOTHING", [userId]);
  await client.query(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, tier, status, billing_source, cancel_at_period_end, current_period_ends_at)
    VALUES ($1, $2, $3, 'pro', 'active', 'stripe', false, now() + interval '20 days') ON CONFLICT DO NOTHING`, [userId, `cus_${userId}`, `sub_${userId}`]);

  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    outboundModelRequests,
    getWeatherCalls: () => weatherCalls,
    getCapturedLogs: () => capturedLogs,
  };
}

test("streaming tool-loop: executes tool and preserves Google thought_signature on next outbound request", async (t) => {
  const userId = "streaming-tool-user";
  const { base, outboundModelRequests, getWeatherCalls, getCapturedLogs } = await createHarness(t, { userId, streaming: true });

  const result = await executeChatRequest({
    base,
    streaming: true,
    userId,
    body: {
      model: "vesper",
      message: "What should I pack for my trip to Tokyo?",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.error, undefined);
  assert.equal(result.text, "The weather in Tokyo is currently 18°C and clear sky.");

  // Turn 1 + Turn 2 outbound calls executed
  assert.equal(outboundModelRequests.length, 2);

  // Assert expected weather tool endpoint invocation count
  assert.equal(getWeatherCalls(), 1, "weather tool endpoint was invoked exactly once");

  // Turn 1 was dispatched to Gemini 3.8 Flash
  assert.equal(outboundModelRequests[0].model, "google/gemini-3.8-flash");

  // Turn 2 preserved the exact signed extra_content and arguments
  const turn2Body = outboundModelRequests[1];
  assert.equal(turn2Body.model, "google/gemini-3.8-flash");

  const replayedAssistant = turn2Body.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(replayedAssistant, "Turn 2 outbound messages include assistant message with tool_calls");
  assert.equal(replayedAssistant.tool_calls.length, 1);

  const replayedCall = replayedAssistant.tool_calls[0];
  assert.equal(replayedCall.id, "call-gemini-synth-weather");
  assert.equal(replayedCall.function.name, "weather");
  assert.equal(replayedCall.function.arguments, '{"location":"Tokyo"}');
  assert.deepEqual(replayedCall.extra_content, { google: { thought_signature: SYNTHETIC_SIGNATURE } });
  assert.equal(replayedCall.extra_content.google.thought_signature, SYNTHETIC_SIGNATURE);

  const toolResultMessage = turn2Body.messages.find((m) => m.role === "tool");
  assert.ok(toolResultMessage, "Turn 2 outbound messages include tool response");
  assert.equal(toolResultMessage.tool_call_id, "call-gemini-synth-weather");
  assert.ok(toolResultMessage.content.includes("Tokyo"));
  assert.ok(toolResultMessage.content.includes("18"));
  assert.ok(toolResultMessage.content.includes("clear sky"));

  // Verify signature NEVER reached visible client response
  assert.ok(!result.rawText.includes(SYNTHETIC_SIGNATURE), "signature never in raw SSE stream");
  assert.ok(!result.text.includes(SYNTHETIC_SIGNATURE), "signature never in visible text");
  assert.ok(!JSON.stringify(result.events).includes(SYNTHETIC_SIGNATURE), "signature never in any SSE event");

  // Verify signature NEVER stored in persistent database chat messages
  const conversationId = result.complete.conversationId;
  const { rows: dbMessages } = await client.query("SELECT role, content, metadata FROM messages WHERE conversation_id = $1", [conversationId]);
  assert.equal(dbMessages.length, 2, "only user and final assistant messages are persisted");
  assert.ok(!JSON.stringify(dbMessages).includes(SYNTHETIC_SIGNATURE), "signature never in database messages");

  // Verify signature NEVER reached stored memory facts in database
  const { rows: dbFacts } = await client.query("SELECT * FROM memory_facts WHERE user_id = $1", [userId]);
  assert.ok(!JSON.stringify(dbFacts).includes(SYNTHETIC_SIGNATURE), "signature never in memory facts");

  // Verify signature NEVER logged to server logs
  assert.ok(!getCapturedLogs().includes(SYNTHETIC_SIGNATURE), "signature never leaked to console logs");

  // Verify an unrelated subsequent request never carries the signature
  await executeChatRequest({
    base,
    streaming: true,
    userId,
    body: {
      model: "lumen",
      message: "Explain gravity in one sentence.",
    },
  });
  assert.equal(outboundModelRequests.length, 3);
  const unrelatedBody = outboundModelRequests[2];
  assert.ok(!JSON.stringify(unrelatedBody).includes(SYNTHETIC_SIGNATURE), "unrelated request never carries signature");
});

test("non-streaming tool-loop: executes tool and preserves Google thought_signature on next outbound request", async (t) => {
  const userId = "nonstreaming-tool-user";
  const { base, outboundModelRequests, getWeatherCalls, getCapturedLogs } = await createHarness(t, { userId, streaming: false });

  const result = await executeChatRequest({
    base,
    streaming: false,
    userId,
    body: {
      model: "vesper",
      message: "What should I pack for my trip to Tokyo?",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.data.reply, "The weather in Tokyo is currently 18°C and clear sky.");

  // Turn 1 + Turn 2 outbound calls executed
  assert.equal(outboundModelRequests.length, 2);

  // Assert expected weather tool endpoint invocation count
  assert.equal(getWeatherCalls(), 1, "weather tool endpoint was invoked exactly once");

  // Turn 2 preserved the exact signed extra_content and arguments
  const turn2Body = outboundModelRequests[1];
  assert.equal(turn2Body.model, "google/gemini-3.8-flash");

  const replayedAssistant = turn2Body.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(replayedAssistant, "Turn 2 outbound messages include assistant message with tool_calls");
  assert.equal(replayedAssistant.tool_calls.length, 1);

  const replayedCall = replayedAssistant.tool_calls[0];
  assert.equal(replayedCall.id, "call-gemini-synth-weather");
  assert.equal(replayedCall.function.name, "weather");
  assert.equal(replayedCall.function.arguments, '{"location":"Tokyo"}');
  assert.deepEqual(replayedCall.extra_content, { google: { thought_signature: SYNTHETIC_SIGNATURE } });
  assert.equal(replayedCall.extra_content.google.thought_signature, SYNTHETIC_SIGNATURE);

  // Assert the next outbound request contains matching tool result and expected synthetic weather content
  const toolResultMessage = turn2Body.messages.find((m) => m.role === "tool");
  assert.ok(toolResultMessage, "Turn 2 outbound messages include tool response");
  assert.equal(toolResultMessage.tool_call_id, "call-gemini-synth-weather");
  assert.ok(toolResultMessage.content.includes("Tokyo"), "tool result includes Tokyo location");
  assert.ok(toolResultMessage.content.includes("18"), "tool result includes 18C temperature");
  assert.ok(toolResultMessage.content.includes("clear sky"), "tool result includes clear sky condition");

  // Verify signature NEVER reached visible response
  assert.ok(!result.data.reply.includes(SYNTHETIC_SIGNATURE), "signature never in visible reply");
  assert.ok(!JSON.stringify(result.data).includes(SYNTHETIC_SIGNATURE), "signature never in response JSON payload");

  // Verify signature NEVER in persistent database chat messages
  const conversationId = result.data.conversationId;
  const { rows: dbMessages } = await client.query("SELECT role, content, metadata FROM messages WHERE conversation_id = $1", [conversationId]);
  assert.equal(dbMessages.length, 2);
  assert.ok(!JSON.stringify(dbMessages).includes(SYNTHETIC_SIGNATURE), "signature never in database messages");

  // Verify signature NEVER reached stored memory facts in database
  const { rows: dbFacts } = await client.query("SELECT * FROM memory_facts WHERE user_id = $1", [userId]);
  assert.ok(!JSON.stringify(dbFacts).includes(SYNTHETIC_SIGNATURE), "signature never in memory facts");

  // Verify signature NEVER logged to server logs
  assert.ok(!getCapturedLogs().includes(SYNTHETIC_SIGNATURE), "signature never leaked to console logs");

  // Verify an unrelated request never carries the signature
  await executeChatRequest({
    base,
    streaming: false,
    userId,
    body: {
      model: "lumen",
      message: "Explain entropy simply.",
    },
  });
  assert.equal(outboundModelRequests.length, 3);
  const unrelatedBody = outboundModelRequests[2];
  assert.ok(!JSON.stringify(unrelatedBody).includes(SYNTHETIC_SIGNATURE), "unrelated non-streaming request never carries signature");
});
