process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  SEED_MODEL_REFERENCE_MATRIX,
  groupModelsByBrand,
  findSeedModelByKey,
} from "../src/models/seed-catalog.js";
import {
  getCatalogForUser,
  formatGroupDisplayName,
  buildSeedRegistrySnapshot,
} from "../src/models/catalog-service.js";
import { normalizeModelKey, isKnownCatalogModel } from "../src/chat/model-keys.js";
import { getModelConfig } from "../src/chat/providers.js";

test("Multi-Model Catalog: Exactly 9 requested families + VibhavGPT native present", () => {
  const brandGroups = groupModelsByBrand(SEED_MODEL_REFERENCE_MATRIX);

  const expectedBrands = [
    // Nine third-party families under neutral aliases (Slice 3.7), plus VibhavGPT.
    "Provider A",
    "Provider B",
    "Provider C",
    "Provider D",
    "Provider E",
    "Provider F",
    "Provider G",
    "Provider H",
    "Provider I",
    "VibhavGPT",
  ];

  for (const expected of expectedBrands) {
    const found = brandGroups.find((g) => g.brand === expected);
    assert.ok(found, `Expected brand group '${expected}' to be present in catalog`);
    assert.ok(found.models.length >= 3, `Expected brand '${expected}' to have at least 3 models, got ${found.models.length}`);
  }
});

test("Multi-Model Catalog: Complete purge of speculative model names", () => {
  const speculativePatterns = [
    /gpt-6/i,
    /terra/i,
    /sol/i,
    /astra/i,
    /haiku-5\.5/i,
    /sonnet-5/i,
    /opus-5/i,
    /argon/i,
    /grok-4/i,
  ];

  for (const model of SEED_MODEL_REFERENCE_MATRIX) {
    for (const pattern of speculativePatterns) {
      assert.equal(
        pattern.test(model.id) || pattern.test(model.modelName),
        false,
        `Found forbidden speculative model in seed catalog: ${model.id} (${model.modelName})`
      );
    }
  }
});

test("Multi-Model Catalog: Performance categories (Fast, Balanced, Best intelligence) on all families", () => {
  const requiredCategories = ["fast", "balanced", "best_intelligence"];
  const families = [
    "provider-a",
    "provider-b",
    "provider-c",
    "provider-d",
    "provider-e",
    "provider-f",
    "provider-g",
    "provider-h",
    "provider-i",
  ];

  for (const fam of families) {
    const famModels = SEED_MODEL_REFERENCE_MATRIX.filter((m) => m.familyGroup === fam);
    assert.ok(famModels.length >= 3, `Family ${fam} missing models`);

    for (const cat of requiredCategories) {
      const match = famModels.find((m) => m.performanceCategory === cat);
      assert.ok(match, `Family ${fam} missing option for category '${cat}'`);
    }
  }
});

test("Customer catalog exposes only VibhavGPT tiers with no vendor leakage", async () => {
  const catalog = await getCatalogForUser({ userId: "test-user-free", userPlan: "free" });

  assert.equal(catalog.userPlan, "free");
  // Nova and Nebula were retired on 2026-11-14. (This catalog's reference matrix has never listed Zenith.)
  assert.equal(catalog.models.length, 2, `Customer catalog must hold only the current house tiers, got ${catalog.models.length}`);

  const ids = catalog.models.map((m) => m.id);
  assert.deepEqual(ids.sort(), ["lumen", "vesper"]);

  for (const model of catalog.models) {
    assert.equal(model.developer, "VibhavGPT");
    assert.equal(model.group?.displayName, "VibhavGPT");
    assert.equal(model.group?.id, "vibhavgpt");
    assert.ok(model.selectability, `Model ${model.id} missing selectability`);
    assert.equal(/openai|anthropic|claude|gpt-|gemini|grok|qwen|kimi|nvidia|zhipu|xiaomi/i.test(JSON.stringify(model)), false);
  }

  const lumen = catalog.models.find((m) => m.id === "lumen");
  assert.ok(lumen);
  assert.equal(lumen.selectability.selectable, true);

  // Third-party seed entries must never appear in the customer payload
  assert.equal(catalog.models.find((m) => m.id === "gpt-4o-mini"), undefined);
  assert.equal(catalog.models.find((m) => m.id === "o1"), undefined);
  assert.equal(catalog.models.find((m) => m.id === "claude-3-5-sonnet"), undefined);
});

test("Retired third-party seed ids stay known for history but are not silently remapped for execution", async () => {
  const { isRetiredCustomerModel, resolveExecutableModelKey } = await import("../src/chat/model-keys.js");

  for (const id of ["claude-3-5-sonnet", "gpt-4o", "o1", "gemini-2-0-flash"]) {
    assert.equal(isKnownCatalogModel(id), true, `Expected ${id} to remain known for history`);
    assert.equal(isRetiredCustomerModel(id), true, `Expected ${id} to be retired for customers`);
    assert.equal(normalizeModelKey(id), id, `normalizeModelKey must not silently substitute ${id}`);
    const resolved = resolveExecutableModelKey(id);
    assert.equal(resolved.available, false);
    assert.equal(resolved.code, "model_unavailable");
  }

  assert.equal(normalizeModelKey("nova"), "nova");
  assert.equal(normalizeModelKey("totally-synthetic-unknown-model"), "lumen");
  assert.equal(resolveExecutableModelKey("nova").modelKey, "nova");
});

test("Native customer models keep vision/reasoning capabilities through getModelConfig", () => {
  const novaConfig = getModelConfig("nova");
  assert.ok(novaConfig);
  assert.match(novaConfig.displayName, /Nova/i);
  assert.equal(novaConfig.supportsVision, true);

  const lumenConfig = getModelConfig("lumen");
  assert.ok(lumenConfig);
  assert.match(lumenConfig.displayName, /Lumen/i);
  assert.equal(lumenConfig.supportsVision, false);

  const vesperConfig = getModelConfig("vesper");
  assert.ok(vesperConfig);
  assert.match(vesperConfig.displayName, /Vulcan/i);
});
