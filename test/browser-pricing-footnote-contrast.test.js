import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The Pricing footnote ("Input and output tokens both count toward an allowance...") passes under the floating
// navigation bar as the page scrolls. In light mode the bar's drop shadow darkens the page behind the line by about a
// quarter, and the footnote was in the faintest text colour, which read 3.4:1 at its worst (2 px under the bar) and
// under 4.5:1 across much of the top of a phone screen. This holds the line at 4.5:1 at every position from just under
// the bar's edge to 90 px below it, in both themes and at phone, tablet and desktop widths.
//
// The measurement is from what is painted, not from computed colours: all text is made transparent, the page is
// screenshotted, and the pixels under the footnote's own line boxes are read; the text colour is then composited over
// the worst of them. Lines under the bar itself are covered by it and not counted.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const CASES = [["light", 390, 844], ["light", 820, 1180], ["light", 1280, 800], ["dark", 390, 844]];

for (const [engine, launch] of ENGINES) describe(`Pricing footnote contrast in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });

  for (const [theme, width, height] of CASES) test(`${theme}, ${width}px wide: the footnote stays at 4.5:1 from the bar's edge to 90px below it`, async (t) => {
    if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return; }
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    await page.goto(`${base}/pricing`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => { const p = document.querySelector(".compare__footnote"); const nav = document.querySelector(".public-nav").getBoundingClientRect(); return { top: p.getBoundingClientRect().top + scrollY, navBottom: nav.bottom, text: p.textContent.trim().slice(0, 36) }; });
    // Found by its element, not its wording: the footnote's copy changes with the plans (and with credits on), its position does not.
    assert.ok(geometry.text.length > 0, "the footnote is found");
    const readings = [];
    for (let offset = -10; offset <= 90; offset += 4) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), Math.max(0, Math.round(geometry.top - (geometry.navBottom + offset))));
      await page.waitForTimeout(120);
      const lines = await page.evaluate(() => {
        const p = document.querySelector(".compare__footnote"); const range = document.createRange(); range.selectNodeContents(p);
        const nav = document.querySelector(".public-nav").getBoundingClientRect();
        // The band where the letters are: a line's box also holds empty space above and below them, which at the bar's edge is
        // the bar's own rim and shadow, not ink, so the top and bottom fifth of each box are left out.
        const rects = [...range.getClientRects()].map((r) => ({ x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.round(r.top + r.height * 0.2)), w: Math.ceil(r.width), h: Math.max(2, Math.round(r.height * 0.6)) })).filter((r) => r.y >= nav.bottom && r.y + r.h <= innerHeight && r.w > 1);
        const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#000"; g.fillStyle = getComputedStyle(p).color; g.fillRect(0, 0, 1, 1);
        const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
        return { rects, fg: [r, gr, b], alpha: a / 255 };
      });
      if (!lines.rects.length) continue;
      const hide = await page.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}" });
      await page.waitForTimeout(60);
      const png = await page.screenshot();
      await hide.evaluate((el) => el.remove());
      const worst = await page.evaluate(async ([data, spec]) => {
        const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
        let min = Infinity;
        for (const r of spec.rects) {
          const px = g.getImageData(r.x, r.y, Math.max(1, Math.min(r.w, img.width - r.x)), Math.max(1, Math.min(r.h, img.height - r.y))).data;
          for (let i = 0; i < px.length; i += 4) {
            const fg = [0, 1, 2].map((k) => spec.fg[k] * spec.alpha + px[i + k] * (1 - spec.alpha));
            const l1 = lum(...fg); const l2 = lum(px[i], px[i + 1], px[i + 2]);
            min = Math.min(min, (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
          }
        }
        return min;
      }, [png.toString("base64"), lines]);
      readings.push({ offset, ratio: worst });
    }
    await context.close();
    assert.ok(readings.length >= 15, `the footnote was measured at ${readings.length} positions`);
    const low = readings.filter((r) => r.ratio < 4.5);
    assert.deepEqual(low, [], `${theme} ${width}px: below 4.5:1 at ${low.map((r) => `${r.offset}px (${r.ratio.toFixed(2)})`).join(", ")}; lowest of ${readings.length}: ${Math.min(...readings.map((r) => r.ratio)).toFixed(2)}`);
  });
});
