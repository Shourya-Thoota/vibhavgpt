// Scrolling stays where it belongs (owner request, 2026-11-16), in a real browser against the built app.
// Chat: the page itself never scrolls or rubber-bands; the chat history scrolls on its own, at its top, middle and bottom, and stops at
// its edges; the sidebar's list does the same. Model picker: only the list scrolls; flinging it past its ends moves neither the dialog
// nor the page, and the Done bar stays the dialog's footer, inside the frame and below the list, never over it.
// Several screen sizes. Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const LINEUP = { models: [], groups: [], userPlan: "max", lineup: { house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })), providers: ["glm", "gpt-6", "gemini-4"].map((p) => ({ id: p, name: providerName(p), models: THIRD_PARTY_MODELS.filter((m) => m.provider === p).map((m) => ({ id: m.id, name: m.name })) })) } };
const LONG = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: i % 2 ? `Answer ${i}. ${"A longer line of reply text. ".repeat(8)}` : `Question ${i}?`, model: i % 2 ? "lumen" : undefined, createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, i)).toISOString() }));

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(width, height) {
  const touch = width < 760;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: LINEUP }));
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: { subscription: { tier: "max", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true } }));
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ json: { conversation: { id: CONVERSATION_ID } } });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, conversation: { ...body.conversation, model: "gpt-6-luna" }, history: LONG, hasMore: false, nextCursor: null } });
  });
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  await page.locator(".chat__scroll").first().waitFor();
  await page.waitForTimeout(500);
  return { context, page };
}

const pageState = (page) => page.evaluate(() => ({
  pageScroll: document.scrollingElement.scrollTop,
  pageScrollable: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
  workspaceTop: Math.round(document.querySelector(".workspace").getBoundingClientRect().top),
}));

for (const [width, height] of [[1280, 800], [1024, 768], [390, 844], [375, 667]]) {
  test(`${width}x${height}: the chat page never bounces; the history scrolls on its own at its top, middle and bottom`, { skip }, async () => {
    const { context, page } = await open(width, height);
    const styles = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overscrollBehaviorY,
      body: getComputedStyle(document.body).overscrollBehaviorY,
      history: getComputedStyle(document.querySelector(".chat__scroll")).overscrollBehaviorY,
      sidebar: document.querySelector(".conversation-history__list") ? getComputedStyle(document.querySelector(".conversation-history__list")).overscrollBehaviorY : "contain",
    }));
    assert.deepEqual(styles, { html: "none", body: "none", history: "contain", sidebar: "contain" });
    const history = page.locator(".chat__scroll").first();
    const box = await history.boundingBox();
    const range = await history.evaluate((el) => el.scrollHeight - el.clientHeight);
    assert.ok(range > 200, "the history is long enough to scroll");
    for (const [label, to] of [["top", 0], ["middle", Math.round(range / 2)], ["bottom", range]]) {
      await history.evaluate((el, top) => { el.scrollTop = top; }, to);
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
      // Fling past the edge, both ways.
      await page.mouse.wheel(0, label === "top" ? -2000 : 2000);
      await page.waitForTimeout(250);
      const after = await pageState(page);
      assert.equal(after.pageScroll, 0, `${label}: the page did not scroll`);
      assert.equal(after.workspaceTop, 0, `${label}: the app did not move`);
    }
    const scrolled = await history.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(250);
    assert.ok(await history.evaluate((el) => el.scrollTop) < scrolled, "the history itself still scrolls");
    assert.ok((await pageState(page)).pageScrollable <= 1, "the page has nothing of its own to scroll");
    await context.close();
  });
}

async function openPicker(page, width) {
  if (width < 500) {
    await page.locator('button[aria-label="Add to message"]').first().click();
    await page.locator(".add-sheet__row", { hasText: "Model" }).click();
  } else {
    await page.locator(".model-trigger").first().click();
  }
  await page.locator(".model-modal").waitFor();
  await page.waitForTimeout(300);
}

for (const [width, height] of [[1280, 800], [1280, 560], [390, 700]]) {
  test(`${width}x${height}: in the model picker only the list scrolls; the dialog stays put and Done stays its footer`, { skip }, async () => {
    const { context, page } = await open(width, height);
    await openPicker(page, width);
    const panel = page.locator(".ui-modal").first();
    const list = page.locator(".model-modal__list");
    const before = await panel.boundingBox();
    assert.equal(await list.evaluate((el) => getComputedStyle(el).overscrollBehaviorY), "contain");
    assert.deepEqual(await panel.evaluate((el) => [getComputedStyle(el).overflowY, getComputedStyle(el).overscrollBehaviorY]), ["hidden", "none"], "the dialog itself does not scroll or bounce");
    const lb = await list.boundingBox();
    await page.mouse.move(lb.x + lb.width / 2, lb.y + Math.min(lb.height / 2, 120));
    for (const delta of [3000, -3000, 3000]) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(250);
      const now = await panel.boundingBox();
      assert.deepEqual([Math.round(now.x), Math.round(now.y), Math.round(now.width), Math.round(now.height)], [Math.round(before.x), Math.round(before.y), Math.round(before.width), Math.round(before.height)], `the dialog does not move (${delta > 0 ? "bottom" : "top"})`);
      assert.equal((await pageState(page)).pageScroll, 0, "nor does the page behind it");
      const done = await page.locator(".model-modal__done").boundingBox();
      const listBox = await list.boundingBox();
      assert.ok(done.y >= now.y && done.y + done.height <= now.y + now.height + 1, "Done is inside the dialog's frame");
      assert.ok(done.y >= listBox.y + listBox.height - 1, "and below the list, never over its rows");
    }
    const range = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
    if (range > 0) assert.ok(await list.evaluate((el) => el.scrollTop) > 0, "the list itself scrolled");
    await context.close();
  });
}
