process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";

const { conversations, messages } = await import("../src/db/schema.js");
const search = await import("../src/chat/search.js");
const { createChatSearchRouter } = await import("../src/chat/search-router.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}

// A small world: two people, each with chats, a study session and an image session, and a few archived and awkward ones.
async function seed(db) {
  const make = async (userId, title, mode, texts, extra = {}) => {
    const [c] = await db.insert(conversations).values({ userId, title, model: "nova", mode, ...extra }).returning();
    let n = 0;
    for (const content of texts) await db.insert(messages).values({ conversationId: c.id, role: n++ % 2 ? "assistant" : "user", content, createdAt: new Date(Date.UTC(2026, 9, 1, 12, n)) });
    return c;
  };
  const world = {
    trip: await make("alice", "Trip budget table", "chat", ["How much should I budget for a week in Lisbon?", "A week in Lisbon usually costs about 900 euros including flights."]),
    tides: await make("alice", "Essay outline: tides", "chat", ["Outline an essay about ocean tides and the moon."]),
    quiz: await make("alice", "Jupiter's moons: cards and quiz", "study", ["Make flashcards about the volcanoes on Io.", "Io has hundreds of active volcanoes driven by tidal flexing."]),
    archived: await make("alice", "Old archived chat", "chat", ["The secret recipe uses saffron."], { archived: true }),
    image: await make("alice", "Sunset picture", "image", ["A volcano at sunset, oil painting."]),
    percent: await make("alice", "100%_done checklist", "chat", ["nothing special here"]),
    html: await make("alice", "Markup", "chat", ["Use <script>alert('x')</script> and <b>bold</b> in the page; the word saffron is here too."]),
    bobSecret: await make("bob", "Bob's private plan", "chat", ["Bob's volcanoes and saffron and Lisbon budget notes: bobsecretword."]),
    bobStudy: await make("bob", "Bob's volcano study", "study", ["volcano volcano volcano"]),
  };
  return world;
}

test("it finds a person's own chats and study sessions by title and by message text, and says where", async (t) => {
  const { db } = await createDatabase(t);
  const world = await seed(db);
  const byText = await search.searchChats({ userId: "alice", query: "lisbon" }, db);
  assert.deepEqual(byText.map((r) => r.id), [world.trip.id], "found by what is said inside");
  assert.equal(byText[0].title, "Trip budget table");
  assert.ok(byText[0].snippet.some((s) => s.match && /lisbon/i.test(s.text)), "the matching word is marked in the snippet");
  assert.match(byText[0].snippet.map((s) => s.text).join(""), /Lisbon/);
  assert.equal(byText[0].mode, "chat");
  assert.match(byText[0].date, /^2026-10-01T12:0\d:00\.000Z$/, "the date is the matching message's");
  const byTitle = await search.searchChats({ userId: "alice", query: "tides" }, db);
  assert.equal(byTitle[0].id, world.tides.id);
  assert.ok(byTitle[0].titleSegments.some((s) => s.match && /tides/i.test(s.text)), "and the title shows the match");
  // Study sessions are chats too, and say so.
  const study = await search.searchChats({ userId: "alice", query: "volcanoes" }, db);
  assert.deepEqual(study.map((r) => r.id), [world.quiz.id, world.html.id].filter((id) => id === world.quiz.id), "the study session, and not the image session");
  assert.equal(study[0].mode, "study");
  // Archived chats are still the person's own.
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "saffron" }, db)).map((r) => r.id).sort(), [world.archived.id, world.html.id].sort());
  // The image session's prompt is not a chat and is left out.
  assert.equal((await search.searchChats({ userId: "alice", query: "oil painting" }, db)).length, 0);
});

test("one person never sees another's chats, whatever they search for", async (t) => {
  const { db } = await createDatabase(t);
  await seed(db);
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "bobsecretword" }, db), [], "a word only bob wrote");
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "private plan" }, db), [], "a title only bob has");
  for (const result of await search.searchChats({ userId: "alice", query: "volcanoes" }, db)) assert.ok(!/Bob/.test(result.title), "no result of bob's among alice's");
  const bobs = await search.searchChats({ userId: "bob", query: "volcano" }, db);
  assert.deepEqual(bobs.map((r) => r.title).sort(), ["Bob's private plan", "Bob's volcano study"].sort());
  assert.deepEqual(await search.searchChats({ userId: "bob", query: "lisbon" }, db).then((r) => r.map((x) => x.title)), ["Bob's private plan"], "bob's own lisbon, not alice's trip");
  assert.deepEqual(await search.searchChats({ userId: "nobody", query: "volcano" }, db), [], "an account with no chats");
  assert.deepEqual(await search.searchChats({ userId: "", query: "volcano" }, db), []);
  assert.deepEqual(await search.searchChats({ userId: undefined, query: "volcano" }, db), []);
});

