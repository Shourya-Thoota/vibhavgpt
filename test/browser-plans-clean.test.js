import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// The public Pricing page, decluttered. It shows first: a title, the Monthly/Yearly choice, and four plain plans (price, purpose, principal
// allowance, one action). Everything longer is behind "Compare all features". Prices and allowances are the canonical ones, so these tests
// assert what the page says against the product facts, not against numbers typed here that could drift.

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

const WIDTHS = [[1280, 900], [760, 900], [390, 844]];
async function open({ width, height, sky = "light" }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, reducedMotion: "reduce", hasTouch: width < 500, isMobile: width < 500 });
  await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(`${fixture.url}/pricing`, { waitUntil: "domcontentloaded" });
  await page.locator("main.pricing .plans .plan").first().waitFor({ timeout: 20000 });
  return { context, page, errors };
}
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

for (const [width, height] of WIDTHS) {
  test(`${width}px: title, period choice, four plain plans, and the comparison closed; no overflow or clipping`, { skip: skipReason }, async () => {
    for (const sky of ["light", "dark"]) {
      const { context, page, errors } = await open({ width, height, sky });
      assert.equal(await page.locator("main.pricing h1").count(), 1);
      assert.match(await text(page.locator("main.pricing h1")), /^Plans$/);
      const plans = page.locator("main.pricing .plans .plan");
      assert.equal(await plans.count(), 4);
      assert.deepEqual((await page.locator("main.pricing .plan__name").allInnerTexts()).map((t) => t.trim()), ["Free", "Plus", "Pro", "Max"]);
      // Each plan: a price, a purpose, a principal allowance, and one action (or a plain statement).
      for (let i = 0; i < 4; i += 1) {
        const plan = plans.nth(i);
        assert.ok(await plan.locator(".plan__price").count(), `plan ${i} has a price`);
        assert.ok((await text(plan.locator(".plan__blurb"))).length > 10, `plan ${i} says what it is for`);
        assert.ok((await text(plan.locator(".plan__allowance"))).length > 10, `plan ${i} states its principal allowance`);
        assert.equal(await plan.locator("button").count() + await plan.locator(".plan__current").count(), 1, `plan ${i} has exactly one action or statement`);
        assert.equal(await plan.locator(".tag").count(), 0, "no Popular or Current chips: one marker at most");
      }
      // The comparison is a closed disclosure.
      const compare = page.locator("main.pricing details.compare");
      assert.equal(await compare.evaluate((el) => el.open), false);
      assert.equal(await compare.locator("summary").innerText(), "Compare all features");
      assert.equal(await compare.locator("table").isVisible(), false, "the long table is out of sight until asked for");
      const facts = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped: [...document.querySelectorAll("main.pricing .plan, main.pricing .plan *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.left < -0.5); }).length }));
      assert.ok(facts.overflow <= 1, `${width}px ${sky}: no sideways scroll (${facts.overflow}px)`);
      assert.equal(facts.clipped, 0, "nothing hangs off the screen");
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
}

test("Compare all features: opens and closes from the keyboard, is a 44px target, and holds the whole table", { skip: skipReason }, async () => {
  const { context, page } = await open({ width: 390, height: 844 });
  const summary = page.locator("main.pricing details.compare > summary");
  const box = await summary.boundingBox();
  assert.ok(box.height >= 43.5, `a touch target (${box.height}px)`);
  await summary.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("main.pricing details.compare").evaluate((el) => el.open), true, "Enter opens it");
  const table = page.locator("main.pricing details.compare table");
  assert.equal(await table.isVisible(), true);
  const groups = (await page.locator("main.pricing .compare__group th").allInnerTexts()).map((t) => t.trim());
  assert.ok(groups.length >= 3, `the comparison is grouped (${groups.join(" | ")})`);
  assert.ok(await page.locator("main.pricing .compare__footnote").count(), "the restrictions footnote is kept");
  await page.keyboard.press("Space");
  assert.equal(await page.locator("main.pricing details.compare").evaluate((el) => el.open), false, "Space closes it");
  await context.close();
});

test("the Monthly and Yearly choice changes the price and shows the annual total, and upgrade actions say Upgrade", { skip: skipReason }, async () => {
  const { context, page } = await open({ width: 1280, height: 900 });
  const priceOf = async (name) => text(page.locator("main.pricing .plan", { has: page.locator(".plan__name", { hasText: new RegExp(`^${name}$`) }) }).locator(".plan__price"));
  const monthly = { plus: await priceOf("Plus"), pro: await priceOf("Pro"), max: await priceOf("Max") };
  assert.match(monthly.plus, /\$4\.99.*per month/);
  assert.match(monthly.pro, /\$12\.99.*per month/);
  assert.match(monthly.max, /\$49\.99.*per month/, "Max is $49.99 a month for new subscriptions (owner-approved)");
  await page.getByRole("radio", { name: "Yearly" }).or(page.getByRole("button", { name: "Yearly" })).first().click();
  const yearly = { plus: await priceOf("Plus"), pro: await priceOf("Pro"), max: await priceOf("Max") };
  assert.match(yearly.plus, /\$49\.99.*per year/, "the annual total is the price shown");
  assert.match(yearly.pro, /\$129\.99.*per year/);
  assert.match(yearly.max, /\$499\.90.*per year/, "and $499.90 a year");
  assert.match(await text(page.locator("main.pricing .plan__equivalent").first()), /About \$\d+\.\d\d a month/, "the monthly equivalent is a smaller second line");
  // Upgrade actions say "Upgrade", never a plan's name; Free states what it is.
  const buttons = (await page.locator("main.pricing .plan button").allInnerTexts()).map((t) => t.trim());
  assert.ok(buttons.length >= 1);
  assert.ok(buttons.every((label) => label === "Upgrade"), `every action says Upgrade: ${buttons.join(", ")}`);
  assert.match(await text(page.locator("main.pricing .plan", { has: page.locator(".plan__name", { hasText: /^Free$/ }) })), /Included with every account/);
  await context.close();
});

test("the Guarantee keeps its approved words, and the page keeps its restrictions and FAQ", { skip: skipReason }, async () => {
  const { context, page } = await open({ width: 1280, height: 900 });
  const body = await text(page.locator("main.pricing"));
  assert.match(body, /We never train on your chats\. We never sell your data\. We never show ads\. Export everything or delete your account whenever you like\./);
  assert.match(body, /Every plan comes with the VibhavGPT Guarantee/);
  await page.locator("main.pricing details.compare > summary").click();
  assert.match(await text(page.locator("main.pricing .compare__footnote")), /\w+(?:\s+\w+){10,}/, "the allowance and restriction footnote is a real sentence, not empty");
  await context.close();
});
