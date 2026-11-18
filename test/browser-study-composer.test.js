import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// The Study composer on a phone (390px) and a small tablet (760px), with and without the keyboard: it is in one place. Its bottom edge is
// the same in a new chat and in a conversation, so sending the first message, opening a menu or the keyboard opening does not move or
// jump it, and nothing is drawn over the greeting or the replies. The keyboard is a viewport that loses its bottom (the page asks for
// interactive-widget=resizes-content), which is how Chromium on Android behaves.
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
let browser; let fixture;
test.before(async () => { if (skipReason) return; browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--no-sandbox"] }); fixture = await startFixture({}); });
test.after(async () => { await browser?.close(); fixture?.close(); });

const REPLY = ["A longer study answer.", ...Array.from({ length: 9 }, (_, i) => `Point ${i + 1}: a line of explanation that wraps on a small screen.`)].join("\n\n");
const sse = () => `event: conversation\ndata: {"conversationId":"conv_study"}\n\nevent: delta\ndata: ${JSON.stringify({ text: REPLY })}\n\nevent: complete\ndata: ${JSON.stringify({ conversationId: "conv_study", messageId: "m1", reply: REPLY, sources: [], activitySummary: [], model: "nova" })}\n\n`;

async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: width < 500, reducedMotion: "reduce" });
  await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } });
  const page = await context.newPage();
  await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: sse() }));
  await page.goto(`${fixture.url}/app/study`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer__input, textarea").first().waitFor({ timeout: 20000 });
  return { context, page };
}
// A viewport change has settled when the page reports the new height and has painted twice.
const resize = async (page, width, height) => {
  await page.setViewportSize({ width, height });
  await page.waitForFunction((h) => innerHeight === h, height);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);
};
const measure = (page) => page.evaluate(() => {
  const rect = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const composer = rect(".composer");
  const wrap = document.querySelector(".composer-wrap");
  return {
    composer, wrap: rect(".composer-wrap"), scroll: rect(".chat__scroll"), opening: rect(".opening"), thread: rect(".chat__thread"), chat: rect(".chat"), tabs: rect(".start-below__tabs"),
    starters: (() => { const el = document.querySelector(".study-starters"); return el ? { shown: getComputedStyle(el).display !== "none", ...rect(".study-starters") } : null; })(),
    position: wrap && getComputedStyle(wrap).position,
    innerHeight, innerWidth, docHeight: document.documentElement.scrollHeight, scrollY, scrollX,
    lastReply: (() => { const nodes = [...document.querySelectorAll(".chat__thread > *")]; const last = nodes.at(-1); return last ? { bottom: last.getBoundingClientRect().bottom } : null; })(),
  };
});
const close = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

