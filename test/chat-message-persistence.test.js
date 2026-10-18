import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// The user's message is saved as soon as a chat request is accepted, before
// any reply. These run the real /api/chat routes on an in-memory database
// with the model stubbed: a reply that fails or is interrupted keeps the
// message, a retry answers it in place, and normal turns still alternate.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
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
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture-nova";
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");

const REPLY = "Here is your answer.";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const encoder = new TextEncoder();

// How the stubbed model behaves for the next request: "answer", "fail"
// (503 on every try) or "hang" (one word, then silence until aborted).
let model = "answer";
let modelRequests = [];
function modelResponse(init) {
  modelRequests.push(JSON.parse(init.body));
  if (model === "fail") return new Response("", { status: 503 });
  if (model === "hang") {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "Partial" } }] })));
        init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  }
  return new Response([
    { choices: [{ delta: { content: REPLY } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
  ].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function serve(t, userId) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) return href.includes("/generation") ? new Response("{}", { status: 404 }) : modelResponse(init);
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const parseEvents = (text) => text.split("\n\n").map((block) => ({
  event: block.match(/^event:\s*(.+)$/m)?.[1],
  data: block.match(/^data:\s*(.+)$/m)?.[1],
})).filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));

async function stream(base, body, signal) {
  const response = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nova", ...body }), signal });
  return parseEvents(await response.text());
}
const eventOf = (events, name) => events.find((item) => item.event === name)?.data;

async function thread(userId) {
  const { rows } = await client.query(
    `SELECT m.conversation_id, m.role, m.content, m.metadata FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1 ORDER BY m.created_at, CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END`,
    [userId],
  );
  return rows;
}
const conversationCount = async (userId) => (await client.query("SELECT count(*)::int AS n FROM conversations WHERE user_id = $1", [userId])).rows[0].n;
// The user turns the model was sent with this text.
const userTurns = (request, text) => request.messages.filter((message) => message.role === "user" && String(message.content).includes(text)).length;

test("a failed first reply keeps the message and its new conversation; Retry answers it in place", async (t) => {
  const userId = "persist-fail";
  const base = await serve(t, userId);
  const question = "What is the boiling point of water at sea level?";

  model = "fail";
  modelRequests = [];
  let events = await stream(base, { message: question });
  const saved = eventOf(events, "conversation");
  assert.ok(saved?.conversationId, "the client learns the new conversation before any reply");
  const failure = eventOf(events, "error");
  assert.equal(failure.retryable, true);
  assert.equal(failure.conversationId, saved.conversationId, "the error names the conversation the message is in");
  assert.equal(eventOf(events, "complete"), undefined);
  let rows = await thread(userId);
  assert.deepEqual(rows.map((row) => [row.role, row.content]), [["user", question]], "the message is kept, with no reply");
  assert.equal(rows[0].conversation_id, saved.conversationId);
  assert.deepEqual(rows[0].metadata, { replyStatus: "failed", requestId: failure.requestId });

  // Retry sends the same message to the same conversation.
  model = "answer";
  modelRequests = [];
  events = await stream(base, { message: question, conversationId: saved.conversationId });
  assert.equal(eventOf(events, "error"), undefined);
  assert.equal(eventOf(events, "complete").conversationId, saved.conversationId);
  rows = await thread(userId);
  assert.deepEqual(rows.map((row) => [row.role, row.content]), [["user", question], ["assistant", REPLY]], "answered in place, not repeated");
  assert.deepEqual(rows[0].metadata, {}, "the missing-reply mark is cleared");
  assert.equal(userTurns(modelRequests[0], question), 1, "the model sees the question once");
  assert.equal(await conversationCount(userId), 1);
});

test("a reply the user leaves mid-stream keeps the message, marked interrupted", async (t) => {
  const userId = "persist-abort";
  const base = await serve(t, userId);
  model = "hang";
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
    body: JSON.stringify({ model: "nova", message: "Write me a long story." }),
  });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("Partial")) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  let rows = [];
  for (let wait = 0; wait < 100 && rows[0]?.metadata?.replyStatus !== "interrupted"; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    rows = await thread(userId);
  }
  assert.deepEqual(rows.map((row) => [row.role, row.content]), [["user", "Write me a long story."]]);
  assert.equal(rows[0].metadata.replyStatus, "interrupted");
  model = "answer";
});

