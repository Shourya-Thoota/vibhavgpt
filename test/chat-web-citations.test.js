/**
 * Grounded web answers through the real /api/chat/stream route (owner request 2026-11-15): a scripted model upstream and a scripted
 * search service. The model is shown numbered sources and the citation rules; the finished reply keeps citations that name retrieved
 * pages and loses invented links and numbers; the saved and returned sources are numbered as the reply cites them; and two searches in
 * one turn number on instead of starting again. No network, no real account.
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
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.searchApiKey = "fixture-search-key";

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const answer = (text) => sse([...text.split(/(?<= )/).map((content) => ({ choices: [{ delta: { content } }] })), { choices: [{ delta: {}, finish_reason: "stop" }], usage }]);
const searchTool = (id, query) => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
]);

const TOWER = { title: "Eiffel Tower facts", url: "https://www.toureiffel.paris/en/the-monument", content: "The tower is 330 metres tall and opened in 1889.", published_date: "2026-10-01" };
const PARIS = { title: "Paris guide", url: "https://example.org/paris", content: "Paris is the capital of France." };
const LOUVRE = { title: "Louvre", url: "https://www.louvre.fr/en", content: "The Louvre is the world's most-visited museum." };

let n = 0;
async function run(t, { body, script, searchResults }) {
  const userId = `citations-user-${++n}`;
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  const upstream = [];
  const searches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      const request = JSON.parse(init.body);
      upstream.push(request);
      const turn = script[Math.min(upstream.length - 1, script.length - 1)];
      if (request.stream === false || request.stream === undefined) return Response.json({ choices: [{ message: { role: "assistant", content: typeof turn === "string" ? turn : "ok" }, finish_reason: "stop" }], usage });
      return typeof turn === "string" ? answer(turn) : turn();
    }
    if (href.startsWith(config.searchApiUrl)) {
      searches.push(JSON.parse(init.body).query);
      if (searchResults === "fail") return new Response("{}", { status: 503 });
      return Response.json({ results: searchResults[Math.min(searches.length - 1, searchResults.length - 1)] });
    }
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
  const history = await client.query("SELECT role, content, metadata FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) ORDER BY created_at", [userId]);
  return { events, upstream, searches, saved: history.rows };
}
const complete = (events) => events.find((e) => e.event === "complete")?.data;

test("a searched answer keeps real citations, loses invented ones, and saves the numbered sources it cites", async (t) => {
  const modelReply = "The tower is 330 metres tall [1] and Paris is the capital [2]. It was painted gold [5]. More at [this page](https://fake.example/eiffel) and https://fake.example/tickets.";
  const { events, upstream, saved } = await run(t, {
    body: { message: "Tell me about the Eiffel Tower", webSearch: true },
    script: [modelReply],
    searchResults: [[TOWER, PARIS]],
  });
  assert.equal(events.find((e) => e.event === "error"), undefined);
  const sent = JSON.stringify(upstream.at(-1).messages);
  assert.match(sent, /\[1\] Eiffel Tower facts\\nSite: toureiffel\.paris \| Published: 2026-10-01\\nURL: https:\/\/www\.toureiffel\.paris\/en\/the-monument/, "the model is shown numbered sources");
  assert.match(sent, /\[2\] Paris guide/);
  assert.match(sent, /Cite only numbers listed above/);
  assert.doesNotMatch(sent, /Cite a source URL/, "the old instruction that invited typed URLs is gone");

  const done = complete(events);
  assert.equal(done.reply, "The tower is 330 metres tall [1] and Paris is the capital [2]. It was painted gold. More at this page and fake.example.");
  assert.deepEqual(done.sources.map(({ n: number, title, url, domain }) => ({ number, title, url, domain })), [
    { number: 1, title: "Eiffel Tower facts", url: "https://www.toureiffel.paris/en/the-monument", domain: "toureiffel.paris" },
    { number: 2, title: "Paris guide", url: "https://example.org/paris", domain: "example.org" },
  ]);
  const assistant = saved.find((row) => row.role === "assistant");
  assert.equal(assistant.content, done.reply, "the saved reply is the grounded one");
  assert.deepEqual(assistant.metadata.sources.map((source) => source.n), [1, 2], "the saved sources carry their numbers");
  assert.deepEqual(assistant.metadata.sources.map((source) => source.cited), [true, true], "and whether the reply cites them");
  assert.equal(JSON.stringify(assistant.metadata.sources).includes("330 metres tall and opened"), false, "excerpts are not saved");
});

test("two searches in one turn number on: the second search's new page is [3] and a repeated page keeps its number", async (t) => {
  const { events, upstream, searches } = await run(t, {
    body: { message: "Compare the Eiffel Tower and the Louvre" },
    script: [() => searchTool("call_1", "Eiffel Tower height"), () => searchTool("call_2", "Louvre visitors"), "Tall [1], in Paris [2], and the Louvre is busiest [3]. Not [4]."],
    searchResults: [[TOWER, PARIS], [{ ...PARIS, url: "http://example.org/paris/#top" }, LOUVRE]],
  });
  assert.equal(searches.length, 2, "two searches ran");
  // This route hands tool results back as trusted server messages (or tool messages, on routes with native tools).
  const toolResults = upstream.at(-1).messages.map((message) => String(message.content)).filter((content) => content.includes("<WebSearchResults>"));
  assert.equal(toolResults.length, 2);
  assert.match(toolResults[0], /\[1\] Eiffel Tower facts[\s\S]*\[2\] Paris guide/);
  assert.match(toolResults[1], /\[2\] Paris guide\nSite: example\.org\nURL: https:\/\/example\.org\/paris\n[\s\S]*\[3\] Louvre/, "the second search shows the repeated page as 2, at the URL it was first listed under, and the new one as 3");
  assert.doesNotMatch(toolResults[1], /\[1\] Paris guide/, "it does not start again at 1");
  const done = complete(events);
  assert.equal(done.reply, "Tall [1], in Paris [2], and the Louvre is busiest [3]. Not.");
  assert.deepEqual(done.sources.map((source) => [source.n, source.domain]), [[1, "toureiffel.paris"], [2, "example.org"], [3, "louvre.fr"]], "every page the turn retrieved, once");
});

test("a reply with no search is left exactly as written", async (t) => {
  const text = "Arrays start at [0] and [1] is the second item; see https://developer.example/arrays.";
  const { events } = await run(t, { body: { message: "explain array indexes" }, script: [text], searchResults: [[]] });
  const done = complete(events);
  assert.equal(done.reply, text);
  assert.deepEqual(done.sources ?? [], []);
});

test("a cited figure the sources do not contain loses its citation before the reply is saved", async (t) => {
  const { events, saved } = await run(t, {
    body: { message: "Tell me about the Eiffel Tower height", webSearch: true },
    script: ["It is 330 metres tall [1]. It is 412 metres tall [2]."],
    searchResults: [[TOWER, PARIS]],
  });
  const done = complete(events);
  assert.equal(done.reply, "It is 330 metres tall [1]. It is 412 metres tall.");
  assert.deepEqual(done.sources.map((source) => [source.n, source.cited]), [[1, true], [2, false]]);
  assert.equal(saved.find((row) => row.role === "assistant").content, done.reply);
});

test("when the search fails, no citation marker or invented link survives", async (t) => {
  const { events } = await run(t, {
    body: { message: "Tell me about the Eiffel Tower", webSearch: true },
    script: ["It is tall [1], see https://fake.example/eiffel."],
    searchResults: "fail",
  });
  const done = complete(events);
  assert.equal(done.reply, "It is tall, see fake.example.");
  assert.deepEqual(done.sources ?? [], []);
});
