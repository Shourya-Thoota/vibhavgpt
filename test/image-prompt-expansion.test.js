import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// "Create an image with all the vocab Study listed" only works if the image
// model is told the vocab. In an ongoing conversation a lightweight model
// rewrites the request into one standalone prompt from the recent turns;
// when it is unavailable the plain handoff is used. The prompt actually used
// is kept with the image reply, so later turns on any model know what it
// shows. The last test runs the real /api/chat routes on an in-memory
// database with the models and the image call stubbed.
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
const real = await import(new URL("../src/generation/service.js?real", import.meta.url).href);
const imagePrompts = [];
mock.module(new URL("../src/generation/service.js", import.meta.url).href, {
  namedExports: {
    ...real,
    generateImage: async ({ prompt }) => { imagePrompts.push(prompt); return { buffer: Buffer.from("png") }; },
    createStoredAttachment: async () => ({ id: "00000000-0000-4000-8000-000000000002" }),
  },
});
const { cleanRewrite, expandImagePrompt, IMAGE_PROMPT_REWRITER, imageRewriteMessages, shouldExpandImagePrompt } = await import("../src/generation/image-handoff.js");

const VOCAB = "## DNA replication vocabulary\n\n- **Helicase**: unzips the double helix\n- **Primase**: lays down RNA primers\n- **DNA polymerase**: adds nucleotides\n- **Okazaki fragments**: pieces of the lagging strand";
const HISTORY = [
  { role: "user", content: "Give me the key vocab for DNA replication" },
  { role: "assistant", content: VOCAB },
];
const REWRITE = "An illustrated, labeled study poster of DNA replication showing the double helix unzipped by helicase, primase laying RNA primers, DNA polymerase adding nucleotides, and Okazaki fragments on the lagging strand, each part labeled with its name.";
const completion = (content) => ({ choices: [{ message: { content } }] });

test("a rewrite is asked for only when the conversation has earlier text to draw on", () => {
  assert.equal(shouldExpandImagePrompt("Create an image with all the vocab", HISTORY), true);
  assert.equal(shouldExpandImagePrompt("A red fox in snow", []), false, "a first message stands alone");
  assert.equal(shouldExpandImagePrompt("Another one", [{ role: "user", content: "a cat" }, { role: "assistant", content: "I created this image for you." }]), false, "earlier images are no context");
  assert.equal(shouldExpandImagePrompt("  ", HISTORY), false);
});

test("the rewriter gets the given instruction, the recent turns as plain text, and the request", () => {
  const messages = imageRewriteMessages("Create an image with all the vocab Study listed", HISTORY);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, IMAGE_PROMPT_REWRITER);
  assert.match(IMAGE_PROMPT_REWRITER, /^You are an image prompt specialist\. Given the recent conversation history and the user's latest image request, rewrite the user's request into a detailed, descriptive, standalone visual prompt for an image generator\./);
  assert.match(IMAGE_PROMPT_REWRITER, /Output ONLY the rewritten image prompt string\.$/);
  assert.equal(messages[1].content, "Recent conversation (oldest first):\nUser: Give me the key vocab for DNA replication\nAssistant: DNA replication vocabulary; Helicase: unzips the double helix; Primase: lays down RNA primers; DNA polymerase: adds nucleotides; Okazaki fragments: pieces of the lagging strand\n\nLatest image request: Create an image with all the vocab Study listed");
  const many = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  assert.equal(imageRewriteMessages("draw it", many)[1].content.split("\n").filter((line) => /^(User|Assistant): /.test(line)).length, 8, "only the latest turns");
});

test("the answer is cleaned into a single bounded prompt", () => {
  assert.equal(cleanRewrite("<think>Let me pick the terms.</think>\nPrompt: \"A labeled poster of helicase.\""), "A labeled poster of helicase.");
  assert.equal(cleanRewrite("Rewritten image prompt:\n  A   tidy\n\nline"), "A tidy line");
  assert.ok(cleanRewrite("word ".repeat(1000)).length <= 1500);
});