test("normal turns still alternate, each reply after its own message, with history sent", async (t) => {
  const userId = "persist-turns";
  const base = await serve(t, userId);
  model = "answer";
  modelRequests = [];
  const first = eventOf(await stream(base, { message: "First question" }), "complete");
  const second = eventOf(await stream(base, { message: "Second question", conversationId: first.conversationId }), "complete");
  assert.equal(second.conversationId, first.conversationId);
  const rows = await thread(userId);
  assert.deepEqual(rows.map((row) => [row.role, row.content]), [
    ["user", "First question"], ["assistant", REPLY], ["user", "Second question"], ["assistant", REPLY],
  ]);
  assert.ok(rows.every((row) => !row.metadata?.replyStatus));
  const history = modelRequests[1].messages.filter((message) => message.role !== "system").map((message) => [message.role, String(message.content).includes("First question") ? "First question" : String(message.content).includes("Second question") ? "Second question" : message.content]);
  assert.deepEqual(history, [["user", "First question"], ["assistant", REPLY], ["user", "Second question"]]);
  assert.equal(await conversationCount(userId), 1);
});

test("a different message after a failed one keeps both, in order", async (t) => {
  const userId = "persist-different";
  const base = await serve(t, userId);
  model = "fail";
  const saved = eventOf(await stream(base, { message: "Unanswered question" }), "conversation");
  model = "answer";
  await stream(base, { message: "A new question", conversationId: saved.conversationId });
  const rows = await thread(userId);
  assert.deepEqual(rows.map((row) => [row.role, row.content, row.metadata?.replyStatus ?? null]), [
    ["user", "Unanswered question", "failed"], ["user", "A new question", null], ["assistant", REPLY, null],
  ]);
});

test("the JSON route keeps the message too and returns its conversation with the error", async (t) => {
  const userId = "persist-json";
  const base = await serve(t, userId);
  model = "fail";
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nova", message: "Plain request" }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  const rows = await thread(userId);
  assert.deepEqual(rows.map((row) => [row.role, row.content, row.metadata.replyStatus]), [["user", "Plain request", "failed"]]);
  assert.equal(body.conversationId, rows[0].conversation_id);
  model = "answer";
});

test("a request refused before it is accepted saves nothing", async (t) => {
  const userId = "persist-refused";
  const base = await serve(t, userId);
  const events = await stream(base, { message: "x".repeat(20_001) });
  assert.equal(eventOf(events, "error").status, 400);
  assert.equal(eventOf(events, "conversation"), undefined);
  assert.equal(await conversationCount(userId), 0);
  assert.deepEqual(await thread(userId), []);
});

test("a message that was answered after all is never marked as missing its reply", async () => {
  const { markReplyMissing } = await import("../src/chat/repository.js");
  const { rows: [conversation] } = await client.query("INSERT INTO conversations (user_id, title, model) VALUES ('persist-guard', 'Chat', 'nova') RETURNING id");
  const { rows: [answered] } = await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, 'user', 'q1', now() - interval '2 seconds') RETURNING id", [conversation.id]);
  await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, 'assistant', 'a1', now() - interval '1 second')", [conversation.id]);
  const { rows: [unanswered] } = await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'q2') RETURNING id", [conversation.id]);
  await markReplyMissing(answered.id, "failed", "req-guard");
  await markReplyMissing(unanswered.id, "failed", "req-guard");
  const { rows } = await client.query("SELECT content, metadata FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at", [conversation.id]);
  assert.deepEqual(rows.map((row) => [row.content, row.metadata]), [["q1", {}], ["q2", { replyStatus: "failed", requestId: "req-guard" }]]);
});

test("the app keeps a first message's conversation as soon as it exists", async () => {
  const app = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(event === "conversation"\) onConversation\?\.\(data\);/);
  assert.match(app, /onConversation: \(saved\) => \{\s*if \(!saved\?\.conversationId \|\| saved\.conversationId === conversationId\) return;\s*setConversationId\(saved\.conversationId\);\s*onConversationSaved\?\.\(saved\.conversationId, !mountedRef\.current\);/);
});
