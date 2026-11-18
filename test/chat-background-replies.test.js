// Background generation, first step (src/chat/live-replies.js) through the REAL chat router and its event stream, over a real Postgres
// (PGlite). Doubles: the session (a header picks which synthetic person is asking) and the model upstream (a scripted fetch that holds the
// reply open until the test lets it finish). Checks: a page that asked for it can leave and the reply still finishes once; the person can
// attach again and see it, with no second inference, message or charge; nobody else can see, attach to or stop it; Stop still stops it;
// and a caller that did not ask keeps the old behaviour (leaving stops the reply).
import test, { mock, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
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
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen-upstream-id";
const { chatRouter } = await import("../src/chat/router.js");
const { resetLiveRepliesForTest } = await import("../src/chat/live-replies.js");
const { default: express } = await import("express");

const OWNER = "background-owner";
const STRANGER = "background-stranger";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const chunk = (text) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const finish = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6 } })}\n\n`);

// The upstream sends its first part at once, then holds the reply open until release() (or until it is aborted).
let release = () => {};
let upstreamCalls = 0;
let upstreamAborted = 0;
const heldReply = (init) => {
  const gate = new Promise((resolve) => { release = resolve; });
  return new Response(new ReadableStream({ async start(c) {
    c.enqueue(chunk("Part one of the answer, written in full so the reply has visible text. "));
    const aborted = new Promise((resolve) => init?.signal?.addEventListener("abort", resolve, { once: true }));
    const outcome = await Promise.race([gate.then(() => "go"), aborted.then(() => "abort")]);
    if (outcome === "abort") { upstreamAborted += 1; try { c.error(new DOMException("aborted", "AbortError")); } catch {} return; }
    c.enqueue(chunk("Part two, and the end."));
    c.enqueue(finish);
    c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstreamCalls += 1;
    return heldReply(init);
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

for (const id of [OWNER, STRANGER]) await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") || OWNER } }; next(); });
app.use("/api/chat", chatRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function readEvents(response, { until, onEvent } = {}) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let step;
    try { step = await reader.read(); } catch { break; }
    const { value, done } = step;
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !data) continue;
      const parsed = { event, data: JSON.parse(data), id: Number(block.match(/^id:\s*(\d+)$/m)?.[1] ?? NaN) };
      events.push(parsed);
      onEvent?.(parsed);
      if (until?.(parsed)) { await reader.cancel().catch(() => {}); return events; }
    }
    if (done) break;
  }
  return events;
}

/** Starts a reply and reads it until its first visible text, then leaves (closes the connection). */
async function startAndLeave({ detach = true, user = OWNER } = {}) {
  const controller = new AbortController();
  const response = await realFetch(`${baseUrl}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": user, ...(detach ? { "X-Reply-Detach": "1" } : {}) },
    body: JSON.stringify({ message: "Tell me a short story", model: "lumen" }),
    signal: controller.signal,
  });
  const events = await readEvents(response, { until: (e) => e.event === "delta" && typeof e.data.text === "string" });
  controller.abort();
  const reply = events.find((e) => e.event === "reply")?.data;
  const conversation = events.find((e) => e.event === "conversation")?.data;
  return { replyId: reply?.replyId, detachable: reply?.detachable, conversationId: conversation?.conversationId, events };
}
const get = (path, user = OWNER) => realFetch(`${baseUrl}${path}`, { headers: { "x-test-user": user } });
const post = (path, user = OWNER) => realFetch(`${baseUrl}${path}`, { method: "POST", headers: { "x-test-user": user } });
const running = async (user = OWNER) => (await (await get("/api/chat/replies", user)).json()).replies;
const messages = async (conversationId) => (await client.query("SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at", [conversationId])).rows;
const usageCount = async () => (await client.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [OWNER])).rows[0].n;
async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return true; await sleep(25); }
  return false;
}

beforeEach(() => { upstreamCalls = 0; upstreamAborted = 0; release = () => {}; });
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await client.close();
});

test("a page that asked for it can leave mid-reply: the reply still finishes, once, and is saved once", async () => {
  const usageBefore = await usageCount();
  const { replyId, detachable, conversationId } = await startAndLeave();
  assert.ok(replyId, "the reply's id is the first thing the page learns");
  assert.equal(detachable, true);
  assert.ok(conversationId);
  await sleep(100);
  assert.equal(upstreamAborted, 0, "leaving did not stop the reply");
  assert.deepEqual((await running()).map((r) => [r.replyId, r.conversationId]), [[replyId, conversationId]]);
  release();
  assert.ok(await waitFor(async () => (await running()).length === 0), "the reply finished");
  const saved = await messages(conversationId);
  assert.deepEqual(saved.map((m) => m.role), ["user", "assistant"], "one message and one reply");
  assert.match(saved[1].content, /Part one[\s\S]*Part two, and the end\./);
  assert.equal(upstreamCalls, 1, "one inference");
  assert.equal(await usageCount(), usageBefore + 1, "charged once");
});

