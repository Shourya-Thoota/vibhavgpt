// Build (owner request, 2026-11-14) in a real browser against the built app and the shared fixture (scripts/design-capture.mjs), whose
// account is on Plus: the top switcher reads Chat | Image | Build, Build says what it is with no vendor name, and on Plus it is gated to
// Pro and up with a way to see plans; nothing is sent. Needs `npm run build` in frontend/ first.
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

test("Chat | Image | Build: Build is the Tecton coding workspace, gated to Pro and up on a Plus account, and nothing is sent", { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const sent = [];
  page.on("request", (request) => { if (request.url().includes("/api/chat/stream")) sent.push(request.url()); });
  await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
  const tabs = page.locator(".mode-tabs--notch").first().getByRole("tab");
  assert.deepEqual((await tabs.allInnerTexts()).map((t) => t.trim()), ["Chat", "Image", "Build"]);
  await page.locator(".mode-tabs--notch").first().getByRole("tab", { name: "Build" }).click();
  await page.waitForFunction(() => location.pathname === "/app/build");
  await page.locator(".opening__title", { hasText: "What are we building?" }).waitFor();
  const lede = await page.locator(".opening__lede").innerText();
  assert.match(lede, /coding model for prototypes, powered by VibhavGPT Tecton/);
  const gate = page.locator(".build-gate");
  assert.match(await gate.innerText(), /Build is included with Pro and Max/);
  assert.equal(await gate.getByRole("button", { name: "See plans" }).count(), 1);
  assert.equal(await page.locator(".model-trigger").count(), 0, "Build has no model picker: it is always Tecton");
  assert.doesNotMatch(await page.locator("body").innerText(), /qwen|cloudflare|openrouter/i, "no vendor name on screen");
  await page.locator("textarea").first().fill("Build me a timer page");
  await page.keyboard.press("Enter");
  await page.getByText("Build with VibhavGPT Tecton is available on Pro or Max.").waitFor();
  assert.deepEqual(sent, [], "nothing was sent");
  const box = await page.locator(".mode-tabs--notch").first().boundingBox();
  assert.ok(Math.abs(box.width - 270) < 4, `three 90px segments (${Math.round(box.width)}px)`);
  await context.close();
});
