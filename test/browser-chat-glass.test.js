// The chat's reading backdrop (owner report, 2026-11-13): the translucent scrim behind the messages ended in a hard horizontal line partway
// down the screen, because it was sized to the conversation column and stopped where the last message did. Now one liquid-glass layer
// (translucent paper + soft backdrop blur) covers the whole chat viewport, edge to edge and top to bottom, on a short chat and on the empty
// new-chat screen, in both skies, at 1280px and 375px. Checked three ways: the layer's own geometry, its style (no mask, a blur), and the
// pixels (no step anywhere down the screen where an edge would be). Text contrast over it is test/browser-readability.test.js.
// Emulated Chromium against the built app. With GLASS_SHOTS_DIR set, it saves the four screenshots there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const SHOTS = process.env.GLASS_SHOTS_DIR || null;
let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open({ width, sky, short = true }) {
  const height = width < 500 ? 812 : 900;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", "reduce"); }, sky);
  const page = await context.newPage();
  // A short conversation: two turns, so the thread ends well above the message box (where the old scrim stopped in a hard line).
  if (short) {
    await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ json: { ...body, history: (body.history ?? []).slice(0, width < 500 ? 1 : 2) } });
    });
  }
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { context, page, height };
}

const glassState = (page) => page.evaluate(() => {
  // The glass is the chat column's ::after (.workspace__main): from the very top of the screen to the very bottom.
  const chat = document.querySelector(".workspace__main");
  const s = getComputedStyle(chat, "::after");
  const box = chat.getBoundingClientRect();
  // Where the visible conversation ends: the bottom of its last turn (the thread element itself stretches to fill the pane).
  const turns = document.querySelectorAll(".chat__thread .turn");
  const thread = turns.length ? turns[turns.length - 1].getBoundingClientRect() : null;
  return {
    on: document.querySelector(".workspace")?.dataset.topography === "on",
    content: s.content, position: s.position, top: s.top, right: s.right, bottom: s.bottom, left: s.left, zIndex: s.zIndex, pointerEvents: s.pointerEvents,
    mask: s.maskImage ?? s.webkitMaskImage, backdrop: s.backdropFilter || s.webkitBackdropFilter, background: s.backgroundColor,
    chat: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    threadBottom: thread?.bottom ?? null,
    viewport: { width: innerWidth, height: innerHeight },
    threadScrim: getComputedStyle(document.querySelector(".chat__thread") ?? chat, "::before").content,
  };
});

// The largest jump in average colour from one pixel row to the next, across the chat's full width, in the empty band between the
// last message and the message box: a scrim edge is a step across every column at once, while the blurred lines are not. The screenshot
// is decoded by the browser's own canvas (no image library needed).
async function largestRowStep(page, shot, { left, right, top, bottom }) {
  return page.evaluate(async ({ data, left, right, top, bottom }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const scale = img.naturalWidth / innerWidth;
    const x0 = Math.max(0, Math.round(left * scale)); const x1 = Math.min(canvas.width, Math.round(right * scale));
    const y0 = Math.max(0, Math.round(top * scale)); const y1 = Math.min(canvas.height, Math.round(bottom * scale));
    const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const w = x1 - x0;
    const means = [];
    for (let y = 0; y < y1 - y0; y += 1) {
      let sum = 0; let n = 0;
      for (let x = 0; x < w; x += 2) { const i = (w * y + x) * 4; sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n += 1; }
      means.push(sum / n);
    }
    let step = 0;
    for (let i = 1; i < means.length; i += 1) step = Math.max(step, Math.abs(means[i] - means[i - 1]));
    return { step, rows: means.length };
  }, { data: shot.toString("base64"), left, right, top, bottom });
}

