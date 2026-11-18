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
// Lumen on its production route type (the router's paid zero-retention route) with the fixture engine. (Nova, which this suite
// used before, was retired on 2026-11-14.)
config.lumenChatRoute = "paid-zdr";
config.lumenPaidZdrProviders = ["fixture-host"];
config.chatModels.lumenFallback1 = "fixture-lumen";
config.lumenPrimaryApproved = true;
config.providerKeys.primaryFree = "fixture-primary-key";
config.providerBaseUrls.primaryFree = "https://primary.fixture.invalid/v1";
config.searchIntentModel = "fixture-small";

const USER_ONE = "privacy-user-one";
const USER_TWO = "privacy-user-two";
const A = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "lumen", userContent: "Describe the ZEBRA-A robot", reply: "ZEBRA-A is a striped robot that paints murals on city walls at dawn." });
const B = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "lumen", userContent: "Describe the OKAPI-B garden", reply: "OKAPI-B is a hidden garden of giant ferns behind a waterfall." });
const C = await saveExchange({ userId: USER_TWO, conversationId: null, modelKey: "lumen", userContent: "Describe the LYNX-C lighthouse", reply: "LYNX-C is a lighthouse carved from ice on a northern cliff." });
const V = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "vesper", userContent: "Describe CANARY-VESPER robot", reply: "CANARY-VESPER is an autonomous rover navigating Martian dunes." });
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
    const text = await (await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", ...body }) })).text();
    const events = text.split("\n\n").map((block) => [block.match(/^event:\s*(\S+)/m)?.[1], block.match(/^data:\s*(.+)$/m)?.[1]]).filter(([event, data]) => event && data);
    const find = (name) => { const found = events.find(([event]) => event === name); return found ? JSON.parse(found[1]) : null; };
    return { complete: find("complete"), error: find("error") };
  };
  return { outbound, rewriter, send, base };
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

test("a Vulcan chat with earlier turns containing unique canary strings skips context expansion", async (t) => {
  imagePrompts.length = 0;
  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that robot";
  const result = await app.send({ message: userRequest, conversationId: V.conversationId, model: "vesper" });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "the rewriter is never called for Vulcan");
  for (const payload of app.outbound) {
    assert.doesNotMatch(payload, /CANARY-VESPER/, "no outbound request contains any canary");
  }

  assert.equal(imagePrompts.length, 1);
  const expectedPrompt = real.composeImagePrompt(userRequest, "");
  assert.equal(imagePrompts[0], expectedPrompt, "final image prompt equals typed words plus fixed directives only");
  assert.doesNotMatch(imagePrompts[0], /CANARY-VESPER/, "image prompt contains no canary");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [V.conversationId]);
  const assistantRow = rows[rows.length - 1];
  assert.equal(assistantRow.metadata.imageContext?.source, "none", "metadata source says none");
});

test("control test: a non-Vulcan tier still expands earlier context with canary", async (t) => {
  imagePrompts.length = 0;
  const CONTROL_CANARY = "CONTROL-CANARY-ROBOT";
  const N = await saveExchange({ userId: USER_ONE, conversationId: null, modelKey: "lumen", userContent: `Describe ${CONTROL_CANARY}`, reply: `${CONTROL_CANARY} is an ornate brass automaton.` });
  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that robot you described";
  const result = await app.send({ message: userRequest, conversationId: N.conversationId, model: "lumen" });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 1, "rewriter is called for non-Vulcan");
  assert.match(app.rewriter[0].messages[1].content, new RegExp(CONTROL_CANARY), "rewriter receives canary");
  assert.equal(imagePrompts.length, 1);
  assert.match(imagePrompts[0], new RegExp(CONTROL_CANARY), "final image prompt carries canary context");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [N.conversationId]);
  const assistantRow = rows[rows.length - 1];
  assert.equal(assistantRow.metadata.imageContext?.source, "rewrite");
});

test("owner receives imagePrompt via API, but another user's request never receives it", async (t) => {
  const appOne = await chatApp(t, USER_ONE);
  const resOne = await fetch(`${appOne.base}/api/chat/conversations/${A.conversationId}`);
  assert.equal(resOne.status, 200);
  const dataOne = await resOne.json();
  assert.ok(dataOne.history.length > 0);

  const appTwo = await chatApp(t, USER_TWO);
  const resTwo = await fetch(`${appTwo.base}/api/chat/conversations/${A.conversationId}`);
  assert.equal(resTwo.status, 404);
  const dataTwo = await resTwo.json();
  assert.equal(dataTwo.error, "Conversation not found.");
  assert.equal(dataTwo.history, undefined);
});

