import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Visible history pages through every message of a long conversation (GET
// /api/chat/conversations/:id?before=<message id>), 80 at a time, newest page
// first, with no gaps, repeats or reordering, and only for the owner. The real
// route on an in-memory database; messages are inserted directly so their
// timestamps, ties and order are exact.
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
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { HISTORY_PAGE_SIZE } = await import("../src/chat/repository.js");

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") ?? "pager" } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (id, query = "", user = "pager") => {
    const response = await fetch(`${base}/api/chat/conversations/${id}${query}`, { headers: { "x-test-user": user } });
    return { status: response.status, body: await response.json() };
  };
  return { get };
}

async function conversation(userId = "pager") {
  const { rows: [row] } = await client.query("INSERT INTO conversations (user_id, title, model) VALUES ($1, 'Long chat', 'nova') RETURNING id", [userId]);
  return row.id;
}

// n alternating messages, one second apart, oldest first: "m1" (user), "m2"
// (assistant), ... Replies record a model on even rows to check Phase 1 labels.
async function fill(conversationId, n, { startSeconds = 100_000 } = {}) {
  await client.query(`INSERT INTO messages (conversation_id, role, content, metadata, created_at)
    SELECT $1, CASE WHEN g % 2 = 1 THEN 'user' ELSE 'assistant' END, 'm' || g,
      CASE WHEN g % 4 = 0 THEN '{"model":"nebula"}'::jsonb ELSE '{}'::jsonb END,
      timestamptz '2026-01-01' + make_interval(secs => $2 + g)
    FROM generate_series(1, $3::int) g`, [conversationId, startSeconds, n]);
}

const contents = (history) => history.map((message) => message.content);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `m${from + index}`);

async function walk(get, id) {
  const pages = [];
  let query = "";
  for (let guard = 0; guard < 100; guard += 1) {
    const { status, body } = await get(id, query);
    assert.equal(status, 200);
    pages.push(body);
    if (!body.hasMore) return pages;
    query = `?before=${encodeURIComponent(body.nextCursor)}`;
  }
  assert.fail("pagination never ended");
}

test("the first page is the newest 80, in order, with hasMore and nextCursor at every boundary", async (t) => {
  const { get } = await serve(t);
  assert.equal(HISTORY_PAGE_SIZE, 80);
  for (const [count, shown, more] of [[0, 0, false], [1, 1, false], [80, 80, false], [81, 80, true], [161, 80, true]]) {
    const id = await conversation();
    await fill(id, count);
    const { status, body } = await get(id);
    assert.equal(status, 200, `${count} messages`);
    assert.deepEqual(contents(body.history), range(count - shown + 1, count), `${count} messages: the newest ${shown}, oldest first`);
    assert.equal(body.hasMore, more, `${count} messages: hasMore`);
    assert.equal(body.nextCursor, more ? body.history[0].id : null, `${count} messages: the cursor is the oldest message shown`);
  }
});

test("walking every page reaches the first message with no gaps, repeats or reordering", async (t) => {
  const { get } = await serve(t);
  for (const count of [81, 161, 240, 241]) {
    const id = await conversation();
    await fill(id, count);
    const pages = await walk(get, id);
    assert.equal(pages.length, Math.ceil(count / 80), `${count} messages: page count`);
    assert.ok(pages.slice(0, -1).every((page) => page.history.length === 80 && page.hasMore), "every page but the last is full");
    const all = pages.slice().reverse().flatMap((page) => contents(page.history));
    assert.deepEqual(all, range(1, count), `${count} messages: every one, once, in order`);
    assert.equal(new Set(pages.flatMap((page) => page.history.map((message) => message.id))).size, count, "no id appears twice");
    assert.equal(pages.at(-1).nextCursor, null);
  }
});

