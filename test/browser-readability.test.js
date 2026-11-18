// PR 2: text stays readable over the moving contour background. Every text zone (assistant text, byline, table headers, code label, user
// bubble, the message box placeholder, the greeting, the temporary-chat notice, the error banner) keeps at least 4.5:1 against the
// least favourable frame of the animation, in both skies, at desktop and phone widths. Measured as in test/support/contrast-measure.js.
// Emulated Chromium against the design fixture, not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture } from "./support/extensions-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { CHAT_ZONES, worstCaseContrastMany } from "./support/contrast-measure.js";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const AA = 4.5;
// 30 seconds of animation, in 1-second steps of a fake clock: deterministic, and long enough for the terrain to carry its bright bands
// under the text (a shorter, real-time sample missed the worst frame and passed without the fix).
const SAMPLING = { frames: 30, intervalMs: 1000 };
let browser; let fixture;
test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({ headless: true, executablePath: exe });
  fixture = await startFixture({});
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open(sky, size, motion = "full") {
  const context = await browser.newContext({ viewport: size, colorScheme: sky, ...(size.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(([s, m]) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", m); }, [sky, motion]);
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-11-11T12:00:00Z") });
  return { context, page };
}
const sample = (page) => ({ ...SAMPLING, advance: (ms) => page.clock.runFor(ms) });
// The page loads over the network in real time while the animation clock only moves when told to: wait for the network to go quiet,
// then advance the clock until the scroll position and the layout stop changing, so nothing moves under the measured text.
async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    await page.clock.runFor(500);
    const now = await page.evaluate(() => { const s = document.querySelector(".chat__scroll"); const t = document.querySelector(".chat__thread, .opening"); return `${s?.scrollTop}|${s?.scrollHeight}|${Math.round(t?.getBoundingClientRect().top ?? 0)}`; });
    if (now === last) return;
    last = now;
  }
}
const failures = (rows) => rows.filter((row) => row.ratio < AA).map((row) => `${row.zone}: ${row.ratio}:1 (text ${row.textColor}, worst background luminance ${row.worstBackgroundLuminance})`);

for (const [device, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  for (const sky of ["dark", "light"]) {
    test(`${device}, ${sky}: every text zone in a conversation keeps ${AA}:1 over the worst frame of the moving background`, { skip: skipReason }, async () => {
      const { context, page } = await open(sky, size);
      await page.goto(`${fixture.url}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "load" });
      await page.locator(".chat__thread").waitFor({ timeout: 20000 });
      await settle(page);
      const rows = await worstCaseContrastMany(page, CHAT_ZONES, sample(page));
      assert.ok(rows.some((row) => row.zone === "assistant text"), "the assistant's text was measured");
      assert.deepEqual(failures(rows), []);
      await context.close();
    });

    test(`${device}, ${sky}: the greeting, the temporary-chat notice and an error banner keep ${AA}:1 over the worst frame`, { skip: skipReason }, async () => {
      const { context, page } = await open(sky, size);
      await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "VibhavGPT is temporarily unavailable. Please try again shortly." }) }));
      await page.goto(`${fixture.url}/app/chat`, { waitUntil: "load" });
      await page.locator(".opening__title").waitFor({ timeout: 20000 });
      await settle(page);
      const greeting = await worstCaseContrastMany(page, [{ zone: "greeting", selector: ".opening__title", limit: 1 }], sample(page));
      assert.equal(greeting.length, 1, "the greeting was measured");
      await page.getByRole("button", { name: "Temporary chat" }).click();
      await page.locator("textarea.composer__input").first().fill("A synthetic question.");
      await page.keyboard.press("Enter");
      await page.locator(".chat-banner").waitFor({ timeout: 15000 });
      await settle(page);
      const rest = await worstCaseContrastMany(page, [{ zone: "temporary notice", selector: ".temporary-banner", limit: 1 }, { zone: "error banner", selector: ".chat-banner .ui-banner__text", limit: 1 }], sample(page));
      assert.equal(rest.length, 2, "the notice and the banner were measured");
      assert.deepEqual(failures([...greeting, ...rest]), []);
      await context.close();
    });
  }
}

test("the reading scrim is there only while the background is on, sits behind the text, and moves nothing; reduced motion still stops the drawing", { skip: skipReason }, async () => {
  const { context, page } = await open("dark", { width: 1280, height: 900 }, "reduce");
  await page.addInitScript(() => {
    window.__draws = 0;
    for (const name of ["drawArrays", "drawArraysInstanced"]) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) { window.__draws += 1; return original.apply(this, args); };
    }
  });
  await page.goto(`${fixture.url}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "load" });
  await page.locator(".chat__thread").waitFor({ timeout: 20000 });
  await page.clock.runFor(2500);
  const scrim = await page.evaluate(() => {
    // The reading glass covers the whole chat column, top to bottom (chat-topography.css), not the conversation's content.
    const s = getComputedStyle(document.querySelector(".workspace__main"), "::after");
    return { content: s.content, zIndex: s.zIndex, pointerEvents: s.pointerEvents, background: s.backgroundColor, animation: s.animationName, transition: s.transitionProperty };
  });
  assert.equal(scrim.content, "\"\"", "the scrim exists while the background is on");
  assert.equal(scrim.zIndex, "-1", "it sits behind the text");
  assert.equal(scrim.pointerEvents, "none", "it takes no clicks or scrolling");
  assert.equal(scrim.animation, "none", "it does not animate");
  const before = await page.evaluate(() => window.__draws);
  await page.clock.runFor(2000);
  assert.equal(await page.evaluate(() => window.__draws), before, "reduced motion: no frames drawn");
  await context.close();
});