test("switching Vulcan -> Nova disables image rewriting and excludes historical canary from image prompt", async (t) => {
  imagePrompts.length = 0;
  const SWITCH_CANARY = "CANARY-VESPER-SWITCH-ALPHA";
  const conv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "vesper",
    userContent: `Describe the ${SWITCH_CANARY} system`,
    reply: `${SWITCH_CANARY} is a classified quantum navigation node.`,
  });

  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that system you described";
  const result = await app.send({
    message: userRequest,
    conversationId: conv.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter must not be called when conversation previously used Vulcan");
  for (const payload of app.outbound) {
    assert.doesNotMatch(payload, new RegExp(SWITCH_CANARY), "no outbound payload contains historical Vulcan canary");
  }

  assert.equal(imagePrompts.length, 1);
  const expectedPrompt = real.composeImagePrompt(userRequest, "");
  assert.equal(imagePrompts[0], expectedPrompt, "image prompt contains literal request and style only");
  assert.doesNotMatch(imagePrompts[0], new RegExp(SWITCH_CANARY), "image prompt carries no historical canary");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conv.conversationId]);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.metadata.imageContext?.source, "none", "imageContext.source must be 'none'");
});

test("a Vulcan turn older than the 8-message context window still protects the conversation on Nova", async (t) => {
  imagePrompts.length = 0;
  const OLD_CANARY = "CANARY-VESPER-OLD-BETA";
  const conv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "vesper",
    userContent: `Analyze ${OLD_CANARY}`,
    reply: `${OLD_CANARY} is a subterranean geothermal reactor deep under volcanic crust.`,
  });

  for (let i = 1; i <= 5; i += 1) {
    await saveExchange({
      userId: USER_ONE,
      conversationId: conv.conversationId,
      modelKey: "lumen",
      userContent: `Follow up question ${i} on cooling pipes`,
      reply: `Cooling pipe observation ${i} for geothermal transfer loops.`,
    });
  }

  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image illustrating the reactor you described earlier";
  const result = await app.send({
    message: userRequest,
    conversationId: conv.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter is never called even when Vulcan turn is beyond 8-turn window");
  for (const payload of app.outbound) {
    assert.doesNotMatch(payload, new RegExp(OLD_CANARY), "no outbound payload carries old Vulcan canary");
  }

  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(OLD_CANARY), "image prompt carries no old canary");
  const expectedPrompt = real.composeImagePrompt(userRequest, "");
  assert.equal(imagePrompts[0], expectedPrompt);

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conv.conversationId]);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.metadata.imageContext?.source, "none");
});

test("plain-handoff fallback cannot include protected history when rewriter is unavailable", async (t) => {
  imagePrompts.length = 0;
  const FALLBACK_CANARY = "CANARY-VESPER-FALLBACK-GAMMA";
  const conv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "vesper",
    userContent: `Detail ${FALLBACK_CANARY}`,
    reply: `${FALLBACK_CANARY} is an orbital telescope with gold hexagonal mirrors.`,
  });

  const app = await chatApp(t, USER_ONE, { rewrite: false });
  const userRequest = "Make an image of that telescope you described";
  const result = await app.send({
    message: userRequest,
    conversationId: conv.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter was not called");
  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(FALLBACK_CANARY), "plain handoff did not leak Vulcan canary");
  assert.doesNotMatch(imagePrompts[0], /The request refers to this/, "plain handoff prefix is absent");
  const expectedPrompt = real.composeImagePrompt(userRequest, "");
  assert.equal(imagePrompts[0], expectedPrompt, "image prompt has literal request only");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conv.conversationId]);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.metadata.imageContext?.source, "none", "source is none, never handoff");
});

test("cross-account access to a Vulcan conversation remains 404 with no generation or provider calls", async (t) => {
  imagePrompts.length = 0;
  const app = await chatApp(t, USER_TWO);
  const result = await app.send({ message: "Make an image of that robot", conversationId: V.conversationId, model: "lumen" });
  assert.equal(result.complete, null);
  assert.equal(result.error?.status, 404);
  assert.equal(app.outbound.length, 0, "no outbound calls made");
  assert.equal(imagePrompts.length, 0, "no image generated");
});

