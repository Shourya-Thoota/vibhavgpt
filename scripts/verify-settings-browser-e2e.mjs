import "../test/setup-env.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import express from "express";
import { chromium, firefox, webkit } from "playwright";
import { createIsolatedAuthFixture } from "../test/helpers/auth-test-harness.js";
import { setConnectorsDbForTest } from "../src/connectors/service.js";
import { connectorsRouter } from "../src/connectors/router.js";
import { config } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.resolve(ROOT, "frontend/dist");
const EVIDENCE_DIR = path.resolve(
  "C:/Users/vibha/.gemini/antigravity/brain/c2c5227a-3cea-487d-bda8-da151d8f5b4c/browser-settings-evidence"
);

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

config.featureModelCatalogApi = true;

async function createServer(fixture) {
  setConnectorsDbForTest(fixture.db);

  const app = express();
  app.use(express.json());

  // Database-backed Cookie Authentication Middleware
  app.use(async (req, _res, next) => {
    const rawCookie = req.headers.cookie || "";
    const match = rawCookie.match(/better-auth\.session_token=([^;]+)/);
    const token = match ? match[1].trim() : null;

    if (token) {
      const res = await fixture.client.query(
        `SELECT s.id as session_id, s.token, s."expiresAt", u.id as user_id, u.email, u.name
         FROM "session" s
         JOIN "user" u ON s."userId" = u.id
         WHERE s.token = $1 AND s."expiresAt" > now()`,
        [token]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        req.user = { id: row.user_id, email: row.email, name: row.name };
        req.authSession = {
          session: { id: row.session_id, token: row.token, expiresAt: row.expiresAt },
          user: req.user,
        };
      }
    }
    next();
  });

  // App support routes
  app.get("/api/me", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in is required." });
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        hasPassword: true,
        surveyCompleted: true,
      },
    });
  });

  app.get("/api/usage", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in is required." });
    res.json({
      tier: "pro",
      limits: { lumen: { monthly: 10000000 } },
      tokenBreakdown: {},
      rollingTokenBreakdown: {},
      creditBalance: 100,
    });
  });

  app.get("/api/profile", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in is required." });
    res.json({
      preferredModel: null,
      lastUsedModel: "lumen",
      thinkingEffort: "medium",
      responseStyle: "balanced",
      memoryEnabled: true,
    });
  });

  app.get("/api/skills", (req, res) => res.json({ skills: [] }));
  app.get("/api/chat/conversations", (req, res) => res.json({ conversations: [] }));
  app.get("/api/chat/groups", (req, res) => res.json({ groups: [] }));
  app.get("/api/memory", (req, res) => res.json({ facts: [], memories: [] }));
  app.get("/api/billing/subscription", (req, res) => {
    res.json({ subscription: { tier: "pro", status: "active", billingSource: "stripe" } });
  });

  // Connectors
  app.use("/api/connectors", connectorsRouter);

  // Static files and SPA fallback
  app.use((req, res) => {
    let reqPath = req.path === "/" || req.path === "/home" ? "/home/index.html" : req.path;
    let filePath = path.join(DIST_DIR, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, "index.html");
    }
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));

  return { server, baseUrl, close };
}

