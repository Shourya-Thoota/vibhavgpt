import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { usagePayload } from "./support/usage-fixture.js";

// The Usage screen and the purchase block in a real browser, at 390px, 760px and a desktop width, in both skies. The numbers come from the
// server's own calculations (usage-fixture.js); the payment page is never opened and nothing is charged: checkout is a stub that records
// what the screen asked for.
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
const HISTORY = [
  { id: "cs_2", purchasedAt: "2026-11-02T15:00:00.000Z", creditsGranted: 1250, amountCents: 1250, currency: "usd", status: "paid", receiptUrl: "https://pay.example/r2" },
  { id: "cs_1", purchasedAt: "2026-10-05T15:00:00.000Z", creditsGranted: 500, amountCents: 500, currency: "usd", status: "paid", receiptUrl: null },
];

async function open({ width = 1280, height = 900, sky = "light", payload, history = HISTORY, usageDelay = 0, usageStatus = 200 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US", colorScheme: sky, hasTouch: width < 800, isMobile: width < 500 });
  await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
  const page = await context.newPage();
  const checkouts = [];
  await page.route("**/api/usage", async (route) => {
    if (usageDelay) await new Promise((resolve) => setTimeout(resolve, usageDelay));
    if (usageStatus !== 200) return route.fulfill({ status: usageStatus, contentType: "application/json", body: JSON.stringify({ error: "down" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/api/billing/credit-purchases", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ purchases: history }) }));
  await page.route("**/api/billing/credits/checkout", (route) => { checkouts.push(JSON.parse(route.request().postData() ?? "{}")); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: `${fixture.url}/app/usage?credits=cancelled`, credits: 0, dollars: 0 }) }); });
  await page.goto(`${fixture.url}/app/usage`, { waitUntil: "domcontentloaded" });
  return { context, page, checkouts };
}
const ready = (page) => page.locator("[data-uo-section=chat]").waitFor({ timeout: 20000 });
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const section = (page, id) => page.locator(`[data-uo-section=${id}]`);

// ---- The order, the words, the numbers ------------------------------------------------------------------------------------------------

for (const [width, height] of WIDTHS) {
  test(`${width}px: the sections come in the order a new person asks, with the numbers up front and the detail folded away`, { skip: skipReason }, async () => {
    for (const sky of ["light", "dark"]) {
      const { context, page } = await open({ width, height, sky, payload: usagePayload({ tier: "plus", spentCredits: 3, flex: 1250, imagesUsed: 12, documentsUsed: 6 }) });
      await ready(page);
      assert.match(await text(page.locator(".usage-head__title")), /^Usage\s*Plus plan$/);
      const headings = (await page.locator("main h2").allInnerTexts()).map((t) => t.trim());
      assert.deepEqual(headings, ["Chat & Study", "Images", "Documents", "Image & document credits"], `${sky}: in order`);
      const chat = section(page, "chat");
      assert.equal(await text(chat.locator("[data-uo-value]")), "25 credits");
      assert.match(await text(chat), /AI credits you can use right now/);
      assert.match(await text(chat.locator("[data-uo-row=used]")), /Used this month\s*3 credits/);
      assert.match(await text(chat.locator("[data-uo-row=monthly]")), /Monthly allowance\s*60 credits, released weekly/);
      assert.match(await text(chat.locator("[data-uo-row=next]")), /Next allocation\s*14 credits on \w{3}, Nov 15/);
      assert.match(await text(chat.locator("[data-uo-runout]")), /wait for your next allocation on/);
      assert.equal(await chat.locator("details").evaluate((el) => el.open), false, "details start closed");
      assert.equal(await chat.getByText("Allocation schedule").isVisible(), false, "and the schedule is out of sight");
      await chat.locator("summary").click();
      assert.equal(await chat.getByText("Allocation schedule").isVisible(), true);
      assert.ok(await chat.locator(".uo-schedule li").count() >= 4);
      assert.equal(await text(section(page, "images").locator("[data-uo-value]")), "88 of 100");
      assert.match(await text(section(page, "images").locator("[data-uo-renews]")), /renews on .*Dec 1/);
      assert.equal(await text(section(page, "documents").locator("[data-uo-value]")), "14 of 20");
      assert.match(await text(section(page, "documents").locator("[data-uo-runout]")), /each extra document uses 1 credit/);
      assert.equal(await text(section(page, "extra").locator("[data-uo-value]")), "1,250 credits");
      assert.match(await text(section(page, "extra")), /Previously called Flex Credits\./);
      assert.match(await text(section(page, "extra")), /don't add Chat & Study credits, and they don't expire/);
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: innerWidth }));
      assert.ok(overflow.doc <= overflow.view, `${width}px ${sky}: no sideways scroll (${overflow.doc} vs ${overflow.view})`);
      await context.close();
    }
  });
}