test("guard-query failure never falls back to history expansion and generates from literal prompt only", async (t) => {
  imagePrompts.length = 0;
  const GUARD_CANARY = "CANARY-GUARD-FAILURE-DELTA";
  const conv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "lumen",
    userContent: `Describe ${GUARD_CANARY}`,
    reply: `${GUARD_CANARY} is a crystal cavern illuminated by bioluminescent moss.`,
  });

  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    if (typeof sql === "string" && sql.includes("exists") && sql.includes("metadata")) {
      throw new Error("Simulated transient database failure during historical guard check");
    }
    return originalQuery(sql, params);
  };
  t.after(() => { client.query = originalQuery; });

  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that cavern you described";
  const result = await app.send({
    message: userRequest,
    conversationId: conv.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter must not be called on guard query failure");
  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(GUARD_CANARY), "canary is not expanded");
  const expectedPrompt = real.composeImagePrompt(userRequest, "");
  assert.equal(imagePrompts[0], expectedPrompt, "generated only from literal prompt plus fixed directives");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conv.conversationId]);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.metadata.imageContext?.source, "none", "guard failure marks source as none");
});

test("existing supported Vulcan aliases and case variations normalize correctly", async () => {
  const { normalizeModelKey, vesperModelKeys } = await import("../src/chat/model-keys.js");
  const { hasHistoricalVesperUse } = await import("../src/chat/repository.js");

  assert.equal(normalizeModelKey("vesper"), "vesper");
  assert.equal(normalizeModelKey("VESPER"), "vesper");
  assert.equal(normalizeModelKey("Vulcan"), "vesper");
  assert.equal(normalizeModelKey("  vesper  "), "vesper");
  assert.equal(normalizeModelKey("  VESPER  "), "vesper");

  const keys = vesperModelKeys();
  assert.ok(keys.includes("vesper"), "vesperModelKeys includes 'vesper'");

  assert.equal(normalizeModelKey("nova"), "nova");
  assert.equal(normalizeModelKey("spark"), "lumen");
  assert.equal(normalizeModelKey("ultra"), "nebula");

  const aliasConv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "VESPER",
    userContent: "Alias test query",
    reply: "Alias test reply",
  });
  assert.equal(await hasHistoricalVesperUse(USER_ONE, aliasConv.conversationId), true);
  assert.equal(await hasHistoricalVesperUse(USER_TWO, aliasConv.conversationId), false);
});

test("legacy unlabelled assistant reply + current Nova disables rewrite and handoff fallback", async (t) => {
  imagePrompts.length = 0;
  const LEGACY_CANARY = "CANARY-LEGACY-UNLABELLED-ZETA";
  const { rows: [conversation] } = await client.query(
    "INSERT INTO conversations (user_id, title, model) VALUES ($1, 'Legacy Chat', 'nova') RETURNING id",
    [USER_ONE],
  );
  await client.query(
    "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'user', 'Who is that?', '{}', now() - interval '2 minutes')",
    [conversation.id],
  );
  await client.query(
    "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'assistant', $2, '{}', now() - interval '1 minute')",
    [conversation.id, `${LEGACY_CANARY} is a secret deep-sea probe.`],
  );

  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that probe you described";
  const result = await app.send({
    message: userRequest,
    conversationId: conversation.id,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter must not be called for legacy unlabelled turn");
  for (const payload of app.outbound) {
    assert.doesNotMatch(payload, new RegExp(LEGACY_CANARY));
  }
  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(LEGACY_CANARY));
  assert.equal(imagePrompts[0], real.composeImagePrompt(userRequest, ""));

  const { rows: rows1 } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conversation.id]);
  const lastRow1 = rows1[rows1.length - 1];
  assert.equal(lastRow1.metadata.imageContext?.source, "none");

  imagePrompts.length = 0;
  const appNoRewrite = await chatApp(t, USER_ONE, { rewrite: false });
  const resultNoRewrite = await appNoRewrite.send({
    message: userRequest,
    conversationId: conversation.id,
    model: "lumen",
  });
  assert.equal(resultNoRewrite.complete?.reply, "I created this image for you.");
  assert.equal(appNoRewrite.rewriter.length, 0);
  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(LEGACY_CANARY));
  assert.doesNotMatch(imagePrompts[0], /The request refers to this/);
  assert.equal(imagePrompts[0], real.composeImagePrompt(userRequest, ""));
  const { rows: rows2 } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conversation.id]);
  const lastRow2 = rows2[rows2.length - 1];
  assert.equal(lastRow2.metadata.imageContext?.source, "none");
});

