import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the functions used by the frontend without loading React/JSX.
const source = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function modelAllowedForTier("), source.indexOf("function relativeConversationTime("));
const { choose, allowed } = runInNewContext(`${helpers}; ({ choose: preferredModelForProfile, allowed: modelAllowedForTier })`, {
  MODELS: ["lumen", "nova", "nebula", "vesper"].map((value) => ({ value })),
});

test("last-used Nebula survives a null fixed preference on Plus and Pro", () => {
  for (const tier of ["plus", "pro"]) {
    assert.equal(choose({ preferredModel: null, lastUsedModel: "nebula" }, tier), "nebula");
    assert.equal(choose({ lastUsedModel: "nova" }, tier), "nova");
    assert.equal(allowed(null, tier), false);
    assert.equal(allowed("invalid", tier), false);
  }
});

test("fixed preference wins, with tier eligibility enforced", () => {
  assert.equal(choose({ preferredModel: "nebula", lastUsedModel: "nebula" }, "pro"), "nebula");
  assert.equal(choose({ preferredModel: "ultra", lastUsedModel: "nova" }, "pro"), "nebula");
  assert.equal(choose({ preferredModel: null, lastUsedModel: "nebula" }, "free", 2), "lumen");
  assert.equal(choose({ preferredModel: null, lastUsedModel: "nebula" }, "free", 3), "lumen");
  assert.equal(choose({}, "pro"), "lumen");
});

test("legacy Spark preferences retain their Lumen selection", () => {
  assert.equal(choose({ preferredModel: "spark", lastUsedModel: "nova" }, "free"), "lumen");
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
  assert.equal(choose({ preferredModel: "qwen", lastUsedModel: "nova" }, "free"), "nova");
});

test("a conversation saved with an unknown model reopens on Lumen", () => {
  assert.match(source, /const restoredModel = result\.conversation\.model === "spark" \? "lumen" : result\.conversation\.model;/);
  assert.match(source, /const conversationModel = modelAllowedForTier\(restoredModel, tier, creditBalance\) \? restoredModel : "lumen";/);
});

test("Vesper requires a paid plan even with credits", () => {
  assert.equal(allowed("vesper", "free", 1000), false);
  for (const tier of ["plus", "pro"]) assert.equal(allowed("vesper", tier), true);
});

test("Nova and Vesper are vision tiers and Nova and Vesper expose thinking controls", () => {
  assert.match(source, /const VISION_MODELS = \["nova", "nebula", "vesper"\];/);
  assert.match(source, /value: "nova"[\s\S]*?description: "Balanced speed and depth\. Reads images\./);
  assert.match(source, /const THINKING_MODELS = \["nova", "nebula", "vesper"\];/);
  assert.match(source, /value: "nebula"[\s\S]*?description: "Strong reasoning for demanding, high-complexity work\. Reads images\./);
  assert.match(source, /value: "vesper"[\s\S]*?description: "Flagship\. Highest reasoning capacity for the most difficult problems\. Reads images\./);
});

test("every picker tier has its capability-rank badge", () => {
  for (const [model, label] of [["lumen", "Entry"], ["nova", "Balanced"], ["nebula", "Premium"], ["vesper", "Top Tier"]]) {
    assert.match(source, new RegExp(`value: "${model}"[\\s\\S]*?label: "${label}"`));
  }
});
