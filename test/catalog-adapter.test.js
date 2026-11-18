import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptCatalogForPresentation,
  evaluateModelPlanLock,
  CONSUMPTION_TIER_CONFIG,
} from "../frontend/src/components/catalog/catalog-adapter.js";
import { RAW_CATALOG_FIXTURES } from "../frontend/src/components/catalog/catalog-fixtures.js";

test("evaluateModelPlanLock - respects plan eligibility and privacy status", () => {
  const miniFixture = RAW_CATALOG_FIXTURES.find((f) => f.id === "openai-gpt-5-mini");
  assert.ok(miniFixture, "openai-gpt-5-mini fixture exists");

  // Free plan
  const freeEval = evaluateModelPlanLock(miniFixture, "free");
  assert.equal(freeEval.locked, true);
  assert.equal(freeEval.lockType, "upgrade_plus");
  assert.equal(freeEval.reason, "Available with Plus or Pro");

  // Plus plan
  const plusEval = evaluateModelPlanLock(miniFixture, "plus");
  assert.equal(plusEval.locked, false);
  assert.equal(plusEval.reason, null);

  // Pro plan
  const proEval = evaluateModelPlanLock(miniFixture, "pro");
  assert.equal(proEval.locked, false);
});

test("evaluateModelPlanLock - extra high models locked for Plus users", () => {
  const extraHighFixture = RAW_CATALOG_FIXTURES.find(
    (f) => f.rawPricing?.consumptionCategory === "extra_high"
  );
  assert.ok(extraHighFixture, "Extra high fixture exists");

  const plusEval = evaluateModelPlanLock(extraHighFixture, "plus");
  assert.equal(plusEval.locked, true);
  assert.equal(plusEval.lockType, "upgrade_pro");
  assert.match(plusEval.reason, /(require a Pro subscription|Available with Pro plan only)/i);

  const proEval = evaluateModelPlanLock(extraHighFixture, "pro");
  assert.equal(proEval.locked, false);
});

test("evaluateModelPlanLock - unapproved privacy fixtures are locked for all plans", () => {
  const unapprovedFixture = RAW_CATALOG_FIXTURES.find(
    (f) => f.privacyReview?.privacyApproved === false
  );
  assert.ok(unapprovedFixture, "Unapproved fixture exists");

  for (const plan of ["free", "plus", "pro"]) {
    const lock = evaluateModelPlanLock(unapprovedFixture, plan);
    assert.equal(lock.locked, true);
    assert.equal(lock.lockType, "compliance");
    assert.match(lock.reason, /compliance and privacy review/i);
  }
});

test("adaptCatalogForPresentation - strictly strips wholesale prices and internal multiplier mu", () => {
  const result = adaptCatalogForPresentation({
    userPlan: "pro",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  assert.ok(result.models.length > 0);

  // Deep check on every model and brand model
  for (const model of result.models) {
    assert.equal(model.rawPricing, undefined, "rawPricing must not be exposed");
    assert.equal(model._internalSortWeight, undefined, "_internalSortWeight must not be exposed");
    assert.equal(model.calculatedMu, undefined, "calculatedMu must not be exposed");
    assert.equal(model.wholesalePriceInUsdPerMillion, undefined, "wholesalePriceInUsdPerMillion must not be exposed");
    assert.equal(model.wholesalePriceOutUsdPerMillion, undefined, "wholesalePriceOutUsdPerMillion must not be exposed");
    assert.equal(model.mau, undefined, "MAU must not be exposed");

    // Must have safe consumption tier
    assert.ok(model.consumptionTier);
    assert.ok(model.consumptionTier.key);
    assert.ok(model.consumptionTier.label);
    assert.ok(model.consumptionTier.shortLabel);
    assert.ok(model.consumptionTier.color);
    assert.ok(CONSUMPTION_TIER_CONFIG[model.consumptionTier.key]);
  }

  for (const brand of result.brands) {
    for (const model of brand.models) {
      assert.equal(model.rawPricing, undefined);
      assert.equal(model._internalSortWeight, undefined);
      assert.equal(model.mau, undefined);
    }
  }
});

test("adaptCatalogForPresentation - search query filtering", () => {
  const terraSearch = adaptCatalogForPresentation({
    searchQuery: "terra",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  assert.ok(terraSearch.filteredCount >= 1);
  assert.ok(terraSearch.models.some((m) => m.id === "openai-gpt-6-terra"));

  const nonExistent = adaptCatalogForPresentation({
    searchQuery: "xyz-non-existent-keyword-999",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  assert.equal(nonExistent.filteredCount, 0);
  assert.equal(nonExistent.models.length, 0);
});

test("adaptCatalogForPresentation - capability filters", () => {
  const reasoningOnly = adaptCatalogForPresentation({
    capabilityFilter: "reasoning",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  for (const m of reasoningOnly.models) {
    assert.equal(m.capabilities.reasoning, true, `Model ${m.id} must support reasoning`);
  }

  const visionOnly = adaptCatalogForPresentation({
    capabilityFilter: "vision",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  for (const m of visionOnly.models) {
    assert.equal(m.capabilities.vision, true, `Model ${m.id} must support vision`);
  }

  const toolsOnly = adaptCatalogForPresentation({
    capabilityFilter: "tools",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  for (const m of toolsOnly.models) {
    assert.equal(m.capabilities.tools, true, `Model ${m.id} must support tools`);
  }

  const fastOnly = adaptCatalogForPresentation({
    capabilityFilter: "fast",
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  for (const m of fastOnly.models) {
    assert.ok(
      m.consumptionTier.key === "low" || m.consumptionTier.key === "medium",
      `Model ${m.id} must be low or medium consumption`
    );
  }
});

test("adaptCatalogForPresentation - favorites and brand reordering", () => {
  const customOrder = ["deepseek", "anthropic", "openai", "google", "vibhavgpt", "experimental"];
  const favs = ["deepseek-v4-flash", "openai-gpt-6-terra"];

  const result = adaptCatalogForPresentation({
    favorites: favs,
    brandOrder: customOrder,
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  // Check favorites
  assert.equal(result.favorites.length, 2);
  assert.ok(result.favorites.some((f) => f.id === "deepseek-v4-flash"));
  assert.ok(result.favorites.some((f) => f.id === "openai-gpt-6-terra"));

  // Check brand ordering
  const brandIds = result.brands.map((b) => b.brandId);
  assert.equal(brandIds[0], "deepseek");
  assert.equal(brandIds[1], "anthropic");
  assert.equal(brandIds[2], "openai");
});

test("adaptCatalogForPresentation - brand visibility control", () => {
  const result = adaptCatalogForPresentation({
    brandVisibility: {
      openai: false,
    },
    rawFixtures: RAW_CATALOG_FIXTURES,
  });

  const openaiGroup = result.brands.find((b) => b.brandId === "openai");
  assert.ok(openaiGroup);
  assert.equal(openaiGroup.visible, false);

  const googleGroup = result.brands.find((b) => b.brandId === "google");
  assert.ok(googleGroup);
  assert.equal(googleGroup.visible, true);
});
