// One footer (owner request, 2026-11-15): Settings and Usage show the homepage's footer, the same markup the public pages carry, once,
// with nothing overflowing at phone width, in both themes. Checked in a real browser against the built site (frontend/dist) and the
// design fixture's synthetic API. Emulated Chromium, not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture, sampleSkills } from "./support/extensions-fixture.js";
import { siteFooterInner } from "../frontend/src/site-footer.js";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let fixture;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: exe });
  fixture = await startFixture({ skills: sampleSkills() });
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open(route, { width, sky }) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, colorScheme: sky, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", "reduce"); }, sky);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(`${fixture.url}${route}`, { waitUntil: "networkidle" });
  return { context, page, errors };
}

// The markup as the browser serialises it, so the comparison is about content, not attribute quoting.
const normalise = (page, html) => page.evaluate((h) => { const t = document.createElement("template"); t.innerHTML = h; return t.innerHTML; }, html);

for (const route of ["/app/settings/account", "/app/settings/general", "/app/usage"]) {
  for (const [width, sky] of [[1280, "light"], [390, "dark"], [320, "light"]]) {
    test(`${route} at ${width}px (${sky}): exactly one footer, and it is the homepage's`, { skip }, async () => {
      const { context, page, errors } = await open(route, { width, sky });
      const footers = page.locator("footer");
      assert.equal(await footers.count(), 1, "one footer");
      const footer = footers.first();
      assert.equal(await footer.evaluate((el) => el.classList.contains("site-footer")), true, "the shared site footer");
      assert.equal(await page.locator(".settings__footer, .settings__legal, .settings__attribution, nav.social-links").count(), 0, "no second, Settings-only footer");
      assert.equal(await footer.evaluate((el) => el.innerHTML), await normalise(page, siteFooterInner()), "the same markup the homepage carries");
      assert.equal(await page.getByText("Made by Vibhav Thoota", { exact: true }).count(), 1, "the credit appears once");
      // It sits after the page's content, inside the column, and nothing spills sideways.
      const fits = await page.evaluate(() => {
        const f = document.querySelector("footer").getBoundingClientRect();
        return { inside: f.left >= -1 && f.right <= document.documentElement.clientWidth + 1, noScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 };
      });
      assert.ok(fits.inside, "the footer stays inside the viewport");
      assert.ok(fits.noScroll, "no horizontal scroll");
      for (const target of await footer.locator("a").all()) assert.ok((await target.boundingBox()).height >= 44, "every footer link is a 44px target");
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
}
