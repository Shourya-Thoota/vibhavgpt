// Captures the homepage logo animation from the built site, for review.
//
//   node scripts/design-home-effects.mjs <outDir>
//
// The glass reveal (the hero's logo) as a frame sequence in both themes (a still taken at one instant says little about a
// 3.5 second reveal). Needs a built site (frontend/dist); signed out, no network.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "./design-capture.mjs";

const outDir = path.resolve(process.argv[2] ?? "home-effects");
fs.mkdirSync(outDir, { recursive: true });
const server = serve({ signedIn: false });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });

async function open({ width, height, theme, reducedMotion = "no-preference" }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
  const page = await context.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  return { context, page };
}
const live = (page, kind, state = "live") => page.waitForFunction(([k, st]) => document.querySelector(`[data-home-effect="${k}"]`)?.dataset.homeEffectState === st, [kind, state], { timeout: 20000 });

const frames = [];
for (const theme of ["light", "dark"]) {
  const { context, page } = await open({ width: 1440, height: 900, theme });
  // The reveal starts as soon as the hero mounts, so reload eagerly and sample from the first frame.
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await live(page, "logo-reveal");
  const start = Date.now();
  for (const at of [250, 600, 1000, 1500, 2100, 2800, 3500, 4300]) {
    const wait = at - (Date.now() - start); if (wait > 0) await page.waitForTimeout(wait);
    const clip = await page.evaluate(() => { const r = document.querySelector("[data-home-effect=logo-reveal]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    frames.push({ label: `${theme} +${Date.now() - start}ms`, img: (await page.screenshot({ clip })).toString("base64") });
  }
  await context.close();
}
const sheet = await browser.newPage({ viewport: { width: 1700, height: 900 } });
await sheet.setContent(`<body style="margin:0;background:#666;font:600 13px system-ui;color:#fff"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${frames.map((f) => `<figure style="margin:0"><figcaption style="padding:2px 0 4px">${f.label}</figcaption><img style="width:100%;display:block" src="data:image/png;base64,${f.img}"></figure>`).join("")}</div>`);
await sheet.screenshot({ path: path.join(outDir, "glass-reveal-frames.png"), fullPage: true });
console.log("glass-reveal-frames.png");
await browser.close();
server.close();
