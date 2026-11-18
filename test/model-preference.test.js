import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { currentThirdPartyKey, isRetiredHouseKey } from "../frontend/src/model-marketplace.js";

// Exercise the functions used by the frontend without loading React/JSX.
const source = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function modelAllowedForTier("), source.indexOf("function relativeConversationTime("));
const { choose, allowed } = runInNewContext(`${helpers}; ({ choose: preferredModelForProfile, allowed: modelAllowedForTier })`, {
  MODELS: ["lumen", "vesper", "zenith"].map((value) => ({ value })),
  // A retired third-party id in a saved preference reads as its replacement (model-marketplace.js); a retired house tier (Nova, Nebula,
  // retired 2026-11-14) is named, never replaced.
  currentThirdPartyKey,
  isRetiredHouseKey,
});

test("last-used Vulcan survives a null fixed preference on Pro and Max", () => {
  for (const tier of ["pro", "max"]) {
    assert.equal(choose({ preferredModel: null, lastUsedModel: "vesper" }, tier), "vesper");
    assert.equal(choose({ lastUsedModel: "vesper" }, tier), "vesper");
    assert.equal(allowed(null, tier), false);
    assert.equal(allowed("invalid", tier), false);
  }
});

test("a saved retired tier is named, so the chat asks for a model; it is never swapped for another tier", () => {
  for (const tier of ["free", "plus", "pro", "max"]) {
    assert.equal(choose({ preferredModel: null, lastUsedModel: "nebula" }, tier), "retired:nebula");
    assert.equal(choose({ lastUsedModel: "nova" }, tier), "retired:nova");
    assert.equal(choose({ retiredModel: "nova", preferredModel: null, lastUsedModel: null }, tier), "retired:nova", "the preferences API names it");
    assert.equal(allowed("nova", tier), false);
    assert.equal(allowed("nebula", tier), false);
  }
});

test("fixed preference wins, with tier eligibility enforced", () => {
  assert.equal(choose({ preferredModel: "vesper", lastUsedModel: "lumen" }, "pro"), "vesper");
  assert.equal(choose({ preferredModel: "zenith", lastUsedModel: "vesper" }, "max"), "zenith");
  assert.equal(choose({ preferredModel: "zenith", lastUsedModel: "vesper" }, "pro"), "vesper", "Zenith is Max only, so the eligible last-used model is used");
  assert.equal(choose({ preferredModel: null, lastUsedModel: "vesper" }, "free", 2), "lumen");
  assert.equal(choose({ preferredModel: null, lastUsedModel: "vesper" }, "plus", 3), "lumen");
  assert.equal(choose({}, "pro"), "lumen");
  // Nebula's legacy alias is retired with it.
  assert.equal(choose({ preferredModel: "ultra", lastUsedModel: "lumen" }, "pro"), "retired:ultra");
});

test("legacy Spark preferences retain their Lumen selection", () => {
  assert.equal(choose({ preferredModel: "spark", lastUsedModel: "vesper" }, "free"), "lumen");
  assert.equal(choose({ lastUsedModel: "spark" }, "plus"), "lumen");
});

test("a stale saved qwen preference falls back to Lumen like any unknown key", () => {
  for (const tier of ["free", "plus", "pro"]) {
    assert.equal(allowed("qwen", tier), false);
    assert.equal(choose({ preferredModel: "qwen" }, tier), "lumen");
    assert.equal(choose({ lastUsedModel: "qwen" }, tier), "lumen");
    assert.equal(choose({ preferredModel: "qwen", lastUsedModel: "qwen" }, tier), "lumen");
    assert.equal(choose({ preferredModel: "qwen", lastUsedModel: "not-a-model" }, tier), "lumen");
  }
  // As with any unknown fixed preference, a valid last-used model is kept.
  assert.equal(choose({ preferredModel: "qwen", lastUsedModel: "vesper" }, "pro"), "vesper");
});

test("a conversation saved with an unknown model reopens on Lumen", () => {
  // A retired third-party id reads as its replacement; anything unknown or not on the plan reopens on Lumen.
  assert.match(source, /const restoredModel = result\.conversation\.model === "spark" \? "lumen" : result\.conversation\.model \? currentThirdPartyKey\(result\.conversation\.model\) : result\.conversation\.model;/);
  assert.match(source, /const conversationModel = modelAllowedForTier\(restoredModel, tier, creditBalance\) \? restoredModel : "lumen";/);
  // A model picked while the conversation was loading is never replaced when the load finishes; a conversation last on a retired tier
  // opens with no model chosen and names the retired tier.
  assert.match(source, /if \(!userPickedModelRef\.current\) \{\n\s+if \(isRetiredHouseKey\(result\.conversation\.model\)\) \{\n\s+setModel\(null\);\n\s+setRetiredSelection\(String\(result\.conversation\.model\)\.toLowerCase\(\)\);/);
});

test("Vulcan requires Pro, even with credits", () => {
  assert.equal(allowed("vesper", "free", 1000), false);
  assert.equal(allowed("vesper", "plus"), false);
  assert.equal(allowed("vesper", "pro"), true);
});

// Slice 7: the picker reads its house lineup from model-marketplace.js, so the facts are checked there and the picker is checked to use it.
const { HOUSE_MODELS, HOUSE_INTELLIGENCE, INTELLIGENCE_LABELS, INTELLIGENCE_TONES } = await import("../frontend/src/model-marketplace.js");
const house = Object.fromEntries(HOUSE_MODELS.map((model) => [model.id, model]));

test("Vulcan and Zenith are vision tiers and expose thinking controls; Lumen does neither", () => {
  assert.match(source, /const VISION_MODELS = \[\.\.\.HOUSE_MODELS\.filter\(\(entry\) => entry\.vision\)/, "the picker's vision list is the lineup's");
  assert.match(source, /const THINKING_MODELS = \["vesper", "zenith"\];/);
  assert.deepEqual(HOUSE_MODELS.filter((model) => model.vision).map((model) => model.id), ["vesper", "zenith"]);
  assert.equal(house.lumen.description, "Fastest. Good for everyday questions.");
  assert.equal(house.vesper.description, "Top-tier reasoning for difficult problems. Reads images.");
  assert.match(house.zenith.description, /^Flagship\./, "Zenith is the flagship now");
});

test("every picker model carries its label on the one intelligence scale, in the existing badge tones", () => {
  assert.match(source, /badges: \[intelligenceBadge\(HOUSE_INTELLIGENCE\[entry\.id\]\)\]/, "the picker's badge is the lineup's label");
  for (const [model, label, tone] of [["lumen", "Fast", "entry"], ["vesper", "Advanced", "premium"], ["zenith", "Best", "top-tier"]]) {
    assert.equal(INTELLIGENCE_LABELS[HOUSE_INTELLIGENCE[model]], label, model);
    assert.equal(INTELLIGENCE_TONES[HOUSE_INTELLIGENCE[model]], tone, model);
  }
});
