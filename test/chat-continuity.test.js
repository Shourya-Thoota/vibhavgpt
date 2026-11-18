import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) {
  await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
}
const db = drizzle(client);

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});

mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-paid-key";
config.providerKeys.direct = "fixture-direct-key";
config.providerBaseUrls.paid = "https://mock-paid.vibhavgpt.test/v1";
config.providerBaseUrls.direct = "https://mock-direct.vibhavgpt.test/v1";
// These requests run on Lumen's production route type (the router's paid zero-retention route) with the fixture engine. (Nova, which
// this suite used before, was retired on 2026-11-14.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-nova"; // lumenPaidZdrModel derives from it
config.chatModels.vesper = "fixture-vesper-router";
config.chatModels.vesperDirect = "gpt-6.1-terra";
config.vesperDataPolicyVerified = true;
config.vesperTransport = "direct";
config.chatModels.study = "gpt-6-luna";

const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { loadConversation } = await import("../src/chat/repository.js");

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
let modelRequests = [];
let modelReply = "Reply from model.";

function mockProviderResponse(init, modelName) {
  let parsedBody = {};
  try { parsedBody = JSON.parse(init.body); } catch {}
  modelRequests.push({ modelName, url: init.url, body: parsedBody, headers: init.headers });
  return new Response([
    { choices: [{ delta: { content: `${modelReply} (${modelName})` } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } },
  ].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function serve(t, userId, plan = "pro") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) return mockProviderResponse({ ...init, url: href }, "paid");
    if (href.startsWith(config.providerBaseUrls.direct)) return mockProviderResponse({ ...init, url: href }, "direct");
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${href}`);
  };

  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (plan === "pro") {
    await client.query("INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'pro', 'active') ON CONFLICT DO NOTHING", [userId]);
  } else {
    await client.query("INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'free', 'active') ON CONFLICT DO NOTHING", [userId]);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  app.use((err, req, res, _next) => {
    res.status(err.status ?? 429).json({ error: err.message, code: err.code });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const parseEvents = (text) => text.split("\n\n").map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: block.match(/^data:\s*(.+)$/m)?.[1],
})).filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));

async function stream(base, body) {
  const response = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseEvents(await response.text());
}

test("switching models across turns in the same conversation preserves id, message order, and cumulative context", async (t) => {
  const userId = "continuity-turns-user";
  const base = await serve(t, userId);
  modelRequests = [];

  // Turn 1 on Lumen
  const turn1Events = await stream(base, { model: "lumen", message: "Tell me about photosynthesis." });
  const turn1Complete = turn1Events.find((e) => e.event === "complete")?.data;
  assert.ok(turn1Complete?.conversationId, "first turn creates conversation");
  const conversationId = turn1Complete.conversationId;

  // Turn 2: Switch to Vulcan (direct transport)
  const turn2Events = await stream(base, { model: "vesper", conversationId, message: "What are the light-dependent reactions?" });
  const turn2Complete = turn2Events.find((e) => e.event === "complete")?.data;
  assert.equal(turn2Complete?.conversationId, conversationId, "same conversation preserved");

  // Verify DB persistence of messages and order
  const stored = await loadConversation(userId, conversationId);
  assert.equal(stored.history.length, 4, "all 4 messages (2 user, 2 assistant) preserved");
  assert.equal(stored.history[0].role, "user");
  assert.equal(stored.history[0].content, "Tell me about photosynthesis.");
  assert.equal(stored.history[1].role, "assistant");
  assert.equal(stored.history[2].role, "user");
  assert.equal(stored.history[2].content, "What are the light-dependent reactions?");
  assert.equal(stored.history[3].role, "assistant");

  // Verify that the second request received Turn 1's history
  const vesperReq = modelRequests[1];
  assert.ok(vesperReq, "vesper request received");
  assert.equal(vesperReq.modelName, "direct", "used direct transport for vesper");
  const sentInput = JSON.stringify(vesperReq.body);
  assert.ok(sentInput.includes("photosynthesis"), "includes first turn question");
  assert.ok(sentInput.includes("light-dependent reactions"), "includes second turn question");
});

test("unsupported attachments on vision-disabled model return explicit 422 vision-model-required", async (t) => {
  const userId = "continuity-vision-user";
  const base = await serve(t, userId);

  // Insert a dummy attachment of kind 'image'
  const attachmentId = "00000000-0000-0000-0000-000000000001";
  await client.query(
    "INSERT INTO attachments (id, user_id, original_name, stored_name, mime_type, size_bytes, kind, extraction_status) VALUES ($1, $2, 'test.png', 'stored.png', 'image/png', 100, 'image', 'ready')",
    [attachmentId, userId]
  );

  // Sending image to lumen (which lacks vision) must explicitly fail with vision-model-required
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "lumen", message: "Describe this image", attachmentIds: [attachmentId] }),
  });

  assert.equal(response.status, 422);
  const data = await response.json();
  assert.equal(data.code, "vision-model-required");
  assert.match(data.error, /Choose a model that supports images/i);
});

test("switching to a paid tier without plan entitlement is blocked before any upstream inference", async (t) => {
  const userId = "continuity-free-user";
  // Serve with free plan
  const base = await serve(t, userId, "free");
  modelRequests = [];

  // Attempting to use Vulcan (0 quota on Free) on Free plan without credits via streaming
  const events = await stream(base, { model: "vesper", message: "Hi" });
  const errorEvent = events.find((e) => e.event === "error");
  assert.ok(errorEvent, "received error event");
  assert.equal(errorEvent.data.status, 403);
  assert.equal(modelRequests.length, 0, "no provider was called");
});

test("internal reasoning, provider credentials, and raw metadata are never exposed in conversation history", async (t) => {
  const userId = "continuity-metadata-user";
  const base = await serve(t, userId);

  const turnEvents = await stream(base, { model: "lumen", message: "A question with reasoning" });
  const complete = turnEvents.find((e) => e.event === "complete")?.data;
  assert.ok(complete?.conversationId);

  const stored = await loadConversation(userId, complete.conversationId);
  const assistantMsg = stored.history.find((m) => m.role === "assistant");
  assert.ok(assistantMsg);

  // Assert no credentials, tokens, or private reasoning fields in surfaced message
  assert.equal(assistantMsg.apiKey, undefined);
  assert.equal(assistantMsg.reasoning_items, undefined);
  assert.equal(assistantMsg.rawToolCalls, undefined);
  assert.equal(assistantMsg.providerRouting, undefined);
});

test("cross-conversation isolation ensures switching models does not cross-pollinate history", async (t) => {
  const userId = "continuity-isolation-user";
  const base = await serve(t, userId);

  // Conversation 1: secret canary
  const turn1Events = await stream(base, { model: "lumen", message: "Conversation 1 confidential canary 12345" });
  const conv1 = turn1Events.find((e) => e.event === "complete")?.data?.conversationId;

  // Conversation 2: on Vulcan
  modelRequests = [];
  const turn2Events = await stream(base, { model: "vesper", message: "What do you know?" });
  const conv2 = turn2Events.find((e) => e.event === "complete")?.data?.conversationId;
  assert.notEqual(conv1, conv2);

  // Inspect the request sent for Conversation 2
  const lastReq = modelRequests.at(-1);
  const sentText = JSON.stringify(lastReq.body);
  assert.equal(sentText.includes("confidential canary 12345"), false, "conversation 2 never contains conversation 1 context");
});

test("frontend changeModel guards against mid-stream tier switching", async () => {
  const appCode = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  // changeModel must check busyRef.current or modelSaving before proceeding
  assert.match(appCode, /async function changeModel\(nextModel\) \{\s*if \(modelSaving \|\| busyRef\.current \|\| nextModel === model\) return;/);
});

test("context-aware image composition keeps latest explicit user request authoritative", async () => {
  const { composeImagePrompt } = await import("../src/generation/service.js");
  const composed = composeImagePrompt("A glowing cyan crystal", "photorealistic", {
    context: "User asked about crystalline mineral formations in ancient caves",
  });
  // Subject comes first as the primary visual instruction
  assert.match(composed, /^A glowing cyan crystal\./);
  assert.match(composed, /The request refers to this, from the conversation just before it: User asked about crystalline mineral formations in ancient caves\./);
  assert.match(composed, /Style: photorealistic style\./);
});
