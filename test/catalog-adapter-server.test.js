import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptServerCatalogForPresentation,
  CONSUMPTION_TIER_CONFIG,
} from "../frontend/src/components/catalog/catalog-adapter.js";

const sampleServerCatalog = {
  userPlan: "plus",
  models: [
    {
      id: "vibhavgpt-lumen-v2",
      displayName: "Lumen 2",
      group: { id: "native", displayName: "VibhavGPT Native" },
      description: "Fast native everyday assistance.",
      modalities: { input: ["text"], output: ["text"] },
      contextWindowTokens: 128000,
      supportedReasoningEfforts: [],
      capabilities: { tools: true, vision: false, streaming: true, structuredOutputs: true, reasoning: false },
      consumptionCategory: "low",
      sortRank: 1,
      selectability: { selectable: true, locked: false, lockReason: null, lockType: null },
    },
    {
      id: "vibhavgpt-vesper-v2",
      displayName: "Vulcan 2",
      group: { id: "native", displayName: "VibhavGPT Native" },
      description: "Flagship native reasoning model.",
      modalities: { input: ["text", "image"], output: ["text"] },
      contextWindowTokens: 200000,
      supportedReasoningEfforts: ["normal", "high"],
      capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: true },
      consumptionCategory: "extra_high",
      sortRank: 4,
      selectability: {
        selectable: false,
        locked: true,
        lockReason: "Extra High consumption models are restricted to Pro members.",
        lockType: "subscription",
      },
    },
    {
      id: "openai-gpt-6-terra",
      displayName: "GPT-6 Terra",
      group: { id: "openai", displayName: "OpenAI" },
      description: "Frontier reasoning model.",
      modalities: { input: ["text", "image"], output: ["text"] },
      contextWindowTokens: 200000,
      supportedReasoningEfforts: ["low", "normal", "high"],
      capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: true },
      consumptionCategory: "high",
      sortRank: 10,
      selectability: { selectable: true, locked: false, lockReason: null, lockType: null },
    },
    {
      id: "google-gemini-25-flash",
      displayName: "Gemini 2.5 Flash",
      group: { id: "google", displayName: "Google" },
      description: "Fast multimodal frontier model.",
      modalities: { input: ["text", "image"], output: ["text"] },
      contextWindowTokens: 1000000,
      supportedReasoningEfforts: [],
      capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: false },
      consumptionCategory: "low",
      sortRank: 20,
      selectability: { selectable: true, locked: false, lockReason: null, lockType: null },
    },
  ],
  groups: [
    { id: "native", displayName: "VibhavGPT Native", sortRank: 1 },
    { id: "openai", displayName: "OpenAI", sortRank: 10 },
    { id: "google", displayName: "Google", sortRank: 20 },
  ],
};

test("adaptServerCatalogForPresentation - transforms server DTO into safe presentation structures", () => {
  const result = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    favorites: ["openai-gpt-6-terra"],
  });

  assert.equal(result.userPlan, "plus");
  assert.equal(result.totalCount, 4);
  assert.equal(result.filteredCount, 4);
  assert.equal(result.autoMode, null, "Auto mode must be null for disconnected catalog");

  // Verify favorites extraction
  assert.equal(result.favorites.length, 1);
  assert.equal(result.favorites[0].id, "openai-gpt-6-terra");
  assert.equal(result.favorites[0].isFavorite, true);

  // Check model properties
  const terra = result.models.find((m) => m.id === "openai-gpt-6-terra");
  assert.ok(terra);
  assert.equal(terra.displayName, "GPT-6 Terra");
  assert.equal(terra.brandId, "openai");
  assert.equal(terra.brandName, "OpenAI");
  assert.equal(terra.isReadOnly, true);
  assert.equal(terra.isFixture, false);
  assert.equal(terra.capabilities.vision, true);
  assert.equal(terra.capabilities.reasoning, true);
  assert.deepEqual(terra.capabilities.reasoningModes, ["low", "normal", "high"]);
  assert.equal(terra.consumptionTier.key, "high");
  assert.equal(terra.consumptionTier.label, CONSUMPTION_TIER_CONFIG.high.label);
  assert.equal(terra.lockState.locked, false);

  // Locked model verification
  const vesper = result.models.find((m) => m.id === "vibhavgpt-vesper-v2");
  assert.ok(vesper);
  assert.equal(vesper.lockState.locked, true);
  assert.equal(vesper.lockState.lockType, "subscription");
  assert.equal(vesper.lockState.reason, "Extra High consumption models are restricted to Pro members.");
  assert.equal(vesper.consumptionTier.key, "extra_high");

  // Strict check: no wholesale rate exposure or multipliers
  for (const model of result.models) {
    assert.equal(model.rawPricing, undefined);
    assert.equal(model.wholesalePriceInUsdPerMillion, undefined);
    assert.equal(model.wholesalePriceOutUsdPerMillion, undefined);
    assert.equal(model.calculatedMu, undefined);
    assert.equal(model._internalSortWeight, undefined);
  }
});

