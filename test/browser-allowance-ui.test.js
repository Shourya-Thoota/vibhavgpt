import test, { describe, before, after, beforeEach } from "node:test";
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
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) return pwPath;
  } catch {
    // Ignore error if not installed
  }
  return undefined;
}

const distDir = path.resolve("frontend/dist");
const screenshotDir = process.env.ALLOWANCE_SCREENSHOT_DIR ? path.resolve(process.env.ALLOWANCE_SCREENSHOT_DIR) : null;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const LUMEN = { id: "vibhavgpt-lumen", modelKey: "lumen", displayName: "VibhavGPT Lumen", description: "Lightweight, simple tasks included on all accounts.", available: true, unavailableReason: null };

function subscriptionSummary(plan, { included, confirmed = "$0.00", pending = "$0.00", available, includedMicros, confirmedMicros = 0, pendingMicros = 0, availableMicros, resetAt = "2026-11-15T00:00:00.000Z", annual = false, restricted = null, freeChoices = [LUMEN] }) {
  return {
    plan,
    allowance: {
      currency: "USD",
      includedMicros,
      confirmedMicros,
      pendingMicros,
      availableMicros,
      display: { included, confirmed, pending, available },
      periodStartedAt: "2026-10-15T00:00:00.000Z",
      resetAt,
      resetCadence: "monthly",
      billingTermExtendsBeyondReset: annual,
    },
    paidUsage: { restricted: Boolean(restricted), reason: restricted },
    freeChoices,
    enforcementConnected: false,
  };
}

const SCENARIOS = {
  plusPending: subscriptionSummary("plus", { included: "$5.00", confirmed: "$1.34", pending: "$0.09", available: "$3.57", includedMicros: 5_000_000, confirmedMicros: 1_334_567, pendingMicros: 90_000, availableMicros: 3_575_433 }),
  proAnnual: subscriptionSummary("pro", { included: "$12.00", available: "$12.00", includedMicros: 12_000_000, availableMicros: 12_000_000, resetAt: "2026-11-30T12:00:00.000Z", annual: true }),
  maxFresh: subscriptionSummary("max", { included: "$30.00", available: "$30.00", includedMicros: 30_000_000, availableMicros: 30_000_000 }),
  plusExhausted: subscriptionSummary("plus", { included: "$5.00", confirmed: "$5.00", available: "$0.00", includedMicros: 5_000_000, confirmedMicros: 5_000_000, availableMicros: 0, restricted: "allowance_exhausted" }),
  plusExhaustedUnavailable: subscriptionSummary("plus", {
    included: "$5.00", confirmed: "$5.00", available: "$0.00", includedMicros: 5_000_000, confirmedMicros: 5_000_000, availableMicros: 0, restricted: "allowance_exhausted",
    freeChoices: [{ ...LUMEN, available: false, unavailableReason: "This model is temporarily unavailable." }],
  }),
  accountA: subscriptionSummary("max", { included: "$30.00", confirmed: "$22.23", available: "$7.77", includedMicros: 30_000_000, confirmedMicros: 22_230_000, availableMicros: 7_770_000 }),
  accountB: subscriptionSummary("plus", { included: "$5.00", confirmed: "$0.50", available: "$4.50", includedMicros: 5_000_000, confirmedMicros: 500_000, availableMicros: 4_500_000 }),
};

