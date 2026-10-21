import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Whichever model answers gets the whole conversation: switching from Nova
// to Nebula mid-chat keeps every earlier turn, any Mermaid diagram exactly as
// written, and what the learner did with the reply's flashcards or quiz.
// Runs the real /api/chat routes on an in-memory database, with the model
// stubbed so each request it receives can be inspected.
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
config.chatModels.nebula = "fixture-nebula";
config.nebulaDataPolicyVerified = true;
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");
const { appendStudyNote, studyResultNote, withStudyResults } = await import("../src/chat/study-results.js");
const { deckResult, initialDeck, parseStudyBlock, quizResult } = await import("../frontend/src/study-widgets.js");

const DIAGRAM = "```mermaid\nflowchart TD\n  A[Sunlight] --> B[\"Chloroplast (leaf)\"]\n  B --> C[Glucose]\n```";
const QUIZ = "```quiz\n" + JSON.stringify({ title: "Cells", questions: [
  { question: "What does mitosis produce?", options: ["Two identical cells", "Four gametes"], answer: 0 },
  { question: "Which makes gametes?", options: ["Mitosis", "Meiosis"], answer: 1 },
] }) + "\n```";
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function serve(t, userId, replies) {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      const body = JSON.parse(init.body);
      requests.push(body);
      const content = replies[Math.min(requests.length - 1, replies.length - 1)];
      return new Response([
        { choices: [{ delta: { content } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20 } },
      ].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  await client.query(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, tier, status, billing_source, cancel_at_period_end, current_period_ends_at)
    VALUES ($1, $2, $3, 'pro', 'active', 'stripe', false, now() + interval '20 days')`, [userId, `cus_${userId}`, `sub_${userId}`]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: req.get("x-test-user") ?? userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (body) => {
    const text = await (await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).text();
    const complete = text.split("\n\n").find((block) => /^event:\s*complete$/m.test(block));
    return complete ? JSON.parse(complete.match(/^data:\s*(.+)$/m)[1]) : assert.fail(`no complete event: ${text.slice(0, 300)}`);
  };
  return { base, send, requests };
}

const historyOf = (request) => request.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }));

test("switching from Nova to Nebula mid-chat sends Nebula every earlier turn, the diagram source unchanged", async (t) => {
  const { base, send, requests } = await serve(t, "switcher", [DIAGRAM, "Mitosis copies a cell; meiosis makes gametes.", "Here is the updated diagram."]);
  const first = await send({ model: "nova", message: "Draw photosynthesis as a flowchart" });
  await send({ model: "nova", conversationId: first.conversationId, message: "And how do mitosis and meiosis differ?" });
  assert.equal(requests[1].model, "fixture-nova");

  const switched = await fetch(`${base}/api/chat/conversations/${first.conversationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nebula" }) });
  assert.equal(switched.status, 200, "the same conversation, now on Nebula");
  await send({ model: "nebula", conversationId: first.conversationId, message: "Add a step for water to the diagram" });

  assert.equal(requests[2].model, "fixture-nebula", "Nebula answers");
  assert.deepEqual(historyOf(requests[2]), [
    { role: "user", content: "Draw photosynthesis as a flowchart" },
    { role: "assistant", content: DIAGRAM },
    { role: "user", content: "And how do mitosis and meiosis differ?" },
    { role: "assistant", content: "Mitosis copies a cell; meiosis makes gametes." },
    { role: "user", content: "Add a step for water to the diagram" },
  ], "every turn, in order, with the Mermaid block exactly as written");
  // Both models get the same instructions, including how to write diagrams.
  const system = (request) => request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(system(requests[2]), /language mermaid/);
  assert.match(system(requests[1]), /language mermaid/);
});

test("a finished quiz is kept with its reply, and the next model sees the score and the missed questions", async (t) => {
  const { base, send, requests } = await serve(t, "learner", [QUIZ, "Let's go over meiosis again."]);
  const quizReply = await send({ model: "nova", message: "Quiz me on cell division" });
  assert.ok(quizReply.messageId, "the reply's id comes back with it");
  const quiz = parseStudyBlock("quiz", QUIZ.replace(/^```quiz\n|\n```$/g, ""));
  const result = quizResult(quiz, { 0: 0, 1: 0 });
  assert.deepEqual(result, { kind: "quiz", title: "Cells", total: 2, score: 1, missed: [{ question: "Which makes gametes?", chosen: "Mitosis", correct: "Meiosis" }] });
  const recorded = await fetch(`${base}/api/chat/conversations/${quizReply.conversationId}/messages/${quizReply.messageId}/study-results`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
  assert.equal(recorded.status, 204);

  // Someone else can't write to this reply, and junk is refused.
  const stranger = await fetch(`${base}/api/chat/conversations/${quizReply.conversationId}/messages/${quizReply.messageId}/study-results`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": "someone-else" }, body: JSON.stringify(result) });
  assert.equal(stranger.status, 404);
  const junk = await fetch(`${base}/api/chat/conversations/${quizReply.conversationId}/messages/${quizReply.messageId}/study-results`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "quiz", score: 9, total: 2 }) });
  assert.equal(junk.status, 400);

  await client.query("UPDATE conversations SET model = 'nebula' WHERE id = $1", [quizReply.conversationId]);
  await send({ model: "nebula", conversationId: quizReply.conversationId, message: "What should I review?" });
  const history = historyOf(requests[1]);
  assert.equal(requests[1].model, "fixture-nebula");
  assert.equal(history[1].role, "assistant");
  assert.equal(history[1].content, `${QUIZ}\n\n[Study result: Quiz "Cells": 1/2 correct. Missed: "Which makes gametes?" (chose "Mitosis"; correct: "Meiosis").]`);
  // The saved reply itself is unchanged; the note travels in its metadata.
  const { rows } = await client.query("SELECT content, metadata FROM messages WHERE id = $1", [quizReply.messageId]);
  assert.equal(rows[0].content, QUIZ);
  assert.equal(rows[0].metadata.studyResults.length, 1);
});

test("study results become short, bounded notes, and only well-formed ones are kept", () => {
  const deck = parseStudyBlock("flashcards", JSON.stringify({ title: "Planets", cards: Array.from({ length: 5 }, (_, index) => ({ front: `P${index}`, back: `A${index}` })) }));
  const state = { ...initialDeck(5), finished: true, marks: { 0: "know", 1: "know", 2: "know", 3: "know", 4: "know" } };
  assert.deepEqual(deckResult(deck, state), { kind: "flashcards", title: "Planets", total: 5, known: 5, learning: 0 });
  assert.equal(studyResultNote(deckResult(deck, state)), 'Flashcard review of "Planets": 5 know it, 0 still learning, of 5 cards.');
  for (const bad of [null, {}, { kind: "flashcards", total: 3, known: 3, learning: 1 }, { kind: "quiz", total: 0, score: 0 }, { kind: "quiz", total: 2, score: -1 }, { kind: "essay" }]) {
    assert.equal(studyResultNote(bad), null, JSON.stringify(bad));
  }
  const long = studyResultNote({ kind: "quiz", title: "x".repeat(500), total: 30, score: 0, missed: Array.from({ length: 30 }, () => ({ question: "q\n".repeat(200), chosen: "a", correct: "b" })) });
  assert.ok(long.length < 2500 && !long.includes("\n"), "clipped, on one line");
  let metadata = { sources: [] };
  for (let index = 0; index < 8; index += 1) metadata = appendStudyNote(metadata, `note ${index}`);
  assert.deepEqual(metadata.studyResults, ["note 3", "note 4", "note 5", "note 6", "note 7"], "the latest few");
  assert.deepEqual(metadata.sources, [], "other metadata is kept");
  assert.deepEqual(withStudyResults([{ role: "user", content: "hi", studyResults: ["x"] }, { role: "assistant", content: "Deck", studyResults: [] }]), [{ role: "user", content: "hi", studyResults: ["x"] }, { role: "assistant", content: "Deck", studyResults: [] }], "only replies with notes change");
});

test("history does not depend on which model answers", () => {
  const router = read("src/chat/router.js");
  assert.match(router, /const existing = await loadConversation\(userId, conversationId\);[\s\S]*?history = existing\.history;/, "loaded by conversation, not by model");
  assert.match(router, /const contextOptions = \{ systemMessages, history: withStudyResults\(history\), referenceMessages, currentMessage \};\n\s*const fittedContext = fitConversationContext\(contextOptions\);/, "one shared budget for every model");
  const app = read("frontend/src/App.jsx");
  assert.match(app, /if \(conversationId\) \{\s*await api\(`\/api\/chat\/conversations\/\$\{conversationId\}`, \{\s*method: "PATCH",\s*body: JSON\.stringify\(\{ model: nextModel \}\),/, "a model switch keeps the conversation");
});

test("finished widgets report once to their reply, through the chat", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /onStudyResult=\{message\.id && conversationId \? \(result\) => recordStudyResult\(message\.id, result\) : null\}/);
  assert.match(app, /api\(`\/api\/chat\/conversations\/\$\{conversationId\}\/messages\/\$\{messageId\}\/study-results`, \{ method: "POST", body: JSON\.stringify\(result\) \}\)\.catch\(\(\) => \{\}\)/, "best effort");
  assert.match(app, /\{ id: reply\.messageId \?\? null, role: "assistant"/, "a fresh reply knows its id");
  assert.match(app, /id: message\.id \?\? null,\n\s*role: message\.role,/, "so does a reloaded one");
  for (const file of ["InteractiveFlashcards.jsx", "InteractiveQuiz.jsx"]) {
    assert.match(read(`frontend/src/components/${file}`), /if \(!state\.finished\) \{ reported\.current = false; return; \}\n\s*if \(reported\.current \|\| !onResult\) return;\n\s*reported\.current = true;/, `${file} reports each finish once`);
  }
});
