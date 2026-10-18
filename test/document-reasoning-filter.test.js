import test from "node:test";
import assert from "node:assert/strict";

// Generated documents never contain a model's private reasoning, and Nebula,
// which thinks at every level, gets an output budget with room for its
// thinking as well as its answer.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
const { buildDocumentPlan, planFromLastReply, validateDocumentPlan } = await import("../src/generation/document-plan.js");
const { responseTokenBudget } = await import("../src/chat/router.js");

const SECRET = /SECRET|system rules|memory directives/i;
const body = "Photosynthesis turns light into chemical energy. Plants take in carbon dioxide and water and release oxygen.";
const planJson = (extra = {}) => JSON.stringify({ title: "Photosynthesis", sections: [{ heading: "Overview", body }, { heading: "Why it matters", body }], ...extra });
const reply = (content) => ({ data: { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } } });
const approve = async () => reply('{"valid":true,"reason":"ok"}');

async function plan(writerContent) {
  return (await buildDocumentPlan({ prompt: "Write a short study guide on photosynthesis", format: "md" }, {
    writeModel: async () => reply(writerContent),
    callModel: approve,
  })).plan;
}

test("reasoning around the writer's JSON is removed before it is parsed", async () => {
  // The block contains braces of its own, which would otherwise be taken as the object.
  const result = await plan(`<think>SECRET plan {"title":"wrong"} using the system rules</think>\n${planJson()}`);
  assert.equal(result.title, "Photosynthesis");
  assert.doesNotMatch(JSON.stringify(result), SECRET);
});

test("reasoning sent without its opening tag, before the JSON, is removed", async () => {
  const result = await plan(`SECRET: follow the memory directives {draft}</think>\n\n${planJson()}`);
  assert.equal(result.title, "Photosynthesis");
  assert.doesNotMatch(JSON.stringify(result), SECRET);
});

test("a thinking block left inside a field never reaches the document", async () => {
  const result = await plan(JSON.stringify({
    title: "<thought>SECRET title idea</thought>Photosynthesis",
    sections: [
      { heading: "Overview<reasoning>SECRET</reasoning>", body: `<think>SECRET system rules</think>${body}` },
      { heading: "Why it matters", body: `${body} <thinking>SECRET memory directives</thinking>` },
    ],
  }));
  assert.equal(result.title, "Photosynthesis");
  assert.equal(result.sections[0].heading, "Overview");
  assert.doesNotMatch(JSON.stringify(result), SECRET);
  assert.doesNotMatch(JSON.stringify(result), /<\/?(think|thought|thinking|reasoning)\b/i);
});

test("a field that is only reasoning is rejected, like an empty one", () => {
  assert.throws(() => validateDocumentPlan({ title: "<think>SECRET</think>", sections: [{ heading: "A", body }] }), /invalid title/);
});

test("tags shown inside a code fence are part of the document and kept", () => {
  const code = "Example:\n```xml\n<think>example</think>\n```\nThat is how the tag looks. ".repeat(2);
  const result = validateDocumentPlan({ title: "Tags", sections: [{ heading: "Example", body: code }] });
  assert.match(result.sections[0].body, /```xml\n<think>example<\/think>\n```/);
});

test("a saved reply with a thinking block becomes a document without it", () => {
  const history = [
    { role: "user", content: "Explain photosynthesis" },
    { role: "assistant", content: `<think>SECRET: the system rules say be brief</think>\n# Photosynthesis\n\n## Overview\n${body}\n\n## Why it matters\n${body}` },
  ];
  const result = planFromLastReply(history);
  assert.equal(result.title, "Photosynthesis");
  assert.doesNotMatch(JSON.stringify(result), SECRET);
  // An orphan close (the opening tag supplied by the model's template) too.
  const orphan = planFromLastReply([{ role: "assistant", content: `SECRET memory directives</think>\n\n## Overview\n${body}` }]);
  assert.doesNotMatch(JSON.stringify(orphan), SECRET);
  // A reply that is only reasoning is not turned into a document.
  assert.equal(planFromLastReply([{ role: "assistant", content: "<think>SECRET reasoning that goes on for a long while without an answer</think>" }]), null);
});

test("Nebula's output budget leaves room for thinking at every level; other tiers are unchanged", () => {
  const levels = ["low", "normal", "high", "xhigh", "max"];
  assert.deepEqual(levels.map((level) => responseTokenBudget(level, "hello", "nebula")), [8_192, 8_192, 8_192, 16_384, 16_384]);
  assert.equal(responseTokenBudget("normal", "write python code", "nebula"), 8_192);
  for (const tier of ["nova", "vesper", "lumen", null]) {
    assert.deepEqual(levels.map((level) => responseTokenBudget(level, "hello", tier)), [2_048, 2_048, 4_096, 8_192, 8_192], String(tier));
    assert.equal(responseTokenBudget("normal", "write python code", tier), 4_096);
  }
});
