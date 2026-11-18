import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// Phone layouts of the changed screens, in the built app, in three engines: the Settings section strip reaches every section by
// swiping (it used to be clipped at 1298px on a 390px screen), the Image controls and the Library search field are touch-sized, and
// the page never scrolls sideways. Light and dark are both measured.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe")].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const PHONE = { width: 390, height: 844 };

for (const [engine, launch] of ENGINES) describe(`Phone layouts in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function open(route, theme = "light") {
    const context = await browser.newContext({ viewport: PHONE, reducedMotion: "reduce" });
    await context.addInitScript((t) => { try { localStorage.setItem("vibhavgpt-theme", t); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    await page.route((url) => url.pathname === "/api/me/location", (r) => json(r, { location: { mode: "off" } }));
    await page.route((url) => url.pathname === "/api/me/preferences", (r) => json(r, { accent: "cerulean" }));
    await page.route((url) => url.pathname === "/api/library", (r) => json(r, { items: [], nextCursor: null }));
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    return { context, page };
  }

  test("the Settings section strip is a swipeable row that reaches its last section, and the page does not scroll sideways", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const { context, page } = await open("/app/settings/account", theme);
      await page.locator("nav.settings-dock").waitFor();
      const m = await page.evaluate(() => {
        const nav = document.querySelector("nav.settings-dock");
        return { navWidth: Math.round(nav.getBoundingClientRect().width), scrollable: nav.scrollWidth > nav.clientWidth + 2, overflowX: document.documentElement.scrollWidth - innerWidth, items: nav.querySelectorAll("a.settings-dock__item").length };
      });
      assert.ok(m.navWidth <= PHONE.width, `${theme}: the strip is ${m.navWidth}px, within the ${PHONE.width}px screen`);
      assert.equal(m.scrollable, true, `${theme}: the strip scrolls sideways to reach the sections past the edge`);
      assert.equal(m.overflowX, 0, `${theme}: no sideways scroll for the page`);
      // Swipe the strip to its end: the last section can then be tapped on screen.
      await page.evaluate(() => { const nav = document.querySelector("nav.settings-dock"); nav.scrollLeft = nav.scrollWidth; });
      await page.waitForTimeout(200);
      const last = await page.locator("nav.settings-dock a.settings-dock__item").last().boundingBox();
      assert.ok(last.x >= 0 && last.x + last.width <= PHONE.width + 0.5, `${theme}: the last section is on screen after swiping (${Math.round(last.x)} to ${Math.round(last.x + last.width)})`);
      await context.close();
    }
  });

  test("the Image controls and the Library search field are touch-sized on a phone, in both themes", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const image = await open("/app/image", theme);
      const shape = await image.page.locator(".studio-segment button").first().boundingBox();
      const reference = await image.page.locator(".studio-plate__reference").boundingBox();
      const ideas = await image.page.locator(".studio-plate__ideas").boundingBox();
      assert.ok(shape.height >= 44, `${theme}: a shape choice is ${Math.round(shape.height)}px tall`);
      assert.ok(reference.height >= 44, `${theme}: Reference is ${Math.round(reference.height)}px tall`);
      assert.ok(ideas.height >= 44, `${theme}: Ideas is ${Math.round(ideas.height)}px tall`);
      assert.equal(await image.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${theme}: Image mode does not scroll sideways`);
      await image.context.close();

      const library = await open("/app/library", theme);
      const search = await library.page.locator(".lib-page__search input").boundingBox();
      assert.ok(search.height >= 39.5, `${theme}: the Library search field is ${Math.round(search.height)}px tall`);
      assert.equal(await library.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${theme}: Library does not scroll sideways`);
      await library.context.close();
    }
  });
});