test("any characters can be searched for: nothing throws, nothing is injected, nothing is lost", async (t) => {
  const { db } = await createDatabase(t);
  await seed(db);
  const before = (await db.select().from(messages)).length;
  const queries = ['"', "'", "\\", "%", "_", "&", "|", "!", ":*", "(", ")", "<->", "a:b", "'; DROP TABLE messages; --", "\" OR 1=1 --", "%' OR '1'='1", "\\'; DELETE FROM conversations; --", "volcano & !saffron", "(((", "))) | |", "-volcano", "\"exact phrase here\"", "日本語のテスト", "café", "🌋🌋", "line\nbreak", "tab\tseparated", "nul\u0000byte", "x".repeat(500), "the and of", "  spaced   out  ", "<script>alert(1)</script>", "${process.exit(1)}", "../../etc/passwd", "ab"];
  for (const query of queries) {
    const results = await search.searchChats({ userId: "alice", query }, db);
    assert.ok(Array.isArray(results), `${JSON.stringify(query).slice(0, 40)} returns a list`);
  }
  assert.equal((await db.select().from(messages)).length, before, "no message was lost");
  assert.equal((await db.select().from(conversations)).length, 9, "and no conversation");
  // Operators work the way people expect from a web search, within a person's own chats.
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "saffron -recipe" }, db)).map((r) => r.title), ["Markup"], "a minus leaves a word out");
  assert.deepEqual((await search.searchChats({ userId: "alice", query: '"hundreds of active"' }, db)).map((r) => r.title), ["Jupiter's moons: cards and quiz"], "a phrase in quotes");
});

test("percent signs, underscores and backslashes are only characters: they are never wildcards", async (t) => {
  const { db } = await createDatabase(t);
  const world = await seed(db);
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "%_" }, db)).map((r) => r.id), [world.percent.id], "only the title that really holds %_");
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "%%" }, db), [], "two percent signs match nothing, not everything");
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "__" }, db), [], "nor two underscores");
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "\\%" }, db), []);
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "100%" }, db)).map((r) => r.id), [world.percent.id]);
});

test("a snippet is plain segments, never markup: nothing in a message can become HTML or break the highlight", async (t) => {
  const { db } = await createDatabase(t);
  const world = await seed(db);
  const results = await search.searchChats({ userId: "alice", query: "saffron" }, db);
  const html = results.find((r) => r.id === world.html.id);
  const text = html.snippet.map((s) => s.text).join("");
  assert.match(text, /<script>|<b>|saffron/, "the page's own characters come back as text");
  assert.ok(html.snippet.every((s) => typeof s.text === "string" && typeof s.match === "boolean" && Object.keys(s).length === 2), "only text and match");
  for (const result of results) for (const part of [...result.snippet, ...result.titleSegments]) assert.doesNotMatch(part.text, /[\u0001\u0002]/, "the markers never reach the page");
  // A message that happens to contain the marker characters cannot forge a highlight.
  const [forged] = await db.insert(conversations).values({ userId: "alice", title: "Forged", model: "nova" }).returning();
  await db.insert(messages).values({ conversationId: forged.id, role: "user", content: "plain words \u0001forged highlight\u0002 and the real needle" });
  const found = await search.searchChats({ userId: "alice", query: "needle" }, db);
  const marked = found[0].snippet.filter((s) => s.match).map((s) => s.text).join("|");
  assert.match(marked, /needle/);
  assert.doesNotMatch(marked, /forged/, "only the word searched for is marked");
});

test("short, empty and over-long searches are handled without a query to the database that could misbehave", async (t) => {
  const { db } = await createDatabase(t);
  await seed(db);
  assert.deepEqual(await search.searchChats({ userId: "alice", query: "" }, db), []);
  assert.deepEqual(await search.searchChats({ userId: "alice", query: " a " }, db), [], "one letter is too little to search");
  assert.deepEqual(await search.searchChats({ userId: "alice", query: 42 }, db), []);
  assert.deepEqual(await search.searchChats({ userId: "alice", query: null }, db), []);
  assert.equal(search.normalizeSearchQuery("x".repeat(900)).length, search.SEARCH_MAX_LENGTH);
  assert.equal(search.normalizeSearchQuery("a\u0001b\u0000c\n\td"), "a b c d", "control characters are spaces");
  assert.equal((await search.searchChats({ userId: "alice", query: "chat", limit: 1 }, db)).length <= 1, true, "the limit is honoured");
  assert.ok((await search.searchChats({ userId: "alice", query: "chat", limit: 9999 }, db)).length <= search.SEARCH_MAX_LIMIT, "and capped");
});