test("Free, Plus, Pro and Max each see their own allowances, and never a number that is not theirs", { skip: skipReason }, async () => {
  const cases = [
    ["free", { imagesUsed: 1 }, { images: "1 of 2", docs: /Document creation is not included on Free/, flex: "can-not-buy" }],
    ["plus", { imagesUsed: 12, documentsUsed: 20 }, { images: "88 of 100", docs: /0 of 20/, flex: "can-buy" }],
    ["pro", { imagesUsed: 0 }, { images: "400 of 400", docs: /Unlimited/, flex: "can-not-buy" }],
    ["max", { imagesUsed: 0 }, { images: "1,500 of 1,500", docs: /Unlimited/, flex: "can-not-buy" }],
  ];
  for (const [tier, options, expected] of cases) {
    const { context, page } = await open({ payload: usagePayload({ tier, ...options }) });
    await ready(page);
    assert.match(await text(page.locator(".usage-head__title")), new RegExp(`${tier[0].toUpperCase()}${tier.slice(1)} plan`));
    assert.equal(await text(section(page, "images").locator("[data-uo-value]")), expected.images, tier);
    assert.match(await text(section(page, "documents")), expected.docs, tier);
    assert.equal(await section(page, "extra").getAttribute("data-uo-state"), expected.flex.replace("can-not-buy", "cannot-buy"), tier);
    await context.close();
  }
  // Free's images are a weekly count and say so.
  const free = await open({ payload: usagePayload({ tier: "free", imagesUsed: 2 }) });
  await ready(free.page);
  assert.match(await text(section(free.page, "images")), /Images left this week\s*0 of 2/);
  assert.match(await text(section(free.page, "images").locator("[data-uo-renews]")), /Free accounts get 2 images each week\./);
  await free.context.close();
});