describe("Allowance UI: authenticated usage page with mocked API", { concurrency: false, timeout: 300000 }, () => {
  let server;
  let serverUrl;
  let browser;
  // Mutable mock state per test.
  let currentUser;
  let allowanceResponse;
  let requests;
  // The chat mock: what the stream endpoint answers, the model the profile starts on, and every stream request received.
  let chatBehavior;
  let profile;
  let streamRequests;

  function reset() {
    chatBehavior = "answer";
    profile = { preferredModel: "nova", lastUsedModel: "nova", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "" };
    streamRequests = [];
    currentUser = { id: "usr_sample_a", name: "Sample Member", email: "member@example.com", surveyCompleted: true };
    allowanceResponse = { status: 200, body: SCENARIOS.plusPending, delayMs: 0 };
    requests = [];
  }

  before(async () => {
    reset();
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };

      if (url.pathname.startsWith("/api/")) {
        requests.push({ method: req.method, path: url.pathname, userId: currentUser?.id ?? null });
        if (url.pathname === "/api/me") return currentUser ? json(200, { user: currentUser }) : json(401, { error: "Sign in is required." });
        if (url.pathname === "/api/auth/sign-out") { currentUser = null; return json(200, { success: true }); }
        if (url.pathname === "/api/profile/preferences" || url.pathname === "/api/profile") {
          if (req.method === "PATCH" || req.method === "PUT") {
            let raw = "";
            req.on("data", (chunk) => { raw += chunk; });
            req.on("end", () => { profile = { ...profile, ...JSON.parse(raw || "{}") }; json(200, profile); });
            return undefined;
          }
          return json(200, profile);
        }
        if (url.pathname === "/api/chat/stream" && req.method === "POST") {
          let raw = "";
          req.on("data", (chunk) => { raw += chunk; });
          req.on("end", () => {
            const body = JSON.parse(raw || "{}");
            streamRequests.push(body);
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
            if (chatBehavior === "answer") {
              const complete = { conversationId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222", reply: "Here is your answer.", model: "VibhavGPT", modelKey: body.model, webSearched: false, sources: [], activitySummary: [], thoughtSeconds: null };
              res.end(`event: complete\ndata: ${JSON.stringify(complete)}\n\n`);
              return;
            }
            const choices = chatBehavior === "unavailable" ? [{ ...LUMEN, available: false, unavailableReason: "This model is temporarily unavailable." }] : [LUMEN];
            const refusal = { error: "Your included AI allowance is used up for this period. You can choose an included model, or wait for your allowance to reset.", code: "allowance_exceeded", retryable: false, status: 429, allowance: { paidModelRestricted: true, reason: "allowance_exhausted", resetAt: "2026-11-14T12:00:00.000Z", freeChoices: choices } };
            res.end(`event: error\ndata: ${JSON.stringify(refusal)}\n\n`);
          });
          return undefined;
        }
        if (url.pathname === "/api/usage") return json(200, { tier: "plus", monthly: { lumen: 10, nova: 10, nebula: 10, vesper: 10, study: 10 }, creditBalance: 0 });
        if (url.pathname === "/api/conversations" || url.pathname === "/api/chat/conversations") return json(200, { conversations: [] });
        if (url.pathname === "/api/chat/groups") return json(200, { groups: [] });
        if (url.pathname === "/api/billing/credit-purchases") return json(200, { purchases: [] });
        if (url.pathname === "/api/usage/allowance") {
          const { status, body, delayMs } = allowanceResponse;
          const send = () => json(status, body, { "Cache-Control": "private, no-store" });
          if (delayMs) setTimeout(send, delayMs);
          else send();
          return undefined;
        }
        return json(404, { error: "Not mocked." });
      }

      let reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      let filePath = path.join(distDir, reqPath);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
      res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
      return undefined;
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: discoverBrowserExecutable(), headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => reset());

  async function openUsage({ gate = true, viewport = { width: 1280, height: 900 }, isMobile = false, initScript = null } = {}) {
    const context = await browser.newContext({ viewport, isMobile });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    if (gate) await page.addInitScript(() => { window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI = true; });
    if (initScript) await page.addInitScript(initScript);
    await page.goto(`${serverUrl}/app/usage`, { waitUntil: "domcontentloaded" });
    return { context, page };
  }

  function assertReadOnlyTraffic() {
    const writes = requests.filter((r) => r.method !== "GET" && r.path !== "/api/auth/sign-out");
    assert.deepEqual(writes, [], "viewing allowance must not send writes");
    // The app shell's sidebar lists recent conversations with GET; nothing may send or change chat.
    const chatCalls = requests.filter((r) => r.path.startsWith("/api/chat"));
    const unexpected = chatCalls.filter((r) => !(r.method === "GET" && /^\/api\/chat\/(conversations|groups)$/.test(r.path)));
    assert.deepEqual(unexpected, [], "viewing allowance must not send messages or change chat");
  }

  test("1. default gate OFF: no allowance panel and no summary request", async () => {
    const { context, page } = await openUsage({ gate: false });
    await page.locator(".usage-page").waitFor({ state: "visible" });
    await page.locator(".usage-head__plan").waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-panel").count(), 0);
    assert.equal(requests.some((r) => r.path === "/api/usage/allowance"), false);
    await context.close();
  });

  test("2. Plus with pending usage: remaining of included, reset date, pending explained separately", async () => {
    const { context, page } = await openUsage();
    const panel = page.locator(".allowance-panel");
    await panel.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.match(await panel.locator("h2").textContent(), /AI allowance/);
    assert.equal(await panel.locator(".allowance-panel__headline").textContent(), "$3.57 remaining of $5.00");
    assert.match(await panel.locator(".allowance-panel__reset").textContent(), /^Resets November 1[45], 2026$/);
    assert.match(await panel.textContent(), /Spent\$1\.34/);
    assert.match(await panel.textContent(), /Pending\$0\.09/);
    assert.match(await panel.textContent(), /\$0\.09 is reserved for requests that are still finishing\. It isn't counted as spent/);
    assert.equal(await panel.locator(".allowance-panel__status").textContent(), "Available");
    const meter = panel.locator(".allowance-meter[role='img']");
    assert.match(await meter.getAttribute("aria-label"), /\$1\.34 spent, \$0\.09 pending, \$3\.57 remaining of \$5\.00/);
    assert.match(await panel.textContent(), /chat doesn't apply this allowance yet/);
    assert.equal(await panel.locator(".allowance-exhausted").count(), 0);
    assertReadOnlyTraffic();
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "allowance-desktop.png"), fullPage: false });
    await context.close();
  });

  test("3. annual Pro shows a monthly reset and Max shows $30", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.proAnnual };
    let { context, page } = await openUsage();
    let panel = page.locator(".allowance-panel");
    await panel.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.equal(await panel.locator(".allowance-panel__headline").textContent(), "$12.00 remaining of $12.00");
    assert.match(await panel.textContent(), /Pro plan/);
    assert.match(await panel.textContent(), /refreshes every month, separately from your plan's renewal date/);
    assert.equal(await panel.locator(".allowance-swatch--pending").count(), 0, "no pending legend without pending usage");
    await context.close();

    allowanceResponse = { status: 200, body: SCENARIOS.maxFresh };
    ({ context, page } = await openUsage());
    panel = page.locator(".allowance-panel");
    await panel.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.equal(await panel.locator(".allowance-panel__headline").textContent(), "$30.00 remaining of $30.00");
    assert.match(await panel.textContent(), /Max plan/);
    assert.doesNotMatch(await panel.textContent(), /refreshes every month/);
    await context.close();
  });

  test("4. exhausted: paid allowance used up, reset timing, explicit free choice, no automatic switch", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.plusExhausted };
    const { context, page } = await openUsage();
    const notice = page.locator(".allowance-exhausted");
    await notice.waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-panel__headline").textContent(), "$0.00 remaining of $5.00");
    assert.equal(await page.locator(".allowance-panel__status").textContent(), "Used up");
    assert.equal(await notice.locator("h3").textContent(), "Paid allowance used up");
    assert.match(await notice.textContent(), /Your allowance resets on November 1[45], 2026/);
    assert.match(await notice.textContent(), /nothing will be charged to your card/);
    assert.match(await notice.textContent(), /Chat isn't affected today/);
    assert.doesNotMatch(await notice.textContent(), /models are paused/);
    assert.match(await notice.locator(".allowance-choice[data-available='true']").textContent(), /VibhavGPT Lumen.*Included/);
    // Read-only presentation on the usage page: no button can switch the chat model.
    assert.equal(await notice.locator("button").count(), 0);
    await page.waitForTimeout(400);
    assertReadOnlyTraffic();
    if (screenshotDir) await notice.screenshot({ path: path.join(screenshotDir, "allowance-exhausted-desktop.png") });
    await context.close();
  });

  test("5. exhausted with the free endpoint unavailable shows an honest unavailable state", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.plusExhaustedUnavailable };
    const { context, page } = await openUsage();
    const notice = page.locator(".allowance-exhausted");
    await notice.waitFor({ state: "visible" });
    assert.match(await notice.locator(".allowance-exhausted__none").textContent(), /No included models are available right now\. Your allowance resets on November 1[45], 2026\./);
    assert.match(await notice.locator(".allowance-choice[data-available='false']").textContent(), /VibhavGPT Lumen.*temporarily unavailable.*Unavailable/);
    assert.equal(await notice.locator(".allowance-choice[data-available='true']").count(), 0);
    await context.close();
  });

  test("6. loading state, then server error with retry", async () => {
    allowanceResponse = { status: 500, body: { error: "Internal error" }, delayMs: 800 };
    const { context, page } = await openUsage();
    await page.locator(".allowance-panel__loading").waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-panel").getAttribute("aria-busy"), "true");
    const alert = page.locator(".allowance-panel__error[role='alert']");
    await alert.waitFor({ state: "visible" });
    assert.match(await alert.textContent(), /couldn't load your AI allowance/);
    assert.equal(await page.locator(".allowance-panel__headline").count(), 0);

    allowanceResponse = { status: 200, body: SCENARIOS.plusPending };
    await alert.locator("button", { hasText: "Try again" }).focus();
    await page.keyboard.press("Enter");
    await page.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-panel__error").count(), 0);
    await context.close();
  });

  test("7. expired session shows a sign-in message and no amounts", async () => {
    allowanceResponse = { status: 401, body: { error: "Sign in is required." } };
    const { context, page } = await openUsage();
    const alert = page.locator(".allowance-panel__error[role='alert']");
    await alert.waitFor({ state: "visible" });
    assert.match(await alert.textContent(), /session has expired\. Sign in again/);
    assert.equal(await alert.locator("button").count(), 0);
    assert.doesNotMatch(await page.locator(".allowance-panel").textContent(), /\$/);
    await context.close();
  });

  test("8. server gate disabled hides the panel without an error", async () => {
    allowanceResponse = { status: 404, body: { error: "Allowance summary API is not enabled.", code: "feature_disabled" } };
    const { context, page } = await openUsage();
    await page.locator(".usage-head__plan").waitFor({ state: "visible" });
    for (let i = 0; i < 50 && !requests.some((r) => r.path === "/api/usage/allowance"); i++) await page.waitForTimeout(100);
    assert.equal(requests.some((r) => r.path === "/api/usage/allowance"), true, "the summary was requested");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".allowance-panel").count(), 0);
    await context.close();
  });

  test("9. account isolation: sign-out clears figures and the next account never sees them", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.accountA };
    const { context, page } = await openUsage();
    await page.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-panel__headline").textContent(), "$7.77 remaining of $30.00");

    await page.locator("button.account").click();
    await page.locator("[role='menuitem']", { hasText: "Sign out" }).click();
    await page.locator(".allowance-panel").waitFor({ state: "detached" });
    assert.doesNotMatch(await page.locator("body").textContent(), /\$7\.77|\$22\.23/);
    await context.close();

    // Account B signs in on a fresh load. Record every text node rendered from
    // the first paint to prove account A's figures never appear, even briefly.
    currentUser = { id: "usr_sample_b", name: "Second Member", email: "second@example.com", surveyCompleted: true };
    allowanceResponse = { status: 200, body: SCENARIOS.accountB };
    const before = requests.filter((r) => r.path === "/api/usage/allowance").length;
    const second = await openUsage({
      initScript: () => {
        window.__seenText = "";
        new MutationObserver(() => { window.__seenText += document.body?.innerText ?? ""; })
          .observe(document, { subtree: true, childList: true, characterData: true });
      },
    });
    await second.page.locator(".allowance-panel__headline").waitFor({ state: "visible" });
    assert.equal(await second.page.locator(".allowance-panel__headline").textContent(), "$4.50 remaining of $5.00");
    const seen = await second.page.evaluate(() => window.__seenText);
    assert.doesNotMatch(seen, /\$7\.77|\$22\.23|\$30\.00/);
    const after = requests.filter((r) => r.path === "/api/usage/allowance");
    assert.equal(after.length, before + 1, "the summary is fetched fresh, never served from cache");
    assert.equal(after.at(-1).userId, "usr_sample_b");
    await second.context.close();
  });

  test("10. mobile 390px: readable layout without horizontal scrolling", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.plusExhausted };
    const { context, page } = await openUsage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const panel = page.locator(".allowance-panel");
    await panel.locator(".allowance-exhausted").waitFor({ state: "visible" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page must not scroll horizontally (overflow ${overflow}px)`);
    const box = await panel.boundingBox();
    assert.ok(box.width <= 390, "panel fits the viewport");
    if (screenshotDir) {
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({ path: path.join(screenshotDir, "allowance-mobile.png") });
    }
    await context.close();
  });

  test("11. native chat is unchanged with the gate on: composer model stays Lumen, no chat or profile writes", async () => {
    allowanceResponse = { status: 200, body: SCENARIOS.plusExhausted };
    profile = { ...profile, preferredModel: "lumen", lastUsedModel: "lumen" };
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(() => { window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI = true; });
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    const picker = page.locator(".composer__model button[role='combobox']");
    await picker.waitFor({ state: "visible" });
    assert.equal(await page.locator(".allowance-exhausted, .allowance-panel").count(), 0, "chat has no allowance surfaces yet");
    assert.equal(requests.some((r) => r.path === "/api/usage/allowance"), false, "chat does not load the allowance");
    assert.match(await picker.textContent(), /Lumen/);
    assertReadOnlyTraffic();
    await context.close();
  });

  async function sendInChat(page, message) {
    const input = page.locator(".composer__input");
    await input.waitFor({ state: "visible" });
    await page.locator(".composer__model .ui-select__trigger").filter({ hasText: "Nova" }).waitFor({ state: "visible" });
    await input.fill(message);
    await page.locator(".composer__send").click();
  }

  test("12. chat refusal explains the limit and offers the included model; nothing is switched or re-sent until the customer clicks", async () => {
    chatBehavior = "exhausted";
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    await sendInChat(page, "Can I still use this model?");

    const notice = page.locator(".allowance-exhausted");
    await notice.waitFor({ state: "visible" });
    assert.equal(await notice.locator("h3").textContent(), "Paid allowance used up");
    assert.match(await notice.textContent(), /Your included AI allowance is used up for this period/);
    assert.match(await notice.textContent(), /Your allowance resets on November 1[34], 2026/);
    assert.equal(await page.locator(".chat-banner").count(), 0, "no second, generic error banner");
    assert.equal(streamRequests.length, 1);
    assert.equal(streamRequests[0].model, "nova");

    // Nothing moves by itself.
    await page.waitForTimeout(600);
    assert.equal(streamRequests.length, 1, "no automatic resend");
    assert.match(await page.locator(".composer__model .ui-select__trigger").textContent(), /Nova/, "the selected model is not changed");

    // An explicit choice changes the model, and still sends nothing.
    await notice.getByRole("button", { name: /Use VibhavGPT Lumen/ }).click();
    await page.locator(".composer__model .ui-select__trigger").filter({ hasText: "Lumen" }).waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    assert.equal(streamRequests.length, 1, "choosing a model does not send the message");
    assert.ok(await notice.isVisible(), "the notice stays until the customer sends again or dismisses");

    // Sending again is its own explicit action, on the model the customer chose.
    chatBehavior = "answer";
    if (screenshotDir) await notice.screenshot({ path: path.join(screenshotDir, "allowance-chat-exhausted-desktop.png") });
    await notice.getByRole("button", { name: /Send again with Lumen/ }).click();
    await page.locator(".turn", { hasText: "Here is your answer." }).waitFor({ state: "visible" });
    assert.equal(streamRequests.length, 2);
    assert.equal(streamRequests[1].model, "lumen");
    assert.equal(streamRequests[1].message, "Can I still use this model?");
    assert.equal(await page.locator(".allowance-exhausted").count(), 0, "the notice clears once the customer sends again");
    await context.close();
  });

  test("13. an unavailable included model is shown honestly, with nothing to click and no fallback", async () => {
    chatBehavior = "unavailable";
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    await sendInChat(page, "Hello?");
    const notice = page.locator(".allowance-exhausted");
    await notice.waitFor({ state: "visible" });
    assert.match(await notice.locator(".allowance-exhausted__none").textContent(), /No included models are available right now/);
    assert.match(await notice.locator(".allowance-choice[data-available='false']").textContent(), /VibhavGPT Lumen.*temporarily unavailable.*Unavailable/);
    assert.equal(await notice.getByRole("button", { name: /^Use / }).count(), 0, "no model can be chosen");
    await page.waitForTimeout(500);
    assert.equal(streamRequests.length, 1, "no automatic fallback request");
    await context.close();
  });

  test("14. mobile 390px: the chat notice fits, its buttons are large, and it can be dismissed from the keyboard", async () => {
    chatBehavior = "exhausted";
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    await page.goto(`${serverUrl}/app`, { waitUntil: "domcontentloaded" });
    const input = page.locator(".composer__input");
    await input.waitFor({ state: "visible" });
    await input.fill("Hello");
    await page.locator(".composer__send").click();
    const notice = page.locator(".allowance-exhausted");
    await notice.waitFor({ state: "visible" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal scrolling (overflow ${overflow}px)`);
    const choose = notice.getByRole("button", { name: /Use VibhavGPT Lumen/ });
    assert.ok((await choose.boundingBox()).height >= 44, "touch target is at least 44px");
    if (screenshotDir) await notice.screenshot({ path: path.join(screenshotDir, "allowance-chat-exhausted-mobile.png") });
    await notice.getByRole("button", { name: "Dismiss" }).focus();
    await page.keyboard.press("Enter");
    await page.locator(".allowance-exhausted").waitFor({ state: "detached" });
    assert.equal(streamRequests.length, 1);
    await context.close();
  });
});
