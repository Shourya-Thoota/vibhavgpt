/**
 * Production logs (2026-11-09 03:53 UTC) show chat requests failing outright in the "searching" phase: a web search error ended the whole turn with no
 * answer. This drives the real /api/chat/stream route with a scripted model upstream and a search service that fails, and checks the turn still answers,
 * says live search was unavailable, and shows no sources. No network, no real account.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
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
// Lumen on its production route type (the router's paid zero-retention route) with the fixture engine. (Nova, which this suite
// used before, was retired on 2026-11-14.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.searchApiKey = "fixture-search-key";

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const answer = (text) => sse([...text.split(/(?<= )/).map((content) => ({ choices: [{ delta: { content } }] })), { choices: [{ delta: {}, finish_reason: "stop" }], usage }]);
const searchToolTurn = () => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "latest news" }) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
]);

let n = 0;
async function run(t, { body, toolFirst = false, searchStatus = 503 }) {
  const userId = `search-fail-user-${++n}`;
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  const upstream = [];
  const searches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      const body = JSON.parse(init.body);
      upstream.push(body);
      const text = "Live search is unavailable right now, so this is from what I already know.";
      if (body.stream === false || body.stream === undefined) return Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
      return toolFirst && upstream.length === 1 ? searchToolTurn() : answer(text);
    }
    if (href.startsWith(config.searchApiUrl)) { searches.push(href); return new Response("{}", { status: searchStatus }); }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", ...body }) });
  const raw = await response.text();
  const events = raw.split("\n\n").map((block) => ({ event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1] }))
    .filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
  return { events, upstream, searches };
}

const complete = (events) => events.find((e) => e.event === "complete")?.data;

test("a failed web search on a search request no longer fails the turn: it answers and says live search was unavailable", async (t) => {
  const { events, upstream, searches } = await run(t, { body: { message: "what's the latest news today?", webSearch: true } });
  assert.ok(searches.length >= 1, "a search was attempted");
  assert.equal(events.find((e) => e.event === "error"), undefined, "the turn did not error");
  const done = complete(events);
  assert.ok(done?.reply, "an answer was given");
  assert.ok(!done.webSearched, "it does not claim a search happened");
  assert.deepEqual(done.sources ?? [], [], "no sources are shown");
  const sent = JSON.stringify(upstream.map((u) => u.messages));
  assert.match(sent, /live web search was attempted for this request and failed/, "the model is told the search failed");
  assert.match(sent, /do not cite or invent sources/);
});

test("a failed web search requested by the model as a tool also lets the turn finish honestly", async (t) => {
  const { events, upstream } = await run(t, { body: { message: "look something up for me" }, toolFirst: true });
  assert.equal(events.find((e) => e.event === "error"), undefined, "the turn did not error");
  assert.ok(complete(events)?.reply);
  assert.match(JSON.stringify(upstream.at(-1).messages), /live web search was attempted for this request and failed/);
});