test("attaching again replays the reply so far and follows it to the end, with no second inference, message or charge", async () => {
  const usageBefore = await usageCount();
  const { replyId, conversationId } = await startAndLeave();
  const attach = get(`/api/chat/replies/${replyId}/events?after=0`);
  setTimeout(() => release(), 150);
  const events = await readEvents(await attach);
  assert.equal(events[0].event, "reply");
  assert.equal(events[0].data.attached, true);
  assert.ok(events.some((e) => e.event === "delta" && /Part one/.test(e.data.text ?? "")), "the text written before attaching is replayed");
  const complete = events.find((e) => e.event === "complete");
  assert.ok(complete, "it follows the reply to its end");
  assert.match(complete.data.reply, /Part two, and the end\./);
  const ids = events.filter((e) => e.event !== "reply").map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "events arrive in order");
  assert.equal(new Set(ids).size, ids.length, "no event twice");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual((await messages(conversationId)).map((m) => m.role), ["user", "assistant"]);
  assert.equal(await usageCount(), usageBefore + 1);
  // Attaching just after it finished still gets the end (the same saved message), and still runs nothing.
  const late = await readEvents(await get(`/api/chat/replies/${replyId}/events?after=0`));
  assert.equal(late.find((e) => e.event === "complete").data.messageId, complete.data.messageId);
  assert.equal(upstreamCalls, 1);
});

test("attaching after a given event replays only what came after it", async () => {
  const { replyId, events: seen } = await startAndLeave();
  const lastSeen = Math.max(...seen.map((e) => e.id).filter(Number.isFinite));
  setTimeout(() => release(), 100);
  const events = await readEvents(await get(`/api/chat/replies/${replyId}/events?after=${lastSeen}`));
  assert.ok(events.filter((e) => e.event !== "reply").every((e) => e.id > lastSeen));
  assert.ok(events.some((e) => e.event === "complete"));
});

test("nobody else can see, attach to or stop someone's reply", async () => {
  const { replyId, conversationId } = await startAndLeave();
  assert.deepEqual(await running(STRANGER), []);
  const attach = await get(`/api/chat/replies/${replyId}/events?after=0`, STRANGER);
  assert.equal(attach.status, 404);
  assert.equal((await attach.json()).code, "reply_not_running", "told it is not running, the same as a reply that does not exist");
  const stop = await post(`/api/chat/replies/${replyId}/stop`, STRANGER);
  assert.equal(stop.status, 404);
  await sleep(50);
  assert.equal(upstreamAborted, 0, "their stop did nothing");
  release();
  assert.ok(await waitFor(async () => (await messages(conversationId)).length === 2), "the owner's reply finished");
  assert.equal((await get(`/api/chat/replies/not-a-reply/events`)).status, 404);
});

test("Stop stops the reply on the server: the inference ends and no reply is saved", async () => {
  const { replyId, conversationId } = await startAndLeave();
  const attach = get(`/api/chat/replies/${replyId}/events?after=0`);
  const stop = await post(`/api/chat/replies/${replyId}/stop`);
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { stopped: true });
  const events = await readEvents(await attach);
  assert.ok(await waitFor(() => upstreamAborted === 1), "the upstream request was aborted");
  assert.equal(events.some((e) => e.event === "complete"), false);
  assert.ok(await waitFor(async () => (await running()).length === 0));
  assert.deepEqual((await messages(conversationId)).map((m) => m.role), ["user"], "the message is kept to retry; no reply is saved");
  assert.equal((await post(`/api/chat/replies/${replyId}/stop`)).status, 404, "a stopped reply cannot be stopped twice");
  assert.equal(upstreamCalls, 1);
});

test("a caller that did not ask to detach keeps the old behaviour: leaving stops the reply", async () => {
  const { replyId, detachable, conversationId } = await startAndLeave({ detach: false });
  assert.equal(detachable, false);
  assert.ok(await waitFor(() => upstreamAborted === 1), "the reply stopped when the page left");
  assert.ok(await waitFor(async () => (await running()).length === 0));
  assert.deepEqual((await messages(conversationId)).map((m) => m.role), ["user"]);
  assert.ok(replyId);
});

// An API restart loses the in-memory registry (docs/background-replies.md). Simulated by clearing it while a reply runs: the process
// cannot really die inside a test, so the held reply is released afterwards only to end the test cleanly.
test("after a restart nothing claims to be running, re-attaching finds nothing, and nothing is sent again", async () => {
  const usageBefore = await usageCount();
  const { replyId, conversationId } = await startAndLeave();
  resetLiveRepliesForTest();
  assert.deepEqual(await running(), [], "no reply is listed, so the 'in progress' notice clears");
  const attach = await get(`/api/chat/replies/${replyId}/events?after=0`);
  assert.equal(attach.status, 404, "re-attaching finds nothing; the page reloads the saved history");
  assert.equal((await post(`/api/chat/replies/${replyId}/stop`)).status, 404);
  assert.deepEqual((await messages(conversationId)).map((m) => m.role), ["user"], "the message is there once, with no reply yet");
  assert.equal(upstreamCalls, 1, "no inference was started to recover it");
  release();
  await waitFor(async () => (await messages(conversationId)).length === 2);
  assert.ok(await usageCount() <= usageBefore + 1, "at most the one reply's usage");
});