for (const [width, height] of [[390, 844], [760, 900]]) {
  const keyboardHeight = Math.round(height * 0.55);

  test(`${width}px: sending the first message does not move the composer, with or without the keyboard`, { skip: skipReason }, async () => {
    for (const keyboard of [false, true]) {
      const { context, page } = await open(width, height);
      const input = page.locator(".composer__input, textarea").first();
      await input.click();
      await input.fill("Explain photosynthesis simply");
      if (keyboard) await resize(page, width, keyboardHeight);
      const before = await measure(page);
      assert.equal(before.position, "sticky", "a new chat uses the conversation's layout: pinned to the bottom");
      close(before.composer.bottom + 12, before.innerHeight, 14, `${keyboard ? "keyboard" : "no keyboard"}: the composer's bottom edge is the bottom of the visible area (less the safe-area gap)`);
      await input.press("Enter");
      await page.locator(".chat__thread").waitFor();
      await page.waitForTimeout(500);
      const after = await measure(page);
      close(after.composer.bottom, before.composer.bottom, 1.5, `${width}px ${keyboard ? "with" : "without"} keyboard: the composer's bottom edge on send`);
      close(after.composer.height, before.composer.height, 80, "its own height changes only with its text");
      assert.equal(after.position, "sticky");
      assert.equal(after.scrollY, 0, "the page did not scroll");
      assert.ok(after.docHeight <= after.innerHeight + 1, `the page is one screen: ${after.docHeight} vs ${after.innerHeight}`);
      assert.equal(after.scrollX, 0);
      await context.close();
    }
  });

  test(`${width}px: the keyboard opening and closing leaves the composer on the bottom edge, before and after a message`, { skip: skipReason }, async () => {
    const { context, page } = await open(width, height);
    const start = await measure(page);
    close(start.composer.bottom + 12, start.innerHeight, 14, "closed");
    await resize(page, width, keyboardHeight);
    const keyboardOpen = await measure(page);
    close(keyboardOpen.composer.bottom + 12, keyboardHeight, 14, "the keyboard opens: still the bottom of what is visible");
    assert.ok(keyboardOpen.composer.top >= (keyboardOpen.opening?.bottom ?? 0) - 1, "the composer does not cover the greeting");
    assert.ok(keyboardOpen.docHeight <= keyboardHeight + 1, "no page-sized scroll behind it");
    await resize(page, width, height);
    const input = page.locator(".composer__input, textarea").first();
    await input.fill("hello");
    await input.press("Enter");
    await page.locator(".chat__thread").waitFor();
    await page.waitForTimeout(500);
    const sent = await measure(page);
    await resize(page, width, keyboardHeight);
    const sentOpen = await measure(page);
    close(sentOpen.composer.bottom + 12, keyboardHeight, 14, "a conversation, keyboard open");
    await resize(page, width, height);
    const sentClosed = await measure(page);
    close(sentClosed.composer.bottom, sent.composer.bottom, 1.5, "and back where it was");
    await context.close();
  });

  test(`${width}px: nothing is drawn over the greeting or the replies`, { skip: skipReason }, async () => {
    const { context, page } = await open(width, height);
    const empty = await measure(page);
    assert.ok(empty.opening, "the greeting is there");
    assert.ok(empty.opening.bottom <= empty.wrap.top + 1, `the greeting ends above the composer's group: ${empty.opening.bottom} vs ${empty.wrap.top}`);
    assert.ok(empty.opening.top >= empty.chat.top - 1, "and starts inside the chat");
    assert.ok(empty.tabs.bottom <= empty.composer.top + 1, "the Chat / Study switch is above the composer, not under it");
    if (empty.starters?.shown) assert.ok(empty.starters.bottom <= empty.composer.top + 1, "the suggestions are above the composer");
    // Little height left: the suggestions step aside and the switch stays.
    await resize(page, width, Math.round(height * 0.55));
    const small = await measure(page);
    assert.ok(!small.starters || !small.starters.shown, "with the keyboard open the suggestions step aside");
    assert.ok(small.tabs && small.tabs.bottom <= small.composer.top + 1);
    assert.ok(small.opening.bottom <= small.wrap.top + 1, "and the greeting is still clear of the composer");
    await resize(page, width, height);
    const input = page.locator(".composer__input, textarea").first();
    await input.fill("hello");
    await input.press("Enter");
    await page.locator(".chat__thread").waitFor();
    await page.waitForTimeout(500);
    // The replies scroll under the composer's translucent edge by design, so what must hold is that the last reply, scrolled to the end,
    // clears the composer.
    await page.evaluate(() => { const scroller = document.querySelector(".chat__scroll"); scroller.scrollTop = scroller.scrollHeight; });
    await page.waitForTimeout(250);
    const thread = await measure(page);
    assert.ok(thread.lastReply.bottom <= thread.composer.top + 1, `the last reply ends above the composer: ${thread.lastReply.bottom} vs ${thread.composer.top}`);
    assert.ok(thread.composer.top >= thread.scroll.top, "the composer is inside the screen");
    await context.close();
  });

  test(`${width}px: opening the + menu does not move the composer or the page`, { skip: skipReason }, async () => {
    const { context, page } = await open(width, height);
    const input = page.locator(".composer__input, textarea").first();
    await input.fill("hello");
    await input.press("Enter");
    await page.locator(".chat__thread").waitFor();
    await page.waitForTimeout(500);
    const before = await measure(page);
    await page.locator(".composer__add-trigger").click();
    await page.locator(".ui-menu__panel, .ui-sheet, [role=menu]").first().waitFor();
    await page.waitForTimeout(400);
    const during = await measure(page);
    close(during.composer.bottom, before.composer.bottom, 1.5, "composer bottom with the menu open");
    close(during.composer.top, before.composer.top, 1.5, "composer top with the menu open");
    assert.equal(during.scrollY, 0);
    assert.ok(during.docHeight <= during.innerHeight + 1);
    // And again from the new-chat state, where the group above the composer is taller.
    await page.keyboard.press("Escape");
    const fresh = await open(width, height);
    const emptyBefore = await measure(fresh.page);
    await fresh.page.locator(".composer__add-trigger").click();
    await fresh.page.locator(".ui-menu__panel, .ui-sheet, [role=menu]").first().waitFor();
    await fresh.page.waitForTimeout(400);
    const emptyDuring = await measure(fresh.page);
    close(emptyDuring.composer.bottom, emptyBefore.composer.bottom, 1.5, "new chat: composer bottom with the menu open");
    await fresh.context.close();
    await context.close();
  });
}

test("the phone layout rules are the cause fix: one sticky composer, safe area, no vh padding", { skip: false }, () => {
  const css = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");
  const block = css.slice(css.indexOf("A phone and a small tablet: the composer has one place"));
  assert.match(block, /@media \(max-width: 760px\) \{[\s\S]*padding-top: 0;/, "no vh padding above a new chat");
  assert.match(block, /position: sticky;\s*bottom: 0;/, "the composer is pinned in a new chat as in a conversation");
  assert.match(block, /max\(12px, var\(--safe-bottom, env\(safe-area-inset-bottom\)\)\)/, "the safe area is part of the bottom padding");
  assert.match(block, /\.start-below \{ order: -1;/, "the suggestions are above the composer");
  assert.match(block, /@media \(max-width: 760px\) and \(max-height: 560px\)/, "they step aside when there is little height");
  assert.doesNotMatch(block, /\d+vh/, "no large-viewport units in the fix");
  assert.match(fs.readFileSync(path.resolve("frontend/index.html"), "utf8"), /viewport-fit=cover, interactive-widget=resizes-content/);
});
