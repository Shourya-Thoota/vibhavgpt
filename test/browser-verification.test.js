import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

export function discoverBrowserExecutable() {
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
    // Ignore error if not installed
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
  ".ttf": "font/ttf",
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

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test.describe("Real-Browser Verification Suite", { concurrency: false }, () => {
  let server;
  let serverUrl;
  let browser;

  test.before(async () => {
    assert.ok(executablePath, "A real system browser (Chrome/Edge/Chromium) must be available. Set BROWSER_PATH, CHROME_BIN, or install Google Chrome/Chromium.");
    server = createStaticServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}`;

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

  test("1. Diagrams: renders multiple Mermaid types with readable SVG labels", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const convId = "conv-diagrams-multitype";
    const history = [
      {
        id: "m-user-1",
        role: "user",
        content: "Please draw process, sequence, state, class, and ER diagrams.",
        createdAt: "2026-10-28T20:00:00.000Z",
      },
      {
        id: "m-asst-1",
        role: "assistant",
        content: [
          "### 1. Flowchart",
          "```mermaid",
          "flowchart TD",
          "  A[Start Process] --> B[Decide Action]",
          "  B --> C[Finish]",
          "```",
          "### 2. Sequence Diagram",
          "```mermaid",
          "sequenceDiagram",
          "  Alice->>Bob: Hello Bob",
          "  Bob-->>Alice: Hi Alice",
          "```",
          "### 3. State Diagram",
          "```mermaid",
          "stateDiagram-v2",
          "  [*] --> ActiveState",
          "  ActiveState --> [*]",
          "```",
          "### 4. Class Diagram",
          "```mermaid",
          "classDiagram",
          "  Animal <|-- Duck",
          "  Animal : +int age",
          "  Animal : +String gender",
          "  Duck : +is_wild()",
          "```",
          "### 5. ER Diagram",
          "```mermaid",
          "erDiagram",
          "  CUSTOMER ||--o{ ORDER : places",
          "  ORDER ||--|{ LINEITEM : contains",
          "```",
        ].join("\n"),
        createdAt: "2026-10-28T20:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Diagrams Test", model: "nova", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Diagrams Test", model: "nova", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);

    // Wait for all 5 diagram viewers to mount and render SVGs in their canvases
    await page.waitForSelector(".diagram-viewer[data-status='ready'] .diagram-viewer__canvas svg", { timeout: 15000 });
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => document.querySelectorAll(".diagram-viewer[data-status='ready'] .diagram-viewer__canvas svg").length >= 5, { timeout: 15000 });
    }, "All 5 Mermaid diagrams should transition to ready status with rendered SVGs");

    const diagramHolders = page.locator(".diagram-viewer");
    const count = await diagramHolders.count();
    assert.equal(count, 5, "Expected 5 diagram viewer elements");

    // Verify SVG and readable text labels in each diagram's canvas
    const svgs = page.locator(".diagram-viewer__canvas svg");
    assert.equal(await svgs.count(), 5, "Expected 5 rendered diagram SVGs");

    const expectedLabels = [
      ["Start Process", "Decide Action", "Finish"],
      ["Alice", "Bob", "Hello Bob", "Hi Alice"],
      ["ActiveState"],
      ["Animal", "Duck", "age", "is_wild"],
      ["CUSTOMER", "ORDER", "LINEITEM"],
    ];

    for (let i = 0; i < count; i++) {
      const svg = svgs.nth(i);
      const bbox = await svg.boundingBox();
      assert.ok(bbox && bbox.width > 20 && bbox.height > 20, `SVG ${i + 1} must have non-zero geometry`);
      const texts = await svg.locator("text").allTextContents();
      const combinedText = texts.join(" ");
      for (const label of expectedLabels[i]) {
        assert.ok(
          combinedText.includes(label),
          `Diagram ${i + 1} SVG should render label "${label}" (got texts: ${JSON.stringify(texts)})`,
        );
      }
    }

    await context.close();
  });

  test("2. Diagrams: zoom, pan drag (mouse & touch), reset, fullscreen modal, and source toggle", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const convId = "conv-diagram-controls";
    const diagramSource = "flowchart TD\n  StepA[Initialize Core] --> StepB[Execute Process]\n  StepB --> StepC[Complete]";
    const history = [
      {
        id: "m-user-controls",
        role: "user",
        content: "Draw a simple flowchart",
        createdAt: "2026-10-28T20:00:00.000Z",
      },
      {
        id: "m-asst-controls",
        role: "assistant",
        content: `\`\`\`mermaid\n${diagramSource}\n\`\`\``,
        createdAt: "2026-10-28T20:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Controls Test", model: "nova", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Controls Test", model: "nova", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);
    await page.waitForSelector(".diagram-viewer[data-status='ready'] .diagram-viewer__canvas svg", { timeout: 10000 });

    // Test Source Toggle (Show / Hide source)
    const showSourceBtn = page.locator(".diagram-viewer__source-bar button");
    assert.equal((await showSourceBtn.textContent()).trim(), "Show source");
    assert.equal(await page.locator(".diagram-viewer__source").count(), 0);

    await showSourceBtn.click();
    assert.equal((await showSourceBtn.textContent()).trim(), "Hide source");
    await page.waitForSelector(".diagram-viewer__source pre", { timeout: 5000 });
    const sourceText = await page.locator(".diagram-viewer__source pre").textContent();
    assert.ok(sourceText.includes("StepA[Initialize Core]"));

    await showSourceBtn.click();
    assert.equal((await showSourceBtn.textContent()).trim(), "Show source");
    assert.equal(await page.locator(".diagram-viewer__source").count(), 0);

    // Test Copy Source Button
    const copyBtn = page.locator(".diagram-viewer__toolbar button").filter({ hasText: "Copy source" });
    await copyBtn.click();
    await page.waitForFunction(() => document.querySelector(".diagram-viewer__toolbar")?.textContent?.includes("Copied"));

    // Test Fullscreen Modal
    const fullscreenBtn = page.locator(".diagram-viewer__toolbar button").filter({ hasText: "Full screen" });
    await fullscreenBtn.click();

    // Modal dialog is opened
    const modal = page.locator("[role='dialog']");
    await modal.waitFor({ state: "visible", timeout: 5000 });
    const zoomLevel = modal.locator(".diagram-viewer__zoom-level");
    assert.equal((await zoomLevel.textContent()).trim(), "100%");

    const zoomedFrame = modal.locator(".diagram-viewer__zoomed");
    let initialStyle = await zoomedFrame.getAttribute("style");
    assert.ok(initialStyle.includes("scale: 1"), `Initial scale should be 1 (was: ${initialStyle})`);
    assert.ok(initialStyle.includes("translate: 0px"), `Initial translate should be 0px (was: ${initialStyle})`);

    // Zoom In to 125%
    const zoomInBtn = modal.locator("button[aria-label='Zoom in']");
    await zoomInBtn.click();
    assert.equal((await zoomLevel.textContent()).trim(), "125%");
    let zoomedStyle = await zoomedFrame.getAttribute("style");
    assert.ok(zoomedStyle.includes("scale: 1.25"), `Scale should be 1.25 after zoom in (was: ${zoomedStyle})`);

    // Mouse Pan Drag when zoomed > 1
    const stage = modal.locator(".diagram-viewer__stage");
    const stageBox = await stage.boundingBox();
    assert.ok(stageBox, "Stage bounding box must exist");

    const startX = stageBox.x + stageBox.width / 2;
    const startY = stageBox.y + stageBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 30, { steps: 5 });
    await page.mouse.up();

    let pannedStyle = await zoomedFrame.getAttribute("style");
    assert.ok(pannedStyle.includes("translate: 40px 30px"), `Translate should reflect mouse pan (was: ${pannedStyle})`);

    // Reset Button restores scale to 1 and pan to 0,0
    const resetBtn = modal.locator(".diagram-viewer__zoom button").filter({ hasText: "Reset" });
    await resetBtn.click();
    assert.equal((await zoomLevel.textContent()).trim(), "100%");
    let resetStyle = await zoomedFrame.getAttribute("style");
    assert.ok(resetStyle.includes("scale: 1"), "Scale should reset to 1");
    assert.ok(resetStyle.includes("translate: 0px"), "Translate should reset to 0px");

    // Zoom Out to 75%
    const zoomOutBtn = modal.locator("button[aria-label='Zoom out']");
    await zoomOutBtn.click();
    assert.equal((await zoomLevel.textContent()).trim(), "75%");
    let zoomedOutStyle = await zoomedFrame.getAttribute("style");
    assert.ok(zoomedOutStyle.includes("scale: 0.75"), "Scale should be 0.75");

    // Close Modal via Escape key
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached", timeout: 5000 });

    await context.close();
  });

  test("3. Diagrams: mobile viewport touch pan drag", async () => {
    // Test mobile touch drag at 390x844 viewport
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await mobileContext.newPage();

    const convId = "conv-diagram-mobile";
    const history = [
      {
        id: "m-user-mob",
        role: "user",
        content: "Mobile diagram",
        createdAt: "2026-10-28T20:00:00.000Z",
      },
      {
        id: "m-asst-mob",
        role: "assistant",
        content: "```mermaid\nflowchart LR\n  Alpha --> Beta\n```",
        createdAt: "2026-10-28T20:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Mobile Diagram", model: "nova", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Mobile Diagram", model: "nova", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);
    await page.waitForSelector(".diagram-viewer[data-status='ready'] .diagram-viewer__canvas svg", { timeout: 10000 });

    // Open fullscreen
    await page.locator(".diagram-viewer__toolbar button").filter({ hasText: "Full screen" }).click();
    const modal = page.locator("[role='dialog']");
    await modal.waitFor({ state: "visible" });

    // Zoom in so zoom > 1
    await modal.locator("button[aria-label='Zoom in']").click();

    // Perform touch pan drag with React state-tick separation
    const stage = modal.locator(".diagram-viewer__stage");
    await stage.evaluate((el) => {
      const touchStart = new Touch({ identifier: 1, target: el, clientX: 100, clientY: 200 });
      el.dispatchEvent(new TouchEvent("touchstart", { touches: [touchStart], changedTouches: [touchStart], bubbles: true }));
    });
    await page.waitForTimeout(60);

    await stage.evaluate((el) => {
      const touchMove = new Touch({ identifier: 1, target: el, clientX: 150, clientY: 260 });
      el.dispatchEvent(new TouchEvent("touchmove", { touches: [touchMove], changedTouches: [touchMove], bubbles: true }));
    });
    await page.waitForTimeout(60);

    await stage.evaluate((el) => {
      const touchEnd = new Touch({ identifier: 1, target: el, clientX: 150, clientY: 260 });
      el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touchEnd], bubbles: true }));
    });

    const zoomedFrame = modal.locator(".diagram-viewer__zoomed");
    const style = await zoomedFrame.getAttribute("style");
    assert.ok(style.includes("translate: 50px 60px"), `Touch drag should update translate coordinates (got: ${style})`);

    await mobileContext.close();
  });

  test("4. Diagrams: malformed syntax displays fallback note and raw code", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const convId = "conv-diagram-malformed";
    const badCode = "flowchart TD\n  A --> [Unclosed bracket and bad syntax";
    const history = [
      {
        id: "m-user-bad",
        role: "user",
        content: "Draw a broken diagram",
        createdAt: "2026-10-28T20:00:00.000Z",
      },
      {
        id: "m-asst-bad",
        role: "assistant",
        content: `\`\`\`mermaid\n${badCode}\n\`\`\``,
        createdAt: "2026-10-28T20:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Malformed Test", model: "nova", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Malformed Test", model: "nova", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);

    // Wait for the failed diagram fallback container
    await page.waitForSelector(".diagram-viewer-failed", { timeout: 10000 });
    const note = page.locator(".diagram-viewer-failed__note");
    assert.equal(await note.textContent(), "Couldn't draw this diagram; showing its source.");
    assert.equal(await note.getAttribute("role"), "note");

    // Verify raw code block is presented as fallback
    const codeBlock = page.locator(".diagram-viewer-failed pre");
    assert.ok((await codeBlock.textContent()).includes("Unclosed bracket"));

    await context.close();
  });

  test("5. Diagrams: hostile SVG prevention (scripts blocked, zero network leaks)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const leakedRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("evil-tracker.test") || url.includes("leak.png") || url.includes("attacker")) {
        leakedRequests.push(url);
      }
    });

    const convId = "conv-hostile-svg";
    const history = [
      {
        id: "m-user-sec",
        role: "user",
        content: "Security test",
        createdAt: "2026-10-28T20:00:00.000Z",
      },
      {
        id: "m-asst-sec",
        role: "assistant",
        // Diagram with labels attempting script tags or HTML breakout
        content: '```mermaid\nflowchart TD\n  A["Safe Start"] --> B["Node<script>window.__HOSTILE_INJECTION__ = true;</script>"]\n```',
        createdAt: "2026-10-28T20:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Hostile SVG Test", model: "nova", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Hostile SVG Test", model: "nova", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);
    await page.waitForSelector(".diagram-viewer", { timeout: 10000 });

    const evilFlag = await page.evaluate(() => window.__HOSTILE_INJECTION__);
    assert.equal(evilFlag, undefined, "Hostile script must NOT execute in page context");
    assert.equal(leakedRequests.length, 0, "Zero unauthorized tracking requests must occur");

    await context.close();
  });

  test("6. Tier switching: history preserved, next request uses new tier, mid-stream switch blocked, control recovery", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const convId = "conv-tier-switch";
    let currentModel = "nova";
    const patchCalls = [];
    const streamCalls = [];

    const history = [
      {
        id: "msg-init-user",
        role: "user",
        content: "What is quantum computing?",
        createdAt: "2026-10-28T21:00:00.000Z",
      },
      {
        id: "msg-init-asst",
        role: "assistant",
        content: "Quantum computing uses qubits to process information.",
        model: "nova",
        createdAt: "2026-10-28T21:00:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => {
      if (route.request().method() === "PATCH") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
      });
    });
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Tier Test", model: currentModel, mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => {
      if (route.request().method() === "PATCH") {
        const payload = JSON.parse(route.request().postData() || "{}");
        patchCalls.push(payload);
        if (payload.model) currentModel = payload.model;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, model: currentModel }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: { id: convId, title: "Tier Test", model: currentModel, mode: "chat" },
          history,
          hasMore: false,
          nextCursor: null,
        }),
      });
    });

    let streamResolve;
    await page.route("**/api/chat/stream", async (route) => {
      const payload = JSON.parse(route.request().postData() || "{}");
      streamCalls.push(payload);

      // Keep stream open briefly to test mid-stream switch blocking
      const streamBody = [
        sseEvent("conversation", { id: convId }),
        sseEvent("status", { phase: "thinking" }),
        sseEvent("delta", { text: "Superposition allows multiple states simultaneously." }),
      ].join("");

      // Provide partial stream, wait for signal, then complete
      await new Promise((res) => {
        streamResolve = res;
        setTimeout(res, 300); // safety fallback
      });

      const fullStream = streamBody + sseEvent("complete", {
        conversationId: convId,
        messageId: "msg-stream-asst",
        reply: "Superposition allows multiple states simultaneously.",
        modelKey: payload.model,
        model: "Vulcan",
      });

      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: fullStream,
      });
    });

    await page.goto(`${serverUrl}/?conversation=${convId}`);

    // Verify existing messages rendered
    await page.waitForSelector(".turn", { timeout: 10000 });
    const turns = page.locator(".turn");
    assert.equal(await turns.count(), 2, "Initial conversation history should render 2 messages");
    assert.ok((await turns.first().textContent()).includes("What is quantum computing?"));

    // Verify initial model is Nova
    const modelPickerTrigger = page.locator(".composer__model .ui-select__trigger");
    assert.ok((await modelPickerTrigger.textContent()).includes("Nova"));

    // Switch model to Vulcan
    await modelPickerTrigger.click();
    const vesperOption = page.locator(".ui-option, [role='option']").filter({ hasText: "Vulcan" });
    await vesperOption.click();

    // Verify PATCH request fired with model: "vesper"
    await page.waitForFunction(() => document.querySelector(".composer__model")?.textContent?.includes("Vulcan"));
    // The picker shows Vulcan at once; the request follows it. Wait for the request to arrive (up to 5s) instead of
    // assuming it already has, which fails on a loaded machine; if it never comes, this still fails.
    for (let waited = 0; waited < 5000 && !patchCalls.some((p) => p.model === "vesper"); waited += 100) await page.waitForTimeout(100);
    assert.ok(patchCalls.some((p) => p.model === "vesper"), "PATCH request should update conversation model to vesper");

    // Verify history remains visible in DOM
    assert.equal(await page.locator(".turn").count(), 2, "Message history must remain intact after switching tier");

    // Send new message via composer
    const textarea = page.locator(".composer__input");
    await textarea.fill("Explain superposition");

    // Click send
    const sendBtn = page.locator(".composer__send");
    await sendBtn.click();

    // While stream is in flight: verify model selector is disabled (mid-stream switch blocked)
    const isDisabledDuringStream = await modelPickerTrigger.getAttribute("disabled");
    assert.notEqual(isDisabledDuringStream, null, "Model picker must be disabled while stream is active");

    // Attempting to click model picker during stream should not open dropdown or fire PATCH
    const patchCountBefore = patchCalls.length;
    await modelPickerTrigger.click({ force: true });
    assert.equal(patchCalls.length, patchCountBefore, "No model change allowed mid-stream");

    // Finish stream
    if (streamResolve) streamResolve();

    // Wait for streaming to finish and new message to be settled
    await page.waitForFunction(() => !document.querySelector(".composer__model .ui-select__trigger")?.hasAttribute("disabled"), { timeout: 10000 });

    // Verify the stream request payload received model: "vesper" and conversationId: convId
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].model, "vesper");
    assert.equal(streamCalls[0].conversationId, convId);
    assert.equal(streamCalls[0].message, "Explain superposition");

    // Control recovery: textarea cleared and enabled, model selector re-enabled
    assert.equal(await textarea.inputValue(), "");
    assert.equal(await modelPickerTrigger.getAttribute("disabled"), null, "Model picker re-enabled after stream");

    // Exactly 4 turns now exist (2 original + 1 user + 1 assistant), no duplicates
    const finalTurns = page.locator(".turn");
    assert.equal(await finalTurns.count(), 4, "Expected exactly 4 message turns (no duplicates or orphaned bubbles)");

    await context.close();
  });

  test("7. Tier switching: Free tier entitlement limits and error resilience", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const convId = "conv-tier-free";
    const history = [
      {
        id: "msg-free-1",
        role: "user",
        content: "Hello",
        createdAt: "2026-10-28T21:00:00.000Z",
      },
      {
        id: "msg-free-2",
        role: "assistant",
        content: "Hi there!",
        model: "lumen",
        createdAt: "2026-10-28T21:00:05.000Z",
      },
    ];

    // User is on "free" tier
    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-free", name: "Free User", email: "free@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 0, nebula: 0, vesper: 0, study: 0 }, tier: "free", plan: "free" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: convId, title: "Free User Test", model: "lumen", mode: "chat" }]),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route(`**/api/chat/conversations/${convId}**`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: { id: convId, title: "Free User Test", model: "lumen", mode: "chat" },
        history,
        hasMore: false,
        nextCursor: null,
      }),
    }));

    await page.goto(`${serverUrl}/?conversation=${convId}`);
    await page.waitForSelector(".composer__model .ui-select__trigger", { timeout: 10000 });

    // Open model picker
    await page.locator(".composer__model .ui-select__trigger").click();

    // Vulcan option should be disabled and show "Plus" badge
    const vesperOption = page.locator(".ui-option, [role='option']").filter({ hasText: "Vulcan" });
    assert.equal(await vesperOption.getAttribute("aria-disabled"), "true", "Vulcan must be disabled for free plan");
    assert.ok((await vesperOption.textContent()).includes("Plus"), "Vulcan must display Plus badge for free plan");

    // Clicking disabled option triggers plan requirement notice without switching
    await vesperOption.click({ force: true });
    await page.waitForSelector(".banner--error, [role='alert'], [role='dialog']", { timeout: 5000 });
    const currentModelText = await page.locator(".composer__model .ui-select__trigger").textContent();
    assert.ok(!currentModelText.includes("Vulcan"), "Model must not have changed to Vulcan");

    await context.close();
  });

  test("8. Image-context UI: disclosure display, expansion, distinct prompts, and cross-conversation isolation", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const convId1 = "conv-img-first";
    const convId2 = "conv-img-second";

    const prompt1 = "A photorealistic crystalline lake at sunrise surrounded by misty pine forests.";
    const prompt2 = "A neon-lit cyberpunk market at midnight in heavy rain with holographic signs.";
    const promptConv2 = "A cozy wooden cabin during a quiet winter snowfall.";

    const historyConv1 = [
      {
        id: "msg-img-user-1",
        role: "user",
        content: "Generate a picture of a lake",
        createdAt: "2026-10-28T22:00:00.000Z",
      },
      {
        id: "msg-img-asst-1",
        role: "assistant",
        content: "Here is your lake image.",
        imagePrompt: prompt1,
        attachment: {
          kind: "generated-image",
          downloadUrl: "/lake.png",
          name: "lake.png",
        },
        createdAt: "2026-10-28T22:00:05.000Z",
      },
      {
        id: "msg-img-user-2",
        role: "user",
        content: "Now make a cyberpunk city",
        createdAt: "2026-10-28T22:01:00.000Z",
      },
      {
        id: "msg-img-asst-2",
        role: "assistant",
        content: "Here is the cyberpunk city.",
        imagePrompt: prompt2,
        attachment: {
          kind: "generated-image",
          downloadUrl: "/cyberpunk.png",
          name: "cyberpunk.png",
        },
        createdAt: "2026-10-28T22:01:05.000Z",
      },
    ];

    const historyConv2 = [
      {
        id: "msg-c2-u",
        role: "user",
        content: "Show me a cabin",
        createdAt: "2026-10-28T22:05:00.000Z",
      },
      {
        id: "msg-c2-a",
        role: "assistant",
        content: "Here is your cozy cabin.",
        imagePrompt: promptConv2,
        attachment: {
          kind: "generated-image",
          downloadUrl: "/cabin.png",
          name: "cabin.png",
        },
        createdAt: "2026-10-28T22:05:05.000Z",
      },
    ];

    await page.route("**/api/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "u-1", name: "Tester", email: "test@example.com", surveyCompleted: true } }),
    }));
    await page.route("**/api/usage", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }),
    }));
    await page.route("**/api/profile/preferences", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ theme: "dark", thinkingEffort: "low", productMode: "chat" }),
    }));
    await page.route("**/api/uploads/limits", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }),
    }));
    await page.route("**/api/chat/conversations", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: convId1, title: "Image Chat 1", model: "nova", mode: "chat" },
        { id: convId2, title: "Image Chat 2", model: "nova", mode: "chat" },
      ]),
    }));
    await page.route("**/api/chat/conversations/*", (route) => {
      const url = route.request().url();
      if (url.includes(convId2)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            conversation: { id: convId2, title: "Image Chat 2", model: "nova", mode: "chat" },
            history: historyConv2,
            hasMore: false,
            nextCursor: null,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation: { id: convId1, title: "Image Chat 1", model: "nova", mode: "chat" },
          history: historyConv1,
          hasMore: false,
          nextCursor: null,
        }),
      });
    });

    // 1. Navigate to Conversation 1
    await page.goto(`${serverUrl}/?conversation=${convId1}`);
    await page.waitForSelector(".image-prompt-disclosure", { timeout: 10000 });

    const disclosures = page.locator(".image-prompt-disclosure");
    assert.equal(await disclosures.count(), 2, "Expected 2 image prompt disclosure elements in Conversation 1");

    // Verify initial collapsed state
    const firstTag = disclosures.first().locator(".image-prompt-disclosure__tag");
    assert.equal((await firstTag.textContent()).trim(), "Prompt used");
    assert.equal(await firstTag.getAttribute("aria-expanded"), "false");
    assert.equal(await disclosures.first().locator(".image-prompt-disclosure__panel").count(), 0);

    // Expand first disclosure and verify prompt text
    await firstTag.click();
    assert.equal(await firstTag.getAttribute("aria-expanded"), "true");
    const firstText = await disclosures.first().locator(".image-prompt-disclosure__text").textContent();
    assert.equal(firstText.trim(), prompt1);

    // Expand second disclosure and verify distinct prompt text
    const secondTag = disclosures.nth(1).locator(".image-prompt-disclosure__tag");
    await secondTag.click();
    assert.equal(await secondTag.getAttribute("aria-expanded"), "true");
    const secondText = await disclosures.nth(1).locator(".image-prompt-disclosure__text").textContent();
    assert.equal(secondText.trim(), prompt2);

    // Verify both are distinct without cross-contamination
    assert.notEqual(firstText.trim(), secondText.trim());

    // Collapse first disclosure
    await firstTag.click();
    assert.equal(await firstTag.getAttribute("aria-expanded"), "false");
    assert.equal(await disclosures.first().locator(".image-prompt-disclosure__panel").count(), 0);
    // Second remains open
    assert.equal(await disclosures.nth(1).locator(".image-prompt-disclosure__panel").count(), 1);

    // 2. Navigate to Conversation 2 (verify cross-conversation isolation)
    await page.goto(`${serverUrl}/?conversation=${convId2}`);
    await page.waitForSelector(".image-prompt-disclosure", { timeout: 10000 });

    const c2Disclosures = page.locator(".image-prompt-disclosure");
    assert.equal(await c2Disclosures.count(), 1, "Conversation 2 should have exactly 1 disclosure");
    const c2Tag = c2Disclosures.first().locator(".image-prompt-disclosure__tag");
    await c2Tag.click();
    const c2Text = await c2Disclosures.first().locator(".image-prompt-disclosure__text").textContent();
    assert.equal(c2Text.trim(), promptConv2);
    assert.ok(!c2Text.includes(prompt1) && !c2Text.includes(prompt2), "Conversation 2 must not leak prompts from Conversation 1");

    await context.close();
  });
});
