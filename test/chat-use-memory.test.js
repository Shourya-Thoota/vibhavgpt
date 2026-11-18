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
// Lumen on its production route type (the router's paid zero-retention route) with the fixture engine. (Nova, which this suite
// used before, was retired on 2026-11-14.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.chatModels.vesper = "fixture-vesper-router";
config.chatModels.vesperDirect = "gpt-6.1-terra";
config.vesperDataPolicyVerified = true;
// Vulcan over the router, so its turns reach the chat-completions fixture below. (Nova carried these turns until it was retired on
// 2026-11-14; Lumen runs no tools, so it is never offered the save-memory tool.)
config.vesperTransport = "router";
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

  await client.query("INSERT INTO user_profiles (user_id, memory_enabled, memory_save_enabled) VALUES ($1, false, false) ON CONFLICT DO NOTHING", [userId]);
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


async function seed(userId, { memory = true } = {}) {
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled, memory_save_enabled) VALUES ($1, $2, $2) ON CONFLICT (user_id) DO UPDATE SET memory_enabled = $2, memory_save_enabled = $2", [userId, memory]);
  await client.query("DELETE FROM memory_facts WHERE user_id = $1", [userId]);
  await client.query("INSERT INTO memory_facts (user_id, content, source, category) VALUES ($1, $2, $3, $4)", [userId, "The user's favorite colour is teal.", "chat", "interests"]);
}
const facts = async (userId) => (await client.query("SELECT content FROM memory_facts WHERE user_id = $1", [userId])).rows.map((r) => r.content);
const sentToModel = () => modelRequests.map((r) => JSON.stringify(r.body)).join("\n");
const toolNames = () => modelRequests.flatMap((r) => (r.body?.tools ?? []).map((tool) => tool.function?.name));
const useMemoryOf = async (id) => (await client.query("SELECT use_memory FROM conversations WHERE id = $1", [id])).rows[0].use_memory;
const ask = async (base, body) => {
  modelRequests = [];
  const events = await stream(base, { model: "vesper", message: "What is my favorite colour?", ...body });
  return { events, id: events.find((e) => e.event === "complete")?.data?.conversationId };
};

test("with memory on and the switch untouched, saved memory is used and the save tool is offered", async (t) => {
  const userId = "usememory-default"; await seed(userId);
  const base = await serve(t, userId);
  const { id } = await ask(base, {});
  assert.ok(id);
  assert.match(sentToModel(), /teal/, "the saved fact reaches the model");
  assert.ok(toolNames().includes("save_memory"), "and the model may save new memory");
  assert.equal(await useMemoryOf(id), null, "no choice was made, so none is stored");
});

test("with the switch off, the exchange neither reads nor writes saved memory, and nothing saved is deleted", async (t) => {
  const userId = "usememory-off"; await seed(userId);
  const base = await serve(t, userId);
  const before = await facts(userId);
  const { id } = await ask(base, { useMemory: false });
  assert.ok(id);
  assert.doesNotMatch(sentToModel(), /teal/, "no saved memory is sent to the model");
  assert.ok(!toolNames().includes("save_memory"), "and the model is not offered the save tool");
  assert.equal(modelRequests.length, 1, "no memory-extraction call is made after the reply");
  assert.deepEqual(await facts(userId), before, "nothing saved was added, changed or deleted");
  assert.equal(await useMemoryOf(id), false, "the choice is kept with the conversation");
});

test("the choice stays with the conversation: later messages keep it until it is changed, and other conversations are unaffected", async (t) => {
  const userId = "usememory-sticky"; await seed(userId);
  const base = await serve(t, userId);
  const first = await ask(base, { useMemory: false });
  const second = await ask(base, { conversationId: first.id });
  assert.doesNotMatch(sentToModel(), /teal/, "a later message without the flag still has memory off");
  const other = await ask(base, {});
  assert.match(sentToModel(), /teal/, "a different conversation is not affected");
  assert.notEqual(other.id, first.id);
  await ask(base, { conversationId: first.id, useMemory: true });
  assert.match(sentToModel(), /teal/, "turning it back on works");
  assert.equal(await useMemoryOf(first.id), true);
  assert.equal(await useMemoryOf(other.id), null);
});

test("the switch can only narrow the account setting: with memory off in Settings, it cannot be turned on from the composer", async (t) => {
  const userId = "usememory-account-off"; await seed(userId, { memory: false });
  const base = await serve(t, userId);
  await ask(base, { useMemory: true });
  assert.doesNotMatch(sentToModel(), /teal/, "the account setting wins");
  assert.ok(!toolNames().includes("save_memory"));
});

test("only a real boolean counts, and one person cannot set another's conversation", async (t) => {
  const userId = "usememory-types"; await seed(userId);
  const base = await serve(t, userId);
  for (const junk of ["false", 0, null, "no", [], {}]) {
    await ask(base, { useMemory: junk });
    assert.match(sentToModel(), /teal/, `${JSON.stringify(junk)} is not a choice to turn memory off`);
  }
  const owner = "usememory-owner"; await seed(owner);
  const ownerBase = await serve(t, owner);
  const theirs = await ask(ownerBase, { useMemory: false });
  const intruderBase = await serve(t, "usememory-intruder");
  const attempt = await fetch(`${intruderBase}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", message: "hi", conversationId: theirs.id, useMemory: true }) });
  assert.ok(attempt.status >= 400 || !(await attempt.text()).includes("complete"), "another account cannot use the conversation");
  assert.equal(await useMemoryOf(theirs.id), false, "and its setting is unchanged");
});
