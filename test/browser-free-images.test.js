import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// The Image page for a Free account: how many of its 2 weekly images are left, and no reference photo or variation (Free cannot use them).
// The usage numbers are stubbed; nothing here makes an image or reaches a provider.
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

const NEXT_MONDAY = (() => { const d = new Date(); const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); return new Date(day.getTime() + (8 - (day.getUTCDay() || 7)) * 86_400_000).toISOString(); })();

async function open(usage) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => { if (/\/api\/generation\/image$/.test(r.url()) && r.method() === "POST") requests.push(r.postData()); });
  await page.route("**/api/usage", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ monthly: {}, limits: {}, creditBalance: 0, ...usage }) }));
  await page.goto(`${fixture.url}/app/image`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Generate" }).waitFor({ timeout: 20000 });
  return { context, page, requests };
}
const free = (remaining) => ({ tier: "free", imagePeriod: "week", imageLimit: 2, imagesRemaining: remaining, imageGenerationsThisPeriod: 2 - remaining, imagePeriodEndsAt: NEXT_MONDAY });

test("a Free account sees how many of its 2 weekly images are left, and when more arrive", { skip: skipReason }, async () => {
  const { context, page } = await open(free(1));
  const line = page.locator(".studio-allowance");
  await line.waitFor();
  const text = (await line.innerText()).replace(/\s+/g, " ");
  assert.match(text, /^1 of 2 free images left this week\. More arrive Monday at 12:00 AM UTC \(.+\)\.$/);
  assert.equal(await page.getByRole("button", { name: /Reference/ }).isDisabled(), true, "a reference photo is not part of Free");
  await page.getByRole("textbox").first().fill("a lighthouse at dusk");
  assert.equal(await page.getByRole("button", { name: "Generate" }).isEnabled(), true);
  await context.close();
});

test("with none left, the plain message shows and Generate is off", { skip: skipReason }, async () => {
  const { context, page, requests } = await open(free(0));
  const line = page.locator(".studio-allowance");
  await line.waitFor();
  assert.match(await line.innerText(), /^You've used your 2 free images this week\. More arrive Monday at 12:00 AM UTC \(/);
  await page.getByRole("textbox").first().fill("a lighthouse at dusk");
  assert.equal(await page.getByRole("button", { name: "Generate" }).isDisabled(), true);
  assert.deepEqual(requests, [], "nothing is sent");
  await context.close();
});

test("a paid plan sees no weekly line and keeps its reference photo", { skip: skipReason }, async () => {
  const { context, page } = await open({ tier: "plus", imagePeriod: "month", imageLimit: 100, imagesRemaining: 70, imagePeriodEndsAt: NEXT_MONDAY });
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".studio-allowance").count(), 0);
  assert.equal(await page.getByRole("button", { name: /Reference/ }).isEnabled(), true);
  await context.close();
});

test("the Usage page shows Free's weekly images with a reset time, and the paid numbers are the enforced ones", async () => {
  const { usagePayload } = await import("./support/usage-fixture.js");
  const { usageOverviewView } = await import("../frontend/src/usage-overview-view.js");
  const view = (options) => usageOverviewView(usagePayload(options), { locale: "en-US", timeZone: "UTC", now: new Date("2026-11-11T15:00:00.000Z") }).images;
  const free = view({ tier: "free", imagesUsed: 1 });
  assert.equal(free.headline.label, "Images left this week");
  assert.equal(free.headline.value, "1 of 2");
  assert.match(free.renews, /Free accounts get 2 images each week. The next 2 arrive Mon, Nov 16, 12:00 AM UTC/);
  assert.equal(view({ tier: "plus" }).headline.value, "100 of 100");
  assert.equal(view({ tier: "pro" }).headline.value, "400 of 400");
});
