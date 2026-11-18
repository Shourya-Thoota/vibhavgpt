// Puts a before and an after capture side by side for review.
//
//   node scripts/design-compare.mjs <beforeDir> <afterDir> <outDir> name1 name2 ...
//
// Each name is a capture file without ".png" (for example "home-desktop").
// The pair is rendered as one image, labelled, at the captures' own scale.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const [beforeDir, afterDir, outDir, ...names] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const local = process.env.LOCALAPPDATA ?? "";
const executablePath = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "/usr/bin/google-chrome"].find((candidate) => candidate && fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const data = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
for (const name of names) {
  const before = path.join(beforeDir, `${name}.png`);
  const after = path.join(afterDir, `${name}.png`);
  if (!fs.existsSync(before) || !fs.existsSync(after)) { console.log(`skipped ${name}: missing capture`); continue; }
  await page.setContent(`<style>body{margin:0;display:flex;gap:16px;padding:16px;background:#777;font:600 18px system-ui;color:#fff}figure{margin:0}figcaption{margin-bottom:8px}img{display:block}</style>
    <figure><figcaption>Before (round 3, e7092dd)</figcaption><img src="${data(before)}"></figure>
    <figure><figcaption>After (round 4)</figcaption><img src="${data(after)}"></figure>`);
  await page.waitForLoadState("load");
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  console.log(`compared ${name}`);
}
await browser.close();
