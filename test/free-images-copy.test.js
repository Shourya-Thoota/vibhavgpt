import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { COMPARISON_GROUPS, comparisonGroupsFor } from "../frontend/src/plan-comparison.js";
import { PRODUCT_KNOWLEDGE, productKnowledgeFor, buildProductKnowledgeSystemPrompt } from "../frontend/src/product-knowledge.js";
import { PUBLIC_PAGES } from "../frontend/src/public-pages.js";
import { CAPABILITY_FREE_NOTES } from "../frontend/src/onboarding.js";
import { IMAGE_MODE_PLAN_QUOTAS } from "../src/generation/image-engine.js";
import { GENERATION_LIMITS } from "../src/usage/service.js";
import { freeImageLine, nextImagesWhen } from "../frontend/src/image-allowance.js";

// Every public line about images says what the server enforces: Free 2 per week; Plus 100 and Pro 400 a month (Max 1,500, unpublished).
// And the image watermark policy (Free always marked; paid plans optional, off by default) is stated the same way everywhere.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const MODES = [null, "carry", "expiry"];

test("the enforced image numbers, the displayed limits and the pricing table are one set", () => {
  assert.deepEqual([GENERATION_LIMITS.free.images, GENERATION_LIMITS.plus.images, GENERATION_LIMITS.pro.images],
    [IMAGE_MODE_PLAN_QUOTAS.free.quotaPerWeek, IMAGE_MODE_PLAN_QUOTAS.plus.quotaPerMonth, IMAGE_MODE_PLAN_QUOTAS.pro.quotaPerMonth]);
  for (const mode of MODES) {
    const row = comparisonGroupsFor(mode).find((group) => group.title === "Making things").rows.find((r) => r.label === "Image generations");
    assert.deepEqual(row.values, ["2 per week", `${IMAGE_MODE_PLAN_QUOTAS.plus.quotaPerMonth} per billing month`, `${IMAGE_MODE_PLAN_QUOTAS.pro.quotaPerMonth} per month`, `${IMAGE_MODE_PLAN_QUOTAS.max.quotaPerMonth.toLocaleString("en-US")} per month`], `mode ${mode}`);
  }
});

test("product facts state the enforced image numbers in the legacy and credits wording", () => {
  for (const mode of MODES) {
    const knowledge = productKnowledgeFor(mode);
    const text = (id) => { const plan = knowledge.plans.find((p) => p.id === id); return [plan.description, ...plan.features, ...plan.details].join(" "); };
    assert.match(text("free"), /2 image generations per week/, `${mode}: Free`);
    assert.match(text("free"), /Monday at 00:00 UTC/);
    assert.match(text("plus"), /100 image/, `${mode}: Plus`);
    assert.match(text("pro"), /400 image generations per UTC calendar month/, `${mode}: Pro`);
    assert.doesNotMatch([text("plus"), text("pro")].join(" "), /\b(?:25|60) image/, "the old numbers are gone");
    const prompt = buildProductKnowledgeSystemPrompt({ creditsMode: mode });
    assert.match(prompt, /2 image generations per week/i, `${mode}: the assistant is told`);
    assert.match(prompt, /image & document credits do not add images or unlock documents on Free/i, `${mode}: credits do not add Free images`);
    assert.match(prompt, /Free includes 2 image generations per week/i);
  }
  assert.match(CAPABILITY_FREE_NOTES.images, /2 images a week/);
});

