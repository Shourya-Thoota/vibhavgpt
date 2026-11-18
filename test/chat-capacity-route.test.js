// PR 4: the capacity layer through the REAL chat router and its event stream, over a real Postgres (PGlite). Doubles: the session,
// and the model upstream (a scripted fetch). "Another replica's reply" is a lease row written straight into the shared table.
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
// These requests run on Lumen's production route type (the router's paid zero-retention route) with the fixture engine. (Nova, which
// this suite used before, was retired on 2026-11-14.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-nova-upstream-id"; // lumenPaidZdrModel derives from it
Object.assign(config.chatCapacity, { enabled: true, global: 0, perUser: 0, perGroup: 0, maxQueuedPerTier: 40, maxQueuedPerUser: 2, maxWaitMs: 20_000 });
Object.assign(config.chatCapacity.tiers, { lumen: 1, vesper: 0, study: 0 });
const { chatRouter } = await import("../src/chat/router.js");
const { default: express } = await import("express");

const USER_ID = "capacity-route-user";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const answer = (text) => new Response(new ReadableStream({ start(c) {
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`));
  c.close();
} }), { headers: { "Content-Type": "text/event-stream" } });

let upstream = () => answer("Hello there.");
let upstreamCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstreamCalls += 1;
    return upstream(upstreamCalls);
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [USER_ID]);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: USER_ID } }; next(); });
app.use("/api/chat", chatRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const leases = async () => (await client.query("SELECT user_id, tier, state FROM chat_capacity_leases ORDER BY enqueued_at")).rows;
const count = async (table) => (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [USER_ID])).rows[0].n;
const otherReplicaHoldsNova = () => client.query("INSERT INTO chat_capacity_leases (id, tier, user_id, state, instance_id, accepted_at, expires_at) VALUES (gen_random_uuid(), 'lumen', 'someone-else', 'active', 'other-replica', now(), now() + interval '60 seconds')");

/** Send one message on Lumen and collect the stream's events as they arrive. */
async function send(message, { signal, onEvent } = {}) {
  const response = await realFetch(`${baseUrl}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, model: "lumen" }), signal,
  });
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    for (const block of blocks) {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !data) continue;
      const parsed = { event, data: JSON.parse(data) };
      events.push(parsed);
      await onEvent?.(parsed);
    }
    if (done) break;
  }
  return events;
}
const phases = (events) => events.filter((e) => e.event === "status").map((e) => e.data.phase);

beforeEach(async () => {
  await client.exec("DELETE FROM chat_capacity_leases");
  upstream = () => answer("Hello there.");
  upstreamCalls = 0;
  Object.assign(config.chatCapacity, { maxQueuedPerTier: 40, maxWaitMs: 20_000 });
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await client.close();
});

test("with room, a reply runs as before: no waiting state, usage recorded as before, and its slot is gone when the stream ends", async () => {
  const usageBefore = await count("usage_events");
  const events = await send("hello");
  assert.equal(events.at(-1).event, "complete");
  assert.equal(phases(events).includes("queued"), false);
  assert.equal(await count("usage_events"), usageBefore + 1, "the usual usage record, unchanged by the capacity layer");
  assert.deepEqual(await leases(), [], "the slot was released before the stream ended");
});

test("waiting state: the stream says the tier is busy and how long it has waited, then the reply starts when the slot frees", async () => {
  await otherReplicaHoldsNova();
  let freed = false;
  const events = await send("are you there?", {
    onEvent: async ({ event, data }) => {
      // Free the other replica's slot only once this reply has reported waiting twice (so the wait was real and reported live).
      if (event === "status" && data.phase === "queued" && data.waitedSeconds >= 1 && !freed) {
        freed = true;
        assert.equal(upstreamCalls, 0, "nothing was sent upstream while waiting");
        assert.deepEqual((await leases()).map((l) => [l.user_id, l.state]), [["someone-else", "active"], [USER_ID, "queued"]]);
        await client.query("DELETE FROM chat_capacity_leases WHERE user_id = 'someone-else'");
      }
    },
  });
  const seen = phases(events);
  const queued = events.find((e) => e.event === "status" && e.data.phase === "queued");
  assert.deepEqual(queued.data, { phase: "queued", tier: "Lumen", waitedSeconds: 0, maxWaitSeconds: 20 }, "tier name only, real figures");
  assert.ok(seen.indexOf("queued") < seen.lastIndexOf("thinking"), `waiting came before thinking: ${seen.join(",")}`);
  assert.equal(events.at(-1).event, "complete");
  assert.match(events.at(-1).data.reply ?? JSON.stringify(events.at(-1).data), /Hello there\./);
  assert.deepEqual(await leases(), []);
});

