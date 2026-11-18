import test from "node:test";
import assert from "node:assert/strict";
import {
  SEED_MODEL_REFERENCE_MATRIX,
  groupModelsByBrand,
  triggerModelReplacement,
} from "../src/models/seed-catalog.js";
import { calculateUsageMultiplier, mapMultiplierToTier } from "../src/models/pricing-engine.js";

test("Seed Catalog: Complete multi-family real inventory verification", () => {
  // 2 system + 27 family models (3 per 9 families) + 4 native models = 33 models
  assert.equal(SEED_MODEL_REFERENCE_MATRIX.length, 33);

  // Spot-check key models across the 9 families
  const gptMini = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "gpt-4o-mini");
  assert.ok(gptMini);
  assert.equal(gptMini.brand, "Provider B");
  assert.equal(gptMini.developer, "Provider B");
  assert.equal(gptMini.performanceCategory, "fast");
  assert.equal(gptMini.rawInput, 0.15);
  assert.equal(gptMini.rawOutput, 0.60);
  assert.equal(gptMini.multiplier, 0.165);
  assert.equal(gptMini.uiDot, "Green");

  const o1 = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "o1");
  assert.ok(o1);
  assert.equal(o1.performanceCategory, "best_intelligence");
  assert.equal(o1.multiplier, 16.500);
  assert.equal(o1.uiDot, "Red");
  assert.equal(o1.plans, "Pro");

  const claudeSonnet = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "claude-3-5-sonnet");
  assert.ok(claudeSonnet);
  assert.equal(claudeSonnet.developer, "Provider A");
  assert.equal(claudeSonnet.performanceCategory, "balanced");
  assert.equal(claudeSonnet.multiplier, 3.713);
  assert.equal(claudeSonnet.uiDot, "Orange");

  const geminiFlash = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "gemini-2-0-flash");
  assert.ok(geminiFlash);
  assert.equal(geminiFlash.developer, "Provider C");
  assert.equal(geminiFlash.performanceCategory, "fast");
  assert.equal(geminiFlash.multiplier, 0.110);
  assert.equal(geminiFlash.uiDot, "Green");

  const grok2 = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "grok-2");
  assert.ok(grok2);
  assert.equal(grok2.developer, "Provider D");
  assert.equal(grok2.performanceCategory, "balanced");

  const qwen72b = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "qwen-2-5-72b-instruct");
  assert.ok(qwen72b);
  assert.equal(qwen72b.developer, "Provider E");

  const kimi32k = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "kimi-32k");
  assert.ok(kimi32k);
  assert.equal(kimi32k.developer, "Provider F");

  const nemotron = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "nemotron-mini-4b");
  assert.ok(nemotron);
  assert.equal(nemotron.developer, "Provider G");

  const glmFlash = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "glm-4-flash");
  assert.ok(glmFlash);
  assert.equal(glmFlash.developer, "Provider H");

  const mimo7b = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "mimo-7b");
  assert.ok(mimo7b);
  assert.equal(mimo7b.developer, "Provider I");

  const nova = SEED_MODEL_REFERENCE_MATRIX.find((m) => m.id === "nova");
  assert.ok(nova);
  assert.equal(nova.developer, "VibhavGPT");
  assert.equal(nova.plans, "All");

  // Verify all models with prices have matching multiplier and dot mappings
  for (const model of SEED_MODEL_REFERENCE_MATRIX) {
    if (model.rawInput !== null && model.rawOutput !== null) {
      const calculatedMu = calculateUsageMultiplier(model.rawInput, model.rawOutput);
      assert.equal(
        Math.abs(calculatedMu - model.multiplier) < 0.005,
        true,
        `Multiplier mismatch for ${model.modelName}: expected ${model.multiplier}, got ${calculatedMu}`
      );
      if (model.multiplier > 0) {
        const tier = mapMultiplierToTier(model.multiplier);
        const expectedColor = tier.uiRepresentation.split(" ")[0];
        assert.equal(
          model.uiDot,
          expectedColor,
          `UI dot mismatch for ${model.modelName}: expected ${expectedColor}, got ${model.uiDot}`
        );
      }
    }
  }
});

test("Seed Catalog: Brand grouping and Flagship-First ordering", () => {
  const brandGroups = groupModelsByBrand(SEED_MODEL_REFERENCE_MATRIX);
  assert.ok(brandGroups.length >= 10);

  // Labels are neutral aliases (Slice 3.7); the routing ids and pricing above are unchanged.
  const openAiGroup = brandGroups.find((g) => g.brand === "Provider B");
  assert.ok(openAiGroup);

  // Flagship-First: highest multiplier first (o1: 16.5 -> GPT-4o: 2.75 -> GPT-4o mini: 0.165)
  const multipliers = openAiGroup.models.map((m) => m.multiplier);
  for (let i = 0; i < multipliers.length - 1; i++) {
    assert.ok(
      multipliers[i] >= multipliers[i + 1],
      `Expected Flagship-First order: ${multipliers[i]} should be >= ${multipliers[i + 1]}`
    );
  }
  assert.equal(openAiGroup.models[0].id, "o1");
  assert.equal(openAiGroup.models.at(-1).id, "gpt-4o-mini");
});

test("Seed Catalog: Automatic Replacement Logic", () => {
  const oldModelId = "o1";
  const newModelDetails = {
    id: "o3-mini",
    brand: "OpenAI",
    modelName: "OpenAI o3-mini",
    rawInput: 1.10,
    rawOutput: 4.40,
    plans: "Paid",
    notes: "Next-gen reasoning model",
    capabilities: { vision: true, tools: true, streaming: true, structuredOutputs: true, reasoning: true },
  };

  const userPrefs = {
    favoriteModelIds: ["o1", "claude-3-5-haiku"],
    preferredModel: "o1",
    modelCategoryFlags: {
      "o1": { pinnedToTop: true },
    },
  };

  // 1. Live session hot-swap attempt MUST be prevented
  const hotSwapAttempt = triggerModelReplacement({
    oldModelId,
    newModel: newModelDetails,
    userPreferences: userPrefs,
    isSessionLive: true,
  });
  assert.equal(hotSwapAttempt.success, false);
  assert.equal(hotSwapAttempt.blocked, true);
  assert.equal(hotSwapAttempt.reason, "live_session_hot_swap_prevented");

  // 2. Browser reload replacement succeeds
  const reloadResult = triggerModelReplacement({
    oldModelId,
    newModel: newModelDetails,
    userPreferences: userPrefs,
    isSessionLive: false,
  });

  assert.equal(reloadResult.success, true);
  assert.equal(reloadResult.blocked, false);
  assert.equal(reloadResult.activationState, "pending_browser_reload");

  // Inherits user preferences
  assert.deepEqual(reloadResult.updatedPreferences.favoriteModelIds, [
    "o3-mini",
    "claude-3-5-haiku",
  ]);
  assert.equal(reloadResult.updatedPreferences.preferredModel, "o3-mini");
  assert.deepEqual(reloadResult.updatedPreferences.modelCategoryFlags["o3-mini"], {
    pinnedToTop: true,
  });
  assert.equal(reloadResult.updatedPreferences.modelCategoryFlags["o1"], undefined);
});