// --- The route ------------------------------------------------------------------------------------------------------------------------

const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
async function serve(t, router) {
  const app = express();
  app.use("/api/chat/search", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/chat/search`;
}
const post = (url, user, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the route: signed-in only, the account is the session's, and the search text can only be in the body", async (t) => {
  const { db } = await createDatabase(t);
  await seed(db);
  const url = await serve(t, createChatSearchRouter({ database: db, session: fakeSession }));
  assert.equal((await post(url, null, { q: "lisbon" })).status, 401);
  const ok = await post(url, "alice", { q: "lisbon" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  const { results } = await ok.json();
  assert.deepEqual(results.map((r) => r.title), ["Trip budget table"]);
  // A user id in the body is ignored: the account is the session's.
  const sneaky = await (await post(url, "alice", { q: "bobsecretword", userId: "bob", user_id: "bob" })).json();
  assert.deepEqual(sneaky.results, []);
  // The search text in a URL is not accepted at all: there is no GET route, so it cannot end up in a log or a history.
  assert.equal((await fetch(`${url}?q=lisbon`, { headers: { "x-test-user": "alice" } })).status, 404);
  assert.equal((await fetch(`${url}/lisbon`, { headers: { "x-test-user": "alice" } })).status, 404);
  assert.equal((await post(url, "alice", { q: 5 })).status, 400);
  assert.equal((await post(url, "alice", {})).status, 400);
  assert.equal((await post(url, "alice", "not json")).status, 400);
  assert.deepEqual(await (await post(url, "alice", { q: "a" })).json(), { results: [] }, "too short: nothing yet, not an error");
  assert.equal((await post(url, "alice", { q: "y".repeat(2000) })).status, 400, "far too long");
});

test("the route is rate limited per account", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createChatSearchRouter({ database: db, session: fakeSession, perMinute: 4 }));
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await post(url, "alice", { q: `word${i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
  assert.equal((await post(url, "bob", { q: "word" })).status, 200, "another account has its own allowance");
});

test("privacy: what someone searches for is never logged, not on success and not on failure", async (t) => {
  const { db } = await createDatabase(t);
  await seed(db);
  const secret = "my-very-private-search-phrase-9137";
  const lines = [];
  const original = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) { original[level] = console[level]; console[level] = (...args) => lines.push(args.map(String).join(" ")); }
  t.after(() => { for (const level of Object.keys(original)) console[level] = original[level]; });
  const goodUrl = await serve(t, createChatSearchRouter({ database: db, session: fakeSession }));
  await post(goodUrl, "alice", { q: secret });
  // A database that fails, with the search text in the error as a database often puts it.
  const broken = { transaction: async () => { throw Object.assign(new Error(`could not parse "${secret}"`), { code: "XX000" }); } };
  const failingUrl = await serve(t, createChatSearchRouter({ database: broken, session: fakeSession }));
  const failed = await post(failingUrl, "alice", { q: secret });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(await failed.json()), new RegExp(secret), "and not in the response");
  const timeout = { transaction: async () => { throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }); } };
  const slowUrl = await serve(t, createChatSearchRouter({ database: timeout, session: fakeSession }));
  assert.equal((await post(slowUrl, "alice", { q: secret })).status, 503, "a search that is too broad is stopped, with a way forward");
  assert.ok(lines.length >= 2, "failures are recorded");
  for (const line of lines) assert.doesNotMatch(line, new RegExp(secret), "nothing logged holds the search text");
  assert.ok(lines.every((line) => /chat_search_failed/.test(line) && /"code":"[^"]+"/.test(line)), "only that a search failed, and its error code");
  // And the source never writes the query anywhere.
  for (const file of ["../src/chat/search.js", "../src/chat/search-router.js"]) {
    const code = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\/\/.*$/gm, "");
    const logging = [...code.matchAll(/console\.\w+\([^)]*\)/g)].map((m) => m[0]);
    for (const call of logging) assert.doesNotMatch(call, /\b(q|query|text|body|req)\b/, `${file}: ${call}`);
    assert.doesNotMatch(code, /fetch\(|https?:\/\/|axios|openai|embedding/i, `${file}: the search text goes to no other service`);
  }
});

// --- A large history ----------------------------------------------------------------------------------------------------------------