// The watermark policy (owner decision, 2026-11-16, superseding #70): Free always marked; paid plans optional, off by default. The
// public copy must say so, and say the same thing everywhere.
test("the pricing table and the product facts state the watermark policy, in every credits wording", () => {
  for (const mode of MODES) {
    const row = comparisonGroupsFor(mode).find((group) => group.title === "Making things").rows.find((r) => r.label === "Image watermark");
    assert.deepEqual(row?.values, ["Always on", "Optional (off by default)", "Optional (off by default)", "Optional (off by default)"], `mode ${mode}`);
    const knowledge = productKnowledgeFor(mode);
    const details = (id) => knowledge.plans.find((p) => p.id === id).details.join(" ");
    assert.match(details("free"), /carry a small black-and-white VibhavGPT watermark[^.]*cannot be turned off on Free/, `${mode}: Free`);
    for (const id of ["plus", "pro", "max"]) assert.match(details(id), /watermark is optional on (Plus|Pro|Max) and off by default/, `${mode}: ${id}`);
  }
  assert.match(read("frontend/src/settings-routes.js"), /slug: "media"/, "Settings > Media holds the switch");
});

test("the server marks generated pictures on delivery under that policy; the old opt-out column is kept and not read", () => {
  assert.equal(fs.existsSync(path.join(root, "src/generation/watermark.js")), true);
  assert.equal(fs.existsSync(path.join(root, "src/generation/assets/vibhavgpt-watermark.png")), true);
  assert.match(read("src/library/delivery.js"), /needsMarkingNow\(record, userId, \{ mustMark \}\)/);
  assert.match(read("src/generation/watermark.js"), /export const watermarkRequiredForTier = \(tier\) => !tier \|\| tier === "free";/);
  assert.match(read("src/db/schema.js"), /watermarkEnabled: boolean\("watermark_enabled"\)/, "kept, so nothing that reads the table breaks");
  assert.match(read("src/db/schema.js"), /imageWatermark: boolean\("image_watermark"\)\.default\(false\)/, "the paid opt-in is off by default");
  assert.doesNotMatch(read("src/generation/watermark.js").replace(/\/\/.*$/gm, ""), /watermarkEnabled/, "the old opt-out choice is not read");
});

test("the image prompt still tells the model not to draw a watermark of its own", () => {
  assert.match(read("src/generation/service.js"), /No watermark, signature, frame or border\./);
});

// ---- The wording on the Image page ------------------------------------------------------------------------------------

test("the Image page's line for a Free account: what is left, and when more arrive in the reader's own time", () => {
  const endsAt = "2026-11-09T00:00:00.000Z";
  const options = { locale: "en-US", timeZone: "America/New_York" };
  assert.equal(freeImageLine({ tier: "free", period: "week", remaining: 2, limit: 2, endsAt }, options), "2 of 2 free images left this week. More arrive Monday at 12:00 AM UTC (Sunday, 7:00 PM EST).");
  assert.match(freeImageLine({ tier: "free", period: "week", remaining: 1, limit: 2, endsAt }, options), /^1 of 2 free images left this week\./);
  assert.equal(freeImageLine({ tier: "free", period: "week", remaining: 0, limit: 2, endsAt }, options), "You've used your 2 free images this week. More arrive Monday at 12:00 AM UTC (Sunday, 7:00 PM EST).");
  assert.equal(freeImageLine({ tier: "plus", period: "month", remaining: 50, limit: 100, endsAt }, options), null, "only Free sees it");
  assert.equal(freeImageLine(null), null);
  assert.equal(freeImageLine({ tier: "free", period: "week", remaining: 7, limit: 2, endsAt }, options).startsWith("2 of 2"), true, "never more than the limit");
  assert.equal(nextImagesWhen("not a date"), "Monday at 12:00 AM UTC");
  const workspace = read("frontend/src/components/ImageWorkspace.jsx");
  assert.match(workspace, /freeImageLine\(allowance\)/);
  assert.match(workspace, /disabled=\{busy \|\| !prompt\.trim\(\) \|\| reference\?\.uploading \|\| outOfImages\}/, "out of images, Generate is off");
  assert.match(workspace, /\{!isFree && <button type="button" className="btn btn--secondary" disabled=\{busy\} onClick=\{\(\) => generateVariation\(inspecting\)\}>/, "a variation is made from a reference, which Free cannot use");
});
