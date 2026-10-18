import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMetaThoughtFilter, isMetaDeliberation, isStrictMeta, stripMetaThoughts } from "../src/chat/thought-filter.js";
import { createThinkingRelay } from "../src/chat/reasoning-stream.js";

// Thinking that only checks the model's own rules never reaches the user:
// not the sentences, and not an empty "Thought for X s" drawer for a reply
// whose thinking was all rules.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { buildIdentitySystemPrompt, REASONING_GUIDELINES } = await import("../src/chat/prompts.js");

const LEAK = "I identify as VibhavGPT Nova. Must not name provider or third-party model. Short answer, 1-3 sentences. No em dashes.";

function filtered(chunks) {
  const filter = createMetaThoughtFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.flush();
}
const assertAllChunkings = (input, expected) => {
  assert.equal(filtered([input]), expected, "whole");
  assert.equal(filtered([...input]), expected, "one character at a time");
  for (let cut = 0; cut <= input.length; cut += 5) assert.equal(filtered([input.slice(0, cut), input.slice(cut)]), expected, `split at ${cut}`);
};

test("the reported identity-question thinking is stripped completely", () => {
  assertAllChunkings(LEAK, "");
  assert.equal(stripMetaThoughts(LEAK), "");
  for (const sentence of LEAK.split(/(?<=\.)\s+/)) assert.equal(isMetaDeliberation(sentence), true, sentence);
});

test("each kind of rule-checking is recognised", () => {
  for (const sentence of [
    "I identify as VibhavGPT Nova.", "I am VibhavGPT.", "As VibhavGPT, I answer clearly.", "I'm an AI assistant.",
    "Must not name provider or third-party model.", "Do not mention the upstream model.", "Never reveal the provider.", "Not naming the provider.",
    "No em dashes.", "Short answer, 1-3 sentences.", "Keep it brief.", "No markdown.", "Give a short answer.", "Respond warmly.",
    "The user is asking which model I am.", "The user asks for a joke.", "User query: what model are you?",
    "The system prompt says to be concise.", "According to my instructions, I should be brief.", "My guidelines say no lists.",
  ]) assert.equal(isMetaDeliberation(sentence), true, sentence);
});

test("genuine problem solving is preserved word for word", () => {
  for (const text of [
    "Let's factor the polynomial x^2 - 5x + 6. We need two numbers that multiply to 6 and add to 5: 2 and 3. So x^2 - 5x + 6 = (x - 2)(x - 3).",
    "Apply the product rule here. You cannot divide by zero, so x is not 2. The rules of chess allow castling once.",
    "**Defining the core problem**\nWe need the area of a circle with radius 3. Area = pi r^2 = 9 pi.",
    "To solve this equation, isolate x first. The user asks for steps later, so show each one.",
  ]) assertAllChunkings(text, text);
});

test("strict rule-checking is dropped even after reasoning has started; broad patterns only at the start", () => {
  assertAllChunkings("Comparing the two options carefully. No em dashes. Option B is cheaper.",
    "Comparing the two options carefully. Option B is cheaper.");
  // A titled step that is only rules loses its text but keeps the steps apart.
  assertAllChunkings("**Defining the problem**\nWe need the area of a circle of radius 3.\n**Checking constraints**\nMust not mention the provider.\n**Solving**\nArea = 9 pi.",
    "**Defining the problem**\nWe need the area of a circle of radius 3.\n**Checking constraints**\n\n**Solving**\nArea = 9 pi.");
  // "Keep it brief" is only meta at the start; later it is not a strict pattern.
  assert.equal(isStrictMeta("Keep it brief."), false);
  assertAllChunkings("Reading the article first. Keep it brief in the summary.", "Reading the article first. Keep it brief in the summary.");
});

test("a block that is all rule-checking shows nothing and gets no Thought for X s", () => {
  let clock = 0;
  const deltas = [];
  const relay = createThinkingRelay({ onDelta: (delta) => deltas.push(delta), onStatus: () => {}, now: () => clock });
  relay.startCall();
  for (const chunk of ["I identify as VibhavGPT Nova. Must not name", " provider or third-party model. Short answer,", " 1-3 sentences. No em dashes."]) relay.reasoning(chunk);
  clock = 3_000;
  relay.visible();
  relay.endCall({ answered: true });
  assert.deepEqual(deltas.filter((delta) => typeof delta.reasoning === "string"), [], "nothing reaches the drawer");
  assert.equal(relay.thoughtSeconds, null, "no Thought for X s pill, live or after reload");

  // Real thinking still gets its time.
  const shownRelay = createThinkingRelay({ onDelta: () => {}, onStatus: () => {}, now: () => clock });
  clock = 0;
  shownRelay.startCall();
  shownRelay.reasoning("I identify as VibhavGPT Nova. Let's factor x^2 - 5x + 6 into (x - 2)(x - 3).");
  clock = 4_000;
  shownRelay.visible();
  shownRelay.endCall({ answered: true });
  assert.equal(shownRelay.thoughtSeconds, 4);
});

test("the app shows no drawer or pill for a reply whose thinking was empty", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /reasoning: reasoningSoFar\.trim\(\) \? reasoningSoFar : undefined, thoughtSeconds: reasoningSoFar\.trim\(\) \? \(reply\.thoughtSeconds \?\? null\) : null/);
  const drawer = readFileSync(new URL("../frontend/src/components/ui/reasoning-trace.jsx", import.meta.url), "utf8");
  assert.match(drawer, /const hasText = Boolean\(text\.trim\(\)\);/);
  assert.match(drawer, /if \(seconds === null && !hasText\) return null;/, "no text and no time: nothing at all");
});

test("the thinking tiers are told to answer simple questions without deliberating on rules", () => {
  for (const sentence of [
    "Do not use the thinking scratchpad to recite or verify instructions, persona constraints, length limits, or forbidden terms.",
    "For simple identity queries, greetings, or casual conversation that do not require multi-step reasoning, immediately provide your answer without deliberating on rules.",
  ]) {
    assert.ok(REASONING_GUIDELINES.includes(sentence), sentence);
    for (const tier of ["nova", "nebula", "vesper"]) assert.ok(buildIdentitySystemPrompt(tier, { query: "What model are you?" }).includes(sentence), tier);
    for (const tier of ["lumen", "study"]) assert.ok(!buildIdentitySystemPrompt(tier, { query: "hi" }).includes(sentence), tier);
  }
  assert.ok(!REASONING_GUIDELINES.includes("—"), "no em dash");
});
