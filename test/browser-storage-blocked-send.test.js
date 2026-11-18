// A send whose file cannot be stored (owner report, 2026-11-15), in a real browser against the built app and the shared fixture: the upload
// is refused with storage-limit, so the one storage notice says why, the message and its image go back to the composer, there is no
// "Couldn't reply" banner and no Retry, and nothing reaches the chat endpoint. Needs `npm run build` in frontend/ first.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url));
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8AAAgMBAp0U3XkAAAAASUVORK5CYII=", "base64");
const MESSAGE = "Your 25 MB of file storage is full (uploads and generated images). Delete older files or chats to attach this one. Messages without files still work.";

for (const width of [1280, 390]) {
  test(`${width}px: storage full: one notice, the message and image come back to the composer, no Retry, nothing sent`, { skip }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await context.newPage();
    const streamed = [];
    await page.route("**/api/uploads", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: MESSAGE, code: "storage-limit", access: { reason: "storage", feature: "File uploads", message: MESSAGE, action: "storage", cta: "Manage files" } }) })
      : route.continue());
    page.on("request", (request) => { if (request.url().includes("/api/chat/stream")) streamed.push(request.url()); });
    // The reported case: a Max account on a model that takes images (Zenith).
    await page.route("**/api/profile**", (route) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferredModel: "zenith", lastUsedModel: "zenith", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "", memoryEnabled: true }) }) : route.continue());
    await page.route("**/api/billing/subscription", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ subscription: { tier: "max", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true }) }));
    await page.route("**/api/usage", async (route) => { const response = await route.fetch(); const body = await response.json(); route.fulfill({ response, json: { ...body, tier: "max" } }); });
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    if (await page.locator(".model-trigger").first().isVisible()) {
      await page.locator(".model-trigger").first().click();
      await page.locator(".model-modal__option", { hasText: "Zenith" }).click();
      await page.locator(".model-modal").waitFor({ state: "detached" });
    } else {
      await page.locator(".composer [aria-haspopup]").first().click();
      await page.getByRole("button", { name: /^Model/ }).click();
      await page.locator(".model-modal__option", { hasText: "Zenith" }).click();
      await page.locator(".model-modal").waitFor({ state: "detached" });
    }
    await page.locator('input[type="file"][accept^=".jpg"]').setInputFiles({ name: "plant_cell.jpg", mimeType: "image/png", buffer: PNG });
    const box = page.locator("textarea").first();
    await box.fill("What is in this plant cell?");
    await box.press("Enter");
    await page.locator(".workspace-notice", { hasText: "File storage limit reached" }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator(".workspace-notice").count(), 1, "one notice");
    assert.match(await page.locator(".workspace-notice").innerText(), /storage is full/);
    assert.equal(await page.locator(".chat-banner").count(), 0, "no second 'Couldn't reply' banner");
    assert.equal(await page.getByRole("button", { name: /^(Retry|Try again)$/ }).count(), 0, "no blind Retry");
    assert.equal(await box.inputValue(), "What is in this plant cell?", "the message is back in the composer");
    assert.ok(await page.getByText("plant_cell.jpg").count() > 0, "the image is still attached");
    assert.equal(await page.locator(".turn--user", { hasText: "What is in this plant cell?" }).count(), 0, "no sent bubble for a message that was not sent");
    assert.deepEqual(streamed, [], "nothing reached the chat endpoint");
    await context.close();
  });
}