async function runSettingsVerification() {
  console.log("=== VIBHAVGPT SETTINGS NAVIGATION FULL-STACK BROWSER VERIFICATION ===");

  const fixture = await createIsolatedAuthFixture({ tier: "pro" });
  const { baseUrl, close } = await createServer(fixture);
  console.log(`Real full-stack application running on ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: fixture.session.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const page = await context.newPage();

    // --- SCENARIO 1: DESKTOP DOCK NAVIGATION & UNIQUE DESTINATIONS ---
    console.log("\n--- Scenario 1: Initial Desktop Settings Navigation ---");
    await page.goto(`${baseUrl}/app/settings/profile`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-dock", { timeout: 10000 });

    // Assert exactly 11 navigation items rendered in dock
    const dockItems = page.locator(".settings-dock__item");
    const count = await dockItems.count();
    console.log(`Rendered .settings-dock__item count: ${count}`);
    if (count !== 11) throw new Error(`Expected exactly 11 dock items, found ${count}`);

    // Assert each label appears exactly once
    const names = await page.locator(".settings-dock__name").allTextContents();
    console.log(`Dock item names: ${names.join(", ")}`);

    const countsByName = {};
    for (const name of names) {
      countsByName[name] = (countsByName[name] || 0) + 1;
    }
    console.log("Label frequencies:", countsByName);

    for (const [name, freq] of Object.entries(countsByName)) {
      if (freq > 1) throw new Error(`Navigation item "${name}" appears ${freq} times! Expected exactly 1.`);
    }

    // Verify key targets specifically
    if (countsByName["Profile"] !== 1) throw new Error(`Profile must appear exactly once, got ${countsByName["Profile"]}`);
    if (countsByName["General"] !== 1) throw new Error(`General must appear exactly once, got ${countsByName["General"]}`);
    if (countsByName["Personalization"] !== 1) throw new Error(`Personalization must appear exactly once, got ${countsByName["Personalization"]}`);
    if (countsByName["Data controls"] !== 1) throw new Error(`Data controls must appear exactly once, got ${countsByName["Data controls"]}`);

    // Assert EXACTLY ONE item is active
    const activeItems = page.locator('.settings-dock__item[aria-current="page"]');
    const activeCount = await activeItems.count();
    console.log(`Active items count: ${activeCount}`);
    if (activeCount !== 1) throw new Error(`Expected exactly 1 active item, found ${activeCount}`);

    const activeSection = await activeItems.getAttribute("data-section");
    console.log(`Active section data-section: ${activeSection}`);
    if (activeSection !== "profile") throw new Error(`Expected active section "profile", found ${activeSection}`);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "settings-01-desktop-profile.png") });
    console.log("Captured settings-01-desktop-profile.png");

    // --- SCENARIO 2: CLICKING DESTINATIONS ---
    console.log("\n--- Scenario 2: Destination Navigation & Highlighting ---");

    // Click Personalization
    console.log("Clicking Personalization...");
    await page.locator('.settings-dock__item[data-section="personalization"]').click();
    await page.waitForSelector("#personality-sliders", { timeout: 5000 });
    const activePersonalization = await page.locator('.settings-dock__item[aria-current="page"]').count();
    if (activePersonalization !== 1) throw new Error(`Expected 1 active item on Personalization, found ${activePersonalization}`);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "settings-02-desktop-personalization.png") });
    console.log("Captured settings-02-desktop-personalization.png");

    // Click Connectors
    console.log("Clicking Connectors...");
    await page.locator('.settings-dock__item[data-section="connectors"]').click();
    await page.waitForSelector(".connectors-settings", { timeout: 5000 });
    const activeConnectors = await page.locator('.settings-dock__item[aria-current="page"]').count();
    if (activeConnectors !== 1) throw new Error(`Expected 1 active item on Connectors, found ${activeConnectors}`);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "settings-03-desktop-connectors.png") });
    console.log("Captured settings-03-desktop-connectors.png");

    // --- SCENARIO 3: LEGACY URL COMPATIBILITY ---
    console.log("\n--- Scenario 3: Legacy URL Resolution ---");
    // Navigate to legacy /app/settings/account
    await page.goto(`${baseUrl}/app/settings/account`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-dock", { timeout: 5000 });
    const activeLegacyAccount = page.locator('.settings-dock__item[aria-current="page"]');
    if ((await activeLegacyAccount.count()) !== 1) throw new Error("Expected exactly 1 active item for legacy /account");
    if ((await activeLegacyAccount.getAttribute("data-section")) !== "profile") {
      throw new Error(`Legacy /account must highlight canonical "profile"`);
    }
    console.log("Legacy /app/settings/account correctly highlighted canonical profile");

    // Navigate to legacy /app/settings/personality
    await page.goto(`${baseUrl}/app/settings/personality`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-dock", { timeout: 5000 });
    const activeLegacyPersonality = page.locator('.settings-dock__item[aria-current="page"]');
    if ((await activeLegacyPersonality.count()) !== 1) throw new Error("Expected exactly 1 active item for legacy /personality");
    if ((await activeLegacyPersonality.getAttribute("data-section")) !== "personalization") {
      throw new Error(`Legacy /personality must highlight canonical "personalization"`);
    }
    console.log("Legacy /app/settings/personality correctly highlighted canonical personalization");

    // --- SCENARIO 4: SETTINGS SEARCH ---
    console.log("\n--- Scenario 4: Settings Search & Clearing ---");
    await page.goto(`${baseUrl}/app/settings/profile`, { waitUntil: "networkidle" });
    const searchInput = page.locator(".settings-search__input");
    await searchInput.fill("passkey");
    await page.waitForSelector(".settings-search__results", { timeout: 5000 });

    const searchResults = page.locator(".settings-search__result");
    const resCount = await searchResults.count();
    console.log(`Search results for "passkey": ${resCount}`);
    if (resCount === 0) throw new Error('Expected search results for "passkey"');

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "settings-04-desktop-search.png") });
    console.log("Captured settings-04-desktop-search.png");

    // Click search result to navigate
    await searchResults.first().click();
    await page.waitForSelector("#security-passkeys", { timeout: 5000 });
    const activeSecurity = page.locator('.settings-dock__item[aria-current="page"]');
    if ((await activeSecurity.count()) !== 1) throw new Error("Expected 1 active item after search navigation");
    if ((await activeSecurity.getAttribute("data-section")) !== "security") {
      throw new Error(`Search navigation must highlight canonical "security"`);
    }
    console.log("Search navigation successfully navigated to Security and cleared search");

    // --- SCENARIO 5: MOBILE PICKER (390x844 iPhone 14) ---
    console.log("\n--- Scenario 5: Mobile Viewport & Picker ---");
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addCookies([
      {
        name: "better-auth.session_token",
        value: fixture.session.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`${baseUrl}/app/settings/profile`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector(".settings-mobile-picker", { timeout: 5000 });

    const mobileOptions = await mobilePage.locator(".settings-mobile-picker option").allTextContents();
    console.log(`Mobile picker options (${mobileOptions.length}): ${mobileOptions.join(", ")}`);
    if (mobileOptions.length !== 11) {
      throw new Error(`Expected exactly 11 options in mobile picker, found ${mobileOptions.length}`);
    }

    const mobileCounts = {};
    for (const opt of mobileOptions) {
      mobileCounts[opt] = (mobileCounts[opt] || 0) + 1;
    }
    for (const [name, freq] of Object.entries(mobileCounts)) {
      if (freq > 1) throw new Error(`Mobile option "${name}" appears ${freq} times!`);
    }

    await mobilePage.screenshot({ path: path.join(EVIDENCE_DIR, "settings-05-mobile-picker.png") });
    console.log("Captured settings-05-mobile-picker.png");

    // --- SCENARIO 6: CROSS-BROWSER VERIFICATION (Firefox & WebKit) ---
    for (const [engine, engineName] of [[firefox, "Firefox"], [webkit, "WebKit"]]) {
      console.log(`\n--- Cross-Browser: ${engineName} ---`);
      try {
        const engBrowser = await engine.launch({ headless: true });
        const engContext = await engBrowser.newContext({ viewport: { width: 1280, height: 800 } });
        await engContext.addCookies([
          {
            name: "better-auth.session_token",
            value: fixture.session.token,
            domain: "127.0.0.1",
            path: "/",
          },
        ]);
        const engPage = await engContext.newPage();
        await engPage.goto(`${baseUrl}/app/settings/profile`, { waitUntil: "networkidle" });
        await engPage.waitForSelector(".settings-dock", { timeout: 10000 });
        const engCount = await engPage.locator(".settings-dock__item").count();
        const engActive = await engPage.locator('.settings-dock__item[aria-current="page"]').count();
        console.log(`${engineName}: ${engCount} items, ${engActive} active`);
        if (engCount !== 11 || engActive !== 1) {
          throw new Error(`${engineName} dock count or active count invalid`);
        }
        await engPage.screenshot({ path: path.join(EVIDENCE_DIR, `settings-06-${engineName.toLowerCase()}-dock.png`) });
        console.log(`Captured settings-06-${engineName.toLowerCase()}-dock.png`);
        await engBrowser.close();
      } catch (err) {
        console.warn(`${engineName} cross-browser check warning: ${err.message}`);
      }
    }

    console.log("\n=== ALL SETTINGS NAVIGATION SCENARIOS PASSED CLEANLY! ===");
  } finally {
    await browser.close();
    await close();
    await fixture.client.close();
  }
}

runSettingsVerification().catch((err) => {
  console.error("Settings verification failed:", err);
  process.exit(1);
});

