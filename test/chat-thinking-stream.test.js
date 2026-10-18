import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { providerTerms, providerTermsPattern } from "./provider-terms.js";

// One streamed chat request through the real /api/chat/stream route, on an
// in-memory database. The model route is stubbed; it streams thinking (text,
// summary and encrypted details) before its answer. Checks what reaches the
// client live and what is saved and reloaded: thinking is shown, never stored.
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

const userId = "thinker";
const term = providerTerms[0];
const THOUGHT = `Reading the notes. Unlike ${term}, I should keep this short. `;
const SUMMARY = "Plan: two sentences.";
const REPLY = "Here is the summary of your notes.";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
// Each test sets whether the stubbed model thinks before it answers.
let modelThinks = true;
const modelStream = () => new Response([
  ...(modelThinks ? [
    { id: "gen-thinking", choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: THOUGHT }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "OPAQUE-BLOB" }, { type: "reasoning.summary", summary: SUMMARY }] } }] },
  ] : []),
  { choices: [{ delta: { content: REPLY } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });

async function serve(t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) return href.includes("/generation") ? new Response("{}", { status: 404 }) : modelStream();
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
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

test("a streamed reply shows its thinking and real stages live, and saves only how long it thought", async (t) => {
  assert.ok(term, "the test setup lists at least one provider name");
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false)", [userId]);
  const { rows: [attachment] } = await client.query(
    "INSERT INTO attachments (user_id, original_name, stored_name, mime_type, kind, size_bytes, extracted_text, extraction_status) VALUES ($1, 'notes.txt', 'notes.txt', 'text/plain', 'document', 42, 'Meeting notes: ship on Friday.', 'ready') RETURNING id",
    [userId],
  );
  const base = await serve(t);

  const response = await fetch(`${base}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Summarize the attached notes.", model: "nova", attachmentIds: [attachment.id] }),
  });
  const events = parseEvents(await response.text());
  assert.deepEqual(events.filter((item) => item.event === "error"), []);

  // Real stages, in the order they happened.
  const phases = events.filter((item) => item.event === "status").map((item) => item.data.phase);
  assert.ok(phases.indexOf("attachments") !== -1, `attachments stage reported (${phases.join(", ")})`);
  assert.ok(phases.indexOf("attachments") < phases.lastIndexOf("thinking"), "attachments are read before the model thinks");

  // Thinking arrives live, readable parts only, with provider names replaced.
  const deltas = events.filter((item) => item.event === "delta").map((item) => item.data);
  const thought = deltas.filter((delta) => typeof delta.reasoning === "string").map((delta) => delta.reasoning).join("");
  assert.match(thought, /Reading the notes\. Unlike the model, I should keep this short\./);
  assert.match(thought, /Plan: two sentences\./);
  assert.doesNotMatch(thought, providerTermsPattern);
  assert.doesNotMatch(thought, /OPAQUE-BLOB/);
  assert.equal(deltas.filter((delta) => typeof delta.text === "string").map((delta) => delta.text).join(""), REPLY);
  const firstText = deltas.findIndex((delta) => typeof delta.text === "string");
  assert.ok(deltas.findIndex((delta) => typeof delta.reasoning === "string") < firstText, "thinking streams before the reply");

  // The finished reply carries how long it thought, never what it thought.
  const complete = events.find((item) => item.event === "complete")?.data;
  assert.equal(complete.reply, REPLY);
  assert.ok(Number.isSafeInteger(complete.thoughtSeconds) && complete.thoughtSeconds >= 0, `thoughtSeconds ${complete.thoughtSeconds}`);
  for (const secret of ["Reading the notes", "Plan: two sentences", "OPAQUE-BLOB"]) assert.ok(!JSON.stringify(complete).includes(secret), secret);

  // Nothing of the thinking is stored; thoughtSeconds is.
  const { rows } = await client.query("SELECT role, content, metadata FROM messages ORDER BY created_at");
  assert.deepEqual(rows.map((row) => row.role), ["user", "assistant"]);
  for (const secret of ["Reading the notes", "Plan: two sentences", "OPAQUE-BLOB"]) assert.ok(!JSON.stringify(rows).includes(secret), `"${secret}" is not in the database`);
  assert.equal(rows[1].metadata.thoughtSeconds, complete.thoughtSeconds);

  // A reload brings back the reply and how long it thought, no thinking text.
  const reloaded = await (await fetch(`${base}/api/chat/conversations/${complete.conversationId}`)).json();
  const answer = reloaded.history.find((message) => message.role === "assistant");
  assert.equal(answer.content, REPLY);
  assert.equal(answer.thoughtSeconds, complete.thoughtSeconds);
  assert.equal(answer.metadata, undefined);
  for (const secret of ["Reading the notes", "Plan: two sentences", "OPAQUE-BLOB"]) assert.ok(!JSON.stringify(reloaded).includes(secret), secret);
});

test("a reply that streams no thinking sends no thinking and saves no thoughtSeconds", async (t) => {
  modelThinks = false;
  t.after(() => { modelThinks = true; });
  const base = await serve(t);
  const response = await fetch(`${base}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Say hello in one line.", model: "nova" }),
  });
  const events = parseEvents(await response.text());
  assert.deepEqual(events.filter((item) => item.event === "error"), []);
  const deltas = events.filter((item) => item.event === "delta").map((item) => item.data);
  assert.deepEqual(deltas.filter((delta) => "reasoning" in delta || "reasoningReset" in delta), [], "no thinking events");
  assert.equal(deltas.map((delta) => delta.text ?? "").join(""), REPLY);
  const complete = events.find((item) => item.event === "complete")?.data;
  assert.equal(complete.thoughtSeconds, null, "no Thought for X s without thinking");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE role = 'assistant' AND conversation_id = $1", [complete.conversationId]);
  assert.equal(rows.length, 1);
  assert.equal("thoughtSeconds" in rows[0].metadata, false, "nothing about thinking is stored");
  const reloaded = await (await fetch(`${base}/api/chat/conversations/${complete.conversationId}`)).json();
  assert.equal(reloaded.history.find((message) => message.role === "assistant").thoughtSeconds, null);
});
