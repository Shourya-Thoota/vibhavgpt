// One thinking control for every model (owner request, 2026-11-16): Low, Medium, High, mapped to each model's own levels in one place
// (frontend/src/thinking-levels.js), for every reasoning-capable model.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const levels = await import("../frontend/src/thinking-levels.js");
const catalog = await import("../frontend/src/model-marketplace.js");
const { thinkingUsageFor } = await import("../src/usage/service.js");
const { reasoningParameter } = await import("../src/chat/reasoning-effort.js");

test("exactly three choices, the same for every model: Low, Medium, High", () => {
  assert.deepEqual(levels.THINKING_CHOICES.map((c) => [c.value, c.label]), [["low", "Low"], ["medium", "Medium"], ["high", "High"]]);
  assert.equal(levels.DEFAULT_UNIFIED_LEVEL, "medium");
});

test("every third-party model: Low, Medium and High map to its own levels, High to its highest", () => {
  const expected = {
    "gpt-6-luna": ["low", "medium", "max"],
    "gpt-6.1-terra": ["low", "medium", "max"],
    "gpt-6.2-sol": ["low", "medium", "max"],
    "gpt-6.2-astra": ["low", "medium", "max"],
    "gemini-4-hydrogen": ["low", "medium", "xhigh"],
    "gemini-4-argon": ["low", "medium", "high"],
    "gemini-4-carbon": ["low", "medium", "high"],
    // GLM documents only low and high here: Medium takes the next level up.
    "glm-5.3": ["low", "high", "high"],
    "glm-5.3-flash": ["low", "high", "high"],
  };
  const withThinking = catalog.THIRD_PARTY_MODELS.filter((m) => catalog.marketplaceThinking(m.id)).map((m) => m.id);
  assert.deepEqual(Object.keys(expected).sort(), withThinking.sort(), "every reasoning-capable third-party model is covered");
  for (const [id, [low, medium, high]] of Object.entries(expected)) {
    const own = catalog.marketplaceThinking(id).levels;
    assert.deepEqual(["low", "medium", "high"].map((u) => catalog.resolveMarketplaceThinking(id, u)), [low, medium, high].map((level) => ({ level, valid: true })), id);
    for (const level of [low, medium, high]) assert.ok(own.includes(level), `${id}: ${level} is a level it documents`);
    assert.deepEqual(catalog.resolveMarketplaceThinking(id, null), { level: medium, valid: true }, `${id}: nothing chosen is Medium`);
  }
});

test("provider levels stay supported underneath: an older client's exact level is accepted, an undocumented one refused", () => {
  assert.deepEqual(catalog.resolveMarketplaceThinking("gpt-6-luna", "none"), { level: "none", valid: true });
  assert.deepEqual(catalog.resolveMarketplaceThinking("gpt-6.2-sol", "xhigh"), { level: "xhigh", valid: true });
  assert.deepEqual(catalog.resolveMarketplaceThinking("gemini-4-carbon", "xhigh"), { level: null, valid: false }, "Carbon has no xhigh");
  assert.deepEqual(catalog.resolveMarketplaceThinking("gemini-4-hydrogen", "minimal"), { level: null, valid: false });
  assert.deepEqual(catalog.resolveMarketplaceThinking("gpt-6-luna", "banana"), { level: null, valid: false });
});

test("stored and older values are read as the nearest of the three", () => {
  const cases = { none: "low", off: "low", minimal: "low", low: "low", normal: "medium", medium: "medium", high: "high", xhigh: "high", max: "high", maximum: "high", nonsense: null, "": null };
  for (const [stored, unified] of Object.entries(cases)) assert.equal(levels.toUnified(stored), unified, stored);
  assert.equal(levels.unifiedLabel("xhigh"), "High");
});

test("house models (Vulcan, Zenith): High is the engine's highest; Medium and Low are its medium and low", () => {
  assert.deepEqual(["low", "medium", "high"].map((u) => thinkingUsageFor("vesper", u).effort), ["low", "medium", "max"]);
  assert.deepEqual(["low", "medium", "high"].map((u) => thinkingUsageFor("zenith", u).effort), ["low", "medium", "max"]);
  assert.equal(thinkingUsageFor("vesper", "normal").effort, "medium", "an older stored Normal is Medium");
  assert.equal(thinkingUsageFor("vesper", "xhigh").effort, "max", "an older Extra High is High");
  // "max" narrows to the engine's own highest level: Zenith's engine tops out at high, Vulcan's at max.
  assert.deepEqual(reasoningParameter("mistralai/mistral-large-4-0", "max"), { effort: "high" });
  assert.deepEqual(reasoningParameter("vesper", "max"), { effort: "max" });
  assert.equal(thinkingUsageFor("lumen", "high").effort, "normal", "a model without adjustable thinking is unchanged");
  assert.equal(thinkingUsageFor("study", "high").providerEffort, "none", "Study is unchanged");
});

test("the app shows only the three levels, in one control, for house and third-party models alike", () => {
  const app = fs.readFileSync("frontend/src/App.jsx", "utf8");
  assert.match(app, /const THINKING_OPTIONS = THINKING_CHOICES;/);
  assert.match(app, /marketplaceThinking\(model\)\?\.levels\?\.length > 1 \? THINKING_CHOICES : null/);
  assert.doesNotMatch(app, /label: "Extra High"|label: "Maximum"|label: "Normal"/, "no provider-specific labels are shown");
  assert.doesNotMatch(app, /THINKING_LEVEL_LABELS\[/, "the per-provider labels are not used for display");
  assert.equal((app.match(/label="Thinking level for your next response"/g) ?? []).length >= 2, true, "house and third-party use the same control");
});
