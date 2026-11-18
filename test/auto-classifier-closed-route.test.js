// Slice 5.1: the auto classifier's remote route is closed (PR 3: a free model with no hosts, held strictly). Auto selection must still
// work: the prompt is never sent anywhere, the local analysis classifies it, and the broker picks a real tier for every plan.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:9/unused";
const { scanAndClassifyPrompt, brokerAutoModel, CLASSIFICATION_COMPLEXITY } = await import("../src/chat/auto-classifier.js");
const { routeAllowed } = await import("../src/chat/route-inventory.js");
const { SEED_MODEL_REFERENCE_MATRIX } = await import("../src/models/seed-catalog.js");

// The same mapping generateChat applies to the broker's choice.
const tierFor = (multiplier, plan) => (multiplier <= 1.0 ? "lumen" : multiplier > 7.0 && (plan === "pro" || plan === "max") ? "vesper" : multiplier > 2.0 ? "nebula" : "nova");

const PROMPTS = {
  [CLASSIFICATION_COMPLEXITY.LIGHTWEIGHT]: "hi",
  general: "Summarise the causes of the French Revolution in three paragraphs.",
  coding: "Write a TypeScript function that debounces another function, with tests:\n```ts\nexport function debounce() {}\n```",
  reasoning: "Prove that the square root of 2 is irrational, step by step, and explain each inference.",
};

test("with its route closed, the classifier sends nothing and returns the local analysis", async () => {
  assert.equal(routeAllowed("auto-classifier"), false, "closed until verified, and its model has no hosts");
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json({}); };
  for (const prompt of Object.values(PROMPTS)) {
    const result = await scanAndClassifyPrompt(prompt, { apiKey: "fixture-key", fetchImpl });
    assert.ok(Object.values(CLASSIFICATION_COMPLEXITY).includes(result.complexity), `a real complexity for "${prompt.slice(0, 20)}"`);
    assert.equal(typeof result.intent, "string");
  }
  assert.equal(calls, 0, "no prompt left the server");
});

test("auto selection still lands on an allowed tier for every plan and every kind of prompt (no user-visible breakage)", async () => {
  const seen = new Set();
  for (const plan of ["free", "plus", "pro", "max"]) {
    for (const prompt of Object.values(PROMPTS)) {
      const { complexity } = await scanAndClassifyPrompt(prompt, { apiKey: "fixture-key", fetchImpl: async () => { throw new Error("must not be called"); } });
      const brokered = brokerAutoModel({ complexity, plan, catalog: SEED_MODEL_REFERENCE_MATRIX });
      assert.ok(Number.isFinite(brokered?.multiplier), `${plan}/${complexity}: the broker chose a model`);
      const tier = tierFor(brokered.multiplier, plan);
      assert.ok(["lumen", "nova", "nebula", "vesper"].includes(tier));
      if (plan === "free") assert.equal(tier, "lumen", "free stays on Lumen");
      if (plan === "plus") assert.notEqual(tier, "vesper", "Plus never reaches Vulcan");
      seen.add(tier);
    }
  }
  assert.ok(seen.size >= 2, `the local analysis still differentiates prompts: ${[...seen].join(",")}`);
});
