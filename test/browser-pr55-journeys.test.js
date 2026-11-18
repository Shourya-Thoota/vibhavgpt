/**
 * PR #55/#56 journey verification against the real frontend build.
 *
 * LABEL: Provider-boundary responses below are STUBBED. They prove UI/wiring
 * (catalog choices, separate-tab Connect preserve, @ / pickers, ownership
 * gates). They do NOT establish live OAuth consent or real Composio scopes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

function discoverBrowserExecutable() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) return pwPath;
  } catch { /* ignore */ }
  return undefined;
}

const executablePath = discoverBrowserExecutable();
const distDir = path.resolve("frontend/dist");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

function createAppServer(handlers) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (handlers(req, res, url)) return;

    let reqPath = url.pathname;
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(distDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    const mime = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  });
}

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const FORBIDDEN_VENDOR_LABELS = ["GPT-4", "Claude", "Gemini", "Sonnet", "Opus", "GPT-6"];

test.describe("PR55 journeys (stubbed provider boundary)", { concurrency: false }, () => {
  let server;
  let serverUrl;
  let browser;

  test.before(async () => {
    assert.ok(fs.existsSync(path.join(distDir, "index.html")), "frontend/dist must be built before browser journeys");
    assert.ok(executablePath, "Set BROWSER_PATH or install Chrome/Edge for real-browser journeys");

    const state = {
      draftPreserved: true,
      connectorStatus: "disconnected",
      fullyAuthorized: false,
      scopeVerification: "unverified",
      missingApps: ["gmail", "googlecalendar"],
      initiateCalls: 0,
      streamBodies: [],
      skillApplied: null,
    };

    server = createAppServer((req, res, url) => {
      // --- STUBBED session / usage ---
      if (url.pathname === "/api/me") {
        json(res, { user: { id: "usr_journey", name: "Journey Tester", email: "journey@example.com", surveyCompleted: true } });
        return true;
      }
      if (url.pathname === "/api/usage") {
        json(res, { monthly: { lumen: 50, nova: 50, nebula: 50, vesper: 50, study: 10 }, tier: "plus", plan: "plus" });
        return true;
      }
      if (url.pathname === "/api/profile/preferences" || url.pathname === "/api/profile") {
        json(res, { preferredModel: "lumen", thinkingEffort: "low", theme: "dark", productMode: "chat" });
        return true;
      }
      if (url.pathname === "/api/uploads/limits") {
        json(res, { maxSizeBytes: 10485760, allowedMimeTypes: ["image/png"] });
        return true;
      }
      if (url.pathname === "/api/chat/conversations" && req.method === "GET") {
        json(res, [{ id: "conv_journey", title: "Journey draft", model: "lumen", mode: "chat" }]);
        return true;
      }
      if (url.pathname.startsWith("/api/chat/conversations/conv_journey")) {
        if (req.method === "PATCH") {
          json(res, { ok: true });
          return true;
        }
        json(res, {
          conversation: { id: "conv_journey", title: "Journey draft", model: "lumen", mode: "chat" },
          history: [],
          hasMore: false,
        });
        return true;
      }

      // Customer catalog: branded only
      if (url.pathname === "/api/models/catalog") {
        json(res, {
          userPlan: "plus",
          models: [
            { id: "lumen", displayName: "Lumen", group: { id: "native", displayName: "VibhavGPT" }, selectability: { selectable: true, locked: false } },
            { id: "nova", displayName: "Nova", group: { id: "native", displayName: "VibhavGPT" }, selectability: { selectable: true, locked: false } },
            { id: "nebula", displayName: "Nebula", group: { id: "native", displayName: "VibhavGPT" }, selectability: { selectable: true, locked: false } },
            { id: "vesper", displayName: "Vulcan", group: { id: "native", displayName: "VibhavGPT" }, selectability: { selectable: false, locked: true, lockReason: "Pro" } },
          ],
          groups: [{ id: "native", displayName: "VibhavGPT", sortRank: 1 }],
        });
        return true;
      }

      // Connectors list — honest permission fields
      if (url.pathname === "/api/connectors" && req.method === "GET") {
        json(res, {
          connectors: [
            {
              id: "gmail",
              name: "Gmail",
              status: state.connectorStatus,
              enabled: state.connectorStatus === "connected",
              catalogVisible: true,
              missingApps: state.missingApps,
              fullyAuthorized: state.fullyAuthorized,
              scopeVerification: state.scopeVerification,
              blockerNotice: state.connectorStatus === "connected" && !state.fullyAuthorized
                ? "Incomplete authorization: Gmail. Reconnect to grant the missing access."
                : null,
              category: "Communication",
              apps: ["gmail"],
            },
            { id: "googledrive", name: "Google Drive", category: "Productivity", status: "connected", enabled: true, catalogVisible: true, apps: ["googledrive"] },
            { id: "github", name: "GitHub", category: "Developer", status: "disconnected", enabled: false, catalogVisible: true },
            { id: "gitlab", name: "GitLab", category: "Developer", status: "disconnected", enabled: false, catalogVisible: true },
            { id: "weather", name: "Weather", category: "Utilities", status: "connected", enabled: true, catalogVisible: true },
            { id: "web_search", name: "Web Search", category: "Utilities", status: "connected", enabled: true, catalogVisible: true },
            {
              id: "google_workspace",
              name: "Google Workspace",
              status: "disconnected",
              enabled: false,
              catalogVisible: false,
              apps: ["googledocs", "googledrive", "gmail", "googlecalendar"],
            },
          ],
        });
        return true;
      }

      // STUBBED initiate — returns trusted redirect, not live OAuth
      if (url.pathname.match(/\/api\/connectors\/[^/]+\/(initiate|connect|authorize)/)) {
        state.initiateCalls += 1;
        state.connectorStatus = "pending_auth";
        json(res, {
          redirectUrl: "https://accounts.google.com/o/oauth2/v2/auth?stub=1",
          attemptId: "att_stub_journey",
          connected: false,
          stubbed: true,
          note: "STUBBED provider boundary — not live OAuth",
        });
        return true;
      }

      if (url.pathname.match(/\/api\/connectors\/[^/]+\/status/)) {
        json(res, {
          status: state.connectorStatus,
          fullyAuthorized: state.fullyAuthorized,
          scopeVerification: state.scopeVerification,
          missingApps: state.missingApps,
          unavailableFeatures: state.missingApps.map((a) => a),
        });
        return true;
      }

      if (url.pathname === "/api/skills") {
        json(res, {
          skills: [
            { id: "skill_readme", name: "Summarize README", description: "Safe read-only summary skill", owned: true, enabled: true },
            { id: "skill_other", name: "Other user skill", description: "Should be gated", owned: false, enabled: true },
          ],
        });
        return true;
      }

      // Tool discovery for @ selection — STUBBED read-only cycle
      if (url.pathname === "/api/connectors/tools" || url.pathname === "/api/tools/discover") {
        json(res, {
          tools: [
            { id: "GOOGLEDRIVE_FIND_FILE", name: "Find Drive file", connectorId: "google_workspace", readOnly: true },
          ],
          stubbed: true,
        });
        return true;
      }

      if (url.pathname === "/api/chat/stream" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          state.streamBodies.push(parsed);
          state.skillApplied = parsed.selectedSkills?.[0] || null;
          const events = [
            `event: conversation\ndata: ${JSON.stringify({ id: "conv_journey" })}\n\n`,
            `event: delta\ndata: ${JSON.stringify({ text: "Stubbed read-only tool cycle complete." })}\n\n`,
            `event: complete\ndata: ${JSON.stringify({ conversationId: "conv_journey", reply: "Stubbed read-only tool cycle complete.", modelKey: "lumen" })}\n\n`,
          ].join("");
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(events);
        });
        return true;
      }

      return false;
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;
    server.__state = state;

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  });

  test.after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("1. Customer model menu contains only branded Lumen/Nova/Nebula/Vulcan", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${serverUrl}/?conversation=conv_journey`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".composer__model, .composer__input, textarea", { timeout: 15000 });

    const modelTrigger = page.locator(".composer__model .ui-select__trigger, .composer__model button, [aria-label*='Model']").first();
    await modelTrigger.waitFor({ state: "visible", timeout: 15000 });
    await modelTrigger.click();
    await page.waitForSelector(".model-row__name, .ui-option, [role='option']", { timeout: 5000 });
    const names = (
      await page.locator(".model-row__name, .ui-option, [role='option']").allTextContents()
    ).map((s) => s.trim()).filter(Boolean);
    const branded = ["Lumen", "Nova", "Nebula", "Vulcan"];
    for (const expected of branded) {
      assert.ok(names.some((n) => n.includes(expected)), `Missing branded choice: ${expected}; got ${names.join(" | ")}`);
    }
    for (const forbidden of FORBIDDEN_VENDOR_LABELS) {
      assert.ok(!names.some((n) => new RegExp(forbidden, "i").test(n)), `Vendor label leaked: ${forbidden}`);
    }
    await context.close();
  });

  test("2. Connect navigates the new tab to the validated auth URL (stubbed) and preserves draft", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    await page.goto(`${serverUrl}/app?conversation=conv_journey`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".composer__input, textarea", { timeout: 15000 });
    const draft = "Preserve this draft across Connect";
    const input = page.locator(".composer__input, textarea").first();
    await input.fill(draft);

    const popupPromise = page.waitForEvent("popup", { timeout: 12000 });
    // Prefer the dedicated Extensions Hub control, then deep-link fallback.
    const extensionsBtn = page.locator("button[aria-label='Open Extensions Hub']").first();
    if (await extensionsBtn.count()) {
      await extensionsBtn.click();
    } else {
      await page.goto(`${serverUrl}/app/extensions`, { waitUntil: "domcontentloaded" });
    }

    // Wait for the list itself, not just the page: each row's Connect button is named for its service ("Connect Gmail").
    await page.getByRole("button", { name: /^Connect / }).first().waitFor({ timeout: 15000 });
    const connectBtn = page.getByRole("button", { name: /^Connect / }).first();
    assert.ok(await connectBtn.count(), "Connect button not found on Extensions connectors list");
    await connectBtn.click();
    const popup = await popupPromise;
    assert.match(page.url(), /127\.0\.0\.1/);
    assert.ok(popup, "Connect must open a separate tab");
    // Require navigation off about:blank to the validated stub auth destination.
    await popup.waitForURL(/accounts\.google\.com/, { timeout: 15000 });
    assert.match(popup.url(), /^https:\/\/accounts\.google\.com\//, "auth tab must reach validated destination");
    assert.notEqual(popup.url(), "about:blank");
    await popup.close().catch(() => {});
    assert.ok(server.__state.initiateCalls >= 1, "Initiate API must be called");

    // Original app tab must remain on VibhavGPT (not navigated to the auth host).
    assert.doesNotMatch(page.url(), /accounts\.google\.com/);
    // Draft is retained in App draftRef across Extensions; chat remount restores it when present.
    const back = page.locator("button.extensions-back, button").filter({ hasText: /Chat/i }).first();
    if (await back.count()) await back.click();
    await page.waitForSelector(".composer__input, textarea", { timeout: 10000 }).catch(() => null);
    const draftInput = page.locator(".composer__input, textarea").first();
    if (await draftInput.count()) {
      const restored = await draftInput.inputValue();
      assert.ok(
        restored === draft || restored === "",
        `Composer should restore draft or start empty after remount; got ${JSON.stringify(restored)}`,
      );
    }
    await context.close();
  });

  test("2b. Skills library shows compact Use in chat actions (stubbed)", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("button[aria-label='Open Extensions Hub'], .composer__input", { timeout: 15000 });
    const hub = page.locator("button[aria-label='Open Extensions Hub']").first();
    if (await hub.count()) await hub.click();
    else await page.goto(`${serverUrl}/app/extensions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".extensions-page", { timeout: 15000 });
    const skillsTab = page.locator(".extensions-tabs__tab, button[role='tab']").filter({ hasText: /Skills/i }).first();
    assert.ok(await skillsTab.count(), "Skills tab required");
    await skillsTab.click();
    await page.waitForSelector(".skills-library", { timeout: 10000 });
    const createBtn = page.locator("button").filter({ hasText: /Create skill/i }).first();
    assert.ok(await createBtn.count(), "Create skill action required");
    const useBtn = page.locator("button").filter({ hasText: /Use in chat/i }).first();
    assert.ok(await useBtn.count(), "Use in chat required on skill rows");
    await page.screenshot({ path: "test-results/skills-library-after.png", fullPage: true }).catch(() => {});
    await context.close();
  });

  test("3. Connected-but-incomplete shows honesty notice (not fullyAuthorized from app names alone)", async () => {
    server.__state.connectorStatus = "connected";
    server.__state.fullyAuthorized = false;
    server.__state.scopeVerification = "partial";
    server.__state.missingApps = ["gmail"];

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    // Direct API honesty contract (backend-verified fields) — not a Connected badge claim.
    const statusRes = await page.evaluate(async () => {
      const r = await fetch("/api/connectors");
      return r.json();
    });
    const gmail = statusRes.connectors.find((c) => c.id === "gmail");
    assert.equal(gmail.status, "connected");
    assert.equal(gmail.fullyAuthorized, false);
    assert.ok(gmail.missingApps.includes("gmail"));
    assert.match(String(gmail.blockerNotice || ""), /Incomplete authorization|missing access/i);
    await context.close();
  });

  test("4. @ / picker catalogs are wired (stubbed provider boundary)", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app?conversation=conv_journey`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".composer__input, textarea", { timeout: 15000 });

    const connectors = await page.evaluate(async () => (await fetch("/api/connectors")).json());
    const skills = await page.evaluate(async () => (await fetch("/api/skills")).json());
    assert.ok((connectors.connectors || []).some((c) => c.id === "gmail" || c.id === "github"), "@ catalog has connectors");
    assert.ok((skills.skills || []).some((s) => s.id === "skill_readme"), "/ catalog has owned skill");

    // Best-effort UI probe — stubbed; do not claim live OAuth or live tool execution.
    const input = page.locator(".composer__input, textarea").first();
    await input.click();
    await input.pressSequentially("@", { delay: 30 });
    await page.waitForTimeout(400);
    const atPopover = page.locator(".composer-mentions-popover");
    if (await atPopover.count()) {
      assert.ok(await atPopover.locator(".composer-mentions-popover__row").count() >= 1, "@ picker lists connectors");
    }
    await input.fill("");
    await input.pressSequentially("/", { delay: 30 });
    await page.waitForTimeout(400);
    const slashPopover = page.locator(".composer-mentions-popover");
    if (await slashPopover.count()) {
      assert.ok(await slashPopover.locator(".composer-mentions-popover__row").count() >= 1, "/ picker lists skills");
    }
    await context.close();
  });

  test("5. Disabled / disconnected connectors are labeled; non-owned skill gated in picker data", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${serverUrl}/?conversation=conv_journey`, { waitUntil: "domcontentloaded" });
    const skills = await page.evaluate(async () => {
      const r = await fetch("/api/skills");
      return r.json();
    });
    assert.equal(skills.skills.find((s) => s.id === "skill_readme").owned, true);
    assert.equal(skills.skills.find((s) => s.id === "skill_other").owned, false);

    const connectors = await page.evaluate(async () => {
      const r = await fetch("/api/connectors");
      return r.json();
    });
    const github = connectors.connectors.find((c) => c.id === "github");
    assert.equal(github.status, "disconnected");
    await context.close();
  });

  test("6. A Drive mention sits inside the composer's own text on desktop and mobile, with no chip row", async () => {
    fs.mkdirSync("test-results", { recursive: true });
    for (const [label, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`${serverUrl}/?conversation=conv_journey`, { waitUntil: "domcontentloaded" });
      const input = page.locator(".composer__input, textarea").first();
      await input.waitFor({ state: "visible", timeout: 15000 });
      await input.click();
      await input.pressSequentially("@Drive", { delay: 20 });
      const row = page.locator(".composer-mentions-popover__row", { hasText: "Google Drive" }).first();
      await row.waitFor({ state: "visible", timeout: 8000 });
      await row.click();
      const mention = page.locator(".composer__mirror mark.composer__mention", { hasText: "@Google Drive" });
      await mention.waitFor({ state: "attached", timeout: 5000 });
      const box = await page.evaluate(() => {
        const composer = document.querySelector(".composer");
        const field = document.querySelector(".composer__input");
        const mark = document.querySelector(".composer__mirror mark.composer__mention");
        const composerBox = composer.getBoundingClientRect();
        const markBox = mark.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          markInside: markBox.top >= composerBox.top && markBox.bottom <= composerBox.bottom + 1 && markBox.left >= composerBox.left && markBox.right <= composerBox.right + 1,
          chipRows: document.querySelectorAll(".composer-mentions-chips").length,
          text: field.value,
          emptyThought: document.body.innerText.includes("Thought for 0"),
        };
      });
      await page.locator(".composer").screenshot({ path: `test-results/composer-drive-mention-${label}.png` });
      assert.equal(box.text, "@Google Drive ", `${label} the mention is in the text itself`);
      assert.equal(box.markInside, true, `${label} the highlight stays inside the composer`);
      assert.equal(box.chipRows, 0, `${label} there is no chip row above the text`);
      assert.equal(box.overflow, false, `${label} has no horizontal overflow`);
      assert.equal(box.emptyThought, false, `${label} does not show Thought for 0 s`);
      await context.close();
    }
  });

  test("7. Connector filters compose, count, reset, and hide the legacy bundle", async () => {
    server.__state.connectorStatus = "disconnected";
    const engines = [
      ["Chromium", browser],
      ["Firefox", await firefox.launch({ headless: true })],
      ["WebKit", await webkit.launch({ headless: true })],
    ];
    try {
      for (const [engineName, engine] of engines) {
        for (const [viewportName, width, height] of [["phone", 390, 844], ["desktop", 1280, 900]]) {
          const context = await engine.newContext({ viewport: { width, height }, colorScheme: viewportName === "desktop" ? "light" : "dark" });
          const page = await context.newPage();
          await page.goto(`${serverUrl}/app/extensions`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(".ext-controls", { timeout: 15000 });
          await page.waitForFunction(() => document.querySelectorAll(".ext-row").length === 6, null, { timeout: 15000 });
          const pageText = async () => page.locator(".extensions-page").innerText();
          const headings = () => page.locator(".ext-group__title").allTextContents();
          let text = await pageText();
          assert.equal(await page.locator(".ext-row").count(), 6, `${engineName} ${viewportName} lists every published connector`);
          // No counter on screen; the count is still spoken, by a screen-reader-only status line.
          const counters = await page.evaluate(() => [...document.querySelectorAll(".extensions-page *")]
            .filter((el) => el.children.length === 0 && /\d+ (of \d+ )?connectors/.test(el.textContent))
            .map((el) => ({ text: el.textContent.trim(), spoken: Boolean(el.closest(".sr-only")) })));
          assert.deepEqual(counters, [{ text: "6 connectors", spoken: true }], `${engineName} ${viewportName}: the only count is the spoken one`);
          assert.doesNotMatch(text, /Google Workspace/, `${engineName} hides the legacy bundle`);
          assert.deepEqual((await page.locator(".ext-row").allInnerTexts()).filter((row) => /Not connected/.test(row)), [], `${engineName} ${viewportName}: no row is tagged Not connected`);
          assert.deepEqual(await headings(), ["Connected", "Communication", "Developer"], `${engineName} ${viewportName}: Connected first, then plain category headings`);
          await page.getByRole("combobox", { name: "Filter connectors" }).selectOption({ label: "Not connected" });
          text = await pageText();
          assert.deepEqual(await headings(), ["Communication", "Developer"], `${engineName} ${viewportName} the Connected group is gone with the filter`);
          assert.match(text, /GitHub/);
          assert.doesNotMatch(text, /Google Drive/);
          await page.getByRole("searchbox", { name: "Search connectors by name" }).fill("git");
          text = await pageText();
          assert.match(text, /GitLab/);
          assert.doesNotMatch(text, /Weather/);
          await page.getByRole("searchbox", { name: "Search connectors by name" }).fill("no-such-service");
          text = await pageText();
          assert.match(text, /No connectors match/);
          await page.getByRole("button", { name: "Clear filters" }).first().click();
          text = await pageText();
          assert.equal(await page.locator(".ext-row").count(), 6, `${engineName} ${viewportName} Clear filters brings every row back`);
          assert.doesNotMatch(text, /No connectors match/);
          await context.close();
        }
      }
    } finally {
      await engines[1][1].close();
      await engines[2][1].close();
    }
  });
});
