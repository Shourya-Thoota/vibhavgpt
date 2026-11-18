import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { usagePayload } from "./support/usage-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";

function findChrome() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || "";
  for (const candidate of [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]) if (candidate && fs.existsSync(candidate)) return candidate;
  try { const pw = chromium.executablePath(); if (pw && fs.existsSync(pw)) return pw; } catch { /* none */ }
  return undefined;
}

const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser;
let fixture;

test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({
    headless: true,
    executablePath: findChrome(),
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
  });
  fixture = await startFixture({});
});

test.after(async () => {
  await browser?.close();
  fixture?.close();
});

async function open({
  width = 1280,
  height = 900,
  sky = "light",
  hasTouch = false,
  route = `/app/chat?conversation=${CONVERSATION_ID}`,
  storage = {},
  usageData = null,
  subscriptionData = null,
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    colorScheme: sky,
    hasTouch,
    isMobile: width < 500,
  });

  await context.addInitScript(([entries]) => {
    try {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    } catch { /* storage disabled */ }
  }, [{ "vibhavgpt-theme": sky, "vibhavgpt-theme-study": sky, "vibhavgpt-theme-chosen": "1", ...storage }]);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));

  // Always supply usage policy mock to prevent boot hang
  await page.route("**/api/usage/policy", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ active: true, carryMode: "carry", version: "credits-2026-11-a" }),
    })
  );

  if (usageData) {
    await page.route("**/api/usage", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usageData) })
    );
  }
  if (subscriptionData) {
    await page.route("**/api/billing/subscription", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(subscriptionData) })
    );
  }

  await page.goto(`${fixture.url}${route}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}

// ========================================================================================================
// 1. Existing Conversation Scrolling & Light-Sky Contour Behavior
// ========================================================================================================

for (const [width, height, isPhone] of [[1280, 900, false], [390, 844, true]]) {
  const deviceLabel = isPhone ? "390px mobile" : "1280px desktop";

  test(`${deviceLabel}: existing conversation loads in light sky with scrollable thread, fixed contour background, and pinned composer`, { skip: skipReason }, async () => {
    const { context, page, errors } = await open({ width, height, sky: "light", hasTouch: isPhone });

    // Wait for message thread to render
    const thread = page.locator(".chat__thread");
    await thread.waitFor({ state: "visible", timeout: 20000 });
    const scroller = page.locator(".chat__scroll");
    await scroller.waitFor({ state: "visible", timeout: 20000 });

    // Verify topography contour layer
    const topography = page.locator(".chat-topography");
    await topography.waitFor({ state: "attached", timeout: 20000 });
    const topoProps = await page.evaluate(() => {
      const el = document.querySelector(".chat-topography");
      if (!el) return null;
      const s = getComputedStyle(el);
      const canvas = el.querySelector("canvas");
      const r = el.getBoundingClientRect();
      return {
        ariaHidden: el.getAttribute("aria-hidden"),
        position: s.position,
        zIndex: s.zIndex,
        pointerEvents: s.pointerEvents,
        canvasPointerEvents: canvas ? getComputedStyle(canvas).pointerEvents : null,
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });

    assert.equal(topoProps.ariaHidden, "true", "topography is hidden from assistive tech");
    assert.equal(topoProps.pointerEvents, "none", "topography takes no pointer events");
    assert.equal(topoProps.canvasPointerEvents, "none", "canvas takes no pointer events");
    assert.equal(topoProps.position, "fixed", "topography is fixed in the viewport");
    assert.equal(topoProps.zIndex, "-1", "topography sits behind conversation thread");
    assert.equal(topoProps.top, 0);
    assert.equal(topoProps.left, 0);

    // Verify thread is scrollable (has history)
    const scrollMetricsBefore = await page.evaluate(() => {
      const el = document.querySelector(".chat__scroll");
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        canScroll: el.scrollHeight > el.clientHeight,
      };
    });
    assert.ok(scrollMetricsBefore.canScroll, "conversation thread has scrollable content");

    // Check composer positioning before scroll
    const composerBefore = await page.locator(".composer").boundingBox();
    assert.ok(composerBefore, "composer is visible");
    const composerBottomBefore = composerBefore.y + composerBefore.height;
    assert.ok(composerBottomBefore <= height + 2, `composer bottom (${composerBottomBefore}) is inside viewport (${height})`);

    // Perform scroll inside the conversation thread (scroll up towards top of history)
    await page.evaluate(() => {
      const el = document.querySelector(".chat__scroll");
      el.scrollTop = 0;
    });
    await page.waitForTimeout(300);

    const scrollMetricsAfter = await page.evaluate(() => {
      const el = document.querySelector(".chat__scroll");
      return { scrollTop: el.scrollTop };
    });
    assert.equal(scrollMetricsAfter.scrollTop, 0, "conversation thread scrolled to top successfully");

    // Verify topography contour background did NOT move or jump when scrolling
    const topoAfterScroll = await page.evaluate(() => {
      const el = document.querySelector(".chat-topography");
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    });
    assert.equal(topoAfterScroll.top, 0, "topography stays anchored at top=0");
    assert.equal(topoAfterScroll.left, 0, "topography stays anchored at left=0");

    // Verify composer remains pinned at bottom after scroll
    const composerAfter = await page.locator(".composer").boundingBox();
    assert.ok(composerAfter, "composer is visible after scroll");
    const composerBottomAfter = composerAfter.y + composerAfter.height;
    assert.ok(Math.abs(composerBottomAfter - composerBottomBefore) < 5, `composer bottom edge stays pinned during scroll (${composerBottomAfter} vs ${composerBottomBefore})`);

    // Verify interaction in scrolled state: typing into composer
    const input = page.locator(".composer__input, textarea").first();
    await input.click();
    await input.fill("Testing scrolling and typing interaction");
    const typedValue = await input.evaluate((el) => el.value ?? el.textContent ?? "");
    assert.match(typedValue, /Testing scrolling and typing interaction/);

    // Verify interaction in scrolled state: clicking '+' add trigger opens sheet/menu
    const addTrigger = page.locator(".composer__add-trigger");
    if (await addTrigger.count() > 0) {
      await addTrigger.click();
      const menu = page.locator(".ui-menu__panel, .ui-sheet, [role=menu]").first();
      await menu.waitFor({ state: "visible", timeout: 8000 });
      assert.ok(await menu.isVisible(), "add menu/sheet opened without layout displacement");
      await page.keyboard.press("Escape");
    }

    // Verify horizontal overflow
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflowX <= 1, `${deviceLabel}: no sideways horizontal overflow (${overflowX}px)`);

    assert.deepEqual(errors, [], "no uncaught page errors");
    await context.close();
  });
}

// ========================================================================================================
// 2. Paid-Plan Screens (Plus, Pro, Max) Verification via Local Fixtures
// ========================================================================================================

test("Paid Plans: Pricing comparison table details Plus, Pro, and Max with approved allowances", { skip: skipReason }, async () => {
  const { context, page, errors } = await open({ route: "/pricing", width: 1280, height: 900 });

  // Open 'Compare all features' disclosure
  const compareSummary = page.locator("main.pricing details.compare > summary");
  await compareSummary.waitFor({ timeout: 15000 });
  await compareSummary.click();

  const compareTable = page.locator("main.pricing details.compare table");
  await compareTable.waitFor({ state: "visible", timeout: 10000 });

  // Check plan column headers
  const headers = await page.locator("main.pricing details.compare th").allInnerTexts();
  const headerText = headers.join(" ");
  assert.match(headerText, /Plus/);
  assert.match(headerText, /Pro/);
  assert.match(headerText, /Max/);

  // Check allowances rendered in table
  const tableText = await compareTable.innerText();
  // Plus: 100 per billing month, 20 per billing month
  assert.match(tableText, /100 per billing month/i);
  assert.match(tableText, /20 per billing month/i);
  // Pro: 400 per month, Unlimited
  assert.match(tableText, /400 per month/i);
  // Max: 1,500 per month (approved owner allowance from PR #74 & PR #77), Unlimited
  assert.match(tableText, /1,500 per month/i);

  assert.deepEqual(errors, []);
  await context.close();
});

test("Paid Plans: Plus tier screen renders Plus plan badge, 100 images, 20 documents, and credit purchase block", { skip: skipReason }, async () => {
  const plusPayload = usagePayload({
    tier: "plus",
    spentCredits: 5,
    flex: 250,
    imagesUsed: 15,
    documentsUsed: 3,
  });

  const { context, page, errors } = await open({
    route: "/app/usage",
    width: 1280,
    height: 900,
    usageData: plusPayload,
    subscriptionData: { subscription: { tier: "plus", status: "active" } },
  });

  await page.locator("[data-uo-section=chat]").waitFor({ timeout: 15000 });

  // Verify plan header
  const title = await page.locator(".usage-head__title").innerText();
  assert.match(title, /Plus plan/);

  // Verify Images section: 85 of 100 (100 - 15)
  const imagesValue = await page.locator("[data-uo-section=images] [data-uo-value]").innerText();
  assert.equal(imagesValue.trim(), "85 of 100");

  // Verify Documents section: 17 of 20 (20 - 3)
  const docsValue = await page.locator("[data-uo-section=documents] [data-uo-value]").innerText();
  assert.equal(docsValue.trim(), "17 of 20");

  // Verify Flex credits purchase block is available on Plus
  const extraSection = page.locator("[data-uo-section=extra]");
  assert.ok(await extraSection.count() > 0, "Plus tier has extra credits purchase section");
  assert.match(await extraSection.innerText(), /250 credits/);

  assert.deepEqual(errors, []);
  await context.close();
});

test("Paid Plans: Pro tier screen renders Pro plan badge, 400 images, and Unlimited documents", { skip: skipReason }, async () => {
  const proPayload = usagePayload({
    tier: "pro",
    spentCredits: 10,
    flex: 0,
    imagesUsed: 42,
    documentsUsed: 120,
  });

  const { context, page, errors } = await open({
    route: "/app/usage",
    width: 1280,
    height: 900,
    usageData: proPayload,
    subscriptionData: { subscription: { tier: "pro", status: "active" } },
  });

  await page.locator("[data-uo-section=chat]").waitFor({ timeout: 15000 });

  const title = await page.locator(".usage-head__title").innerText();
  assert.match(title, /Pro plan/);

  // Images: 358 of 400 (400 - 42)
  const imagesValue = await page.locator("[data-uo-section=images] [data-uo-value]").innerText();
  assert.equal(imagesValue.trim(), "358 of 400");

  // Documents: Unlimited
  const docsValue = await page.locator("[data-uo-section=documents] [data-uo-value]").innerText();
  assert.match(docsValue, /Unlimited/);

  assert.deepEqual(errors, []);
  await context.close();
});

test("Paid Plans: Max tier screen renders Max plan badge, 1,500 images, and Unlimited documents", { skip: skipReason }, async () => {
  const maxPayload = usagePayload({
    tier: "max",
    spentCredits: 20,
    flex: 0,
    imagesUsed: 100,
    documentsUsed: 500,
  });

  const { context, page, errors } = await open({
    route: "/app/usage",
    width: 1280,
    height: 900,
    usageData: maxPayload,
    subscriptionData: { subscription: { tier: "max", status: "active" } },
  });

  await page.locator("[data-uo-section=chat]").waitFor({ timeout: 15000 });

  const title = await page.locator(".usage-head__title").innerText();
  assert.match(title, /Max plan/);

  // Images: 1,400 of 1,500 (1500 - 100)
  const imagesValue = await page.locator("[data-uo-section=images] [data-uo-value]").innerText();
  assert.equal(imagesValue.trim(), "1,400 of 1,500");

  // Documents: Unlimited
  const docsValue = await page.locator("[data-uo-section=documents] [data-uo-value]").innerText();
  assert.match(docsValue, /Unlimited/);

  assert.deepEqual(errors, []);
  await context.close();
});
