import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// Image mode, in the built app, in three engines: a saved avatar is offered in the Reference menu, choosing it shows as the reference,
// and the image request carries referenceAvatarId (by id, never the file) and no attachment reference. The avatar list and its image
// are stubbed at the browser, so no paid image call is made; the generation request itself is answered with a stub error.
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
const AVATAR_ID = "5b1e2c3d-4f60-4a71-8b92-0c1d2e3f4a5b";
const AVATAR = { id: AVATAR_ID, name: "Summer portrait", imageUrl: `/api/avatars/${AVATAR_ID}/image`, createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z" };
// A 1x1 PNG: enough for the browser to draw the thumbnail without shipping a photograph in the repo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

for (const [engine, launch] of ENGINES) describe(`Image-mode saved avatars in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  // Opens Image mode with one saved avatar, and records every image request body sent from the page.
  async function openImageMode({ width = 1440, height = 900, avatars = [AVATAR] } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} });
    const page = await context.newPage();
    const requests = [];
    await page.route((url) => url.pathname === "/api/avatars", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ avatars, limit: 10 }) }));
    await page.route((url) => url.pathname.startsWith("/api/avatars/") && url.pathname.endsWith("/image"), (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.route((url) => url.pathname === "/api/generation/image", (route) => {
      requests.push(route.request().postDataJSON());
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Stubbed by the browser test: no image is made." }) });
    });
    await page.goto(`${base}/app/image`, { waitUntil: "networkidle" });
    await page.getByRole("form", { name: "Create an image" }).waitFor();
    return { context, page, requests };
  }

  test("a saved avatar is offered in the Reference menu and, once chosen, is the reference of the next image", async (t) => {
    if (skip(t)) return;
    const { context, page, requests } = await openImageMode();
    await page.locator(".studio-plate__reference").click();
    const item = page.getByRole("menuitemradio", { name: "Summer portrait" });
    await item.waitFor();
    await item.click();
    const pressed = await page.locator(".studio-plate__reference").getAttribute("aria-pressed");
    assert.equal(pressed, "true", "the Reference button shows that a reference is set");
    assert.equal(await page.locator(".studio-plate__reference").textContent().then((text) => text.trim()), "Change reference");
    await page.getByPlaceholder("Describe what you want to see").fill("a lighthouse at dusk");
    await page.locator(".studio-plate__create").click();
    for (let i = 0; i < 50 && requests.length === 0; i += 1) await page.waitForTimeout(100);
    assert.equal(requests.length, 1, "one image request was sent");
    const body = requests[0];
    assert.equal(body.referenceAvatarId, AVATAR_ID, "the request names the saved avatar by id");
    assert.equal(body.referenceAttachmentId, undefined, "no attachment reference is sent alongside it");
    assert.equal(body.prompt, "a lighthouse at dusk");
    await context.close();
  });

  test("the chosen avatar shows as a chip, and removing it means the next image has no reference", async (t) => {
    if (skip(t)) return;
    const { context, page, requests } = await openImageMode();
    await page.locator(".studio-plate__reference").click();
    await page.getByRole("menuitemradio", { name: "Summer portrait" }).click();
    const chip = page.locator(".studio-reference");
    await chip.waitFor();
    assert.equal((await chip.locator("strong").textContent()).trim(), "Saved avatar");
    assert.equal((await chip.locator("small").textContent()).trim(), "Summer portrait");
    await chip.getByRole("button", { name: "Remove reference image" }).click();
    await chip.waitFor({ state: "detached" });
    assert.equal(await page.locator(".studio-plate__reference").getAttribute("aria-pressed"), "false", "the Reference button no longer shows a reference");
    await page.getByPlaceholder("Describe what you want to see").fill("a lighthouse at dusk");
    await page.locator(".studio-plate__create").click();
    for (let i = 0; i < 50 && requests.length === 0; i += 1) await page.waitForTimeout(100);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].referenceAvatarId, undefined, "the removed avatar is not sent");
    assert.equal(requests[0].referenceAttachmentId, undefined);
    await context.close();
  });

  test("no auto-attach: with saved avatars, nothing is chosen until the person chooses it", async (t) => {
    if (skip(t)) return;
    const { context, page, requests } = await openImageMode();
    assert.equal(await page.locator(".studio-reference").count(), 0, "no chip on arrival");
    assert.notEqual(await page.locator(".studio-plate__reference").getAttribute("aria-pressed"), "true");
    await page.getByPlaceholder("Describe what you want to see").fill("a lighthouse at dusk");
    await page.locator(".studio-plate__create").click();
    for (let i = 0; i < 50 && requests.length === 0; i += 1) await page.waitForTimeout(100);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].referenceAvatarId, undefined, "no avatar was attached on the person's behalf");
    await context.close();
  });

  test("with no saved avatars the Reference menu says where to add them and offers no empty choice", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openImageMode({ avatars: [] });
    await page.locator(".studio-plate__reference").click();
    await page.getByRole("menu", { name: "Reference image" }).waitFor();
    assert.equal(await page.getByRole("menuitemradio", { name: "Summer portrait" }).count(), 0, "no avatar row appears");
    assert.equal(await page.getByText("No saved avatars yet. Add some in Settings.").count(), 1, "the menu says where to add one");
    await context.close();
  });

  test("on a phone the Reference menu opens on screen and its avatar rows are touch-sized", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openImageMode({ width: 390, height: 844 });
    await page.locator(".studio-plate__reference").click();
    const menu = page.getByRole("menu", { name: "Reference image" });
    await menu.waitFor();
    await page.waitForTimeout(350);
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390.5, `inside the phone's width (${Math.round(box.x)} to ${Math.round(box.x + box.width)})`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844.5, "inside the phone's height");
    const row = await page.getByRole("menuitemradio", { name: "Summer portrait" }).boundingBox();
    assert.ok(row.height >= 44, `an avatar row of ${Math.round(row.height)}px is a touch target`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(overflow, 0, "no sideways scroll");
    await context.close();
  });
});