test("when it has run out the screen says what ran out, when more comes, and what the other balance does not do", { skip: skipReason }, async () => {
  const { context, page } = await open({ payload: usagePayload({ tier: "plus", spentCredits: 30, imagesUsed: 100, documentsUsed: 20 }) });
  await ready(page);
  assert.equal(await text(section(page, "chat").locator("[data-uo-value]")), "None");
  assert.match(await text(section(page, "chat").locator("[data-uo-runout]")), /used all the AI credits released so far this month\. More arrive on/);
  assert.match(await text(section(page, "images").locator("[data-uo-runout]")), /image requests stop until .*Extra images can't be bought\./);
  assert.match(await text(section(page, "documents").locator("[data-uo-runout]")), /With none, documents wait until/);
  await context.close();
});

// ---- Loading and failure: no zeros -------------------------------------------------------------------------------------------------------------

test("while it loads and when it fails, no number is shown that is not known", { skip: skipReason }, async () => {
  const loading = await open({ payload: usagePayload({ tier: "plus" }), usageDelay: 1500 });
  await loading.page.getByText("Loading usage").waitFor();
  assert.equal(await loading.page.locator("[data-uo-section]").count(), 0, "nothing is drawn yet, so no zeros");
  await loading.page.locator("[data-uo-section=chat]").waitFor({ timeout: 10000 });
  await loading.context.close();
  const failed = await open({ payload: {}, usageStatus: 500 });
  await failed.page.getByText("Your usage could not be loaded, so no numbers are shown.").waitFor({ timeout: 20000 });
  assert.equal(await failed.page.locator("[data-uo-value]").count(), 0);
  assert.doesNotMatch(await text(failed.page.locator("main")), /\b0 credits\b|\b0 of\b/);
  await failed.context.close();
  // The purchased balance's own figures are missing: unavailable, not zero.
  const partial = await open({ payload: usagePayload({ tier: "plus", includeOverview: false }) });
  await ready(partial.page);
  for (const id of ["images", "documents", "extra"]) assert.match(await text(section(partial.page, id)), /unavailable right now\./, id);
  await partial.context.close();
});

// ---- Buying ------------------------------------------------------------------------------------------------------------------------------------------

test("buying: nothing is chosen at first, each card says price and units, the preview is exact, and only the button charges", { skip: skipReason }, async () => {
  for (const [width, height] of WIDTHS) {
    const { context, page, checkouts } = await open({ width, height, payload: usagePayload({ tier: "plus", flex: 40 }) });
    await ready(page);
    const extra = section(page, "extra");
    assert.equal(await extra.locator("[role=radio][aria-checked=true]").count(), 0, "no amount is preselected");
    const button = extra.locator(".uo-buy__button");
    assert.equal(await button.isDisabled(), true);
    assert.equal((await button.innerText()).trim(), "Choose an amount");
    assert.match(await text(extra.locator("[data-uo-preview]")), /Choose an amount to see what you get\./);
    const cards = (await extra.locator("[role=radio]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    assert.deepEqual(cards, ["$5 500 credits 500 extra documents", "$10 1,000 credits 1,000 extra documents", "$20 2,000 credits 2,000 extra documents", "$50 5,000 credits 5,000 extra documents"]);
    assert.match(await text(extra), /1 credit pays for 1 extra document\. Images can't be bought beyond your plan's allowance\./);
    // A preset.
    await extra.getByRole("radio", { name: /^\$5 / }).click();
    assert.equal(await extra.getByRole("radio", { name: /^\$5 / }).getAttribute("aria-checked"), "true");
    assert.match(await text(extra.locator("[data-uo-preview]")), /You pay \$5\.00 and get 500 credits\./);
    assert.equal((await button.innerText()).trim(), "Buy 500 credits for $5.00");
    assert.equal(await button.isEnabled(), true);
    assert.deepEqual(checkouts, [], "choosing is not buying");
    // A custom amount replaces the preset.
    await extra.getByLabel("Or enter an amount").fill("12.50");
    assert.equal(await extra.locator("[role=radio][aria-checked=true]").count(), 0);
    assert.match(await text(extra.locator("[data-uo-preview]")), /You pay \$12\.50 and get 1,250 credits\./);
    assert.equal((await button.innerText()).trim(), "Buy 1,250 credits for $12.50");
    // An amount the server would refuse is refused here, in the same words, with the button off.
    await extra.getByLabel("Or enter an amount").fill("0.55");
    assert.match(await text(extra.locator("[data-uo-preview]")), /Enter an amount from \$1 to \$500 in \$0\.10 increments\./);
    assert.equal(await button.isDisabled(), true);
    assert.deepEqual(checkouts, []);
    // Only the button charges, and it sends the dollar amount once.
    await extra.getByLabel("Or enter an amount").fill("12.5");
    await button.click();
    await page.waitForFunction(() => location.search.includes("credits=cancelled") || true);
    assert.deepEqual(checkouts, [{ amount: 12.5 }], `${width}px: one request, for the amount shown`);
    await context.close();
  }
});

test("an account that could not spend a purchase is told why and offered no purchase, but keeps its balance and its history", { skip: skipReason }, async () => {
  for (const tier of ["free", "pro", "max"]) {
    const { context, page, checkouts } = await open({ payload: usagePayload({ tier, flex: 75 }) });
    await ready(page);
    const extra = section(page, "extra");
    assert.equal(await extra.getAttribute("data-uo-state"), "cannot-buy", tier);
    assert.equal(await extra.locator("[role=radio]").count(), 0, `${tier}: no amounts to choose`);
    assert.equal(await extra.locator(".uo-buy__button, form").count(), 0, `${tier}: no buy button`);
    assert.equal(await text(extra.locator("[data-uo-value]")), "75 credits", `${tier}: the balance is still shown`);
    assert.match(await text(extra.locator("[data-uo-ineligible]")), /You keep the 75 credits you already have/);
    assert.ok(await extra.locator("[data-uo-history] li").count() === 2, `${tier}: and the history`);
    if (tier === "free") {
      assert.match(await text(extra.locator("[data-uo-ineligible]")), /Free does not include documents/);
      assert.equal(await extra.getByRole("button", { name: "See Plus and Pro" }).count(), 1, "Free is pointed at the plans");
    } else {
      assert.match(await text(extra.locator("[data-uo-ineligible]")), /unlimited documents/);
      assert.equal(await extra.getByRole("button", { name: /See/ }).count(), 0, `${tier}: nothing to upgrade to`);
    }
    assert.deepEqual(checkouts, []);
    await context.close();
  }
});

test("the history reads as date, amount paid, credits added and status, newest first", { skip: skipReason }, async () => {
  const { context, page } = await open({ payload: usagePayload({ tier: "plus", flex: 1750 }) });
  await ready(page);
  const rows = (await section(page, "extra").locator("[data-uo-history] li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Nov 2, 2026 \$12\.50 1,250 credits added Paid Receipt/);
  assert.match(rows[1], /Oct 5, 2026 \$5\.00 500 credits added Paid$/);
  await context.close();
});

// ---- Layout and access ------------------------------------------------------------------------------------------------------------------------------

for (const [width, height] of WIDTHS) {
  test(`${width}px: controls are 44px, labelled, and focusable in order; nothing overflows`, { skip: skipReason }, async () => {
    const { context, page } = await open({ width, height, payload: usagePayload({ tier: "plus", flex: 40 }) });
    await ready(page);
    await section(page, "chat").locator("summary").click();
    const audit = await page.evaluate(() => {
      const root = document.querySelector("main.usage-page");
      const out = [];
      for (const el of root.querySelectorAll("button, summary, input, [role=radio], a")) {
        if (el.matches("p a, .usage-page__note a")) continue; // links inside a sentence are exempt
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const name = el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30) || el.id;
        if (r.height < 43.5) out.push(`${name}: ${Math.round(r.height)}px tall`);
        if (el.matches("button, input, [role=radio]") && r.width < 43.5) out.push(`${name}: ${Math.round(r.width)}px wide`);
      }
      const wide = [...root.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.left < -0.5); }).map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
      const bars = [...root.querySelectorAll("[role=progressbar]")].map((el) => el.getAttribute("aria-label"));
      return { out, wide, bars, doc: document.documentElement.scrollWidth, view: innerWidth, unnamed: [...root.querySelectorAll("button, input, [role=radiogroup]")].filter((el) => !(el.getAttribute("aria-label") || el.textContent.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)))).map((el) => el.outerHTML.slice(0, 80)) };
    });
    assert.deepEqual(audit.out, [], `${width}px`);
    assert.deepEqual(audit.wide, []);
    assert.ok(audit.doc <= audit.view);
    assert.deepEqual(audit.unnamed, [], "every control has a name");
    assert.ok(audit.bars.every((label) => /\d/.test(label)), `progress bars say their values: ${audit.bars.join(" | ")}`);
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body));
    assert.ok(await page.locator("[role=radiogroup][aria-label='Choose an amount']").count() === 1);
    await context.close();
  });
}

test("the text and the controls are readable in both skies", { skip: skipReason }, async () => {
  const { auditContrast } = await import("../scripts/contrast-audit.mjs");
  for (const sky of ["light", "dark"]) {
    const { context, page } = await open({ sky, payload: usagePayload({ tier: "plus", spentCredits: 3, flex: 40 }) });
    await ready(page);
    await section(page, "extra").getByRole("radio", { name: /^\$10 / }).click();
    const failures = await page.evaluate(`(${auditContrast.toString()})()`);
    const mine = failures.filter((f) => /uo-|usage-page/.test(f.selector));
    assert.deepEqual(mine, [], `${sky}`);
    await context.close();
  }
});

test("the screen uses the design tokens and no new pure white or raw colour", { skip: false }, () => {
  const css = fs.readFileSync(path.resolve("frontend/src/components/usage-overview.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|box-shadow|transition: all/);
  const defined = new Set([...fs.readFileSync(path.resolve("frontend/src/theme/vibhav.css"), "utf8").matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  for (const token of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))) assert.ok(defined.has(token), `${token} exists`);
});