test("adaptServerCatalogForPresentation - search query filtering", () => {
  const searchGemini = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    searchQuery: "gemini",
  });
  assert.equal(searchGemini.filteredCount, 1);
  assert.equal(searchGemini.models[0].id, "google-gemini-25-flash");

  const searchBrand = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    searchQuery: "OpenAI",
  });
  assert.equal(searchBrand.filteredCount, 1);
  assert.equal(searchBrand.models[0].id, "openai-gpt-6-terra");

  const searchEmpty = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    searchQuery: "nonexistent-model-xyz",
  });
  assert.equal(searchEmpty.filteredCount, 0);
  assert.equal(searchEmpty.models.length, 0);
});

test("adaptServerCatalogForPresentation - capability filters", () => {
  const reasoning = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    capabilityFilter: "reasoning",
  });
  assert.equal(reasoning.filteredCount, 2);
  assert.ok(reasoning.models.every((m) => m.capabilities.reasoning));

  const fast = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    capabilityFilter: "fast",
  });
  assert.equal(fast.filteredCount, 2);
  assert.ok(fast.models.every((m) => m.consumptionTier.key === "low" || m.consumptionTier.key === "medium"));

  const vision = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    capabilityFilter: "vision",
  });
  assert.equal(vision.filteredCount, 3);
  assert.ok(vision.models.every((m) => m.capabilities.vision));
});

test("adaptServerCatalogForPresentation - brand ordering and hidden brands", () => {
  // Custom brand ordering: google first, then native, then openai
  const customOrder = adaptServerCatalogForPresentation({
    catalog: sampleServerCatalog,
    brandOrder: ["google", "native", "openai"],
    hiddenBrands: ["openai"],
  });

  const visibleBrands = customOrder.brands.filter((b) => b.visible);
  const hiddenBrands = customOrder.brands.filter((b) => !b.visible);

  assert.equal(visibleBrands[0].brandId, "google");
  assert.equal(visibleBrands[1].brandId, "native");
  assert.equal(hiddenBrands.length, 1);
  assert.equal(hiddenBrands[0].brandId, "openai");
  assert.equal(hiddenBrands[0].visible, false);
});

test("adaptServerCatalogForPresentation - empty catalog handling without fixture fallback", () => {
  const empty = adaptServerCatalogForPresentation({
    catalog: { models: [], groups: [], userPlan: "free" },
  });

  assert.equal(empty.totalCount, 0);
  assert.equal(empty.filteredCount, 0);
  assert.equal(empty.models.length, 0);
  assert.equal(empty.brands.length, 0);
  assert.equal(empty.favorites.length, 0);
});

