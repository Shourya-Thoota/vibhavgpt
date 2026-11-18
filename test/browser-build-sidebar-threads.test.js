// Build's own sidebar and its Threads background (owner requests, 2026-11-15), in a real browser against the built app and the shared
// fixture. Needs `npm run build` in frontend/ first.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url));
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
let browser;
let noGlBrowser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath, args: GL_ARGS });
  noGlBrowser = await chromium.launch({ headless: true, executablePath, args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"] });
  server = serve({ signedIn: true, emptyLibrary: true, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); await noGlBrowser?.close(); server?.close(); });

const BUILD_ID = "8e4f5061-7283-4d94-aea5-cfb1c2d3e4f5";
const at = (i) => new Date(Date.UTC(2026, 10, 14, 12, 0) - i * 60_000).toISOString();
const LIST = [
  { id: BUILD_ID, title: "Habit tracker build", model: "tecton", mode: "build", groupId: null, temporary: false, createdAt: at(1), updatedAt: at(1) },
  { id: "8e4f5061-7283-4d94-aea5-cfb1c2d3e4f6", title: "Landing page build", model: "tecton", mode: "build", groupId: null, temporary: false, createdAt: at(2), updatedAt: at(2) },
  { id: "8e4f5061-7283-4d94-aea5-cfb1c2d3e4f7", title: "Trip budget chat", model: "lumen", mode: "chat", groupId: null, temporary: false, createdAt: at(3), updatedAt: at(3) },
];

async function open(b, { path = "/app/build", width = 1280, reducedMotion = "no-preference" } = {}) {
  const context = await b.newContext({ viewport: { width, height: 820 }, reducedMotion });
  const page = await context.newPage();
  const searches = [];
  await page.route("**/api/chat/conversations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: LIST }) }));
  await page.route(`**/api/chat/conversations/${BUILD_ID}**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversation: { ...LIST[0] }, history: [], hasMore: false, nextCursor: null }) }));
  await page.route("**/api/chat/search", (route) => { searches.push(JSON.parse(route.request().postData() || "{}")); route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) }); });
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ subscription: { tier: "pro", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true }) }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "pro" } }); });
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  return { context, page, searches };
}
const titles = (page) => page.locator(".sidebar .conversation-item__open span").allInnerTexts();

test("Build has its own sidebar: the VibhavGPT header only, New build, Search builds, the way back, and only builds under Your builds", { skip }, async () => {
  const { context, page, searches } = await open(browser);
  const sidebar = page.locator(".sidebar");
  assert.equal(await sidebar.getAttribute("data-variant"), "build");
  assert.equal(await page.locator(".sidebar").count(), 1, "one sidebar, not two");
  // One header: VibhavGPT. No extra "VibhavGPT Tecton" row under it (owner, 2026-11-15).
  assert.doesNotMatch(await sidebar.innerText(), /VibhavGPT Tecton/);
  assert.equal(await sidebar.locator(".sidebar__build-title").count(), 0);
  await sidebar.getByRole("button", { name: "New build" }).waitFor();
  assert.deepEqual(await titles(page), ["Habit tracker build", "Landing page build"], "builds only");
  assert.match(await sidebar.locator(".conversation-history__head").innerText(), /Your builds/);
  for (const name of ["Chat", "Image"]) assert.equal(await sidebar.getByRole("link", { name }).count(), 1, `back to ${name}`);
  assert.equal(await sidebar.getByRole("link", { name: "Memory" }).count(), 0, "no Chat navigation copied in");
  assert.equal(await sidebar.locator(".library__section").count(), 0, "no projects in Build");
  await sidebar.getByRole("button", { name: /^Search builds/ }).click();
  await page.getByRole("dialog", { name: "Search builds" }).getByRole("combobox").fill("habit");
  await page.waitForTimeout(500);
  assert.equal(searches.at(-1)?.scope, "build", "the search is scoped to builds");
  await page.keyboard.press("Escape");
  await sidebar.getByRole("link", { name: "Chat" }).click();
  await page.waitForFunction(() => location.pathname === "/app/chat");
  await page.locator('.sidebar[data-variant="chat"]').waitFor();
  assert.ok(!(await titles(page)).some((t) => /build/i.test(t)), "Chat's list has no builds");
  await context.close();
});

test("a direct link that opens a build under Chat reopens it in Build, with Build's sidebar", { skip }, async () => {
  const { context, page } = await open(browser, { path: `/app/chat?conversation=${BUILD_ID}` });
  await page.waitForFunction(() => location.pathname === "/app/build");
  await page.locator('.sidebar[data-variant="build"]').waitFor();
  assert.match(page.url(), new RegExp(`conversation=${BUILD_ID}`));
  await context.close();
});

test("Threads: behind Build's column only, never in Chat, one canvas however often Build is opened, and nothing it covers stops working", { skip }, async () => {
  const { context, page } = await open(browser);
  await page.locator(".build-threads canvas").waitFor({ state: "attached" });
  const layer = await page.locator(".build-threads").evaluate((el) => ({ aria: el.getAttribute("aria-hidden"), pointer: getComputedStyle(el).pointerEvents, position: getComputedStyle(el).position, tab: el.querySelector("canvas").tabIndex }));
  assert.deepEqual(layer, { aria: "true", pointer: "none", position: "absolute", tab: -1 });
  const main = await page.locator(".workspace__main").boundingBox();
  const threads = await page.locator(".build-threads").boundingBox();
  assert.deepEqual([Math.round(threads.x), Math.round(threads.width)], [Math.round(main.x), Math.round(main.width)], "it covers Build's column, not the sidebar");
  assert.ok(threads.height > 600, "the full height of the column, not a fixed 600px box");
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("typing works over it");
  assert.equal(await box.inputValue(), "typing works over it");
  const tabs = page.locator(".mode-tabs--notch:visible").first();
  for (let i = 0; i < 4; i += 1) {
    await tabs.getByRole("tab", { name: "Chat" }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".build-threads").count(), 0, "not in Chat");
    await tabs.getByRole("tab", { name: "Build" }).click();
    await page.locator(".build-threads").waitFor({ state: "attached" });
  }
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".build-threads canvas").count(), 1, "one canvas, not one per visit");
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1), true, "no page scrollbar from it");
  await context.close();
});

test("reduced motion holds the threads still; without it they move", { skip }, async () => {
  for (const [reducedMotion, still] of [["reduce", true], ["no-preference", false]]) {
    const { context, page } = await open(browser, { reducedMotion });
    await page.locator(".build-threads canvas").waitFor({ state: "attached" });
    await page.waitForTimeout(800);
    const a = await page.locator(".build-threads").screenshot();
    await page.waitForTimeout(900);
    const b = await page.locator(".build-threads").screenshot();
    assert.equal(a.equals(b), still, reducedMotion);
    await context.close();
  }
});

test("without WebGL, a still picture of the blue threads is shown instead of an empty box", { skip }, async () => {
  const { context, page } = await open(noGlBrowser);
  await page.locator('.build-threads[data-state="still"] svg').waitFor({ state: "attached" });
  assert.equal(await page.locator(".build-threads canvas").count(), 0);
  assert.equal(await page.locator(".build-threads path[stroke], .build-threads g[stroke]").count() > 0, true);
  await context.close();
});

test("Build's composer names Tecton and shows no chat model's thinking level, whatever was chosen in Chat", { skip }, async () => {
  const { context, page } = await open(browser);
  await page.evaluate(() => { localStorage.setItem("vibhavgpt-marketplace-thinking", JSON.stringify({ "gpt-6-luna": "high" })); });
  const box = page.locator("textarea").first();
  await box.waitFor();
  assert.equal(await box.getAttribute("aria-label"), "Message VibhavGPT Tecton");
  assert.equal(await page.locator(".composer__level").count(), 0, "no thinking-level control in Build");
  assert.equal(await page.locator(".model-trigger").count(), 0, "no model picker in Build");
  await context.close();
});
