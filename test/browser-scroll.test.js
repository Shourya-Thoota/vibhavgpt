import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// Scrolling, in the built app, in three engines, measured the way a person meets it: a wheel over the sidebar, a long chat history,
// the account footer kept on screen, and no second scroll on the page. The source-only checks in sidebar-scroll.test.js describe the
// design; these prove what runs. The conversations are a fixture (60 of them), so the history is genuinely long.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe")].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const LONG = Array.from({ length: 60 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, title: `Conversation number ${i + 1}`, model: "nova", mode: "chat", archived: false, groupId: null, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: new Date(Date.UTC(2026, 9, 1) - i * 3600e3).toISOString() }));

for (const [engine, launch] of ENGINES) describe(`Scrolling in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function openChat({ width, height, conversations = LONG }) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.route(`${base}/api/chat/conversations`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations }) }));
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    return { context, page };
  }

  test("on a tall desktop window the chat history scrolls on its own while the sidebar stays still and the account stays on screen", async (t) => {
    if (skip(t)) return;
    for (const [width, height] of [[1440, 900], [1366, 768]]) {
      const { context, page } = await openChat({ width, height });
      // The pointer goes to the middle of the history pane itself, wherever the window's own layout put it: a fixed fraction of the
      // window can land on the controls above the pane, where a wheel scrolls nothing.
      const pane = await page.locator(".conversation-history__list").boundingBox();
      await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        history: document.querySelector(".conversation-history__list").scrollTop,
        sidebar: document.querySelector(".sidebar").scrollTop,
        page: Math.round(scrollY),
        footBottom: Math.round(document.querySelector(".sidebar__foot").getBoundingClientRect().bottom),
        innerH: innerHeight,
      }));
      const label = `${width}x${height}`;
      assert.ok(m.history > 100, `${label}: the history scrolled (${m.history}px)`);
      assert.equal(m.sidebar, 0, `${label}: the sidebar itself did not scroll, so there is one scroll, not two`);
      assert.equal(m.page, 0, `${label}: the page did not move`);
      assert.ok(m.footBottom <= m.innerH + 1, `${label}: the account footer is on screen (${m.footBottom} of ${m.innerH})`);
      await context.close();
    }
  });

  test("the account footer stays reachable after a long history is scrolled to its end", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openChat({ width: 1440, height: 900 });
    await page.mouse.move(150, 450);
    for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, 800); await page.waitForTimeout(60); }
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const list = document.querySelector(".conversation-history__list");
      return { atEnd: list.scrollTop + list.clientHeight >= list.scrollHeight - 2, footBottom: Math.round(document.querySelector(".sidebar__foot").getBoundingClientRect().bottom), innerH: innerHeight, sidebar: document.querySelector(".sidebar").scrollTop };
    });
    assert.equal(m.atEnd, true, "the last chat can be reached");
    assert.ok(m.footBottom <= m.innerH + 1, `the footer is still on screen (${m.footBottom} of ${m.innerH})`);
    assert.equal(m.sidebar, 0);
    await context.close();
  });

  test("a short history needs no scrolling at all, and the page never scrolls sideways", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openChat({ width: 1440, height: 900, conversations: LONG.slice(0, 3) });
    const m = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth - innerWidth, historyScrolls: document.querySelector(".conversation-history__list").scrollHeight > document.querySelector(".conversation-history__list").clientHeight + 2 }));
    assert.equal(m.overflowX, 0, "no sideways scroll");
    assert.equal(m.historyScrolls, false, "three chats fit without a scrollbar");
    await context.close();
  });
});
