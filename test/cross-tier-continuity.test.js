/**
 * One saved conversation, answered by different tiers in turn: Lumen -> Vulcan -> Lumen -> Vulcan. (It was Nova -> Nebula -> Vulcan ->
 * Nova until Nova and Nebula were retired on 2026-11-14.) The real /api/chat/stream route and an
 * isolated database; the model upstream is a scripted stand-in that records what each tier was sent. Mocked request construction only:
 * this says nothing about how a real model answers.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
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
// Lumen on its production route type (the router's paid zero-retention route), Vulcan on the router, both with fixture engines.
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["route-a"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.chatModels.vesper = "fixture-vesper";
config.vesperTransport = "router";

const REASONING = "HIDDEN-REASONING-SENTINEL";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const sse = (text) => new Response([
  frame({ choices: [{ delta: { reasoning: REASONING } }] }),
  ...text.split(/(?<= )/).map((content) => frame({ choices: [{ delta: { content } }] })),
  frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage }),
].join(""), { headers: { "Content-Type": "text/event-stream" } });

const upstream = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(init.body);
    upstream.push(body);
    const reply = `Reply from ${body.model}.`;
    if (body.stream === false || body.stream === undefined) return Response.json({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage });
    return sse(reply);
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
let signedIn = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (signedIn) req.authSession = { user: { id: signedIn } }; next(); });
app.use("/api/chat", chatRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
test.after(async () => { globalThis.fetch = realFetch; await new Promise((resolve) => server.close(resolve)); await client.close(); });

let n = 0;
async function person(tier = "max") {
  const id = `continuity-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  await client.query("INSERT INTO subscriptions (user_id, tier, status, current_period_started_at, current_period_ends_at, billing_source) VALUES ($1, $2, 'active', now() - interval '5 days', now() + interval '25 days', 'stripe')", [id, tier]);
  return id;
}
async function say(userId, model, message, conversationId) {
  signedIn = userId;
  const before = upstream.length;
  const response = await realFetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, message, ...(conversationId ? { conversationId } : {}) }) });
  const raw = await response.text();
  const events = raw.split("\n\n").map((b) => ({ event: b.match(/^event:\s*(.+)$/m)?.[1], data: b.match(/^data:\s*(.+)$/m)?.[1] })).filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
  const error = events.find((e) => e.event === "error")?.data;
  const done = events.find((e) => e.event === "complete")?.data;
  const sent = upstream.slice(before).filter((b) => b.stream !== false && Array.isArray(b.messages)).at(-1);
  return { status: response.status, error, done, sent, sentText: sent ? JSON.stringify(sent.messages) : "" };
}

test("Lumen -> Vulcan -> Lumen -> Vulcan: one conversation, and each tier is sent the same saved history including the later correction", async () => {
  const a = await person();
  const t1 = await say(a, "lumen", "My favourite colour is teal.");
  assert.equal(t1.error, undefined, JSON.stringify(t1.error));
  const conversationId = t1.done.conversationId;
  assert.ok(conversationId);
  const t2 = await say(a, "vesper", "Correction: my favourite colour is actually amber.", conversationId);
  assert.equal(t2.error, undefined, JSON.stringify(t2.error));
  assert.equal(t2.done.conversationId, conversationId, "switching to Vulcan does not start a new conversation");
  assert.match(t2.sentText, /teal/, "Vulcan is sent the earlier turn");
  const t3 = await say(a, "lumen", "What is my favourite colour?", conversationId);
  assert.equal(t3.error, undefined, JSON.stringify(t3.error));
  assert.equal(t3.done.conversationId, conversationId);
  assert.ok(t3.sentText.indexOf("amber") > t3.sentText.indexOf("teal"), "Lumen sees the correction after the original");
  const t4 = await say(a, "vesper", "And remind me again?", conversationId);
  assert.equal(t4.error, undefined, JSON.stringify(t4.error));
  assert.ok(t4.sentText.indexOf("amber") > t4.sentText.indexOf("teal"), "switching back to Vulcan does not resurrect the stale value as current");
  // Not asserted either way: whether a Vulcan reply may be sent to a later non-Vulcan tier is an open owner decision (see PR).
  for (const turn of [t2, t3, t4]) assert.doesNotMatch(turn.sentText, new RegExp(REASONING), "hidden reasoning from an earlier tier is never sent to another");
  const models = [t1, t2, t3, t4].map((t) => t.sent.model);
  assert.deepEqual(models, ["fixture-lumen", "fixture-vesper", "fixture-lumen", "fixture-vesper"], "each turn went to the tier that was chosen");
  const saved = (await client.query("SELECT role, count(*)::int AS n FROM messages WHERE conversation_id = $1 GROUP BY role ORDER BY role", [conversationId])).rows;
  assert.deepEqual(saved, [{ role: "assistant", n: 4 }, { role: "user", n: 4 }], "one user and one assistant message per turn, no duplicates");
});

test("another person's history never reaches a request, and their conversation cannot be continued", async () => {
  const a = await person();
  const b = await person();
  const first = await say(a, "lumen", "My secret project codename is BLUEHERON.");
  const theirs = await say(b, "vesper", "What do you know about me?");
  assert.doesNotMatch(theirs.sentText, /BLUEHERON/);
  const hijack = await say(b, "lumen", "Continue this", first.done.conversationId);
  assert.ok(hijack.status === 404 || hijack.error, "continuing someone else's conversation is refused");
  assert.equal(hijack.sent, undefined, "nothing was sent to a model");
});

test("a correction older than the newest 80 saved messages still reaches the model", async () => {
  const a = await person();
  const start = await say(a, "lumen", "Let's begin.");
  const conversationId = start.done.conversationId;
  await client.query("UPDATE messages SET created_at = now() - interval '2 days' WHERE conversation_id = $1", [conversationId]);
  await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, 'user', 'Correction: my favourite colour is actually amber.', now() - interval '1 day')", [conversationId]);
  for (let i = 0; i < 90; i += 1) {
    await client.query("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, now() - interval '1 hour' + ($4 || ' seconds')::interval)", [conversationId, i % 2 ? "assistant" : "user", `Filler message ${i} about the itinerary.`, String(i)]);
  }
  const turn = await say(a, "vesper", "What is my favourite colour?", conversationId);
  assert.equal(turn.error, undefined, JSON.stringify(turn.error));
  assert.match(turn.sentText, /actually amber/, "the old correction is included even though it is outside the newest 80 messages");
  assert.match(turn.sentText, /later messages and corrections take precedence/);
});