test("the rewrite replaces the request; without the model, the plain handoff is used and nothing breaks", async () => {
  const seen = [];
  const ok = await expandImagePrompt("Create an image with all the vocab", HISTORY, { callModel: async (messages) => { seen.push(messages); return { data: completion(REWRITE) }; } });
  assert.deepEqual(ok, { prompt: REWRITE, context: "", expanded: true });
  assert.equal(seen.length, 1);
  const unapproved = await expandImagePrompt("Make an image of that list", HISTORY, { callModel: async () => { throw Object.assign(new Error("off"), { code: "route-not-configured" }); } });
  assert.equal(unapproved.expanded, false);
  assert.equal(unapproved.prompt, "Make an image of that list");
  assert.match(unapproved.context, /^DNA replication vocabulary; Helicase/, "the handoff still carries the reply");
  const empty = await expandImagePrompt("Make an image of that list", HISTORY, { callModel: async () => ({ data: completion("  ") }) });
  assert.equal(empty.expanded, false);
  const calls = [];
  await expandImagePrompt("A red fox", [], { callModel: async () => { calls.push(1); return { data: completion(REWRITE) }; } });
  assert.equal(calls.length, 0, "no call without a conversation");
});

test("in a chat, the image is drawn from the rewritten prompt, keeps its words, and the next turn knows what it shows", async (t) => {
  const { config } = await import("../src/config.js");
  config.moderationApiKey = "";
  config.providerKeys.paid = "fixture-key";
  config.chatModels.nova = "fixture-nova";
  config.lumenPrimaryApproved = true;
  config.providerKeys.primaryFree = "fixture-primary-key";
  config.providerBaseUrls.primaryFree = "https://primary.fixture.invalid/v1";
  config.searchIntentModel = "fixture-small";
  const { default: express } = await import("express");
  const { chatRouter } = await import("../src/chat/router.js");

  const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
  const paidRequests = [];
  const rewriterRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(config.providerBaseUrls.primaryFree)) {
      const body = JSON.parse(init.body);
      rewriterRequests.push(body);
      return Response.json(completion(REWRITE));
    }
    if (href.startsWith(config.providerBaseUrls.paid)) {
      if (href.includes("/generation")) return new Response("{}", { status: 404 });
      paidRequests.push(JSON.parse(init.body));
      return new Response([
        { choices: [{ delta: { content: paidRequests.length === 1 ? VOCAB : "That poster covers all four terms." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 60 } },
      ].map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const userId = "vocab-user";
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

  const first = await send({ message: "Give me the key vocab for DNA replication" });
  const image = await send({ message: "Create an image with all the vocab Study listed", conversationId: first.conversationId });
  assert.equal(image.reply, "I created this image for you.");

  assert.equal(rewriterRequests.length, 1, "one rewrite for the image");
  assert.equal(rewriterRequests[0].model, "fixture-small", "the lightweight model");
  assert.equal(rewriterRequests[0].messages[0].content, IMAGE_PROMPT_REWRITER);
  assert.match(rewriterRequests[0].messages[1].content, /Helicase: unzips the double helix; Primase: lays down RNA primers/, "it reads the vocab the reply listed");
  assert.equal(imagePrompts.length, 1);
  assert.ok(imagePrompts[0].startsWith(`${REWRITE} Render it`), "the image model gets the standalone rewrite");
  assert.doesNotMatch(imagePrompts[0], /Do not add any text/, "a labeled vocab poster may carry its words");

  // The image reply carries its prompt into the next turn's context.
  await send({ message: "Does it cover everything?", conversationId: first.conversationId });
  const history = paidRequests.at(-1).messages.filter((message) => message.role !== "system");
  const imageTurn = history.find((message) => message.role === "assistant" && message.content.startsWith("I created this image for you."));
  assert.equal(imageTurn.content, `I created this image for you.\n\n[Image prompt: ${REWRITE}]`);
  const { rows } = await client.query("SELECT content, metadata FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at", [first.conversationId]);
  assert.equal(rows[1].content, "I created this image for you.", "the saved reply itself is unchanged");
  assert.equal(rows[1].metadata.imagePrompt, REWRITE);
});