test("rows sharing a timestamp page in one stable order: user before reply, then by id", async (t) => {
  const { get } = await serve(t);
  const id = await conversation();
  // 90 user rows and 90 replies all at one instant, plus microsecond-apart
  // rows written by now(), which a millisecond cursor would mishandle.
  await client.query(`INSERT INTO messages (conversation_id, role, content, created_at)
    SELECT $1, CASE WHEN g <= 90 THEN 'user' ELSE 'assistant' END, 'tie' || g, timestamptz '2026-02-01 12:00:00'
    FROM generate_series(1, 180) g`, [id]);
  for (let index = 0; index < 5; index += 1) {
    await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)", [id, `now${index}`]);
  }
  const expected = (await client.query(`SELECT id FROM messages WHERE conversation_id = $1
    ORDER BY created_at, CASE WHEN role = 'assistant' THEN 1 ELSE 0 END, id`, [id])).rows.map((row) => row.id);
  const first = await walk(get, id);
  const second = await walk(get, id);
  const ids = (pages) => pages.slice().reverse().flatMap((page) => page.history.map((message) => message.id));
  assert.deepEqual(ids(first), expected, "the database's own total order, across page boundaries inside the tie");
  assert.deepEqual(ids(second), expected, "and the same every time");
  const roles = first.slice().reverse().flatMap((page) => page.history).filter((message) => message.content.startsWith("tie")).map((message) => message.role);
  assert.equal(roles.lastIndexOf("user") < roles.indexOf("assistant"), true, "at one instant, every user row comes before the replies");
});

test("messages added between page requests never show up in older pages or cause a skip", async (t) => {
  const { get } = await serve(t);
  const id = await conversation();
  await fill(id, 200);
  const first = await get(id);
  assert.deepEqual(contents(first.body.history), range(121, 200));
  // New turns arrive (later timestamps) before the earlier page is requested.
  await fill(id, 6, { startSeconds: 900_000 });
  const second = await get(id, `?before=${first.body.nextCursor}`);
  assert.deepEqual(contents(second.body.history), range(41, 120), "exactly the 80 before the cursor");
  const third = await get(id, `?before=${second.body.nextCursor}`);
  assert.deepEqual(contents(third.body.history), range(1, 40));
  assert.equal(third.body.hasMore, false);
});

test("bad cursors are refused with 400 and nothing is read", async (t) => {
  const { get } = await serve(t);
  const id = await conversation();
  await fill(id, 100);
  const other = await conversation();
  await fill(other, 3);
  const { rows: [foreignToThis] } = await client.query("SELECT id FROM messages WHERE conversation_id = $1 LIMIT 1", [other]);
  for (const query of ["?before=not-a-uuid", "?before=", "?before=123", "?before=a&before=b",
    `?before=${foreignToThis.id}&before=${foreignToThis.id}`, `?before=${foreignToThis.id}`, "?before=6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"]) {
    const { status, body } = await get(id, query);
    assert.equal(status, 400, query);
    assert.deepEqual(body, { error: "Invalid cursor." }, query);
  }
  // Express 5 reads "before[id]" as its own key, not as "before": no cursor.
  assert.equal((await get(id, "?before[id]=x")).body.hasMore, true, "an unrelated key is ignored like any other");
});

test("another account gets 404 with or without a valid cursor, and nothing leaks", async (t) => {
  const { get } = await serve(t);
  const id = await conversation("owner");
  await fill(id, 100);
  const own = await get(id, "", "owner");
  assert.equal(own.status, 200);
  for (const query of ["", `?before=${own.body.nextCursor}`]) {
    const { status, body } = await get(id, query, "stranger");
    assert.equal(status, 404, query || "(no cursor)");
    assert.doesNotMatch(JSON.stringify(body), /"m\d+"|Long chat|nebula/, "no content, title or label");
  }
});

test("older pages keep each reply's stored model, and older rows return null", async (t) => {
  const { get } = await serve(t);
  const id = await conversation();
  await fill(id, 120);
  const [newest, older] = await walk(get, id);
  for (const message of [...older.history, ...newest.history]) {
    const n = Number(message.content.slice(1));
    assert.equal(message.model, n % 4 === 0 ? "nebula" : null, `${message.content} (${message.role})`);
    assert.equal("metadata" in message, false, "raw metadata is never returned");
  }
});

test("without a cursor the response is today's newest page, plus hasMore and nextCursor only", async (t) => {
  const { get } = await serve(t);
  const id = await conversation();
  await fill(id, 90);
  const { body } = await get(id);
  assert.deepEqual(Object.keys(body).sort(), ["conversation", "hasMore", "history", "nextCursor"]);
  assert.equal(body.conversation.id, id);
  assert.equal(body.conversation.model, "nova");
  assert.deepEqual(Object.keys(body.history[0]).sort(), ["activitySummary", "attachment", "content", "createdAt", "id", "imagePrompt", "model", "role", "sources", "studyResults", "thoughtSeconds"]);
  assert.deepEqual(contents(body.history), range(11, 90));
});
