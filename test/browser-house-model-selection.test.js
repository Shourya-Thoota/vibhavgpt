import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

function discoverBrowserExecutable() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [];
  if (process.platform === "win32") {
    const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const progFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");

    candidates.push(
      path.join(progFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) return pwPath;
  } catch {
    // ignore
  }

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
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createStaticServer() {
  return http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(distDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    const ext = path.extname(filePath);
    const mime = mimeTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  });
}

// What this suite checks (it was free-nova-selection.test.js, written when Free included Nova; Nova and Nebula were retired on
// 2026-11-14 and the dropdown was replaced by the centered model picker). Free now has one house model, so the switching scenarios run
// on a Pro account choosing between Lumen and Vulcan; Free's own checks are that its locked rows cannot be chosen and that the retired
// tiers are not offered at all.

const USER = { id: "usr_house_selection", name: "Selection Tester", email: "selection@example.test", surveyCompleted: true };
const LIMITS = (tier) => ({ tier, fileBytes: 10485760, imageBytes: 10485760, messageBytes: 20971520 });

// The routes every test needs; `prefs` is the store the preferences endpoint reads and writes.
async function routeApp(page, { tier, prefs, conversations = [] }) {
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: USER } }));
  await page.route("**/api/usage", (route) => route.fulfill({ json: { tier, plan: tier, creditBalance: 0 } }));
  await page.route("**/api/profile/preferences", (route) => {
    if (route.request().method() === "PATCH") Object.assign(prefs, route.request().postDataJSON());
    return route.fulfill({ json: prefs });
  });
  await page.route("**/api/chat/conversations", (route) => route.fulfill({ json: conversations }));
  await page.route("**/api/uploads/limits", (route) => route.fulfill({ json: LIMITS(tier) }));
  await page.route("**/api/connectors", (route) => route.fulfill({ json: { connectors: [] } }));
  await page.route("**/api/skills", (route) => route.fulfill({ json: { skills: [] } }));
}
const triggerName = (page) => page.locator(".model-trigger__name").first().innerText().then((text) => text.trim());
async function waitForTrigger(page, name) {
  await page.waitForFunction((expected) => document.querySelector(".model-trigger__name")?.textContent.trim() === expected, name, { timeout: 5000 });
}
async function choose(page, name) {
  await page.locator(".model-trigger").first().click();
  await page.locator(".model-modal").waitFor({ timeout: 5000 });
  await page.locator(".model-modal__option", { hasText: name }).first().click();
  await page.locator(".model-modal").waitFor({ state: "detached", timeout: 5000 });
}

