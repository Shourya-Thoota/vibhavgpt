// Phone acceptance in an emulated phone (390x844, touch, CPU slowed 4x). Emulation, not a real device. Owner feedback 2026-11-09: choppy
// interaction, a poor sidebar, pages not optimised for phones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture } from "./support/extensions-fixture.js";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let fixture;
test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  fixture = await startFixture({});
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function phone({ storage = {}, width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await context.addInitScript(([entries]) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    window.__draws = 0;
    for (const name of ["drawArrays", "drawArraysInstanced"]) { const o = WebGL2RenderingContext.prototype[name]; WebGL2RenderingContext.prototype[name] = function (...a) { window.__draws += 1; return o.apply(this, a); }; }
  }, [{ "vibhavgpt-theme": "dark", "vibhavgpt-theme-chosen": "1", ...storage }]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  return { context, page };
}
const drawsOver = (page, ms) => page.evaluate(async (wait) => { const s = window.__draws; await new Promise((r) => setTimeout(r, wait)); return window.__draws - s; }, ms);

test("on a phone the contours stand still by default, so the drawing loop stops; Allow brings movement back", { skip: skipReason }, async () => {
  const still = await phone();
  await still.page.goto(`${fixture.url}/app/chat`, { waitUntil: "load" });
  await still.page.locator(".chat-topography canvas").waitFor({ state: "attached", timeout: 20000 });
  await still.page.waitForTimeout(2500);
  assert.equal(await drawsOver(still.page, 2500), 0, "no frames drawn once still");
  await still.context.close();
  const moving = await phone({ storage: { "vibhavgpt-motion": "full" } });
  await moving.page.goto(`${fixture.url}/app/chat`, { waitUntil: "load" });
  await moving.page.locator(".chat-topography canvas").waitFor({ state: "attached", timeout: 20000 });
  assert.ok((await drawsOver(moving.page, 3000)) > 0, "Allow keeps it moving on a phone");
  await moving.context.close();
});

test("the phone drawer: focus moves in, rows are 44px, Escape closes it and focus returns to the menu button", { skip: skipReason }, async () => {
  const { context, page } = await phone();
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "load" });
  const opener = page.getByRole("button", { name: "Open navigation" });
  await opener.click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector(".sidebar")?.getAttribute("data-open")), "true");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest(".sidebar"))), true, "focus is inside the drawer");
  const small = await page.evaluate(() => [...document.querySelectorAll(".sidebar a, .sidebar button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44 && !el.classList.contains("sidebar__toggle"); }).length);
  assert.equal(small, 0, "every drawer row is at least 44px tall");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector(".sidebar")?.getAttribute("data-open")), "false", "Escape closes it");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open navigation", "focus returns to the menu button");
  await context.close();
});

for (const width of [320, 390, 768]) {
  test(`page families at ${width}px: no sideways page scroll, inputs at 16px or more`, { skip: skipReason }, async () => {
    const { context, page } = await phone({ width, height: width === 768 ? 1024 : 800 });
    for (const route of ["/", "/pricing", "/sources", "/apps", "/sign-in", "/app/chat", "/app/study", "/app/image", "/app/library", "/app/extensions", "/app/settings/appearance", "/app/usage", "/app/plan"]) {
      await page.goto(`${fixture.url}${route}`, { waitUntil: "load" }).catch(() => {});
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => ({
        over: document.documentElement.scrollWidth - innerWidth,
        small: [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select")].filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).length,
      }));
      assert.ok(r.over <= 1, `${route} at ${width}px scrolls sideways by ${r.over}px`);
      assert.equal(r.small, 0, `${route} at ${width}px has an input under 16px (phones zoom in on tap)`);
    }
    await context.close();
  });
}
