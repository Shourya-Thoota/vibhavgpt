// The homepage model showcase is visible on every screen (owner request, 2026-11-16), in a real browser against the built site: at
// phone, tablet and desktop sizes, portrait and landscape, the live stage mounts, the current model's artwork has loaded and is on
// screen, its name and actions are on screen, and nothing overflows sideways. Aura is one of the slides, with its own artwork.
// Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";
import { ORBIT_MODEL_IDS } from "../frontend/src/orbit-showcase-data.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const SIZES = [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [896, 414], [768, 1024], [1024, 768], [1024, 600], [1280, 800], [1920, 1080], [2560, 1440]];

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openAt(width, height) {
  const touch = width < 900;
  const context = await browser.newContext({ viewport: { width, height }, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.querySelector("#models")?.scrollIntoView({ block: "start" }));
  await page.locator(".osh-root").waitFor({ timeout: 15000 });
  await page.evaluate(() => window.scrollBy(0, 40));
  await page.waitForTimeout(900);
  return { context, page };
}

for (const [width, height] of SIZES) {
  test(`${width}x${height}: the showcase is live and on screen: the artwork, the model's name and its actions, with no sideways overflow`, { skip }, async () => {
    const { context, page } = await openAt(width, height);
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth; const vh = window.innerHeight;
      const onScreen = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw && s.visibility !== "hidden" && s.display !== "none"; };
      const img = [...document.querySelectorAll(".osh-plates img")].find((i) => { const b = i.getBoundingClientRect(); return b.width > 0 && Number(getComputedStyle(i).opacity) > 0.2; });
      // The visible heading of the current slide, and its two actions.
      const title = [...document.querySelectorAll(".osh-hd")].find((h) => getComputedStyle(h).visibility !== "hidden");
      const actions = [...document.querySelectorAll(".osh-acts a, .osh-acts button")].filter((a) => onScreen(a));
      return {
        img: Boolean(img && img.complete && img.naturalWidth > 0 && onScreen(img)),
        title: onScreen(title), titleBottom: title ? Math.round(title.getBoundingClientRect().bottom) : null,
        actions: actions.length, vh,
        overflow: document.documentElement.scrollWidth > vw + 1,
      };
    });
    assert.equal(m.img, true, "the current model's artwork is loaded and on screen");
    assert.equal(m.title, true, "the model's name is on screen");
    assert.ok(m.titleBottom <= m.vh, `the name is not cut off at the bottom (${m.titleBottom} > ${m.vh})`);
    assert.ok(m.actions >= 1, "its actions are on screen");
    assert.equal(m.overflow, false, "nothing overflows sideways");
    await context.close();
  });
}

test("Aura is a slide, with its own artwork, on a phone and a desktop", { skip }, async () => {
  assert.equal(ORBIT_MODEL_IDS.at(-1), "aura");
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const { context, page } = await openAt(width, height);
    const aura = page.locator('.osh-plates img[src="/home/models/aura.svg"]');
    assert.equal(await aura.count(), 1, `${width}px: Aura's artwork is in the stage`);
    await aura.evaluate((img) => img.decode?.().catch(() => {}));
    assert.equal(await aura.evaluate((img) => img.complete && img.naturalWidth > 0), true, `${width}px: and it loads`);
    assert.ok(await page.getByText("VibhavGPT Aura", { exact: false }).count() >= 1, `${width}px: named VibhavGPT Aura`);
    await context.close();
  }
});
