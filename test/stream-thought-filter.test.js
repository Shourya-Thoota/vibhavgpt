import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// A model's private reasoning, inside the reply text or in its own fields,
// never reaches the user: not live, not in the saved reply.
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
config.chatModels.nova = "fixture-nova";
const { createThoughtFilter, stripThoughts } = await import("../src/chat/thought-filter.js");
const { callModelStreaming } = await import("../src/chat/providers.js");
const { visibleReply } = await import("../src/chat/router.js");

// Feeds chunks through one filter the way the chat stream does, applying
// withdrawals, and returns what the user would end up seeing.
function streamThrough(chunks) {
  const filter = createThoughtFilter();
  let shown = "";
  for (const part of [...chunks.map((chunk) => filter.push(chunk)), filter.end()]) {
    if (part.discardEarlier) shown = "";
    shown += part.text;
  }
  return shown;
}
// Every way of cutting `text` into three chunks.
function* splits(text) {
  for (let i = 0; i <= text.length; i += 1) for (let j = i; j <= text.length; j += 1) yield [text.slice(0, i), text.slice(i, j), text.slice(j)];
}
const assertAllSplits = (input, expected) => {
  for (const chunks of splits(input)) assert.equal(streamThrough(chunks), expected, JSON.stringify(chunks));
  assert.equal(streamThrough([...input]), expected, "one character at a time");
  assert.equal(stripThoughts(input), expected, "whole reply");
};

test("normal text passes through unchanged, with no character dropped", () => {
  const text = "Hello, world. a < b and x<y>z, <3, 5 > 3, <div>ok</div>, <thinker> and <th alone, `code` and <|not a marker.";
  assertAllSplits(text, text);
});

test("ordinary text is sent at once; only a possible tag start is held", () => {
  const filter = createThoughtFilter();
  assert.equal(filter.push("Hello").text, "Hello");
  assert.equal(filter.push(" world <th").text, " world ", "only '<th' waits for the next chunk");
  assert.equal(filter.push("ink>secret</think>!").text, "!");
  assert.equal(filter.push(" a <").text, " a ");
  assert.equal(filter.push("3").text, "<3", "a '<' that is not a tag is released by the next chunk");
});

test("a <think> block is removed and only the answer remains", () => {
  assertAllSplits("<think>notes</think>Output", "Output");
});

test("a <thought> block is removed and only the answer remains", () => {
  assertAllSplits("<thought>notes</thought>Output", "Output");
});

test("other envelopes, attributes, case and blocks mid-reply are removed", () => {
  assertAllSplits("<Thinking mode=\"deep\">secret</THINKING>\n\nAnswer here", "Answer here");
  assertAllSplits("Sure. <reasoning>hidden plan</reasoning>Here it is.", "Sure. Here it is.");
  assertAllSplits("<think>a</think>One <thought>b</thought>two", "One two");
  assertAllSplits("<|channel|>analysis<|message|>secret steps<|end|><|start|>assistant<|channel|>final<|message|>Final answer", "Final answer");
});

test("tags split across chunk boundaries are buffered and removed", () => {
  assert.equal(streamThrough(["<th", "ink>reasoning</th", "ink>Visible text"]), "Visible text");
  assert.equal(streamThrough(["Intro <tho", "ught>x</", "thought> end"]), "Intro  end");
});

test("a block left open when the stream ends or is cut off is dropped", () => {
  assertAllSplits("Answer first. <think>never closed and secret", "Answer first. ");
  assert.equal(streamThrough(["<think>the system rules say", " to never reveal"]), "");
});

test("reasoning sent without its opening tag is withdrawn at the closing tag", () => {
  // Common with Qwen3 templates that supply the opening <think> themselves.
  const filter = createThoughtFilter();
  assert.equal(filter.push("I should follow the memory rules").text, "I should follow the memory rules");
  const after = filter.push(".</think>\n\nThe answer is 4.");
  assert.equal(after.discardEarlier, true, "what was sent must be withdrawn");
  assert.equal(after.text, "The answer is 4.");
  assertAllSplits("I should follow the memory rules.</think>\n\nThe answer is 4.", "The answer is 4.");
});

