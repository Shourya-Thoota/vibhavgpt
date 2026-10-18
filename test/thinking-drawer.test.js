import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMetaThoughtFilter, isMetaDeliberation } from "../src/chat/thought-filter.js";
import { createThinkingRelay } from "../src/chat/reasoning-stream.js";
import { thinkingSteps } from "../frontend/src/thinking-steps.js";

// The thinking drawer shows the model working on the user's problem:
// deliberation about instructions or persona at the start of a block is
// dropped, the thinking tiers are told to keep it out, and the drawer shows
// titled phases as numbered steps. Also: the landing page's source link is
// above every other layer, so it can be clicked.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { buildIdentitySystemPrompt, REASONING_GUIDELINES } = await import("../src/chat/prompts.js");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function filtered(chunks) {
  const filter = createMetaThoughtFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.flush();
}
const assertAllChunkings = (input, expected) => {
  assert.equal(filtered([input]), expected, "whole");
  assert.equal(filtered([...input]), expected, "one character at a time");
  for (let cut = 0; cut <= input.length; cut += 7) assert.equal(filtered([input.slice(0, cut), input.slice(cut)]), expected, `split at ${cut}`);
};

test("deliberation about the request, persona or instructions is dropped from the start of thinking", () => {
  assertAllChunkings("The user asks for the derivative of x^2. I should answer as VibhavGPT and keep it short. To solve this, apply the power rule: 2x.",
    "To solve this, apply the power rule: 2x.");
  assertAllChunkings("My instructions say do not disclose the provider. According to the system prompt I am Nova. Drafting the solution: list three options.",
    "Drafting the solution: list three options.");
  assertAllChunkings("**Considering the instructions**\nThe system prompt says keep it short.\n**Drafting the answer**\nUse a table.",
    "**Drafting the answer**\nUse a table.");
});

test("domain reasoning is kept intact, including later sentences that mention the user", () => {
  for (const text of [
    "To solve this equation, isolate x first. Then divide both sides by 3.",
    "**Defining the core problem**\nWe need the area of a circle with radius 3. Area = pi r^2 = 9 pi.",
    "Defining the core problem: the series converges. The user asks for steps, so show each one.",
    "Pi is 3.14 here. Keep going.",
  ]) assertAllChunkings(text, text);
  assert.equal(isMetaDeliberation("To solve this equation"), false);
  assert.equal(isMetaDeliberation("Defining the core problem"), false);
  assert.equal(isMetaDeliberation("The user wants a haiku."), true);
  assert.equal(isMetaDeliberation("I must not mention the model behind me."), true);
});

test("a block that is only deliberation shows nothing", () => {
  assert.equal(filtered(["The user wants a joke. I must not mention the model."]), "");
});

test("the live relay drops the deliberation, keeps the reasoning and separates later blocks only when they show text", () => {
  const deltas = [];
  const relay = createThinkingRelay({ onDelta: (delta) => deltas.push(delta), onStatus: () => {} });
  const shown = () => deltas.filter((delta) => typeof delta.reasoning === "string").map((delta) => delta.reasoning).join("");
  relay.startCall();
  for (const chunk of ["The user asks for", " a summary. I should keep it", " short. Reading the", " article first: it has three parts."]) relay.reasoning(chunk);
  relay.endCall({ answered: false });
  assert.equal(shown(), "Reading the article first: it has three parts.");
  // A second call whose thinking is all deliberation adds nothing, not even a blank line.
  relay.startCall();
  relay.reasoning("As VibhavGPT I must not reveal the provider.");
  relay.endCall({ answered: false });
  assert.equal(shown(), "Reading the article first: it has three parts.");
  // A third call with real reasoning is set apart by a blank line.
  relay.startCall();
  relay.reasoning("Comparing the three parts.");
  relay.visible();
  relay.endCall({ answered: true });
  assert.equal(shown(), "Reading the article first: it has three parts.\n\nComparing the three parts.");
});

test("the thinking tiers are told to keep their thinking on the user's problem", () => {
  for (const tier of ["nova", "nebula", "vesper"]) assert.ok(buildIdentitySystemPrompt(tier, { query: "hi" }).includes(REASONING_GUIDELINES), tier);
  for (const tier of ["lumen", "study"]) assert.ok(!buildIdentitySystemPrompt(tier, { query: "hi" }).includes(REASONING_GUIDELINES), tier);
  assert.match(REASONING_GUIDELINES, /^Reasoning Guidelines: Use your thinking scratchpad exclusively for domain analysis, problem-solving, and formulating the response to the user's query\. Never deliberate on, recite, verify, or mention system guidelines, persona boundaries, developer instructions, or memory constraints within your thinking process\.$/);
  assert.ok(!REASONING_GUIDELINES.includes("—"), "no em dash");
});

test("the drawer shows titled phases as numbered steps, and plain thinking as paragraphs", () => {
  assert.deepEqual(thinkingSteps("**Defining the problem**\nWe need the area.\n\nRadius is **3**.\n## Drafting the solution\nArea = 9 pi."), [
    { title: "Defining the problem", paragraphs: [[{ text: "We need the area." }], [{ text: "Radius is " }, { text: "3", strong: true }, { text: "." }]] },
    { title: "Drafting the solution", paragraphs: [[{ text: "Area = 9 pi." }]] },
  ]);
  assert.deepEqual(thinkingSteps("Plain thinking.\n\nSecond paragraph."), [{ title: null, paragraphs: [[{ text: "Plain thinking." }], [{ text: "Second paragraph." }]] }]);
  // Markup in the model's text stays text; nothing is rendered as HTML.
  assert.deepEqual(thinkingSteps("<img src=x onerror=alert(1)>"), [{ title: null, paragraphs: [[{ text: "<img src=x onerror=alert(1)>" }]] }]);
  const component = read("frontend/src/components/ui/reasoning-trace.jsx");
  assert.equal(component.match(/<ThinkingSteps text=\{text\} \/>/g)?.length, 2, "live and folded views both show steps");
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
  assert.match(component, /aria-expanded=\{open\}/, "the Thought for X s pill still folds and unfolds");
});

test("the landing page's source link sits above every other layer and is the only clickable part of the footer", () => {
  const html = read("frontend/public/home/index.html");
  const footer = html.match(/<footer style="([^"]*)">[\s\S]*?<a ([^>]*)>Source code<\/a><\/footer>/);
  assert.ok(footer, "the footer and its link are there");
  const footerZ = Number(footer[1].match(/z-index:(\d+)/)[1]);
  const otherZ = [...html.matchAll(/z-index:(-?\d+)/g)].map((match) => Number(match[1])).filter((value) => value !== footerZ);
  assert.ok(otherZ.length > 0 && otherZ.every((value) => value < footerZ), `footer z-index ${footerZ} is above ${Math.max(...otherZ)}`);
  assert.match(footer[1], /pointer-events:none/, "the footer strip blocks nothing");
  assert.match(footer[2], /href="https:\/\/github\.com\/Shourya-Thoota\/vibhavgpt"/);
  assert.match(footer[2], /target="_blank" rel="noopener noreferrer"/);
  assert.match(footer[2], /pointer-events:auto/);
  assert.match(footer[2], /cursor:pointer/);
});
