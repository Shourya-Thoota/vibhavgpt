import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// A chat image may draw on its own conversation, and on nothing else: not on
// the same user's other chats, and never on another user's. Each conversation
// carries a marker word; every outbound payload (rewriter, image model and
// any other small-model call) is searched for the markers. Runs the real
// /api/chat routes on an in-memory database with every provider stubbed.
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
    generateImage: async ({ prompt, preparePrompt }) => { imagePrompts.push(preparePrompt ? await preparePrompt(prompt) : prompt); return { buffer: Buffer.from("png") }; },
    createStoredAttachment: async () => ({ id: "00000000-0000-4000-8000-000000000003" }),
  },
});
const { IMAGE_PROMPT_REWRITER } = await import("../src/generation/image-handoff.js");
const { saveExchange } = await import("../src/chat/repository.js");
const { config } = await import("../src/config.js");
const { default: express } = await import("express");
const { chatRouter } = await import("../src/chat/router.js");

config.moderationApiKey = "";
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture-nova";
config.lumenPrimaryApproved = true;
config.providerKeys.primaryFree = "fixture-primary-key";
config.providerBaseUrls.primaryFree = "https://primary.fixture.invalid/v1";
config.searchIntentModel = "fixture-small";

const USER_ONE = "privacy-user-one";
const USER_TWO = "privacy-user-two";
const A = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "nova", userContent: "Describe the ZEBRA-A robot", reply: "ZEBRA-A is a striped robot that paints murals on city walls at dawn." });
const B = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "nova", userContent: "Describe the OKAPI-B garden", reply: "OKAPI-B is a hidden garden of giant ferns behind a waterfall." });
const C = await saveExchange({ userId: USER_TWO, conversationId: null, modelKey: "nova", userContent: "Describe the LYNX-C lighthouse", reply: "LYNX-C is a lighthouse carved from ice on a northern cliff." });
for (const userId of [USER_ONE, USER_TWO]) {
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
}

// The rewriter echoes the conversation it was given, so whatever history
// reached it shows up in the image prompt too. `rewrite: false` leaves its
// route unapproved, so the plain handoff is used instead.
async function chatApp(t, userId, { rewrite = true } = {}) {
  config.lumenPrimaryApproved = rewrite;
  t.after(() => { config.lumenPrimaryApproved = true; });
  const outbound = [];
  const rewriter = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
    outbound.push(String(init?.body ?? ""));
    if (href.startsWith(config.providerBaseUrls.primaryFree)) {
      const body = JSON.parse(init.body);
      if (body.messages?.[0]?.content === IMAGE_PROMPT_REWRITER) {
        rewriter.push(body);
        const conversation = body.messages[1].content.split("\n\nLatest image request:")[0];
        return Response.json({ choices: [{ message: { content: `A mural-style illustration of this: ${conversation}` } }] });
      }
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    }
    throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { globalThis.fetch = realFetch; return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (body) => {
    const text = await (await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "nova", ...body }) })).text();
    const events = text.split("\n\n").map((block) => [block.match(/^event:\s*(\S+)/m)?.[1], block.match(/^data:\s*(.+)$/m)?.[1]]).filter(([event, data]) => event && data);
    const find = (name) => { const found = events.find(([event]) => event === name); return found ? JSON.parse(found[1]) : null; };
    return { complete: find("complete"), error: find("error") };
  };
  return { outbound, rewriter, send };
}

const FOREIGN = /OKAPI-B|LYNX-C/;

test("a rewritten image prompt draws on its own conversation and on no other chat or user", async (t) => {
  imagePrompts.length = 0;
  const app = await chatApp(t, USER_ONE);
  const result = await app.send({ message: "Make an image of that robot you described", conversationId: A.conversationId });
  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 1);
  assert.match(app.rewriter[0].messages[1].content, /ZEBRA-A/, "the rewriter sees this conversation");
  assert.doesNotMatch(app.rewriter[0].messages[1].content, FOREIGN);
  assert.equal(imagePrompts.length, 1);
  assert.match(imagePrompts[0], /ZEBRA-A/, "the image prompt carries it");
  assert.doesNotMatch(imagePrompts[0], FOREIGN, "and nothing from another chat or user");
  for (const payload of app.outbound) assert.doesNotMatch(payload, FOREIGN, "no outbound payload carries another chat");
});

test("the plain handoff, without the rewriter, also draws only on its own conversation", async (t) => {
  imagePrompts.length = 0;
  const app = await chatApp(t, USER_ONE, { rewrite: false });
  const result = await app.send({ message: "Make an image of that robot you described", conversationId: A.conversationId });
  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0);
  assert.match(imagePrompts[0], /The request refers to this, from the conversation just before it: .*ZEBRA-A/);
  assert.doesNotMatch(imagePrompts[0], FOREIGN);
  for (const payload of app.outbound) assert.doesNotMatch(payload, FOREIGN);
});

test("another user's conversation is not found, and no provider is called", async (t) => {
  imagePrompts.length = 0;
  const app = await chatApp(t, USER_ONE);
  const result = await app.send({ message: "Make an image of that lighthouse you described", conversationId: C.conversationId });
  assert.equal(result.complete, null);
  assert.equal(result.error?.status, 404);
  assert.equal(app.outbound.length, 0, "no outbound call of any kind");
  assert.equal(imagePrompts.length, 0, "no image");
  // Nothing was written into user two's conversation either.
  const { rows } = await client.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [C.conversationId]);
  assert.equal(rows[0].n, 2);
  assert.ok(B.conversationId, "user one's other chat exists and was never read");
});
