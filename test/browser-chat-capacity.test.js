/**
 * Real-browser check of the waiting state (PR 4, src/chat/capacity.js).
 *
 * The built frontend runs in a real browser against an in-process server that mounts the REAL chat router over a real Postgres
 * (PGlite) with the capacity layer on. "Another replica's reply" holding Nova's only slot is a lease row written into the shared
 * table. Doubles: the session and the model upstream. No network, no real account, no live model.
 *
 * Needs a built frontend (npm run build --prefix frontend) and a system browser. Run with: npm run test:browser
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
const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture-nova-upstream-id";
Object.assign(config.chatCapacity, { enabled: true, global: 0, perUser: 0, perGroup: 0, maxQueuedPerTier: 40, maxQueuedPerUser: 2, maxWaitMs: 30_000 });
Object.assign(config.chatCapacity.tiers, { lumen: 0, nova: 1, nebula: 0, vesper: 0, study: 0 });
const { chatRouter } = await import("../src/chat/router.js");
const { default: express } = await import("express");

const USER_ID = "browser-capacity-user";
const ANSWER = "Your reply arrived after the wait.";
const encoder = new TextEncoder();
const answer = (text) => new Response(new ReadableStream({ start(c) {
  for (const content of text.split(/(?<= )/)) c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
  c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6 } })}\n\n`));
  c.close();
} }), { headers: { "Content-Type": "text/event-stream" } });
let upstreamCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.startsWith(config.providerBaseUrls.paid)) {
    if (href.includes("/generation")) return new Response("{}", { status: 404 });
    upstreamCalls += 1;
    return answer(ANSWER);
  }
  if (href.startsWith("http://127.0.0.1")) return realFetch(url, init);
  throw new Error(`Unexpected outbound request in test: ${new URL(href).host}`);
};
await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [USER_ID]);

const distDir = path.resolve("frontend/dist");
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authSession = { user: { id: USER_ID } }; next(); });
app.get("/api/me", (_req, res) => res.json({ user: { id: USER_ID, name: "Tester", email: "tester@example.com", surveyCompleted: true } }));
app.get("/api/usage", (_req, res) => res.json({ monthly: { lumen: 100, nova: 100, nebula: 100, vesper: 100, study: 100 }, tier: "pro", plan: "pro" }));
app.get("/api/profile/preferences", (_req, res) => res.json({ theme: "dark", thinkingEffort: "low", productMode: "chat" }));
app.patch("/api/profile/preferences", (_req, res) => res.json({ ok: true }));
app.get("/api/uploads/limits", (_req, res) => res.json({ maxSizeBytes: 10485760, allowedMimeTypes: ["image/png", "image/jpeg"] }));
app.use("/api/chat", chatRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "not part of this fixture" }));
app.use((req, res) => {
  let filePath = path.join(distDir, req.path === "/" ? "/index.html" : req.path);
  if (!filePath.startsWith(distDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
  res.type(mimeTypes[path.extname(filePath)] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
});

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
test.beforeEach(async () => {
  await client.exec("DELETE FROM chat_capacity_leases");
  upstreamCalls = 0;
  config.chatCapacity.maxQueuedPerTier = 40;
});

const leases = async () => (await client.query("SELECT user_id, state FROM chat_capacity_leases ORDER BY enqueued_at")).rows;
const otherReplicaHoldsNova = () => client.query("INSERT INTO chat_capacity_leases (id, tier, user_id, state, instance_id, accepted_at, expires_at) VALUES (gen_random_uuid(), 'nova', 'someone-else', 'active', 'other-replica', now(), now() + interval '120 seconds')");
const WAITING = /Nova is in high demand\. Waiting for a free slot\.\.\. \((\d+) s\)/;

async function openNovaChat() {
  const created = await client.query("INSERT INTO conversations (user_id, title, model) VALUES ($1, 'Capacity', 'nova') RETURNING id", [USER_ID]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
  await page.goto(`${baseUrl}/?conversation=${created.rows[0].id}`);
  await page.waitForSelector(".composer__input", { timeout: 15_000 });
  assert.ok((await page.locator(".composer__model .ui-select__trigger").textContent()).includes("Nova"));
  return { page, context, pageErrors };
}
const bodyText = (page) => page.evaluate(() => document.body.textContent);

test("waiting state: an honest live label with a real wait counter; typing still works; the reply arrives when a slot frees", async () => {
  await otherReplicaHoldsNova();
  const { page, context, pageErrors } = await openNovaChat();
  await page.locator(".composer__input").fill("hello while it is busy");
  await page.locator(".composer__send").click();
  await page.waitForFunction((source) => new RegExp(source).test(document.body.textContent), WAITING.source, { timeout: 10_000 });
  assert.equal(await page.locator(".chat__cancel-wait").isVisible(), true, "a Cancel control is offered while waiting");
  // The counter is the real wait: it moves on.
  const firstSeconds = Number((await bodyText(page)).match(WAITING)[1]);
  await page.waitForFunction(([source, from]) => Number(document.body.textContent.match(new RegExp(source))?.[1] ?? -1) >= from + 2, [WAITING.source, firstSeconds], { timeout: 10_000 });
  // Typing (and editing) the next message works while the reply waits.
  await page.locator(".composer__input").fill("a draft typed while waiting");
  assert.equal(await page.locator(".composer__input").inputValue(), "a draft typed while waiting");
  assert.equal(upstreamCalls, 0, "nothing was sent upstream while waiting");
  assert.deepEqual((await leases()).map((l) => l.state), ["active", "queued"]);
  await page.screenshot({ path: path.resolve(process.env.CAPACITY_SCREENSHOT_DIR || "test-results", "capacity-waiting.png") }).catch(() => {});
  // The other replica's reply finishes: this one starts and completes.
  await client.query("DELETE FROM chat_capacity_leases WHERE user_id = 'someone-else'");
  await page.waitForFunction((text) => [...document.querySelectorAll(".turn")].at(-1)?.textContent.includes(text), ANSWER, { timeout: 15_000 });
  const text = await bodyText(page);
  assert.doesNotMatch(text, WAITING, "the waiting label is gone");
  assert.equal(await page.locator(".chat__cancel-wait").count(), 0);
  assert.doesNotMatch(text, /fixture-nova-upstream-id|provider/i, "no model id or provider wording");
  assert.deepEqual(pageErrors, []);
  for (let i = 0; i < 20 && (await leases()).length; i += 1) await page.waitForTimeout(50);
  assert.deepEqual(await leases(), []);
  await context.close();
});

test("cancel while waiting: the message goes back to the composer, no error, nothing sent, no place kept in line", async () => {
  await otherReplicaHoldsNova();
  const { page, context, pageErrors } = await openNovaChat();
  await page.locator(".composer__input").fill("cancel me please");
  await page.locator(".composer__send").click();
  await page.waitForSelector(".chat__cancel-wait", { timeout: 10_000 });
  await page.locator(".chat__cancel-wait").click();
  await page.waitForFunction(() => document.querySelector(".composer__input")?.value === "cancel me please", null, { timeout: 5_000 });
  for (let i = 0; i < 40 && (await leases()).length > 1; i += 1) await page.waitForTimeout(50);
  assert.deepEqual((await leases()).map((l) => l.user_id), ["someone-else"], "the cancelled reply left the line");
  assert.equal(await page.locator(".chat-banner").count(), 0, "a cancel is not an error");
  assert.doesNotMatch(await bodyText(page), WAITING);
  assert.equal(upstreamCalls, 0);
  // The composer is usable at once: the message can be edited and sent again (and here waits again, honestly).
  await page.locator(".composer__input").fill("cancel me please, edited");
  await page.locator(".composer__send").click();
  await page.waitForFunction((source) => new RegExp(source).test(document.body.textContent), WAITING.source, { timeout: 10_000 });
  await page.locator(".chat__cancel-wait").click();
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test("saturation: the high-demand message by tier name, with Retry; nothing is invented and nothing was sent", async () => {
  await otherReplicaHoldsNova();
  config.chatCapacity.maxQueuedPerTier = 0;
  const { page, context, pageErrors } = await openNovaChat();
  await page.locator(".composer__input").fill("hello at the busiest moment");
  await page.locator(".composer__send").click();
  const banner = page.locator(".chat-banner");
  await banner.waitFor({ timeout: 10_000 });
  assert.match(await banner.textContent(), /Nova is in high demand right now, so this reply didn't start and nothing was used\. Please try again in a minute\./);
  assert.equal(await banner.getByRole("button", { name: /Retry/ }).count(), 1, "Retry is offered");
  assert.equal(upstreamCalls, 0);
  assert.doesNotMatch(await bodyText(page), /fixture-nova-upstream-id|provider/i);
  // Room again: Retry goes through.
  config.chatCapacity.maxQueuedPerTier = 40;
  await client.exec("DELETE FROM chat_capacity_leases");
  await banner.getByRole("button", { name: /Retry/ }).click();
  await page.waitForFunction((text) => [...document.querySelectorAll(".turn")].at(-1)?.textContent.includes(text), ANSWER, { timeout: 15_000 });
  assert.deepEqual(pageErrors, []);
  await context.close();
});