test("missing, blank, non-string and unrecognized assistant model values disable image context", async (t) => {
  const cases = [
    { name: "null model", metadata: { model: null }, canary: "CANARY-NULL-MODEL" },
    { name: "empty string model", metadata: { model: "" }, canary: "CANARY-EMPTY-MODEL" },
    { name: "whitespace-only model", metadata: { model: "  \t\n  " }, canary: "CANARY-BLANK-MODEL" },
    { name: "number model", metadata: { model: 123 }, canary: "CANARY-NUMBER-MODEL" },
    { name: "object model", metadata: { model: { nested: "val" } }, canary: "CANARY-OBJECT-MODEL" },
    { name: "unrecognized model", metadata: { model: "gpt-4o" }, canary: "CANARY-UNRECOGNIZED-MODEL" },
    { name: "voice line with no model", metadata: { source: "voice" }, canary: "CANARY-VOICE-MODEL" },
  ];

  for (const c of cases) {
    imagePrompts.length = 0;
    const { rows: [conversation] } = await client.query(
      "INSERT INTO conversations (user_id, title, model) VALUES ($1, $2, 'nova') RETURNING id",
      [USER_ONE, `Test ${c.name}`],
    );
    await client.query(
      "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'assistant', $2, $3, now() - interval '1 minute')",
      [conversation.id, `${c.canary} is an artifact.`, JSON.stringify(c.metadata)],
    );

    const app = await chatApp(t, USER_ONE);
    const userRequest = "Make an image of that artifact you described";
    const result = await app.send({
      message: userRequest,
      conversationId: conversation.id,
      model: "lumen",
    });

    assert.equal(result.complete?.reply, "I created this image for you.", `${c.name}: completes`);
    assert.equal(app.rewriter.length, 0, `${c.name}: rewriter not called`);
    for (const payload of app.outbound) {
      assert.doesNotMatch(payload, new RegExp(c.canary), `${c.name}: outbound does not match canary`);
    }
    assert.equal(imagePrompts.length, 1, `${c.name}: one prompt generated`);
    assert.doesNotMatch(imagePrompts[0], new RegExp(c.canary), `${c.name}: image prompt does not contain canary`);
    assert.equal(imagePrompts[0], real.composeImagePrompt(userRequest, ""), `${c.name}: literal prompt only`);

    const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conversation.id]);
    assert.equal(rows[rows.length - 1].metadata.imageContext?.source, "none", `${c.name}: imageContext.source is none`);
  }
});

test("whitespace/case variants in stored conversation/message models normalize and protect context", async (t) => {
  const cases = [
    {
      name: "conversation model with tabs, newlines and spaces",
      convModel: "  \t\r\nVESPER \n",
      msgModel: "nova",
      canary: "CANARY-WS-CONV-VESPER",
    },
    {
      name: "assistant message model with tabs, newlines and mixed case",
      convModel: "nova",
      msgModel: " \t\nVesper\r\n ",
      canary: "CANARY-WS-MSG-VESPER",
    },
    {
      name: "user message model with whitespace and upper case",
      convModel: "nova",
      userMsgModel: " \r\n VESPER \t",
      canary: "CANARY-WS-USER-VESPER",
    },
  ];

  for (const c of cases) {
    imagePrompts.length = 0;
    const { rows: [conversation] } = await client.query(
      "INSERT INTO conversations (user_id, title, model) VALUES ($1, $2, $3) RETURNING id",
      [USER_ONE, `Test ${c.name}`, c.convModel],
    );
    if (c.userMsgModel) {
      await client.query(
        "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'user', $2, $3, now() - interval '2 minutes')",
        [conversation.id, `Question about ${c.canary}`, JSON.stringify({ model: c.userMsgModel })],
      );
      await client.query(
        "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'assistant', $2, $3, now() - interval '1 minute')",
        [conversation.id, `Details of ${c.canary}`, JSON.stringify({ model: "lumen" })],
      );
    } else {
      await client.query(
        "INSERT INTO messages (conversation_id, role, content, metadata, created_at) VALUES ($1, 'assistant', $2, $3, now() - interval '1 minute')",
        [conversation.id, `Details of ${c.canary}`, JSON.stringify({ model: c.msgModel })],
      );
    }

    const app = await chatApp(t, USER_ONE);
    const userRequest = "Make an image of that thing you described";
    const result = await app.send({
      message: userRequest,
      conversationId: conversation.id,
      model: "lumen",
    });

    assert.equal(result.complete?.reply, "I created this image for you.", `${c.name}: reply received`);
    assert.equal(app.rewriter.length, 0, `${c.name}: rewriter not called`);
    for (const payload of app.outbound) {
      assert.doesNotMatch(payload, new RegExp(c.canary), `${c.name}: canary not in outbound`);
    }
    assert.equal(imagePrompts.length, 1);
    assert.doesNotMatch(imagePrompts[0], new RegExp(c.canary), `${c.name}: canary not in prompt`);
    assert.equal(imagePrompts[0], real.composeImagePrompt(userRequest, ""));

    const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conversation.id]);
    assert.equal(rows[rows.length - 1].metadata.imageContext?.source, "none", `${c.name}: imageContext.source is none`);
  }
});

