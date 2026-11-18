import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { auditContrast } from "../scripts/contrast-audit.mjs";

// No pure white (#fff) surface anywhere on screen, in either sky, and no font outside the design system's three (the display face, the
// platform's own text face, and the monospace). Surfaces use the off-white tokens; text on them stays at AA or better. Text colour on
// a filled accent button, a QR code's own white ground and a logo's own colours are not surfaces and are not part of this.
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

const PAGES = ["/home/", "/pricing", "/apps", "/sources", "/android", "/vibhavgpt-windows", "/terms", "/app/chat", "/app/study", "/app/extensions", "/app/settings/appearance", "/app/library"];
const ALLOWED_FONTS = new Set(["Google Sans", "-apple-system", "ui-monospace"]);

const whiteSurfaces = () => {
  const white = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return false; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); const a = p.length > 3 ? p[3] : 1; return p[0] >= 253 && p[1] >= 253 && p[2] >= 253 && a >= 0.92; };
  const found = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg, canvas, img, video, picture, .qr, [data-scan-target]")) continue;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (s.display === "none" || s.visibility === "hidden" || r.width < 8 || r.height < 8 || r.width * r.height < 300) continue;
    if (white(s.backgroundColor)) found.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const fonts = {};
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (s.display === "none" || r.width === 0) continue;
    const family = s.fontFamily.split(",")[0].trim().replace(/["']/g, "");
    fonts[family] = (fonts[family] || 0) + 1;
  }
  return { found, fonts };
};

for (const sky of ["light", "dark"]) {
  test(`${sky} sky: no pure white surface and only the design system's fonts, on every page`, { skip: skipReason }, async () => {
    const problems = [];
    for (const route of PAGES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", colorScheme: sky });
      await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-study", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
      const page = await context.newPage();
      await page.goto(`${fixture.url}${route}`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const { found, fonts } = await page.evaluate(`(${whiteSurfaces.toString()})()`);
      for (const item of found) problems.push(`${route}: pure white surface ${item}`);
      for (const family of Object.keys(fonts)) if (!ALLOWED_FONTS.has(family)) problems.push(`${route}: font "${family}" is not in the design system (${fonts[family]} elements)`);
      await context.close();
    }
    assert.deepEqual(problems, []);
  });
}

test("the open surfaces (+ menu, solid material) are not pure white either", { skip: skipReason }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", colorScheme: "light" });
  await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-effects", "solid"); } catch { /* none */ } });
  const page = await context.newPage();
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer__add-trigger").click({ timeout: 20000 });
  await page.waitForTimeout(700);
  const { found } = await page.evaluate(`(${whiteSurfaces.toString()})()`);
  assert.deepEqual(found, [], "with the Solid material and a menu open");
  await context.close();
});

for (const sky of ["light", "dark"]) {
  test(`${sky} sky: text on the surfaces that were pure white is still AA (4.5:1)`, { skip: skipReason }, async () => {
    for (const route of ["/apps", "/sources", "/app/study"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", colorScheme: sky });
      await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-study", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
      const page = await context.newPage();
      await page.goto(`${fixture.url}${route}`, { waitUntil: "load" });
      await page.waitForTimeout(1000);
      const failures = await page.evaluate(`(${auditContrast.toString()})()`);
      const mine = failures.filter((f) => /mode-tabs|app-card|src-row|src-section|start-below/.test(f.selector));
      assert.deepEqual(mine, [], `${sky} ${route}`);
      await context.close();
    }
  });
}

test("the surfaces use the off-white tokens in the stylesheets, not a literal white", () => {
  const read = (file) => fs.readFileSync(path.resolve(file), "utf8");
  // The Chat | Study switcher wears the Chat | Image notch's own treatment (hotfix after Slice 6.1), never a paper or white block.
  assert.match(read("frontend/src/mobile.css"), /--seg-surface: var\(--surface-2\);/);
  assert.doesNotMatch(read("frontend/src/mobile.css"), /--seg-surface: #fff;/);
  assert.equal((read("frontend/src/apps-pages.css").match(/--card-surface: var\(--color-paper-2\);/g) ?? []).length, 2);
  assert.doesNotMatch(read("frontend/src/apps-pages.css"), /--card-surface: white;/);
  assert.match(read("frontend/src/theme/vibhav.css"), /--glass-solid: var\(--color-paper-2\);/);
  assert.doesNotMatch(read("frontend/src/theme/vibhav.css"), /--glass-solid: #ffffff;/);
  assert.match(read("frontend/src/writing-tools.css"), /background: var\(--color-paper-2\);\s*box-shadow: 0 4px 20px/);
  assert.match(read("frontend/src/menus.css"), /\.ui-menu__switch::after \{[^}]*background: var\(--color-paper-2\)/);
  assert.match(read("frontend/src/compact.css"), /--ref-chip: color-mix\(in srgb, var\(--color-paper-2\) 72%, transparent\)/);
  assert.doesNotMatch(read("frontend/src/components/ui/orbit-showcase.tsx"), /Hanken Grotesk',var/, "the showcase uses the body face");
  // The off-white itself is not white.
  const tokens = read("frontend/src/theme/vibhav.css");
  assert.match(tokens, /--color-paper-2: #fffaf4;/);
});