for (const width of [1280, 375]) {
  for (const sky of ["light", "dark"]) {
    test(`${width}px, ${sky}: one glass layer covers the whole chat viewport, with no edge anywhere down the screen`, { skip }, async () => {
      const { context, page, height } = await open({ width, sky });
      const g = await glassState(page);
      assert.equal(g.on, true, "the contour background is on");
      assert.equal(g.content, "\"\"", "the glass exists");
      assert.deepEqual([g.position, g.top, g.right, g.bottom, g.left], ["absolute", "0px", "0px", "0px", "0px"], "it fills the chat viewport");
      assert.equal(g.zIndex, "-1", "behind every message and control");
      assert.equal(g.pointerEvents, "none");
      assert.equal(g.mask, "none", "no feathered or partial mask");
      assert.match(g.backdrop, /blur\(6px\)/, "a soft backdrop blur");
      // color-mix() computes to color(srgb r g b / a); an rgba() form is accepted too. Either way the alpha is below 1: translucent.
      const alpha = Number((g.background.match(/\/\s*([\d.]+)\)$/) ?? g.background.match(/rgba\([^)]*,\s*([\d.]+)\)$/) ?? [])[1]);
      assert.ok(alpha > 0.3 && alpha < 1, `translucent, so the lines show through (${g.background})`);
      assert.equal(g.threadScrim, "none", "the old column scrim is gone");
      assert.ok(g.chat.top <= 0.5 && Math.abs(g.chat.bottom - height) <= 1, `the glass runs from the very top of the screen to the very bottom (${JSON.stringify(g.chat)})`);
      // Nothing near the top paints a second, different glass over it (that made a seam under the phone's top bar).
      const topbar = await page.evaluate(() => { const el = document.querySelector(".topbar-mobile"); if (!el || !el.getBoundingClientRect().height) return null; const s = getComputedStyle(el); return { bg: s.backgroundColor, bf: s.backdropFilter }; });
      if (topbar) assert.deepEqual(topbar, { bg: "rgba(0, 0, 0, 0)", bf: "none" }, "the phone's top bar sits on the one glass");
      assert.ok(Math.abs(g.chat.right - width) <= 1, "and to the right edge");
      // The pixels: from just above the last message's end to just above the message box, there is no step a scrim edge would make.
      const composerTop = await page.locator(".composer").first().evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(g.threadBottom !== null && g.threadBottom < composerTop - 40, "the short thread ends well above the message box");
      const band = await largestRowStep(page, await page.screenshot(), { left: g.chat.left + 8, right: g.chat.right - 8, top: g.threadBottom + 6, bottom: composerTop - 12 });
      assert.ok(band.rows > 20, `a band to measure (${band.rows} rows)`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `chat-glass-${width}-${sky}.png`) });
      // Measured in the widest run of columns at the top that no control (tabs, buttons, icons) or message crosses, so only the
      // backdrop is in it.
      // Rows: from the top of the screen to just above the first message, which takes in the bottom edge of the tabs bar or the phone's
      // top bar, where a second layer would have made its seam.
      const free = await page.evaluate(({ left, right }) => {
        const firstTurn = Math.min(...[...document.querySelectorAll(".chat__thread .turn")].map((el) => el.getBoundingClientRect().top), 110);
        const bottom = Math.max(30, Math.min(110, firstTurn - 4));
        // Visible controls only (the closed phone drawer's scrim is an invisible full-screen button).
        const visible = (el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && Number(s.opacity) > 0 && s.display !== "none"; };
        const taken = [...document.querySelectorAll("button, a, [role=tab], .mode-tabs, img, svg")].filter(visible)
          .map((el) => el.getBoundingClientRect()).filter((b) => b.width && b.height && b.top < bottom && b.bottom > 0).map((b) => [b.left - 6, b.right + 6]);
        let best = [left, left]; let x = left;
        for (const [a, b] of [...taken.sort((p, q) => p[0] - q[0]), [right, right]]) {
          if (a - x > best[1] - best[0]) best = [x, Math.min(a, right)];
          x = Math.max(x, b);
        }
        return { cols: best, bottom };
      }, { left: g.chat.left + 4, right: g.chat.right - 4 });
      assert.ok(free.cols[1] - free.cols[0] >= 16, `a control-free strip at the top (${JSON.stringify(free)})`);
      const topBand = await largestRowStep(page, await page.screenshot(), { left: free.cols[0], right: free.cols[1], top: 2, bottom: free.bottom });
      assert.ok(topBand.step < 3, `${width}px ${sky}: no seam at the top of the screen (largest row-to-row step ${topBand.step.toFixed(2)} of 255)`);
      assert.ok(band.step < 3, `${width}px ${sky}: no hard line (largest row-to-row step ${band.step.toFixed(2)} of 255)`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `chat-glass-${width}-${sky}.png`) });
      await context.close();
    });
  }
}

// The empty landing screen (before any message) has no glass at all: the contour background shows crisp and unobstructed. It appears
// as soon as a message is sent and the conversation view has it.
for (const width of [1280, 375]) {
  for (const sky of ["light", "dark"]) {
    test(`${width}px, ${sky}: the empty landing screen has no glass; it appears across the whole viewport once a message is sent`, { skip }, async () => {
      const context = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 900 }, colorScheme: sky, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", "reduce"); }, sky);
      const page = await context.newPage();
      await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: complete\ndata: ${JSON.stringify({ reply: "Hello.", modelKey: "lumen", messageId: "m1", userMessageId: "u1", conversationId: "00000000-0000-4000-8000-000000000001", sources: [], activitySummary: [] })}\n\n` }));
      await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const landing = await glassState(page);
      assert.equal(await page.locator(".chat__scroll[data-empty]").count(), 1, "the landing screen");
      assert.equal(landing.content, "none", "no glass on the landing screen");
      const topbar = await page.evaluate(() => { const el = document.querySelector(".topbar-mobile"); return el && el.getBoundingClientRect().height ? getComputedStyle(el).backdropFilter : null; });
      if (topbar !== null) assert.notEqual(topbar, "none", "the phone's top bar keeps its own look on the landing screen");
      await page.locator(".composer__input").first().fill("Hello");
      await page.locator('button[aria-label="Send message"]').first().click();
      await page.waitForFunction(() => !document.querySelector(".chat__scroll[data-empty]"), null, { timeout: 10_000 });
      await page.waitForTimeout(300);
      const active = await glassState(page);
      assert.deepEqual([active.content, active.position, active.top, active.bottom, active.mask], ["\"\"", "absolute", "0px", "0px", "none"], "the full glass once the conversation has a message");
      assert.match(active.backdrop, /blur\(6px\)/);
      await context.close();
    });
  }
}