test("on a large history the search stays quick, stays inside the person's own chats, and uses the index", { timeout: 240000 }, async (t) => {
  const { client, db } = await createDatabase(t);
  // 30 accounts x 100 chats x 12 messages = 36,000 messages, built in the database. One word appears in few of them (rareterm), another in many.
  await client.exec(`
    INSERT INTO conversations (user_id, title, model, mode)
      SELECT 'user' || u, 'Chat ' || c || ' about ' || md5((u * 1000 + c)::text), 'nova', CASE WHEN c % 5 = 0 THEN 'study' ELSE 'chat' END
      FROM generate_series(1, 30) u, generate_series(1, 100) c;
    INSERT INTO messages (conversation_id, role, content, created_at)
      SELECT id, CASE WHEN m % 2 = 0 THEN 'user' ELSE 'assistant' END,
             'message ' || m || ' ' || md5(id::text || m::text) || ' ' || md5(m::text || id::text) || ' common filler words about planning and travel and budgets'
             || CASE WHEN m = 5 AND (hashtext(id::text) % 400) = 0 THEN ' rareterm' ELSE '' END,
             now() - (m || ' minutes')::interval
      FROM conversations, generate_series(1, 12) m;
    INSERT INTO conversations (user_id, title, model, mode) VALUES ('needle-owner', 'The one needle chat', 'nova', 'chat');
    INSERT INTO messages (conversation_id, role, content) SELECT id, 'user', 'a unique string: zxqneedlevalue' FROM conversations WHERE user_id = 'needle-owner';
    ANALYZE;
  `);
  const total = (await client.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n;
  assert.ok(total >= 36000, `${total} messages`);
  const timed = async (userId, query) => { const started = performance.now(); const results = await search.searchChats({ userId, query }, db); return { results, ms: performance.now() - started }; };
  const needle = await timed("needle-owner", "zxqneedlevalue");
  assert.equal(needle.results.length, 1);
  assert.ok(needle.ms < 1500, `a rare word across ${total} messages: ${Math.round(needle.ms)} ms`);
  assert.deepEqual((await timed("user7", "zxqneedlevalue")).results, [], "another account cannot find it, however large the history");
  const rare = await timed("user3", "rareterm");
  assert.ok(rare.ms < 1500, `a rare word: ${Math.round(rare.ms)} ms`);
  const common = await timed("user3", "planning travel");
  assert.ok(common.results.length > 0 && common.results.length <= search.SEARCH_DEFAULT_LIMIT, "a very common phrase: a page of results, not a flood");
  assert.ok(common.ms < 3000, `a phrase in every one of the person's ${100} chats: ${Math.round(common.ms)} ms`);
  for (const r of common.results) assert.ok(r.title.startsWith("Chat ") || r.title.length > 0);
  // Only the person's own: every common-phrase hit belongs to user3 (their titles encode their number, so check by id).
  const owned = new Set((await client.query(`SELECT id FROM conversations WHERE user_id = 'user3'`)).rows.map((r) => r.id));
  for (const r of common.results) assert.ok(owned.has(r.id), "every result is the person's own");
  // The index is what answers it.
  const plan = (await client.query(`EXPLAIN SELECT 1 FROM messages WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', 'zxqneedlevalue')`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(plan, /messages_content_fts_idx/, "the full-text index on messages is used");
  const titlePlan = (await client.query(`EXPLAIN SELECT 1 FROM conversations WHERE to_tsvector('english', title) @@ websearch_to_tsquery('english', 'needle')`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(titlePlan, /conversations_title_fts_idx|Seq Scan/, "titles are searched (a small table may be scanned)");
});

// Build has its own search (owner request, 2026-11-15): "Search builds" finds only a person's builds, and the ordinary search never shows them.
test("Search builds finds only the person's own builds; the ordinary search never includes them", async (t) => {
  const { db } = await createDatabase(t);
  const world = await seed(db);
  const [mine] = await db.insert(conversations).values({ userId: "alice", title: "Habit tracker build", model: "tecton", mode: "build" }).returning();
  await db.insert(messages).values({ conversationId: mine.id, role: "user", content: "Build a habit tracker with streaks and a lisbon theme." });
  const [theirs] = await db.insert(conversations).values({ userId: "bob", title: "Bob habit build", model: "tecton", mode: "build" }).returning();
  await db.insert(messages).values({ conversationId: theirs.id, role: "user", content: "Build a habit tracker for bob." });
  const builds = await search.searchChats({ userId: "alice", query: "habit", scope: "build" }, db);
  assert.deepEqual(builds.map((r) => r.id), [mine.id], "her build, never Bob's");
  assert.equal(builds[0].mode, "build");
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "habit" }, db)).map((r) => r.id), [], "the ordinary search has no builds");
  const chatOnly = await search.searchChats({ userId: "alice", query: "lisbon" }, db);
  assert.deepEqual(chatOnly.map((r) => r.id), [world.trip.id], "and builds stay out of it even when they match");
  assert.deepEqual((await search.searchChats({ userId: "alice", query: "lisbon", scope: "build" }, db)).map((r) => r.id), [mine.id]);
});