test("Authoritative Server Eligibility - contradictory inputs preserve server locks and lock reasons", () => {
  // Contradictory input 1: Server unavailable + userPlan Pro -> remains locked, lockType preserved
  const unavailableCatalog = {
    userPlan: "pro",
    models: [
      {
        id: "model-server-unavailable",
        displayName: "Unavailable Frontier Model",
        group: { id: "openai", displayName: "OpenAI" },
        description: "Provider endpoint temporarily unreachable.",
        modalities: { input: ["text"], output: ["text"] },
        contextWindowTokens: 128000,
        supportedReasoningEfforts: [],
        capabilities: { tools: true, vision: false, streaming: true, structuredOutputs: true, reasoning: false },
        consumptionCategory: "high",
        sortRank: 5,
        selectability: {
          selectable: false,
          locked: true,
          lockReason: "Provider endpoint unavailable in this region",
          lockType: "configuration",
        },
      },
    ],
    groups: [{ id: "openai", displayName: "OpenAI", sortRank: 10 }],
  };

  const adaptedUnavailable = adaptServerCatalogForPresentation({
    catalog: unavailableCatalog,
  });
  const unavailModel = adaptedUnavailable.models[0];
  assert.equal(unavailModel.lockState.locked, true, "Pro plan must not unlock server-unavailable model");
  assert.equal(unavailModel.lockState.lockType, "configuration", "Must preserve server lockType 'configuration'");
  assert.equal(unavailModel.lockState.reason, "Provider endpoint unavailable in this region", "Must preserve server lockReason");

  // Contradictory input 2: Server compliance blocked + consumption category low -> remains locked
  const complianceCatalog = {
    userPlan: "pro",
    models: [
      {
        id: "model-compliance-blocked",
        displayName: "Compliance Blocked Model",
        group: { id: "deepseek", displayName: "DeepSeek" },
        description: "Model under international export review.",
        modalities: { input: ["text"], output: ["text"] },
        contextWindowTokens: 64000,
        supportedReasoningEfforts: [],
        capabilities: { tools: false, vision: false, streaming: true, structuredOutputs: false, reasoning: false },
        consumptionCategory: "low",
        sortRank: 8,
        selectability: {
          selectable: false,
          locked: true,
          lockReason: "Model failed export compliance validation",
          lockType: "compliance",
        },
      },
    ],
    groups: [{ id: "deepseek", displayName: "DeepSeek", sortRank: 30 }],
  };

  const adaptedCompliance = adaptServerCatalogForPresentation({
    catalog: complianceCatalog,
  });
  const compModel = adaptedCompliance.models[0];
  assert.equal(compModel.lockState.locked, true, "Low consumption category must not bypass compliance lock");
  assert.equal(compModel.lockState.lockType, "compliance", "Must preserve server lockType 'compliance'");
  assert.equal(compModel.lockState.reason, "Model failed export compliance validation", "Must preserve server lockReason");
  assert.equal(compModel.consumptionTier.key, "low");

  // Contradictory input 3: Server pricing pending + stale client preference data -> remains locked
  const pricingCatalog = {
    userPlan: "plus",
    models: [
      {
        id: "model-pricing-pending",
        displayName: "Pending Pricing Model",
        group: { id: "google", displayName: "Google" },
        description: "Experimental model undergoing wholesale cost review.",
        modalities: { input: ["text"], output: ["text"] },
        contextWindowTokens: 1000000,
        supportedReasoningEfforts: [],
        capabilities: { tools: true, vision: true, streaming: true, structuredOutputs: true, reasoning: false },
        consumptionCategory: "pending",
        sortRank: 15,
        selectability: {
          selectable: false,
          locked: true,
          lockReason: "Wholesale rate schedule pending audit",
          lockType: "pricing",
        },
      },
    ],
    groups: [{ id: "google", displayName: "Google", sortRank: 20 }],
  };

  const adaptedPricing = adaptServerCatalogForPresentation({
    catalog: pricingCatalog,
    favorites: ["model-pricing-pending"], // Stale favorite preference
  });
  const priceModel = adaptedPricing.models[0];
  assert.equal(priceModel.lockState.locked, true, "Stale favorite status must not unlock unpriced model");
  assert.equal(priceModel.lockState.lockType, "pricing", "Must preserve server lockType 'pricing'");
  assert.equal(priceModel.lockState.reason, "Wholesale rate schedule pending audit", "Must preserve server lockReason");
  assert.equal(priceModel.isFavorite, true, "Preference is tracked but lockState remains locked");
});
