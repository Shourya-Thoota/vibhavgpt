import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Each chat image reply records how its prompt was built: where the context
// came from (a rewrite, the plain handoff, or nothing), two lengths and the
// final prompt's hash, never the prompt itself. A request with no context to
// draw on is sent exactly as before.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const { cleanRewrite, expandImagePrompt, imageContextSource, imagePromptRecord, imageRewriteMessages, IMAGE_CONTEXT_SOURCES } = await import("../src/generation/image-handoff.js");
const { composeImagePrompt } = await import("../src/generation/service.js");
const { assistantMessageMetadata, imageContextMetadata } = await import("../src/chat/repository.js");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const completion = (content) => ({ choices: [{ message: { content } }] });
const unapproved = async () => { throw Object.assign(new Error("off"), { code: "route-not-configured" }); };
const HISTORY = [
  { role: "user", content: "Explain photosynthesis with an analogy" },
  { role: "assistant", content: "Think of a **chloroplast** as a solar-powered kitchen: sunlight is the stove, water and carbon dioxide are the ingredients, and sugar is the meal." },
];
const REWRITE = "A cozy kitchen inside a green chloroplast, sunlight powering the stove while water and carbon dioxide simmer into sugar.";

test("a rewrite is recorded as such, with both lengths and the final prompt's hash", async () => {
  const request = "Make an image of that analogy";
  const expansion = await expandImagePrompt(request, HISTORY, { callModel: async () => ({ data: completion(REWRITE) }) });
  const finalPrompt = composeImagePrompt(expansion.prompt, "", { context: expansion.context, textRequest: request });
  const record = imagePromptRecord({ request, expansion, finalPrompt });
  assert.deepEqual(record, { contextSource: "rewrite", requestChars: request.length, promptChars: finalPrompt.length, promptSha256: sha256(finalPrompt) });
  assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.values(record).includes(finalPrompt), false, "the prompt itself is not in the record");
});

test("the plain handoff, used when the rewriter is unavailable, is recorded as handoff", async () => {
  const request = "Make an image of that analogy";
  const expansion = await expandImagePrompt(request, HISTORY, { callModel: unapproved });
  assert.equal(expansion.expanded, false);
  assert.match(expansion.context, /solar-powered kitchen/);
  const finalPrompt = composeImagePrompt(expansion.prompt, "", { context: expansion.context, textRequest: request });
  assert.equal(imagePromptRecord({ request, expansion, finalPrompt }).contextSource, "handoff");
});

test("with no context to draw on, the prompt is exactly what it was before and is recorded as none", async () => {
  const request = "Create an image of a red fox in fresh snow";
  const calls = [];
  const expansion = await expandImagePrompt(request, [], { callModel: async () => { calls.push(1); return { data: completion(REWRITE) }; } });
  assert.deepEqual(expansion, { prompt: request, context: "", expanded: false });
  assert.equal(calls.length, 0, "no rewriter call");
  const finalPrompt = composeImagePrompt(expansion.prompt, "", { context: expansion.context, textRequest: request });
  assert.equal(finalPrompt, composeImagePrompt(request, ""), "byte for byte the old prompt");
  assert.equal(imagePromptRecord({ request, expansion, finalPrompt }).contextSource, "none");
  // A self-contained request in an ongoing chat, with the rewriter off, is also unchanged.
  const standalone = await expandImagePrompt(request, HISTORY, { callModel: unapproved });
  assert.equal(imageContextSource(standalone), "none");
  assert.equal(composeImagePrompt(standalone.prompt, "", { context: standalone.context, textRequest: request }), composeImagePrompt(request, ""));
});

test("a long conversation stays within the rewriter's budget, and so does its answer", async () => {
  const long = `${"The mitochondria is the powerhouse of the cell. ".repeat(210)}`.slice(0, 10_000);
  assert.equal(long.length, 10_000);
  const history = Array.from({ length: 20 }, (_, index) => (index % 2 ? { role: "assistant", content: long } : { role: "user", content: `Question ${index} ${"why ".repeat(200)}` }));
  const [, payload] = imageRewriteMessages("Make an image of that explanation", history);
  const turns = payload.content.split("\n").filter((line) => /^(User|Assistant): /.test(line));
  assert.ok(turns.length <= 8, `at most 8 turns, got ${turns.length}`);
  for (const line of turns.filter((turn) => turn.startsWith("Assistant: "))) assert.ok(line.length - "Assistant: ".length <= 900, "assistant lines at most 900 characters");
  for (const line of turns.filter((turn) => turn.startsWith("User: "))) assert.ok(line.length - "User: ".length <= 300, "user lines at most 300 characters");

  const sprawling = "A detailed scene of a glowing cell interior with mitochondria. ".repeat(80);
  assert.ok(cleanRewrite(sprawling).length <= 1500);
  const expansion = await expandImagePrompt("Make an image of that explanation", history, { callModel: async () => ({ data: completion(sprawling) }) });
  assert.equal(expansion.expanded, true);
  assert.ok(expansion.prompt.length <= 1500, "the final rewrite is at most 1500 characters");
});

test("only the three known sources are accepted, when recorded and when stored", () => {
  assert.deepEqual(IMAGE_CONTEXT_SOURCES, ["rewrite", "handoff", "none"]);
  for (const contextSource of ["bogus", "", "REWRITE", null]) {
    assert.throws(() => imagePromptRecord({ request: "x", expansion: null, finalPrompt: "x", contextSource }), TypeError, String(contextSource));
  }
  const valid = { source: "handoff", requestChars: 12, promptChars: 240, promptSha256: sha256("prompt") };
  assert.deepEqual(imageContextMetadata(valid), valid);
  assert.deepEqual(imageContextMetadata({ ...valid, prompt: "the full prompt" }), valid, "nothing but the four fields is kept");
  assert.equal(imageContextMetadata(null), null);
  for (const bad of [{ source: "bogus" }, { requestChars: -1 }, { promptChars: 1.5 }, { promptSha256: "abc" }, { promptSha256: sha256("x").toUpperCase() }]) {
    assert.throws(() => imageContextMetadata({ ...valid, ...bad }), TypeError, JSON.stringify(bad));
    assert.throws(() => assistantMessageMetadata({ model: "image", imageContext: { ...valid, ...bad } }), TypeError);
  }
  assert.deepEqual(assistantMessageMetadata({ model: "image", imageContext: valid }), { model: "image", imageContext: valid });
  assert.deepEqual(assistantMessageMetadata({ model: "nova" }), { model: "nova" }, "other replies carry no image context");
});
