import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// Sidebar menus in the built app, in three engines: they open toward the workspace (not over the sidebar), stay on screen, take focus,
// close on Escape and on an outside click, return focus to their trigger, and on a phone open as a sheet on screen.
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

for (const [engine, launch] of ENGINES) describe(`Sidebar menus in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function openChat({ width, height }) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    if (width < 600) { await page.getByRole("button", { name: "Open navigation" }).click(); await page.waitForTimeout(500); }
    return { context, page };
  }
  const panel = (page) => page.locator(".ui-menu__panel.account-menu");
  const box = (page, selector) => page.locator(selector).first().boundingBox();

  test("on a desktop the account menu opens toward the workspace, beside the sidebar, and stays on screen", async (t) => {
    if (skip(t)) return;
    for (const [width, height] of [[1440, 900], [1366, 768]]) {
      const { context, page } = await openChat({ width, height });
      await page.locator(".account").first().click();
      await panel(page).waitFor();
      const p = await panel(page).boundingBox();
      const sb = await box(page, ".sidebar");
      const label = `${width}x${height}`;
      assert.ok(p.x >= sb.x + sb.width - 1, `${label}: the menu starts at or past the sidebar's edge (${Math.round(p.x)} vs ${Math.round(sb.x + sb.width)})`);
      assert.ok(p.x + p.width <= width + 0.5 && p.y >= 0 && p.y + p.height <= height + 0.5, `${label}: the menu is on screen`);
      await context.close();
    }
  });

  test("the account menu takes focus when it opens, Escape closes it and returns focus to the account button", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openChat({ width: 1440, height: 900 });
    const trigger = page.locator(".account").first();
    await trigger.click();
    await panel(page).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem"));
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, "focus is back on the account button");
    await context.close();
  });

  test("an outside click closes the menu, and arrow keys walk its rows", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openChat({ width: 1440, height: 900 });
    await page.locator(".account").first().click();
    await panel(page).waitFor();
    // Focus lands on the first row one frame after the panel shows; the arrow keys walk from there.
    await page.waitForFunction(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem"));
    await page.keyboard.press("ArrowDown");
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
    assert.notEqual(first, second, "arrow keys move between rows");
    await page.mouse.click(700, 300);
    await panel(page).waitFor({ state: "detached" });
    await context.close();
  });

  test("on a phone the account menu opens on screen, with its rows reachable", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openChat({ width: 390, height: 844 });
    await page.locator(".account").first().click();
    await panel(page).waitFor();
    const p = await panel(page).boundingBox();
    assert.ok(p.x >= 0 && p.x + p.width <= 390.5, `inside the phone's width (${Math.round(p.x)} to ${Math.round(p.x + p.width)})`);
    assert.ok(p.y >= 0 && p.y + p.height <= 844.5, "inside the phone's height");
    for (const item of await panel(page).locator("[role=menuitem]").all()) assert.ok((await item.boundingBox()).height >= 40, "a 40px-plus row");
    await context.close();
  });
});