test("Vulcan user turn whose reply failed preserves Vulcan marker and blocks image context after switch to Nova", async (t) => {
  const { markReplyMissing, saveUserMessage, setConversationModel } = await import("../src/chat/repository.js");
  const FAILED_VESPER_CANARY = "CANARY-FAILED-VESPER-TURN";

  const saved = await saveUserMessage({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "vesper",
    content: `Design the ${FAILED_VESPER_CANARY} drone`,
  });

  const { rows: [initialUserMsg] } = await client.query(
    "SELECT role, metadata FROM messages WHERE id = $1",
    [saved.messageId],
  );
  assert.equal(initialUserMsg.role, "user");
  assert.equal(initialUserMsg.metadata?.model, "vesper", "newly saved Vulcan user turn records model: vesper");

  // Include unrelated synthetic metadata and a whitespace/case-variant existing Vulcan marker
  await client.query(
    "UPDATE messages SET metadata = metadata || $1::jsonb WHERE id = $2",
    [JSON.stringify({ model: "  \t\nVESPER\r\n ", syntheticAuditProp: "keep-me-across-retries" }), saved.messageId],
  );

  await markReplyMissing(saved.messageId, "failed", "req-failed-1");
  const { rows: [failedUserMsg] } = await client.query(
    "SELECT metadata FROM messages WHERE id = $1",
    [saved.messageId],
  );
  assert.match(failedUserMsg.metadata?.model, /vesper/i, "markReplyMissing preserves Vulcan model marker");
  assert.equal(failedUserMsg.metadata?.replyStatus, "failed", "replyStatus is recorded");
  assert.equal(failedUserMsg.metadata?.requestId, "req-failed-1", "requestId is recorded");
  assert.equal(failedUserMsg.metadata?.syntheticAuditProp, "keep-me-across-retries", "unrelated metadata preserved through failure");

  await markReplyMissing(saved.messageId, "interrupted", "req-interrupted-2");
  const { rows: [interruptedUserMsg] } = await client.query(
    "SELECT metadata FROM messages WHERE id = $1",
    [saved.messageId],
  );
  assert.match(interruptedUserMsg.metadata?.model, /vesper/i, "interruption preserves Vulcan marker");
  assert.equal(interruptedUserMsg.metadata?.replyStatus, "interrupted");
  assert.equal(interruptedUserMsg.metadata?.syntheticAuditProp, "keep-me-across-retries");

  // Explicitly call owner-scoped setConversationModel(..., "nova") before requesting the image
  const updatedConv = await setConversationModel(USER_ONE, saved.conversationId, "nova");
  assert.equal(updatedConv?.model, "nova");
  const { rows: [convRow] } = await client.query("SELECT model FROM conversations WHERE id = $1", [saved.conversationId]);
  assert.equal(convRow.model, "nova", "stored conversation model really is Nova");

  // Retry that identical unanswered user message on Nova
  const retried = await saveUserMessage({
    userId: USER_ONE,
    conversationId: saved.conversationId,
    modelKey: "lumen",
    content: `Design the ${FAILED_VESPER_CANARY} drone`,
  });
  assert.equal(retried.reused, true, "identical unanswered user message is reused");
  assert.equal(retried.messageId, saved.messageId);

  const { rows: [retriedUserMsg] } = await client.query(
    "SELECT metadata FROM messages WHERE id = $1",
    [saved.messageId],
  );
  assert.equal(retriedUserMsg.metadata?.model, "vesper", "Vulcan marker survives retry on Nova and is canonicalized");
  assert.equal(retriedUserMsg.metadata?.replyStatus, undefined, "transient replyStatus is cleared on retry");
  assert.equal(retriedUserMsg.metadata?.requestId, undefined, "transient requestId is cleared on retry");
  assert.equal(retriedUserMsg.metadata?.syntheticAuditProp, "keep-me-across-retries", "unrelated synthetic metadata survives retry");

  imagePrompts.length = 0;
  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make an image of that drone";
  const result = await app.send({
    message: userRequest,
    conversationId: saved.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 0, "rewriter must not be called after failed and retried Vulcan user turn");
  for (const payload of app.outbound) {
    assert.doesNotMatch(payload, new RegExp(FAILED_VESPER_CANARY), "outbound payloads do not contain failed Vulcan canary");
  }
  assert.equal(imagePrompts.length, 1);
  assert.doesNotMatch(imagePrompts[0], new RegExp(FAILED_VESPER_CANARY), "final prompt contains no canary");
  assert.equal(imagePrompts[0], real.composeImagePrompt(userRequest, ""));

  const { rows: convMsgs } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [saved.conversationId]);
  const lastMsg = convMsgs[convMsgs.length - 1];
  assert.equal(lastMsg.metadata.imageContext?.source, "none", "imageContext.source remains none");
});