describe("House model selection in the centered picker", { concurrency: false, timeout: 180000 }, () => {
  let server;
  let serverUrl;
  let browser;

  before(async () => {
    assert.ok(executablePath, "A real system browser or chromium binary must be discoverable.");
    server = createStaticServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("A & B & D: a Pro user chooses Vulcan; the trigger updates, the choice is saved, and the message is sent to Vulcan", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      const prefs = { preferredModel: null, lastUsedModel: null, responseStyle: "balanced", thinkingEffort: "low" };
      let lastChatPayload = null;
      await routeApp(page, { tier: "pro", prefs });
      await page.route("**/api/chat/stream", (route) => {
        lastChatPayload = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: delta\ndata: ${JSON.stringify({ text: "Hello from Vulcan!" })}\n\n` });
      });

      await page.goto(`${serverUrl}/app`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await waitForTrigger(page, "Lumen");

      await choose(page, "Vulcan");
      assert.equal(pageErrors.length, 0, `Page errors encountered during selection: ${pageErrors.join("; ")}`);
      await waitForTrigger(page, "Vulcan");
      assert.equal(prefs.lastUsedModel, "vesper", "the choice is saved as the last-used model");

      await page.fill(".composer__input", "Hello from a Pro account");
      await page.click(".composer__send");
      await page.waitForFunction(() => document.querySelector(".turn, .bubble"), { timeout: 5000 }).catch(() => {});
      assert.ok(lastChatPayload, "Chat request must have been sent");
      assert.equal(lastChatPayload.model, "vesper", "the request names the chosen model");
    } finally {
      await context.close();
    }
  });

  test("C: a reload restores the saved choice", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await routeApp(page, { tier: "pro", prefs: { preferredModel: null, lastUsedModel: "vesper", responseStyle: "balanced", thinkingEffort: "low" } });
      await page.goto(`${serverUrl}/app`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await waitForTrigger(page, "Vulcan");
      assert.equal(await triggerName(page), "Vulcan");
    } finally {
      await context.close();
    }
  });

  test("C2: a saved retired tier opens with no model chosen and a notice, never another tier", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await routeApp(page, { tier: "pro", prefs: { preferredModel: null, lastUsedModel: null, retiredModel: "nova", responseStyle: "balanced", thinkingEffort: "low" } });
      await page.goto(`${serverUrl}/app`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await page.getByText("VibhavGPT Nova has been retired.").first().waitFor({ timeout: 5000 });
      assert.match(await triggerName(page), /Choose (a|an available) model/);
    } finally {
      await context.close();
    }
  });

  test("H: switching in an existing conversation updates the conversation's model and keeps its history", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const convId = "conv-existing-123";
      let conversationModel = "lumen";
      let patchedModel = null;
      await routeApp(page, { tier: "pro", prefs: { preferredModel: null, lastUsedModel: "lumen" }, conversations: [{ id: convId, title: "Existing Chat", model: conversationModel, mode: "chat" }] });
      await page.route(`**/api/chat/conversations/${convId}**`, (route) => {
        if (route.request().method() === "PATCH") {
          patchedModel = route.request().postDataJSON().model;
          conversationModel = patchedModel;
          return route.fulfill({ json: { conversation: { id: convId, title: "Existing Chat", model: conversationModel, mode: "chat" } } });
        }
        return route.fulfill({ json: {
          conversation: { id: convId, title: "Existing Chat", model: conversationModel, mode: "chat" },
          history: [
            { id: "msg-1", role: "user", content: "Previous message in history", createdAt: new Date().toISOString() },
            { id: "msg-2", role: "assistant", content: "Previous answer in history", createdAt: new Date().toISOString() },
          ],
          hasMore: false,
          nextCursor: null,
        } });
      });

      await page.goto(`${serverUrl}/app?conversation=${convId}`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await waitForTrigger(page, "Lumen");
      await choose(page, "Vulcan");
      await waitForTrigger(page, "Vulcan");
      assert.equal(patchedModel, "vesper", "PATCH /api/chat/conversations/:id received model: 'vesper'");
      assert.ok(await page.locator(".turn, .bubble").count() >= 2, "History messages must remain displayed");
    } finally {
      await context.close();
    }
  });

  test("Phone (390px): the model row in the add sheet opens the picker, and the choice is saved", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const prefs = { preferredModel: null, lastUsedModel: null, responseStyle: "balanced", thinkingEffort: "low" };
      await routeApp(page, { tier: "pro", prefs });
      await page.goto(`${serverUrl}/app`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await page.locator('button[aria-label="Add to message"]').first().click();
      await page.locator(".add-sheet__row", { hasText: "Model" }).first().click();
      await page.locator(".model-modal").waitFor({ timeout: 5000 });
      await page.locator(".model-modal__option", { hasText: "Vulcan" }).first().click();
      await page.waitForTimeout(300);
      assert.equal(prefs.lastUsedModel, "vesper", "the phone picker's choice is saved as the last-used model");
    } finally {
      await context.close();
    }
  });

  test("I: Study mode shows no model picker", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await routeApp(page, { tier: "free", prefs: { preferredModel: null, lastUsedModel: "lumen", productMode: "study" } });
      await page.goto(`${serverUrl}/app/study`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      assert.equal(await page.locator(".model-trigger").count(), 0, "Study mode does not render the model picker trigger");
    } finally {
      await context.close();
    }
  });

  test("J: on Free, Vulcan and Zenith are locked and cannot be chosen, and the retired tiers are not offered", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const prefs = { preferredModel: null, lastUsedModel: "lumen" };
      await routeApp(page, { tier: "free", prefs });
      await page.goto(`${serverUrl}/app`);
      await page.waitForSelector(".composer", { timeout: 15000 });
      await page.locator(".model-trigger").first().click();
      await page.locator(".model-modal").waitFor({ timeout: 5000 });
      for (const name of ["Vulcan", "Zenith"]) {
        assert.equal(await page.locator(".model-modal__option", { hasText: name }).first().getAttribute("aria-disabled"), "true", `${name} is locked on Free`);
      }
      const names = await page.locator(".model-modal__option .model-row__name").allInnerTexts();
      assert.equal(names.some((name) => /Nova|Nebula/.test(name)), false, names.join(", "));
      await page.locator(".model-modal__option", { hasText: "Vulcan" }).first().click({ force: true });
      await page.waitForTimeout(300);
      assert.notEqual(prefs.lastUsedModel, "vesper", "a locked row is not saved as the choice");
    } finally {
      await context.close();
    }
  });
});
