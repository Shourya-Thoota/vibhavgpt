// Part A in a real browser: the sidebar and the plans page show the same plan from the server's one resolver. The owner's case: a
// complimentary account (server tier Max) with a stale direct-grant row behind it showed "Free plan" in the sidebar and "Pro plan,
// Bought in the Android app" on the plans page. Emulated Chromium against the built app.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function surfaces({ usageTier, billing }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route("**/api/usage", async (route) => { const r = await route.fetch(); const body = await r.json(); await route.fulfill({ json: { ...body, tier: usageTier } }); });
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: billing }));
  await page.goto(`${base}/app/billing`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const sidebar = await page.locator(".sidebar__foot").innerText();
  const card = await page.locator("section.subscription").first().innerText();
  const buttons = await page.locator("section.subscription button").allInnerTexts();
  await context.close();
  return { sidebar, card, buttons };
}

test("a complimentary account: Max on both surfaces, \"Complimentary\", no store card, nothing to manage or cancel", { skip }, async () => {
  const { sidebar, card, buttons } = await surfaces({
    usageTier: "max",
    billing: { subscription: { tier: "max", status: "active", billingSource: "complimentary", currentPeriodEndsAt: null, cancelAtPeriodEnd: false }, plan: { tier: "max", source: "complimentary" }, maxAvailable: false, complimentary: true },
  });
  assert.doesNotMatch(sidebar, /Free plan/, "the sidebar no longer drops Max to Free");
  assert.match(sidebar, /Max plan/);
  assert.match(card, /Max plan/);
  assert.match(card, /Complimentary/);
  assert.doesNotMatch(card, /Android app|Pro plan/);
  assert.deepEqual(buttons, []);
});

test("a leftover row the server does not honour: Free on both surfaces, no store card", { skip }, async () => {
  const { sidebar, card } = await surfaces({ usageTier: "free", billing: { subscription: null, plan: { tier: "free", source: "none" }, maxAvailable: false, complimentary: false } });
  assert.match(sidebar, /Free plan/);
  assert.match(card, /Free plan/);
  assert.doesNotMatch(card, /Android app/);
});

test("a direct grant: its plan on both surfaces, labelled as granted access, never as a store purchase, nothing to cancel", { skip }, async () => {
  const { sidebar, card, buttons } = await surfaces({
    usageTier: "pro",
    billing: { subscription: { tier: "pro", status: "active", billingSource: "internal", currentPeriodEndsAt: null, cancelAtPeriodEnd: false }, plan: { tier: "pro", source: "internal" }, maxAvailable: false, complimentary: false },
  });
  assert.match(sidebar, /Pro plan/);
  assert.match(card, /Pro plan/);
  assert.match(card, /Access granted by VibhavGPT/);
  assert.doesNotMatch(card, /Android app/);
  assert.deepEqual(buttons, []);
});
