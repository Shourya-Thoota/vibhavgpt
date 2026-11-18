process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { NATIVE_FAMILY_ARCHITECTURES } = await import("../src/models/inventory.js");
const { isModelEligibleForPlan, THROTTLE_REASONS } = await import("../src/usage/plan-throttle-policy.js");
const { authorizeImageGeneration } = await import("../src/generation/image-engine.js");
const { VALID_PRICE_LOOKUP_KEYS, tierForPriceLookupKey, billedTier } = await import("../src/billing/service.js");

test("1. Nova and Lumen are eligible native models on Free plan", () => {
  assert.equal(NATIVE_FAMILY_ARCHITECTURES.nova.planEligibility, "free");
  assert.equal(NATIVE_FAMILY_ARCHITECTURES.lumen.planEligibility, "free");

  // Both Nova and Lumen pass plan throttle check on Free
  const novaCheck = isModelEligibleForPlan("free", { calculatedMu: 1.25, modelKey: "nova" });
  assert.equal(novaCheck.eligible, true);

  const lumenCheck = isModelEligibleForPlan("free", { calculatedMu: 0.124, modelKey: "lumen" });
  assert.equal(lumenCheck.eligible, true);

  // Paid models remain ineligible on Free
  const nebulaCheck = isModelEligibleForPlan("free", { calculatedMu: 2.475, modelKey: "nebula" });
  assert.equal(nebulaCheck.eligible, false);
  assert.equal(nebulaCheck.reason, THROTTLE_REASONS.FREE_RESTRICTED_TO_GREEN_DOT);

  const vesperCheck = isModelEligibleForPlan("free", { calculatedMu: 12.375, modelKey: "vesper" });
  assert.equal(vesperCheck.eligible, false);
});

test("2. Free tier accounts get 2 images a week, and no more", () => {
  const freeAuth = authorizeImageGeneration("free", 0);
  assert.equal(freeAuth.authorized, true);
  assert.equal(freeAuth.remaining, 2);
  const spent = authorizeImageGeneration("free", 2);
  assert.equal(spent.authorized, false);
  assert.match(spent.error?.message, /You've used your 2 free images this week/i);

  const plusAuth = authorizeImageGeneration("plus", 0);
  assert.equal(plusAuth.authorized, true);
});

test("3. Model selector lock badges display 'Upgrade' and accurate plan requirements", async () => {
  const appJsx = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");

  // Lock badge says "Upgrade", not "Plus"
  assert.match(appJsx, /<Lock size=\{12\} strokeWidth=\{2\.2\} aria-hidden="true" \/>Upgrade/);
  assert.doesNotMatch(appJsx, /<Lock size=\{12\} strokeWidth=\{2\.2\} aria-hidden="true" \/>Plus/);

  // Accurate entitlement copy distinguishing Pro from Plus/Pro
  // Slice 7: the lock copy lives in the shared lineup the picker reads (HOUSE_PLAN_COPY), and the picker uses it.
  const lineup = await import("../frontend/src/model-marketplace.js");
  assert.equal(lineup.HOUSE_PLAN_COPY.vesper, "Available with Pro or Max.");
  assert.equal("nebula" in lineup.HOUSE_PLAN_COPY, false, "Nebula is retired and has no plan copy");
  assert.equal(lineup.HOUSE_PLAN_COPY.zenith, "Available with Max.");
  assert.match(appJsx, /HOUSE_PLAN_COPY\[entry\.value\] \?\? "Available with Plus, Pro, or Max\."/);

  // Clicking locked model opens plan comparison
  assert.match(appJsx, /if \(!modelAllowedForTier\(nextModel, tier, creditBalance\)\) \{\s*go\("billing"\);\s*return;\s*\}/);
});

test("4. Chat error handling preserves message draft and suppresses duplicate retry on plan restriction", async () => {
  const appJsx = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");

  // On plan restriction error, draft is preserved and failed/retry is suppressed
  assert.match(appJsx, /const isPlanRestriction = err\.access\?\.reason === "plan" \|\| err\.code === "free_restricted_to_green_dot"/);
  assert.match(appJsx, /if \(isPlanRestriction\) \{\s*setDraft\(content\);/);
  assert.match(appJsx, /setFailed\(null\);/);
});

test("5. Max annual billing release: price lookup keys, billing intervals, and yearly pricing", () => {
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_monthly"), true);
  assert.equal(VALID_PRICE_LOOKUP_KEYS.has("vibhavgpt_max_yearly"), true);
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_monthly"), "max");
  assert.equal(tierForPriceLookupKey("vibhavgpt_max_yearly"), "max");

  const monthlySub = { items: { data: [{ price: { lookup_key: "vibhavgpt_max_monthly" } }] } };
  const yearlySub = { items: { data: [{ price: { lookup_key: "vibhavgpt_max_yearly" } }] } };
  assert.equal(billedTier(monthlySub), "max");
  assert.equal(billedTier(yearlySub), "max");
});

test("6. Sidebar account footer: dedicated settings button, stable layout, and 44px touch target", async () => {
  const sidebarJsx = await readFile(new URL("../frontend/src/components/Sidebar.jsx", import.meta.url), "utf8");
  const stylesCss = await readFile(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
  const referenceCss = await readFile(new URL("../frontend/src/chat-reference.css", import.meta.url), "utf8");

  // Sidebar renders account-row with separate settings button
  assert.match(sidebarJsx, /className="account-row"/);
  assert.match(sidebarJsx, /className="account__settings-btn"/);
  assert.match(sidebarJsx, /onClick=\{\(event\) => navigate\(event, "settings"\)\}/);

  // No display: contents breaking the footer layout
  assert.doesNotMatch(stylesCss, /\.sidebar__foot \{ display: contents; \}/);

  // Settings button and account row styling have minimum 44px touch targets
  assert.match(stylesCss, /\.account__settings-btn \{\s*display: inline-flex;[\s\S]*?min-width: 44px;\s*min-height: 44px;/);
  assert.match(referenceCss, /\.workspace \.account__settings-btn \{\s*display: inline-flex;[\s\S]*?min-width: 44px;\s*min-height: 44px;/);
});
