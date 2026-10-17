import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPreferredName, defaultOnboarding, MANAGED_BLOCK_START, mergeInstructions, normalizeOnboarding,
  ONBOARDING_STEPS, personalityInstructions, ROLE_OPTIONS, stripManagedInstructions,
} from "../frontend/src/onboarding.js";

test("older saved answers gain the new questions' defaults", () => {
  const legacy = { onboarding_completed: true, role: ["code"], personality: { concise_detailed: 20 }, primary_capability: "study", theme: "nebula" };
  const record = normalizeOnboarding(legacy);
  assert.equal(record.preferred_name, "");
  assert.equal(record.expertise, "some");
  assert.equal(record.units, "auto");
  assert.equal(record.sky, "dark");
  assert.equal(record.theme, "nebula");
  assert.equal(record.personality.concise_detailed, 20);
});

test("the retired Code role is no longer offered, and a saved one is dropped safely", () => {
  assert.equal(ROLE_OPTIONS.some((option) => option.value === "code"), false);
  const roleStep = ONBOARDING_STEPS.find((step) => step.id === "role");
  assert.equal(roleStep.options.some((option) => option.value === "code" || option.label === "Code"), false);
  const record = normalizeOnboarding({ onboarding_completed: true, role: ["code", "study", "write", "not-a-role"] });
  assert.deepEqual(record.role, ["study", "write"]);
  assert.deepEqual(normalizeOnboarding({ role: ["code"] }).role, []);
  assert.equal(record.onboarding_completed, true, "an older answer set still counts as finished");
});

test("unknown answers fall back instead of reaching the prompt", () => {
  const record = normalizeOnboarding({ expertise: "wizard", units: "cubits", sky: "plaid" });
  assert.deepEqual([record.expertise, record.units, record.sky], ["some", "auto", "dark"]);
});

test("a preferred name is one short line of plain text", () => {
  assert.equal(cleanPreferredName("  Ada\nLovelace  "), "Ada Lovelace");
  assert.equal(cleanPreferredName("<b>Ada</b>"), "bAda/b");
  assert.equal(cleanPreferredName("x".repeat(80)).length, 40);
});

test("the managed block carries name, background and units, and nothing for defaults", () => {
  assert.equal(personalityInstructions(defaultOnboarding()), "");
  const block = personalityInstructions({ ...defaultOnboarding(), preferred_name: "Ada", expertise: "expert", units: "metric" });
  assert.match(block, /Call the user Ada/);
  assert.match(block, /expert background/);
  assert.match(block, /metric units/);
  // Older callers still pass only the personality axes.
  assert.match(personalityInstructions({ ...defaultOnboarding().personality, concise_detailed: 10 }), /brief/);
});

test("merging keeps the user's own text and replaces only the managed block", () => {
  const first = mergeInstructions("Use TypeScript.", { ...defaultOnboarding(), units: "imperial" });
  assert.ok(first.startsWith("Use TypeScript."));
  assert.equal(first.split(MANAGED_BLOCK_START).length, 2);
  const second = mergeInstructions(first, { ...defaultOnboarding(), units: "metric" });
  assert.doesNotMatch(second, /imperial/);
  assert.equal(stripManagedInstructions(second), "Use TypeScript.");
});

test("every step has a headline and the last step offers the sky", () => {
  for (const step of ONBOARDING_STEPS) assert.ok(step.headline, step.id);
  assert.equal(ONBOARDING_STEPS.at(-1).kind, "themes");
  assert.deepEqual(ONBOARDING_STEPS.map((step) => step.id), ["welcome", "name", "role", "expertise", "personality", "units", "capability", "theme"]);
});
