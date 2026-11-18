import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The homepage's new section (heading, one-line description, the five features as text, the call to action) measured on what
// is actually painted, not on the colour tokens: the page behind the text is a fixed gradient wash, so the colour behind a word
// is whatever pixel the browser put there. For each piece of text the glyphs are hidden, the page is photographed, and the
// pixels under the real text lines (not the element's whole box) are read; the ratio is taken against the WORST of them.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/home/index.html"));

// What to measure: every piece of text in the section, by selector.
const TEXT = [
  ["heading", "#showcase-title"],
  ["Chat", ".slide:nth-child(1) h3 a"], ["Chat text", ".slide:nth-child(1) p"],
  ["Image creation", ".slide:nth-child(2) h3 a"], ["Image creation text", ".slide:nth-child(2) p"],
  ["Study", ".slide:nth-child(3) h3 a"], ["Study text", ".slide:nth-child(3) p"],
  ["Diagrams", ".slide:nth-child(4) h3 a"], ["Diagrams text", ".slide:nth-child(4) p"],
  ["Guarantee", ".slide:nth-child(5) h3 a"], ["Guarantee text", ".slide:nth-child(5) p"],
  ["call to action line", ".cta p"],
  ["call to action button", ".cta .btn"],
];

for (const [engine, launch] of ENGINES) describe(`The showcase's text contrast, as painted, in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });

  for (const theme of ["light", "dark"]) for (const [width, height, view] of [[1440, 900, "desktop"], [390, 844, "phone"]]) test(`${theme}, ${view}: every line of text in the showcase is at least 4.5:1 against the pixels behind it`, async (t) => {
    if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return; }
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: theme });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    await page.locator("#showcase-title").waitFor();
    // The colour each piece of text really has, read before anything is hidden.
    const inks = await page.evaluate((list) => Object.fromEntries(list.map(([name, sel]) => [name, getComputedStyle(document.querySelector(sel)).color])), TEXT);
    // Glyphs invisible, everything else as it is: what is left is the ground each word sits on.
    await page.addStyleTag({ content: "#showcase .slide__art{visibility:hidden} #showcase *{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;text-decoration-color:transparent !important}" });
    const results = [];
    for (const [name, selector] of TEXT) {
      await page.evaluate((sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); window.scrollTo({ top: scrollY + r.top - innerHeight / 2, behavior: "instant" }); }, selector);
      await page.waitForTimeout(250);
      const ink = inks[name];
      const png = await page.screenshot();
      const m = await page.evaluate(async ([data, sel, colour]) => {
        const el = document.querySelector(sel);
        const range = document.createRange(); range.selectNodeContents(el);
        const lines = [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
        const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const g = canvas.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = ([r, gr, b]) => 0.2126 * channel(r) + 0.7152 * channel(gr) + 0.0722 * channel(b);
        const parsed = colour.match(/[\d.]+/g).map(Number); const alpha = parsed.length > 3 ? parsed[3] : 1;
        let worst = Infinity; let samples = 0; let at = null;
        for (const r of lines) {
          if (r.bottom < 0 || r.top > innerHeight) continue;
          for (let y = Math.max(0, Math.floor(r.top)); y < Math.min(innerHeight, Math.ceil(r.bottom)); y += 2) for (let x = Math.max(0, Math.floor(r.left)); x < Math.min(innerWidth, Math.ceil(r.right)); x += 3) {
            const bg = [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
            const fg = [0, 1, 2].map((i) => parsed[i] * alpha + bg[i] * (1 - alpha));
            const a = lum(fg); const b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            samples += 1; if (ratio < worst) { worst = ratio; at = { x, y, bg }; }
          }
        }
        return { lines: lines.length, samples, worst, at };
      }, [png.toString("base64"), selector, ink]);
      results.push({ name, ink, ...m });
    }
    await context.close();
    for (const r of results) {
      assert.ok(r.samples > 20, `${r.name}: the text's own pixels were found (${r.samples} samples on ${r.lines} lines)`);
      assert.ok(r.worst >= 4.5, `${r.name}: ${r.worst.toFixed(2)}:1 at the worst pixel (${r.ink} on rgb(${r.at?.bg})), needs 4.5:1`);
    }
    t.diagnostic(`${engine} ${theme} ${view}: lowest ratio ${Math.min(...results.map((r) => r.worst)).toFixed(2)}:1 (${results.reduce((lo, r) => (r.worst < lo.worst ? r : lo)).name}) over ${results.length} pieces of text (${results.reduce((n, r) => n + r.samples, 0)} pixels)`);
  });
});