test("saturation: a clear high-demand message by tier name; nothing reserved, saved or sent", async () => {
  await otherReplicaHoldsNova();
  config.chatCapacity.maxQueuedPerTier = 0;
  const [usageBefore, conversationsBefore] = [await count("usage_events"), await count("conversations")];
  const events = await send("hello?");
  const error = events.at(-1);
  assert.equal(error.event, "error");
  assert.equal(error.data.code, "high_demand");
  assert.equal(error.data.error, "Lumen is in high demand right now, so this reply didn't start and nothing was used. Please try again in a minute.");
  assert.equal(error.data.retryable, true);
  assert.equal(error.data.status, 503);
  assert.equal(upstreamCalls, 0);
  assert.equal(await count("usage_events"), usageBefore, "no usage reservation");
  assert.equal(await count("conversations"), conversationsBefore, "nothing saved");
  assert.deepEqual((await leases()).map((l) => l.user_id), ["someone-else"]);
  // The plain (non-streaming) route answers the same way.
  const plain = await realFetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hello?", model: "lumen" }) });
  assert.equal(plain.status, 503);
  assert.equal((await plain.json()).code, "high_demand");
});

test("waiting too long ends honestly, and leaves nothing waiting", async () => {
  await otherReplicaHoldsNova();
  config.chatCapacity.maxWaitMs = 1_200;
  const events = await send("hello?");
  assert.equal(phases(events)[0], "queued");
  assert.equal(events.at(-1).data.code, "high_demand");
  assert.equal(upstreamCalls, 0);
  assert.deepEqual((await leases()).map((l) => l.user_id), ["someone-else"]);
});

test("disconnect while waiting: the reply leaves the line and never reaches the model", async () => {
  await otherReplicaHoldsNova();
  const controller = new AbortController();
  const sending = send("never mind", { signal: controller.signal, onEvent: ({ data }) => { if (data.phase === "queued") controller.abort(); } }).catch((error) => error);
  await sending;
  for (let i = 0; i < 40 && (await leases()).length > 1; i += 1) await sleep(50);
  assert.deepEqual((await leases()).map((l) => l.user_id), ["someone-else"], "the cancelled reply holds no place and no slot");
  await client.query("DELETE FROM chat_capacity_leases");
  await sleep(1_000);
  assert.equal(upstreamCalls, 0, "it was never started afterwards either");
});

test("disconnect while running: the slot is freed at once, so the next reply does not wait", async () => {
  upstream = () => new Response(new ReadableStream({ async start(c) {
    c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Slow " } }] })}\n\n`));
    await sleep(3_000);
    c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`));
    c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const controller = new AbortController();
  await send("start then stop", { signal: controller.signal, onEvent: ({ event }) => { if (event === "delta") controller.abort(); } }).catch((error) => error);
  for (let i = 0; i < 40 && (await leases()).length > 0; i += 1) await sleep(25);
  assert.deepEqual(await leases(), [], "freed well before the upstream's 3 s were up");
  upstream = () => answer("Second reply.");
  const events = await send("next");
  assert.equal(phases(events).includes("queued"), false);
  assert.equal(events.at(-1).event, "complete");
});

test("a failed reply's slot is back before the error reaches the client: an immediate retry does not wait, and never holds two", async () => {
  upstream = () => new Response("{}", { status: 500 });
  const failed = await send("first try");
  assert.equal(failed.at(-1).event, "error");
  assert.deepEqual(await leases(), [], "the slot was released before the error was sent");
  const callsForFailure = upstreamCalls;
  assert.ok(callsForFailure >= 2, "the model call was retried inside the one reply");
  let peak = 0;
  upstream = async () => { peak = Math.max(peak, (await leases()).length); return answer("Recovered."); };
  const retried = await send("first try");
  assert.equal(phases(retried).includes("queued"), false, "with one Nova slot, the retry would have waited if the failed reply still held it");
  assert.equal(retried.at(-1).event, "complete");
  assert.equal(peak, 1, "one slot for the reply, whatever was retried");
});

test("upstream saturation after the bounded backoff: told as high demand by tier name, not as a generic failure; slot released", async () => {
  upstream = () => new Response(JSON.stringify({ error: { code: 429, message: "rate limited" } }), { status: 429, headers: { "retry-after": "30" } });
  const startedAt = Date.now();
  const events = await send("busy upstream");
  const error = events.at(-1);
  assert.equal(error.event, "error");
  assert.equal(error.data.code, "inference-unavailable", "the same code as any exhausted reply");
  assert.equal(error.data.status, 503);
  assert.equal(error.data.error, "Lumen is in high demand right now and couldn't start this reply. Please try again in a minute.");
  assert.equal(error.data.retryable, true);
  assert.equal(upstreamCalls, 1, "the host asked for 30 s: not retried inside the reply");
  assert.ok(Date.now() - startedAt < 5_000);
  assert.deepEqual(await leases(), []);
});
