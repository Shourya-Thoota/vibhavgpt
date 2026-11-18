// Builds the image watermark (owner policy, 2026-11-16, superseding the removal in #70): a monochrome black-and-white VibhavGPT mark on a
// transparent background, src/generation/assets/vibhavgpt-watermark.png. It is drawn once here, in a real browser with the app's own
// brand icon and font, so the server never depends on the fonts its machine happens to have; the server only scales and places it.
// Run: node scripts/build-watermark-asset.mjs (needs a Chromium-family browser; see scripts/design-capture.mjs).
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { systemBrowser } from "./design-capture.mjs";

const root = new URL("..", import.meta.url);
const icon = fs.readFileSync(new URL("frontend/public/brand/vibhavgpt-icon-512.png", root)).toString("base64");
const font = fs.readFileSync(new URL("frontend/public/fonts/GoogleSans-latin.woff2", root)).toString("base64");

// White glyphs with a black outline and a soft black edge read on light and dark pictures alike; the icon's layers become black and white.
const html = `<!doctype html><html><head><style>
@font-face { font-family: "Mark"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 400 700; }
html, body { margin: 0; background: transparent; }
#mark { display: inline-flex; align-items: center; gap: 24px; padding: 22px 30px; }
#mark img { width: 128px; height: 128px; filter: grayscale(1) contrast(3.2) brightness(1.1) drop-shadow(0 0 3px #000) drop-shadow(0 0 2px #000) drop-shadow(0 0 1px #000); }
#mark span { font: 600 104px/1 "Mark", sans-serif; letter-spacing: -1px; color: #fff; -webkit-text-stroke: 12px #000; paint-order: stroke fill; text-shadow: 0 0 4px #000, 0 0 8px rgba(0,0,0,.6); }
</style></head><body><div id="mark"><img alt="" src="data:image/png;base64,${icon}"><span>VibhavGPT</span></div></body></html>`;

const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const out = new URL("src/generation/assets/vibhavgpt-watermark.png", root);
fs.mkdirSync(new URL(".", out), { recursive: true });
await page.locator("#mark").screenshot({ path: out.pathname.replace(/^\/([A-Za-z]:)/, "$1"), omitBackground: true });
await browser.close();
console.log("Watermark built: src/generation/assets/vibhavgpt-watermark.png");
