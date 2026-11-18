/**
 * Real-browser check of the AI credits display.
 *
 * The built frontend runs in a real browser against an in-process server that
 * mounts the REAL usage and chat routers over an in-memory database. Nothing
 * here reaches a network, a model, a payment provider or a real account.
 *
 * Needs a built frontend (npm run build --prefix frontend) and a system
 * browser. Screenshots go to CREDITS_SCREENSHOT_DIR when set, else the OS temp
 * directory; they are never written into the repository.
 * Run with: npm run test:browser
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { chromium } from "@playwright/test";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

function discoverBrowserExecutable() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [];
  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    candidates.push(
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Not installed.
  }
  return undefined;
}

// ---- Server side ------------------------------------------------------------------------

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (text, params) => client.query(text, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const schema = await import("../src/db/schema.js");
const { config } = await import("../src/config.js");
const { createUsageRouter } = await import("../src/usage/router.js");
const { chatRouter, chatAbuseGuard } = await import("../src/chat/router.js");
const { calculateUnifiedLedgerDeductionMicros } = await import("../src/models/pricing-engine.js");
const { CREDIT_MICROS, creditsPhrase } = await import("../frontend/src/credits-policy.js");
const { default: express } = await import("express");
config.moderationApiKey = "";

const DAY = 86_400_000;
const current = { userId: null, name: "Tester" };
const unhandledApi = [];
const builtDir = path.resolve("frontend/dist");
// The directory being served. The rollback scenario swaps in a build made with credits wording on.
let distDir = builtDir;
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };

const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (current.userId) req.authSession = { user: { id: current.userId } }; next(); });
app.get("/api/me", (_req, res) => res.json({ user: { id: current.userId, name: current.name, email: "tester@example.com", surveyCompleted: true } }));
app.get("/api/profile/preferences", (_req, res) => res.json({ theme: "light", thinkingEffort: "low", productMode: "chat" }));
app.patch("/api/profile/preferences", (_req, res) => res.json({ ok: true }));
app.get("/api/uploads/limits", (_req, res) => res.json({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }));
app.get("/api/billing/credit-purchases", (_req, res) => res.json({ purchases: [] }));
// Which weekly window an account is in depends on the date, so the scenarios that need a particular
// window pin the usage API's clock (and stamp their seeded spend with it). Others use the real clock.
const clock = { fixed: null };
app.use("/api/usage", createUsageRouter({ now: () => clock.fixed ?? new Date() }));
app.use("/api/chat", chatRouter);
app.use("/api", (req, res) => { unhandledApi.push(`${req.method} ${req.originalUrl}`); res.status(404).json({ error: "not part of this fixture" }); });
app.use((req, res) => {
  let filePath = path.join(distDir, req.path === "/" ? "/index.html" : req.path);
  if (!filePath.startsWith(distDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
  res.type(mimeTypes[path.extname(filePath)] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
});

let counter = 0;
async function seedUser(tier, { daysIntoPeriod = 10, flex = 0 } = {}) {
  const userId = `browser_credits_${++counter}_${tier}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [userId]);
  if (tier !== "free") {
    await db.insert(schema.subscriptions).values({
      userId, tier, status: "active",
      currentPeriodStartedAt: new Date(Date.now() - daysIntoPeriod * DAY),
      currentPeriodEndsAt: new Date(Date.now() + (30 - daysIntoPeriod) * DAY), updatedAt: new Date(),
    });
  }
  if (flex) await db.insert(schema.creditLedger).values({ userId, credits: flex, kind: "stripe_purchase", externalReference: `seed:${userId}` });
  return userId;
}
function debitAtLeast(targetMicros) {
  let raw = Math.max(0, Math.floor(targetMicros / 1.1) - 3);
  while (calculateUnifiedLedgerDeductionMicros(raw) < targetMicros) raw += 1;
  return raw;
}
async function spend(userId, targetMicros, model = "nova") {
  await db.insert(schema.usageEvents).values({ userId, model, costMicros: debitAtLeast(targetMicros), inputTokens: 100, outputTokens: 100, createdAt: clock.fixed ?? new Date() });
}
async function apiCredits(base, userId) {
  current.userId = userId;
  return (await (await fetch(`${base}/api/usage`)).json()).credits;
}
// Credits activate at 00:00 UTC on the 1st of the current month, so there is no partial first week
// and every account is on the same fixed weekly windows (docs/credits-policy.md).
const monthStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
async function withCredits(mode, fn, { fixedAt = null } = {}) {
  const before = { enabled: config.creditsPolicyEnabled, mode: config.creditsCarryMode, at: config.creditsActivatedAt, fixed: clock.fixed };
  config.creditsPolicyEnabled = mode !== null;
  config.creditsCarryMode = mode ?? "";
  config.creditsActivatedAt = mode !== null ? monthStart(fixedAt ?? new Date()) : null;
  clock.fixed = fixedAt;
  try { return await fn(); } finally { config.creditsPolicyEnabled = before.enabled; config.creditsCarryMode = before.mode; config.creditsActivatedAt = before.at; clock.fixed = before.fixed; }
}
// 2026-04-10 12:00 UTC is in the second weekly window (Apr 8 to 15) of a month that began on the 1st:
// one earlier week exists to carry from, whatever day the tests actually run.
const PINNED = { fixedAt: new Date("2026-04-10T12:00:00.000Z") };
const pinned = (mode, fn) => withCredits(mode, fn, PINNED);

// ---- Browser side -------------------------------------------------------------------------

const executablePath = discoverBrowserExecutable();
const shots = process.env.CREDITS_SCREENSHOT_DIR || path.join(os.tmpdir(), "vibhavgpt-credits-screenshots");
let server;
let base;
let browser;

test.before(async () => {
  assert.ok(fs.existsSync(path.join(builtDir, "index.html")), "Build the frontend first: npm run build --prefix frontend");
  assert.ok(executablePath, "A system browser (Chrome, Edge, Brave or Chromium) is required. Set BROWSER_PATH to its executable.");
  fs.mkdirSync(shots, { recursive: true });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openUsage(userId, { viewport = { width: 1280, height: 900 }, shot } = {}) {
  current.userId = userId;
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
  await page.goto(`${base}/app/usage`);
  await page.waitForSelector(".usage-head__title", { timeout: 20_000 });
  await page.waitForSelector("[data-uo-section=chat]", { timeout: 20_000 });
  await page.waitForTimeout(400);
  if (shot) await page.screenshot({ path: path.join(shots, `${shot}.png`), fullPage: true });
  const text = await page.locator("main.usage-page").innerText();
  return { context, page, text, pageErrors };
}

test("credits off: the existing Usage page is shown, unchanged, and says nothing about credits", async () => {
  await withCredits(null, async () => {
    const free = await seedUser("free");
    const { context, text, pageErrors, page } = await openUsage(free, { shot: "usage-credits-off-free" });
    assert.deepEqual(pageErrors, []);
    assert.match(text, /Daily limit/);
    assert.match(text, /Up to 15 AI requests in any 24-hour period/);
    assert.match(text, /\$0\.25 of included model use each UTC calendar month/);
    assert.doesNotMatch(text, /AI credits|Available this week|Allocation schedule/);
    assert.equal(await page.locator("[data-credits-mode]").count(), 0, "no credits section while the policy is off");
    assert.match(text, /Previously called Flex Credits\./, "the purchased balance carries its current name");
    assert.match(text, /don't add Chat & Study credits/);
    await context.close();

    const plus = await seedUser("plus");
    const paid = await openUsage(plus, { shot: "usage-credits-off-plus" });
    assert.match(paid.text, /Current usage/);
    assert.match(paid.text, /Input and output tokens both count/);
    assert.doesNotMatch(paid.text, /AI credits/);
    await paid.context.close();
  });
});

test("expiry: the credits panel shows the week, the month and the reset in the approved words", async () => {
  await pinned("expiry", async () => {
    const userId = await seedUser("plus", { flex: 320 });
    await spend(userId, 6 * CREDIT_MICROS + 20_000); // 6.4 credits this week
    const credits = await apiCredits(base, userId);
    const { context, page, text, pageErrors } = await openUsage(userId, { shot: "usage-credits-expiry-plus" });
    assert.deepEqual(pageErrors, []);
    await page.locator("[data-uo-section=chat] summary").click(); // the accounting detail is behind "View details"
    const panel = await page.locator("[data-uo-section=chat]").innerText();

    assert.match(panel, /AI credits you can use right now/);
    assert.match(panel, /Monthly allowance\s*60 credits, released weekly/);
    assert.match(panel, new RegExp(`Allocated this week\\s*${credits.week.allocationCredits} credits`));
    assert.match(panel, /Used this month\s*6\.4\d* credits/);
    assert.match(panel, /Future allocations this month/);
    assert.match(panel, /Next allocation/, "the next release is still a dated allocation");
    assert.match(panel, /Unused credits expire when the week resets/);
    assert.equal(await page.locator("[data-credits-mode]").getAttribute("data-credits-mode"), "expiry");

    // The screen shows the server's own figure, worded by the shared helper: this week's allocation
    // less the 6.4 credits spent, to the hundredth, rounded down.
    const available = await page.locator("[data-credits-available]").innerText();
    assert.equal(available, creditsPhrase(credits.available.micros, "down"));
    assert.equal(credits.available.micros, credits.week.allocationMicros - credits.week.consumedMicros, "expiry: this week's allocation less this week's spend");

    // The purchased balance is separate, named for what it pays for, and says so.
    const extra = await page.locator("[data-uo-section=extra]").innerText();
    assert.match(extra, /Image & document credits/);
    assert.match(extra, /320 credits/);
    assert.match(extra, /don't add Chat & Study credits/);

    // None of the superseded wording appears anywhere on the page.
    assert.doesNotMatch(text, /\btokens?\b|5-hour|five-hour|24-hour|rolling|\$0\.25|15 AI requests|Daily limit|Current usage/i);
    await context.close();
  });
});

test("carry: earlier weeks' unused credits are shown as carried, and the next event is an allocation", async () => {
  await pinned("carry", async () => {
    const userId = await seedUser("plus");
    await spend(userId, 2 * CREDIT_MICROS);
    const credits = await apiCredits(base, userId);
    const { context, page, text, pageErrors } = await openUsage(userId, { shot: "usage-credits-carry-plus" });
    assert.deepEqual(pageErrors, []);
    await page.locator("[data-uo-section=chat] summary").click();
    const panel = await page.locator("[data-uo-section=chat]").innerText();
    assert.match(panel, /Carried from earlier weeks/);
    assert.match(panel, /Next allocation/);
    assert.doesNotMatch(panel, /Resets on|expire when the week resets/);
    assert.match(panel, /Unused credits carry forward within the month/);
    assert.match(panel, /never available early/);
    assert.equal(await page.locator("[data-credits-mode]").getAttribute("data-credits-mode"), "carry");
    // The balance can exceed this week's allocation under carry.
    assert.ok(credits.available.micros > credits.week.allocationMicros - credits.week.consumedMicros, "carried credits add to this week's");
    assert.doesNotMatch(text, /\btokens?\b|5-hour|rolling/i);
    await context.close();
  });
});

test("exhausted states say what ran out; a balance under one credit is not shown as exhausted", async () => {
  await pinned("expiry", async () => {
    const free = await seedUser("free");
    await spend(free, 2 * CREDIT_MICROS, "lumen"); // well past this week's 1 credit
    const week = await openUsage(free, { shot: "usage-credits-week-exhausted" });
    assert.equal(await week.page.locator("[data-credits-available]").innerText(), "None");
    assert.match(week.text, /You've used this week's AI credits\. They reset on/);
    assert.doesNotMatch(week.text, /used this month's AI credits/);
    assert.equal(await week.page.locator("[data-uo-section=chat]").getAttribute("data-uo-state"), "week-exhausted");
    await week.context.close();
  });
  await pinned("carry", async () => {
    const plus = await seedUser("plus");
    const probe = await apiCredits(base, plus);
    await spend(plus, probe.allocatedToDateMicros - 20_000); // leaves about 0.4 credit
    const sub = await openUsage(plus, { shot: "usage-credits-sub-one-credit" });
    assert.doesNotMatch(sub.text, /None left/);
    const available = await sub.page.locator("[data-credits-available]").innerText();
    assert.match(available, /^0\.\d+ credits$/, `shown as a fraction (got "${available}")`);
    assert.match(sub.text, /Less than one credit is left, and it can still be used/);
    assert.equal(await sub.page.locator("[data-uo-section=chat]").getAttribute("data-uo-state"), "ok");
    await sub.context.close();
  });
});

test("phone width: the credits panel fits with no sideways scroll", async () => {
  await pinned("expiry", async () => {
    const userId = await seedUser("pro", { flex: 5 });
    await spend(userId, 3 * CREDIT_MICROS);
    const { context, page, pageErrors } = await openUsage(userId, { viewport: { width: 390, height: 844 }, shot: "usage-credits-expiry-pro-phone" });
    assert.deepEqual(pageErrors, []);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal scroll (overflow ${overflow}px)`);
    for (const id of ["chat", "images", "documents", "extra"]) {
      const box = await page.locator(`[data-uo-section=${id}]`).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390 + 1, `the ${id} section stays inside the screen`);
    }
    await context.close();
  });
});

test("a chat request refused for credits shows a notice that names what ran out, and the Usage action", async () => {
  await withCredits("expiry", async () => {
    const free = await seedUser("free");
    await spend(free, 2 * CREDIT_MICROS, "lumen");
    current.userId = free;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
    await page.goto(`${base}/app`);
    await page.waitForSelector(".composer__input", { timeout: 20_000 });
    await page.locator(".composer__input").fill("hello");
    await page.locator(".composer__send").click();
    const notice = page.locator(".workspace-notice");
    await notice.waitFor({ timeout: 20_000 });
    const text = await notice.innerText();
    assert.match(text, /This week's AI credits used/);
    assert.match(text, /You've used this week's AI credits\./);
    assert.match(text, /They reset /);
    assert.match(text, /View AI credits/);
    assert.doesNotMatch(text, /5-hour|24-hour|token|rolling|upgrade|plan/i, "not a plan or rate-limit message");
    await page.screenshot({ path: path.join(shots, "chat-credits-week-exhausted-notice.png") });
    assert.deepEqual(pageErrors, []);
    await context.close();
  });
});

// ---- Abuse protection and activation/rollback consistency ----------------------------------

test("a chat request refused for sending too fast shows a rate notice, not an allowance notice", async () => {
  const before = { ...config.chatAbuse };
  Object.assign(config.chatAbuse, { burstMax: 1, burstWindowMs: 60_000, maxConcurrent: 0 });
  chatAbuseGuard.reset();
  try {
    await withCredits("expiry", async () => {
      const plus = await seedUser("plus"); // plenty of credits: this is not about how much they have
      chatAbuseGuard.admit(plus); // one request already in the window
      current.userId = plus;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
      await page.goto(`${base}/app`);
      await page.waitForSelector(".composer__input", { timeout: 20_000 });
      await page.locator(".composer__input").fill("hello");
      await page.locator(".composer__send").click();
      const notice = page.locator(".workspace-notice");
      await notice.waitFor({ timeout: 20_000 });
      const text = await notice.innerText();
      assert.match(text, /Sending too quickly/);
      assert.match(text, /You're sending messages very quickly\. Please wait a moment and try again\./);
      assert.match(text, /Try again/);
      assert.doesNotMatch(text, /credits|allowance|upgrade|plan|View usage|See plans/i, "nothing was used up and no plan would help");
      await page.screenshot({ path: path.join(shots, "chat-rate-limited-notice.png") });
      assert.deepEqual(pageErrors, []);
      await context.close();
    });
  } finally { Object.assign(config.chatAbuse, before); chatAbuseGuard.reset(); }
});

async function pricingText(userId) {
  current.userId = userId;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
  await page.goto(`${base}/pricing`);
  await page.waitForFunction(() => document.documentElement.dataset.creditsServer !== undefined, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  const marks = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  const text = await page.locator("body").innerText();
  return { context, page, text, marks, pageErrors };
}

test("activation before the frontend is rebuilt: a credits-off build follows the server and shows the credits wording", async () => {
  await withCredits("expiry", async () => {
    const userId = await seedUser("plus");
    const { context, text, marks, pageErrors } = await pricingText(userId);
    assert.deepEqual(pageErrors, []);
    assert.equal(marks.creditsCopy, "off", "this build was made with the existing wording");
    assert.equal(marks.creditsServer, "expiry", "the server is enforcing credits");
    assert.equal(marks.creditsShown, "expiry", "the page shows what the server enforces");
    assert.match(text, /AI credits/);
    assert.doesNotMatch(text, /15 AI requests|5-hour|token (?:caps|allowances)/i, "no limit the server no longer applies is advertised");
    await context.close();
  });
});

test("the server turned off while the pages were built for credits: the open page returns to the existing wording", { skip: process.env.CREDITS_PUBLIC_COPY_DIST ? false : "set CREDITS_PUBLIC_COPY_DIST to a frontend build made with VITE_CREDITS_PUBLIC_COPY=expiry" }, async () => {
  const creditsBuild = path.resolve(process.env.CREDITS_PUBLIC_COPY_DIST);
  assert.ok(fs.existsSync(path.join(creditsBuild, "index.html")), "CREDITS_PUBLIC_COPY_DIST must point at a built frontend");
  distDir = creditsBuild;
  try {
    await withCredits(null, async () => { // the rollback: the server enforces the existing limits
      const userId = await seedUser("free");
      const { context, text, marks, pageErrors } = await pricingText(userId);
      assert.deepEqual(pageErrors, []);
      assert.match(marks.creditsCopy, /^(expiry|carry)$/, "the static pages were built for credits");
      assert.equal(marks.creditsServer, "off");
      assert.equal(marks.creditsShown, "off", "the running page follows the server");
      assert.doesNotMatch(text, /AI credits/, "the page does not promise credits the server is not enforcing");
      assert.match(text, /15 AI requests/);
      await context.close();
    });
  } finally { distDir = builtDir; }
});