test("saveExchange preserves user Vulcan marker and unrelated metadata while clearing transient failure fields", async () => {
  const { markReplyMissing, saveExchange, saveUserMessage } = await import("../src/chat/repository.js");
  const userTurn = await saveUserMessage({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "vesper",
    content: "Unanswered Vulcan query to be answered",
  });
  await client.query(
    "UPDATE messages SET metadata = metadata || $1::jsonb WHERE id = $2",
    [JSON.stringify({ syntheticField: "keep-me-on-success" }), userTurn.messageId],
  );
  await markReplyMissing(userTurn.messageId, "failed", "req-transient-fail");

  const { rows: [beforeExchange] } = await client.query("SELECT metadata FROM messages WHERE id = $1", [userTurn.messageId]);
  assert.equal(beforeExchange.metadata.model, "vesper");
  assert.equal(beforeExchange.metadata.replyStatus, "failed");
  assert.equal(beforeExchange.metadata.requestId, "req-transient-fail");
  assert.equal(beforeExchange.metadata.syntheticField, "keep-me-on-success");

  await saveExchange({
    userId: USER_ONE,
    conversationId: userTurn.conversationId,
    modelKey: "lumen",
    userContent: "Unanswered Vulcan query to be answered",
    userMessageId: userTurn.messageId,
    reply: "Here is your completed answer.",
  });

  const { rows: [afterExchange] } = await client.query("SELECT metadata FROM messages WHERE id = $1", [userTurn.messageId]);
  assert.equal(afterExchange.metadata.model, "vesper", "saveExchange preserves Vulcan marker on answered user message");
  assert.equal(afterExchange.metadata.syntheticField, "keep-me-on-success", "saveExchange preserves unrelated metadata");
  assert.equal(afterExchange.metadata.replyStatus, undefined, "transient replyStatus is cleared by saveExchange");
  assert.equal(afterExchange.metadata.requestId, undefined, "transient requestId is cleared by saveExchange");
});

test("fully labelled never-Vulcan conversation with multiple safe turns still expands context", async (t) => {
  imagePrompts.length = 0;
  const EXPAND_CANARY = "CANARY-SAFE-EXPAND-MULTI";
  const conv = await saveExchange({
    userId: USER_ONE,
    conversationId: null,
    modelKey: "lumen",
    userContent: `Tell me about ${EXPAND_CANARY}`,
    reply: `${EXPAND_CANARY} is a celestial observatory in the mountains.`,
  });

  await saveExchange({
    userId: USER_ONE,
    conversationId: conv.conversationId,
    modelKey: "lumen",
    userContent: "Show me a picture of the observatory",
    reply: "I created this image for you.",
    replyModel: "image",
    imageContext: { source: "rewrite", requestChars: 30, promptChars: 50, promptSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  });

  const app = await chatApp(t, USER_ONE);
  const userRequest = "Make another image of that observatory at sunset";
  const result = await app.send({
    message: userRequest,
    conversationId: conv.conversationId,
    model: "lumen",
  });

  assert.equal(result.complete?.reply, "I created this image for you.");
  assert.equal(app.rewriter.length, 1, "rewriter is called for fully labelled never-Vulcan conversation");
  assert.match(app.rewriter[0].messages[1].content, new RegExp(EXPAND_CANARY), "rewriter sees canary");
  assert.equal(imagePrompts.length, 1);
  assert.match(imagePrompts[0], new RegExp(EXPAND_CANARY), "final image prompt carries canary");

  const { rows } = await client.query("SELECT metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC", [conv.conversationId]);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.metadata.imageContext?.source, "rewrite");
});
