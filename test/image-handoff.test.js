import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// An image asked for in a chat or Study conversation can point back at what
// the assistant just wrote ("an image of that analogy", "draw the
// flashcards"). The image model sees only its prompt, so the assistant's
// latest reply goes with such a request, as clean prose and kept short; a
// request that stands on its own goes as it is. The last test runs the real
// /api/chat routes on an in-memory database with the model and the image
// call stubbed.
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
  namedExports: { requireSession: (req, _res, next) => next(), loadOptionalSession: (_req, _res, next) => next() },
});
// The real prompt builder, with the image call and file storage captured.
const real = await import(new URL("../src/generation/service.js?real", import.meta.url).href);
const imagePrompts = [];
mock.module(new URL("../src/generation/service.js", import.meta.url).href, {
  namedExports: {
    ...real,
    generateImage: async ({ prompt }) => { imagePrompts.push(prompt); return { buffer: Buffer.from("png") }; },
    createStoredAttachment: async () => ({ id: "00000000-0000-4000-8000-000000000001" }),
  },
});
const { composeImagePrompt } = real;
const { imageHandoffContext, plainContext, refersToConversation } = await import("../src/generation/image-handoff.js");

const ANALOGY = "Think of a **chloroplast** as a solar-powered kitchen:\n\n- Sunlight is the stove's power.\n- Water and carbon dioxide are the ingredients.\n- Sugar is the meal, and oxygen is the steam that escapes.\n\nSee [this diagram](https://example.com/x.png).";

test("requests that point back at the conversation are recognised; self-contained ones are not", () => {
  for (const request of [
    "Make an image of that analogy", "Draw the flashcards", "Can you illustrate the character you described?",
    "Create a picture based on this", "Draw it", "Generate an image of the solar kitchen analogy", "Make an illustration of the above",
    "Picture of these cards please", "make an image from your explanation",
  ]) assert.equal(refersToConversation(request), true, request);
  for (const request of ["Make an image of a red fox in fresh snow", "Generate a watercolor lighthouse at dusk", "Draw a cat wearing a tiny hat"]) {
    assert.equal(refersToConversation(request), false, request);
  }
});

test("the reply is handed on as plain prose: no markdown, links, code or reasoning", () => {
  assert.equal(plainContext(ANALOGY),
    "Think of a chloroplast as a solar-powered kitchen:; Sunlight is the stove's power.; Water and carbon dioxide are the ingredients.; Sugar is the meal, and oxygen is the steam that escapes. See this diagram.");
  assert.equal(plainContext("<think>The user wants cards.</think>## Cards\n```js\nconst x = 1;\n```\n| Term | Meaning |\n|---|---|\n| Mitosis | Cell division |"),
    "Cards; Term, Meaning; Mitosis, Cell division");
});

test("the latest text reply is used, skipping image replies, and it is kept short", () => {
  const history = [
    { role: "user", content: "Explain photosynthesis with an analogy" },
    { role: "assistant", content: ANALOGY },
    { role: "user", content: "Make an image of that analogy" },
    { role: "assistant", content: "I created this image for you." },
  ];
  assert.match(imageHandoffContext("Now draw it again but at night", history), /^Think of a chloroplast as a solar-powered kitchen/);
  assert.equal(imageHandoffContext("A red fox in fresh snow, as an image", history), "", "self-contained: nothing added");
  assert.equal(imageHandoffContext("Draw that", [{ role: "user", content: "hi" }]), "", "nothing to hand on");
  const long = Array.from({ length: 80 }, (_, index) => `Card ${index + 1} shows the stage where the cell copies its chromosomes.`).join(" ");
  const context = imageHandoffContext("Illustrate these cards", [{ role: "assistant", content: long }]);
  assert.ok(context.length <= 1200 && context.length > 700, `${context.length} characters`);
  assert.match(context, /\.$/, "cut at a sentence end");
});

test("the image prompt carries the context apart from the request, and only the request decides on text", () => {
  const prompt = composeImagePrompt("Make an image of that analogy", "", { context: "A kitchen powered by sunlight. The sign reads Chloroplast Cafe." });
  assert.match(prompt, /^Make an image of that analogy\. The request refers to this, from the conversation just before it: A kitchen powered by sunlight\. The sign reads Chloroplast Cafe\. Render it/);
  assert.match(prompt, /Do not add any text, letters or numbers to the image\./, "a sign in the context does not ask for lettering");
  assert.equal(composeImagePrompt("A cat"), composeImagePrompt("A cat", "", { context: "" }), "no context, no change");
});

test("a chat request for an image of the last reply sends that reply to the image model", async (t) => {
  const { config } = await import("../src/config.js");
  config.moderationApiKey = "";
  config.providerKeys.primaryFree = "";
  config.providerKeys.paid = "fixture-key";
  config.chatModels.nova = "fixture-nova";
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");

  const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      return new Response([
        { choices: [{ delta: { content: ANALOGY } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 60 } },
      ].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const userId = "handoff-user";
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (body) => {
    const text = await (await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nova", ...body }) })).text();
    const complete = text.split("\n\n").find((block) => /^event:\s*complete$/m.test(block));
    return complete ? JSON.parse(complete.match(/^data:\s*(.+)$/m)[1]) : assert.fail(`no complete event: ${text.slice(0, 300)}`);
  };

  const first = await send({ message: "Explain photosynthesis with an analogy" });
  assert.ok(first.conversationId);
  const image = await send({ message: "Make an image of that analogy", conversationId: first.conversationId });
  assert.equal(image.reply, "I created this image for you.");
  assert.equal(imagePrompts.length, 1);
  assert.match(imagePrompts[0], /^Make an image of that analogy\. The request refers to this, from the conversation just before it: Think of a chloroplast as a solar-powered kitchen:; Sunlight is the stove's power\./);
  assert.doesNotMatch(imagePrompts[0], /\*\*|https?:|\]\(/, "clean prose only");

  await send({ message: "Make an image of a red fox in fresh snow", conversationId: first.conversationId });
  assert.equal(imagePrompts[1].startsWith("Make an image of a red fox in fresh snow. Render it"), true, "self-contained requests are unchanged");
  // The saved user message is what the user typed, not the expanded prompt.
  const { rows } = await client.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at", [first.conversationId]);
  assert.deepEqual(rows.map((row) => row.content), ["Explain photosynthesis with an analogy", "Make an image of that analogy", "Make an image of a red fox in fresh snow"]);
});
