/**
 * Real-browser fixture for a connector read.
 *
 * The built frontend runs in a real browser against an in-process server that
 * mounts the REAL chat router, so server-sent events arrive incrementally.
 * Doubles: the model upstream (scripted, with delays) and the connector
 * provider. No network, no real account, no live model.
 *
 * A MutationObserver records every text state the page ever showed, so
 * "no flash of raw planning" is checked at every moment, not only at the end.
 *
 * Needs a built frontend (npm run build --prefix frontend) and a system browser.
 * Run with: npm run test:browser
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

// ---- Server side: real chat router over PGlite, doubled upstream/provider ----

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db: drizzle(client), pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});
const adapterHref = new URL("../src/connectors/composio-adapter.js", import.meta.url).href;
const adapter = await import(adapterHref);
const provider = { respond: async () => ({ data: {} }) };
mock.module(adapterHref, {
  namedExports: {
    COMPOSIO_TOOLKITS: adapter.COMPOSIO_TOOLKITS,
    uploadComposioFile: adapter.uploadComposioFile,
    checkComposioFilesAccess: adapter.checkComposioFilesAccess,
    accountBelongsToUser: adapter.accountBelongsToUser,
    accountGrantedToUser: adapter.accountGrantedToUser,
    TOOLKIT_METADATA: adapter.TOOLKIT_METADATA,
    TOOL_SLUG_MAP: adapter.TOOL_SLUG_MAP,
    COMPOSIO_AUTH_TRUSTED_HOSTS: adapter.COMPOSIO_AUTH_TRUSTED_HOSTS,
    isComposioConfigured: adapter.isComposioConfigured,
    computePayloadHash: adapter.computePayloadHash,
    isTrustedComposioRedirectUrl: adapter.isTrustedComposioRedirectUrl,
    listAllComposioConnections: adapter.listAllComposioConnections,
    initiateComposioConnection: adapter.initiateComposioConnection,
    checkComposioAccountStatus: adapter.checkComposioAccountStatus,
    revokeComposioConnection: adapter.revokeComposioConnection,
    sanitizeProviderError: adapter.sanitizeProviderError,
    interpretComposioExecution: adapter.interpretComposioExecution,
    executeComposioTool: async (args) => provider.respond(args),
  },
});
const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture-nova-upstream-id";
const { connectUserConnector } = await import("../src/connectors/service.js");
const { chatRouter } = await import("../src/chat/router.js");
const { default: express } = await import("express");

const USER_ID = "browser-activity-user";
const RAW_PLANNING = "RAW-PLANNING-SENTINEL I should call the YouTube tool and then explain it";
const RAW_AFTER = "RAW-AFTER-SENTINEL the tool might have failed so maybe try a search instead";
const THINK_MS = 2_200; // how long the upstream "thinks" before its first word
const PROVIDER_MS = 800; // how long the connector read takes, so its label is on screen

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const frame = (chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
const usage = { prompt_tokens: 40, completion_tokens: 12 };
const thinking = (text) => ({ choices: [{ delta: { reasoning: text, reasoning_details: [{ type: "reasoning.text", text }] } }] });
// A scripted upstream response: [delayMsBeforeChunk, chunk] pairs, delivered over time.
const timed = (steps) => new Response(new ReadableStream({
  async start(controller) {
    for (const [delay, chunk] of steps) {
      if (delay) await sleep(delay);
      controller.enqueue(frame(chunk));
    }
    controller.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });
const toolTurn = () => timed([
  [0, thinking(RAW_PLANNING)],
  [250, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "youtube_get_my_channel", arguments: "{}" } }] } }] }],
  [100, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }],
]);
const answerTurn = (text) => timed([
  [0, thinking(RAW_AFTER)],
  ...text.split(/(?<= )/).map((content, i) => [i === 0 ? THINK_MS : 120, { choices: [{ delta: { content } }] }]),
  [50, { choices: [{ delta: {}, finish_reason: "stop" }], usage }],
]);

const scenario = { tool: true, answer: "" };
let upstreamCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstreamCalls += 1;
    return scenario.tool && upstreamCalls === 1 ? toolTurn() : answerTurn(scenario.answer);
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};

await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [USER_ID]);
await connectUserConnector(USER_ID, "youtube", { accessToken: "tok_youtube_test", scopes: [], metadata: { accountId: "acct_fixture_browser_tool_activity_1" } });

const distDir = path.resolve("frontend/dist");
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };
const unhandledApi = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: USER_ID } }; next(); });
app.get("/api/me", (_req, res) => res.json({ user: { id: USER_ID, name: "Tester", email: "tester@example.com", surveyCompleted: true } }));
app.get("/api/usage", (_req, res) => res.json({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }));
app.get("/api/profile/preferences", (_req, res) => res.json({ theme: "dark", thinkingEffort: "low", productMode: "chat" }));
app.patch("/api/profile/preferences", (_req, res) => res.json({ ok: true }));
app.get("/api/uploads/limits", (_req, res) => res.json({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }));
app.use("/api/chat", chatRouter);
app.use("/api", (req, res) => { unhandledApi.push(`${req.method} ${req.originalUrl}`); res.status(404).json({ error: "not part of this fixture" }); });
app.use((req, res) => {
  let filePath = path.join(distDir, req.path === "/" ? "/index.html" : req.path);
  if (!filePath.startsWith(distDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
  res.type(mimeTypes[path.extname(filePath)] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
});

// ---- Browser side ----------------------------------------------------------

const executablePath = discoverBrowserExecutable();
let server;
let baseUrl;
let browser;

test.before(async () => {
  assert.ok(fs.existsSync(path.join(distDir, "index.html")), "Build the frontend first: npm run build --prefix frontend");
  assert.ok(executablePath, "A system browser (Chrome, Edge, Brave or Chromium) is required. Set BROWSER_PATH to its executable.");
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
});

test.after(async () => {
  globalThis.fetch = realFetch;
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Every distinct text state the page showed, in order (textContent also covers hidden or collapsed nodes).
const RECORDER = () => {
  window.__states = [];
  const record = () => {
    const text = document.body ? document.body.textContent : "";
    if (window.__states.at(-1) !== text) window.__states.push(text);
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true });
};

async function chat({ tool, answer, provide }) {
  scenario.tool = tool;
  scenario.answer = answer;
  upstreamCalls = 0;
  provider.respond = provide;
  const created = await client.query("INSERT INTO conversations (user_id, title, model) VALUES ($1, 'Tool activity', 'nova') RETURNING id", [USER_ID]);
  const conversationId = created.rows[0].id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
  await page.addInitScript(RECORDER);
  await page.goto(`${baseUrl}/?conversation=${conversationId}`);
  await page.waitForSelector(".composer__input", { timeout: 15_000 });
  assert.ok((await page.locator(".composer__model .ui-select__trigger").textContent()).includes("Nova"), "the conversation is on Nova");
  await page.locator(".composer__input").fill("what's my YouTube channel's name?");
  await page.locator(".composer__send").click();
  // The reply is complete when the answer is on screen and the composer is usable again.
  await page.waitForFunction((text) => [...document.querySelectorAll(".turn")].at(-1)?.textContent.includes(text)
    && !document.querySelector(".composer__model .ui-select__trigger")?.hasAttribute("disabled"), answer, { timeout: 30_000 });
  await page.waitForTimeout(600); // a duplicated or late write would show up in this window
  const turns = await page.locator(".turn").allTextContents();
  const pill = await page.locator(".thinking-tool__toggle").allTextContents();
  const pillDisabled = await page.locator(".thinking-tool__toggle[disabled]").count();
  // Collapsed content is not in the page text, so open anything that can be opened:
  // a thinking transcript hidden behind a pill must not exist either.
  const openable = page.locator(".thinking-tool__toggle:not([disabled])");
  for (let index = 0, count = await openable.count(); index < count; index += 1) await openable.nth(index).click();
  await page.waitForTimeout(200);
  const states = await page.evaluate(() => window.__states);
  const finalText = await page.evaluate(() => document.body.textContent);
  await context.close();
  return { states, turns, finalText, pill, pillDisabled, pageErrors };
}

const first = (states, needle) => states.findIndex((s) => s.includes(needle));
const occurrences = (text, needle) => text.split(needle).length - 1;

function assertNeverShown(run) {
  assert.deepEqual(run.pageErrors, [], "no uncaught page errors");
  assert.equal(run.states.some((s) => /RAW-PLANNING-SENTINEL|RAW-AFTER-SENTINEL/.test(s)), false, "raw reasoning was never in the page, not even for a moment");
  assert.doesNotMatch(run.finalText, /fixture-nova-upstream-id/, "no upstream model id in customer-facing text");
}

test("tool turn: no raw planning at any moment, labels follow the real steps, the answer appears once", async () => {
  const answer = "Your channel is Fixture Channel.";
  const run = await chat({
    tool: true, answer,
    provide: async () => { await sleep(PROVIDER_MS); return { data: { items: [{ id: "UC_fixture", snippet: { title: "Fixture Channel" } }] } }; },
  });
  assertNeverShown(run);

  // Progress: an honest thinking indicator, then reading, then the outcome, then the answer.
  const thinkingAt = first(run.states, "Thinking...");
  const readingAt = first(run.states, "Reading from YouTube...");
  const doneAt = first(run.states, "Got a response from YouTube");
  const answerAt = first(run.states, answer);
  assert.ok(thinkingAt >= 0, "a thinking indicator was shown");
  assert.ok(readingAt > thinkingAt, "reading follows the thinking indicator");
  assert.ok(doneAt > readingAt, "the outcome follows the read");
  assert.ok(answerAt > doneAt, "the answer follows the outcome");
  assert.equal(first(run.states, "Could not read from YouTube"), -1, "no failure label after a successful read");

  // No duplication: one user turn, one assistant turn, the answer once.
  assert.equal(run.turns.length, 2, "exactly two turns: the question and the reply");
  assert.equal(occurrences(run.turns.at(-1), answer), 1, "the answer is in the reply once");
  assert.equal(occurrences(run.finalText, answer), 1, "and once on the page");
  // The leftover labels are gone once the reply is final.
  assert.doesNotMatch(run.finalText, /Reading from YouTube\.\.\.|Got a response from YouTube/);
  // The paid reasoning experience is a duration with nothing to expand, never a transcript.
  assert.ok(run.pill.some((text) => /Thought for \d+ s/.test(text)), `a "Thought for N s" pill is kept (saw ${JSON.stringify(run.pill)})`);
  assert.ok(run.pillDisabled >= 1, "and it has no body to open");
});

test("failed read: the page says it could not read, never that it got a response", async () => {
  const answer = "I could not read your YouTube channel just now.";
  const run = await chat({
    tool: true, answer,
    provide: async () => { await sleep(PROVIDER_MS); throw Object.assign(new Error("401 Unauthorized invalid_grant ya29.SECRETTOKENVALUE"), { logId: "log_b" }); },
  });
  assertNeverShown(run);
  assert.ok(first(run.states, "Reading from YouTube...") >= 0);
  assert.ok(first(run.states, "Could not read from YouTube") > first(run.states, "Reading from YouTube..."));
  assert.equal(first(run.states, "Got a response from YouTube"), -1, "no success label after an error");
  assert.equal(run.states.some((s) => /SECRETTOKEN|invalid_grant/.test(s)), false, "no provider text on the page");
  assert.ok(first(run.states, answer) > first(run.states, "Could not read from YouTube"));
  assert.equal(run.turns.length, 2);
  assert.equal(occurrences(run.turns.at(-1), answer), 1);
});

test("a turn with no tool still completes normally: thinking indicator, no connector labels, answer once", async () => {
  const answer = "Photosynthesis turns light into sugar.";
  const run = await chat({ tool: false, answer, provide: async () => { throw new Error("the provider must not be called"); } });
  assertNeverShown(run);
  assert.ok(first(run.states, "Thinking...") >= 0, "an honest thinking indicator was shown while the model worked");
  assert.equal(run.states.some((s) => /Reading from YouTube|Got a response from|Could not read from/.test(s)), false, "no connector label without a connector step");
  assert.equal(run.turns.length, 2);
  assert.equal(occurrences(run.turns.at(-1), answer), 1);
  assert.ok(run.pill.some((text) => /Thought for \d+ s/.test(text)), "the thought-time pill is kept on a plain turn too");
  assert.ok(run.pillDisabled >= 1, "and it has no transcript to open, on a turn with no tool as well");
  assert.deepEqual(unhandledApi.filter((entry) => entry.startsWith("POST")), [], "nothing was posted to an endpoint this fixture does not provide");
});
