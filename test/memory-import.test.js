import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
const { importedFactText, parseImportedFacts } = await import("../src/memory/service.js");

const contents = (text) => parseImportedFacts(text).map((fact) => fact.content);

test("the format the Memory page documents imports every fact", () => {
  const facts = contents("## Profile\n- I live in Boston.\n- I am a software engineer.\n\n## Preferences\n- I prefer concise answers.\n\n## VibhavGPT\n- I am rebuilding the memory page.");
  assert.deepEqual(facts, ["User lives in Boston.", "User is a software engineer.", "User prefers concise answers.", "User is rebuilding the memory page."]);
});

test("text copied from a rendered reply (no # or - markers) imports, preamble ignored", () => {
  const facts = contents("Here's a structured memory summary:\n\nPreferences\nPrefers concise, direct answers.\n\nProfile\nLives in New Jersey.");
  assert.deepEqual(facts, ["User prefers concise, direct answers.", "User lives in New Jersey."]);
});

test("PDF text: glyph bullets and wrapped lines become whole facts", () => {
  const facts = contents("Profile\n● Studies computer science at Rutgers, expected\nto graduate in 2027.\n• Plays guitar.");
  assert.deepEqual(facts, ["User studies computer science at Rutgers, expected to graduate in 2027.", "User plays guitar."]);
});

test("bold labels, numbered lists and colon headings", () => {
  const facts = contents("**Profile**\n- **Name:** Avery\n\n### Interests\n1. Astronomy\n2) Plays chess\n\nTools:\n- VS Code");
  assert.deepEqual(facts, ["User's name: Avery", "User is interested in astronomy", "User plays chess", "User uses VS Code"]);
});

test("first-person facts read in the third person", () => {
  assert.equal(importedFactText("I usually study at night"), "User usually studies at night");
  assert.equal(importedFactText("I'm a junior"), "User is a junior");
  assert.equal(importedFactText("My major is physics"), "User's major is physics");
  assert.equal(importedFactText("I can read Spanish"), "User can read Spanish");
});

test("an import with no facts is an error, not 'Added 0 memories'", () => {
  const router = readFileSync(new URL("../src/memory/router.js", import.meta.url), "utf8");
  assert.match(router, /if \(!result\.candidates\) return res\.status\(422\)/);
});

test("Study uses its independent server-selected route", () => {
  const router = readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.match(router, /STUDY_MODEL_KEY = "study"/);
  assert.match(router, /if \(conversationMode === "study"\) modelKey = STUDY_MODEL_KEY;/);
  assert.match(router, /title: "Study session", model: STUDY_MODEL_KEY/);
  assert.doesNotMatch(router, /today's Study messages/);
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /const sentModel = studyMode \? STUDY_MODEL : model;/);
  assert.match(app, /\{!studyMode && <Select/);
  assert.match(app, /studyMode \? "VibhavGPT" : modelLabel\(message\.model\)/);
});
