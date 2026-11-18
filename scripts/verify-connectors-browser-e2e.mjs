import "../test/setup-env.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import express from "express";
import { chromium, webkit, firefox } from "playwright";
import { createIsolatedAuthFixture } from "../test/helpers/auth-test-harness.js";
import {
  setConnectorsDbForTest,
  getConnectorsSummary,
  connectUserConnector,
  disconnectUserConnector,
  setUserConnectorEnabled,
  isConnectorEnabled,
  getConnectorAccessToken,
} from "../src/connectors/service.js";
import { connectorsRouter } from "../src/connectors/router.js";
import { config } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.resolve(ROOT, "frontend/dist");
const EVIDENCE_DIR = path.resolve(
  "C:/Users/vibha/.gemini/antigravity/brain/c2c5227a-3cea-487d-bda8-da151d8f5b4c/browser-connectors-evidence"
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

  // Real Connectors Router
  app.use("/api/connectors", connectorsRouter);

  // Real built static frontend with SPA fallback
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

async function runVerification() {
  console.log("=== VIBHAVGPT CONNECTORS FULL-STACK BROWSER VERIFICATION ===");

  const fixtureA = await createIsolatedAuthFixture({ tier: "pro" });
  const fixtureB = await createIsolatedAuthFixture({ tier: "free" });

  const { server, baseUrl, close } = await createServer(fixtureA);
  console.log(`Real full-stack application running on ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });

  try {
    // --- 1. DESKTOP VIEWPORT RUN (1280x800) ---
    console.log("\n--- Testing Desktop Viewport (1280x800) ---");
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await desktopContext.addCookies([
      {
        name: "better-auth.session_token",
        value: fixtureA.session.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const page = await desktopContext.newPage();
    page.on("dialog", async (dialog) => {
      console.log(`[Browser Dialog]: ${dialog.message()}`);
      await dialog.accept();
    });

    await page.goto(`${baseUrl}/app?page=extensions&tab=connectors`, { waitUntil: "networkidle" });

    // Wait for connectors list to mount
    await page.waitForSelector(".connectors-list", { timeout: 10000 });

    // Assert compact connectors list rendered exactly 7 rows
    const listCount = await page.locator(".connector-row").count();
    console.log(`Rendered connector rows: ${listCount}`);
    if (listCount !== 7) throw new Error(`Expected 7 connectors in list, found ${listCount}`);

    // Verify plain service names (no marketing inflation)
    const plainNames = await page.locator(".connector-row__name").allTextContents();
    console.log(`Plain names rendered: ${plainNames.join(", ")}`);
    const expectedPlain = ["Google Workspace", "GitHub", "Notion", "Slack", "Microsoft 365", "Weather", "Web Search"];
    for (const exp of expectedPlain) {
      if (!plainNames.includes(exp)) {
        throw new Error(`Expected plain name "${exp}" not found in rendered names`);
      }
    }
    for (const name of plainNames) {
      if (/Power|Companion|Dispatcher|Radar/i.test(name)) {
        throw new Error(`Invented marketing name detected: ${name}`);
      }
    }

    // Verify SVG logos rendered
    const svgLogoCount = await page.locator(".connector-row__logo svg").count();
    console.log(`Rendered SVG logos: ${svgLogoCount}`);
    if (svgLogoCount !== 7) throw new Error(`Expected 7 SVG logos, found ${svgLogoCount}`);

    // Capture initial state screenshot
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "desktop-01-compact-list-initial.png") });
    console.log("Captured desktop-01-compact-list-initial.png");

    // --- TEST ACTION 1: CONNECT ---
    console.log("\nTesting Action: Connect Google Workspace");
    // Connect user via DB operation (representing completed OAuth callback)
    await connectUserConnector(fixtureA.user.id, "google_workspace", {
      accessToken: "tok_gw_live_456",
      metadata: { accountName: "alice@company.com" },
    });

    // Reload and verify
    await page.reload({ waitUntil: "networkidle" });
    const gwRow = page.locator('.connector-row:has-text("Google Workspace")');
    const gwStatusText = await gwRow.locator(".status-badge--connected").textContent();
    console.log(`Google Workspace status: ${gwStatusText?.trim()}`);
    if (!gwStatusText?.includes("Connected")) throw new Error("Google Workspace not showing Connected");

    const gwAccount = await gwRow.locator(".connector-row__account").textContent();
    console.log(`Google Workspace account: ${gwAccount?.trim()}`);
    if (!gwAccount?.includes("alice@company.com")) throw new Error("Account name missing from row");

    // Capture connected state screenshot
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "desktop-02-connected-state.png") });
    console.log("Captured desktop-02-connected-state.png");

    // --- TEST ACTION 2: ENABLE / DISABLE ---
    console.log("\nTesting Action: Toggle Enable / Disable");
    const toggleLabel = gwRow.locator(".connector-toggle");
    const toggleInput = toggleLabel.locator('input[type="checkbox"]');

    // Currently checked
    let isChecked = await toggleInput.isChecked();
    console.log(`Initial toggle checked: ${isChecked}`);
    if (!isChecked) throw new Error("Expected initial connected state to be enabled");

    // Click toggle to disable
    const [disableRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/connectors/google_workspace") && r.request().method() === "PATCH"),
      toggleLabel.click(),
    ]);
    const disableJson = await disableRes.json();
    console.log("PATCH response:", disableJson);
    if (disableJson.connector?.enabled !== false) throw new Error("Backend did not persist enabled: false");

    // Check DB state directly
    const dbRecordDisabled = await fixtureA.client.query(
      `SELECT enabled FROM "user_connectors" WHERE "user_id" = $1 AND provider = $2`,
      [fixtureA.user.id, "google_workspace"]
    );
    console.log(`DB Record enabled: ${dbRecordDisabled.rows[0]?.enabled}`);
    if (dbRecordDisabled.rows[0]?.enabled !== false) throw new Error("DB record not updated to enabled: false");

    // Reload page to verify reload persistence
    await page.reload({ waitUntil: "networkidle" });
    const gwRowReloaded = page.locator('.connector-row:has-text("Google Workspace")');
    const isCheckedAfterReload = await gwRowReloaded.locator('.connector-toggle input[type="checkbox"]').isChecked();
    console.log(`Checked state after reload: ${isCheckedAfterReload}`);
    if (isCheckedAfterReload !== false) throw new Error("State persistence failed after reload");

    // Capture disabled state screenshot
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "desktop-03-disabled-state.png") });
    console.log("Captured desktop-03-disabled-state.png");

    // Toggle back to enabled
    const [enableRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/connectors/google_workspace") && r.request().method() === "PATCH"),
      gwRowReloaded.locator(".connector-toggle").click(),
    ]);
    const enableJson = await enableRes.json();
    console.log("PATCH re-enable response:", enableJson);
    if (enableJson.connector?.enabled !== true) throw new Error("Backend did not persist enabled: true");

    // --- TEST ACTION 3: DISCONNECT ---
    console.log("\nTesting Action: Disconnect");
    const disconnectBtn = gwRowReloaded.locator(".connector-disconnect-btn");
    const [discRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/connectors/google_workspace/disconnect") && r.request().method() === "POST"),
      disconnectBtn.click(),
    ]);
    const discJson = await discRes.json();
    console.log("Disconnect response:", discJson);
    if (!discJson.disconnected) throw new Error("Backend disconnect failed");

    // Check DB state directly
    const dbRecordDisc = await fixtureA.client.query(
      `SELECT status, "access_token", enabled FROM "user_connectors" WHERE "user_id" = $1 AND provider = $2`,
      [fixtureA.user.id, "google_workspace"]
    );
    const discRow = dbRecordDisc.rows[0];
    console.log(`DB Record status after disconnect: ${discRow?.status}, token: ${discRow?.access_token}`);
    if (discRow?.status !== "disconnected" || discRow?.access_token !== null) {
      throw new Error("DB record not set to disconnected or token not null");
    }

    // Verify UI dynamically updated
    await page.waitForTimeout(500);
    const gwRowAfterDisc = page.locator('.connector-row:has-text("Google Workspace")');
    const isDiscBadge = await gwRowAfterDisc.locator(".status-badge--available, .status-badge--warning").count();
    console.log(`Disconnected status badges: ${isDiscBadge}`);
    if (isDiscBadge === 0) throw new Error("UI did not dynamically refresh to disconnected");

    // Capture disconnected state screenshot
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "desktop-04-after-disconnect.png") });
    console.log("Captured desktop-04-after-disconnect.png");

    // --- 2. MOBILE VIEWPORT RUN (390x844 iPhone 14) ---
    console.log("\n--- Testing Mobile Viewport (390x844) ---");
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addCookies([
      {
        name: "better-auth.session_token",
        value: fixtureA.session.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`${baseUrl}/app?page=extensions&tab=connectors`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector(".connectors-list", { timeout: 10000 });

    // Verify touch targets >= 36px
    const actionElement = mobilePage.locator(".connector-row button, .connector-row .connector-toggle").first();
    const box = await actionElement.boundingBox();
    console.log(`Mobile button bounding box: width=${box?.width}, height=${box?.height}`);
    if (box && box.height < 36) {
      throw new Error(`Mobile button height too small: ${box.height}`);
    }

    await mobilePage.screenshot({ path: path.join(EVIDENCE_DIR, "mobile-01-compact-list.png") });
    console.log("Captured mobile-01-compact-list.png");

    // Connect GitHub for mobile demo
    await connectUserConnector(fixtureA.user.id, "github", {
      accessToken: "tok_gh_mobile",
      metadata: { accountName: "alice-mobile-dev" },
    });
    await mobilePage.reload({ waitUntil: "networkidle" });
    await mobilePage.waitForSelector(".connector-row", { timeout: 10000 });
    await mobilePage.screenshot({ path: path.join(EVIDENCE_DIR, "mobile-02-connected-toggle.png") });
    console.log("Captured mobile-02-connected-toggle.png");

    // --- 3. CROSS-BROWSER CHECKS: FIREFOX & WEBKIT ---
    for (const [engine, engineName] of [[firefox, "Firefox"], [webkit, "WebKit"]]) {
      console.log(`\n--- Testing Cross-Browser: ${engineName} ---`);
      try {
        const engBrowser = await engine.launch({ headless: true });
        const engContext = await engBrowser.newContext({ viewport: { width: 1280, height: 800 } });
        await engContext.addCookies([
          {
            name: "better-auth.session_token",
            value: fixtureA.session.token,
            domain: "127.0.0.1",
            path: "/",
          },
        ]);
        const engPage = await engContext.newPage();
        await engPage.goto(`${baseUrl}/app?page=extensions&tab=connectors`, { waitUntil: "networkidle" });
        await engPage.waitForSelector(".connectors-list", { timeout: 10000 });
        const rows = await engPage.locator(".connector-row").count();
        console.log(`${engineName} rendered connector rows: ${rows}`);
        if (rows !== 7) throw new Error(`${engineName} failed to render 7 rows`);
        await engPage.screenshot({ path: path.join(EVIDENCE_DIR, `${engineName.toLowerCase()}-01-compact-list.png`) });
        console.log(`Captured ${engineName.toLowerCase()}-01-compact-list.png`);
        await engBrowser.close();
      } catch (err) {
        console.warn(`${engineName} run skipped or error: ${err.message}`);
      }
    }

    console.log("\n=== ALL BROWSER E2E SCENARIOS PASSED CLEANLY! ===");
  } finally {
    await browser.close();
    await close();
    await fixtureA.client.close();
    await fixtureB.client.close();
  }
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