test("tags inside a code fence are part of the answer and are kept", () => {
  const text = "Use:\n```xml\n<think>example</think>\n```\nDone";
  assertAllSplits(text, text);
});

test("the saved reply uses the same filter", () => {
  assert.equal(visibleReply("Sure. <thought>internal: follow memory rules</thought>Here you go."), "Sure. Here you go.");
  assert.equal(visibleReply("internal plan about system instructions</think>\n\nHello!"), "Hello!");
  assert.equal(visibleReply("<think>only reasoning, never closed"), "", "a reply that is only reasoning is empty");
});

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });

test("provider reasoning fields never reach the visible text", async () => {
  const seen = [];
  const reasoning = [];
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    onDelta: (text) => { seen.push(text); return true; },
    onReasoning: (text) => reasoning.push(text),
    fetchImpl: async (url) => url.includes("/generation") ? new Response("{}", { status: 404 }) : sse([
      { choices: [{ delta: { reasoning_content: "SECRET-reasoning_content", thought: "SECRET-thought", reasoning: "SECRET-reasoning", thinking: "SECRET-thinking" } }] },
      { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "SECRET-encrypted" }] } }] },
      { choices: [{ delta: { content: "Visible answer." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]),
  });
  assert.equal(seen.join(""), "Visible answer.");
  assert.equal(data.choices[0].message.content, "Visible answer.");
  assert.deepEqual(reasoning, [], "no dedicated reasoning field is relayed");
  assert.doesNotMatch(JSON.stringify(data), /SECRET/);
});

// The real /api/chat/stream route: what the client receives and what is saved.
async function serve(t, userId, modelChunks) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      return sse([...modelChunks.map((content) => ({ choices: [{ delta: { content } }] })), { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 12 } }]);
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nova", message: "Explain photosynthesis briefly." }),
  });
  return (await response.text()).split("\n\n").map((block) => ({ event: block.match(/^event:\s*(.+)$/m)?.[1], data: block.match(/^data:\s*(.+)$/m)?.[1] }))
    .filter((item) => item.event && item.data).map((item) => ({ event: item.event, data: JSON.parse(item.data) }));
}
// The visible text the client would show, applying resets as the app does.
function clientText(events) {
  let text = "";
  for (const { event, data } of events) {
    if (event !== "delta") continue;
    if (data.reset) text = "";
    if (typeof data.text === "string") text += data.text;
  }
  return text;
}
const savedReply = async (userId) => (await client.query(
  "SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1 AND m.role = 'assistant'", [userId],
)).rows.map((row) => row.content);

test("a <think> block split across chunks never reaches the client and is not saved", async (t) => {
  const events = await serve(t, "thought-split", ["<th", "ink>SECRET system rules and memory directives</th", "ink>Visible text"]);
  assert.equal(events.find((item) => item.event === "error"), undefined);
  assert.doesNotMatch(JSON.stringify(events.filter((item) => item.event === "delta")), /SECRET/, "nothing of the block was streamed");
  assert.equal(clientText(events), "Visible text", "the answer still streams live");
  assert.equal(events.find((item) => item.event === "complete").data.reply, "Visible text");
  assert.deepEqual(await savedReply("thought-split"), ["Visible text"]);
});

test("reasoning without an opening tag is withdrawn from the client and not saved", async (t) => {
  const events = await serve(t, "thought-orphan", ["SECRET plan: follow the memory rules", ".</think>\n\n", "The answer is 4."]);
  const withdraw = events.find((item) => item.event === "delta" && item.data.reset);
  assert.deepEqual(withdraw?.data, { reset: true, withdraw: true }, "the streamed reasoning is withdrawn, with no copy kept");
  assert.equal(clientText(events), "The answer is 4.");
  assert.equal(events.find((item) => item.event === "complete").data.reply, "The answer is 4.");
  assert.deepEqual(await savedReply("thought-orphan"), ["The answer is 4."]);
});

test("the app keeps no copy of a withdrawn stream", async () => {
  const app = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(delta\.reset\) \{ previousStream = delta\.withdraw \? "" : \(visibleStream \|\| previousStream\);/);
});
