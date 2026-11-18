// The circled "i" on a notice says what that notice means (owner request, 2026-11-15), in a real browser against the built app. A
// conversation last used with a retired model shows its info notice; its icon is a labelled button: hover or keyboard focus shows the help,
// a click or tap keeps it open with a Close help control, Escape hides it, and the help opens inside the notice (not over other controls).
// Also: starting a temporary chat does not move the composer. Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openRetired(width) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.route((url) => url.pathname === `/api/chat/conversations/${CONVERSATION_ID}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    route.fulfill({ response, json: { ...body, conversation: { ...body.conversation, model: "nebula" } } });
  });
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  const banner = page.locator(".ui-banner", { hasText: "has been retired." });
  await banner.waitFor({ timeout: 15000 });
  return { context, page, banner, toggle: banner.locator(".ui-banner__help-toggle"), help: banner.locator(".ui-banner__help") };
}

test("desktop: hover and keyboard focus show the notice's own help; a click keeps it; Escape and Close help hide it", { skip }, async () => {
  const { context, page, banner, toggle, help } = await openRetired(1280);
  assert.match(await toggle.getAttribute("aria-label"), /^What this notice means: VibhavGPT .+ has been retired\.$/);
  assert.equal(await help.isVisible(), false, "hidden until asked for");
  const before = await toggle.boundingBox();
  await toggle.hover();
  await help.waitFor({ state: "visible" });
  await page.waitForTimeout(600);
  assert.equal(await help.isVisible(), true, "the preview stays while the pointer stays");
  assert.deepEqual(await toggle.boundingBox(), before, "previewing does not move the icon");
  assert.match(await help.innerText(), /no longer offered, so nothing is sent until you choose another/);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.mouse.move(5, 5);
  await help.waitFor({ state: "hidden" });
  await toggle.focus();
  await help.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await toggle.click();
  await help.waitFor({ state: "visible" });
  await page.mouse.move(5, 5);
  assert.equal(await help.isVisible(), true, "a click keeps it open after the pointer leaves");
  // The help is inside the notice: the notice grows to hold it, and nothing outside is covered.
  const [helpBox, bannerBox] = await Promise.all([help.boundingBox(), banner.boundingBox()]);
  assert.ok(helpBox.y >= bannerBox.y && helpBox.y + helpBox.height <= bannerBox.y + bannerBox.height + 1, "the help is within the notice");
  await banner.getByRole("button", { name: "Close help" }).click();
  await help.waitFor({ state: "hidden" });
  await context.close();
});

test("phone: a tap opens and closes the help; the icon has a 44px touch area", { skip }, async () => {
  const { context, toggle, help } = await openRetired(375);
  const area = await toggle.evaluate((el) => { const r = el.getBoundingClientRect(); const a = getComputedStyle(el, "::after"); return { w: r.width + 2 * Math.abs(parseFloat(a.left)), h: r.height + 2 * Math.abs(parseFloat(a.top)) }; });
  assert.ok(area.w >= 44 && area.h >= 44, `touch area ${Math.round(area.w)}x${Math.round(area.h)}`);
  await toggle.tap();
  await help.waitFor({ state: "visible" });
  await toggle.tap();
  await help.waitFor({ state: "hidden" });
  await context.close();
});

for (const width of [1280, 375]) {
  test(`${width}px: starting a temporary chat leaves the composer where it was`, { skip }, async () => {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 860 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    const composerTop = () => page.locator(".composer").first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const before = await composerTop();
    await page.locator("button.temporary-chat-button").first().click();
    await page.getByText(/Temporary chat\. Memory isn't used or saved/).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await composerTop(), before, "the notice does not push the composer");
    await context.close();
  });
}
