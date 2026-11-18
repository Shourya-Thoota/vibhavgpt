// The composer's Stop response button and the Tecton byline (owner requests, 2026-11-15), in a real browser against the built app. A small
// server in front of the shared fixture streams a Build reply slowly and records stop requests, like the real API: the reply is named
// "VibhavGPT Tecton" from its recorded model while it streams, after it completes and when history is reopened; while it runs, Send is
// "Stop response" in the same place, the draft stays, Enter sends nothing; Stop asks the server to stop that exact reply and says so
// honestly when the server refuses. Needs `npm run build` in frontend/ first.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url));
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
const CONVERSATION = "7d3e4f50-6172-4c83-9d94-bea0f1a2b3c4";
const REPLY = "reply-under-test";

const state = { streams: 0, stops: [], stopStatus: 200, open: null };
let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath });
  const fixture = serve({ signedIn: true, emptyLibrary: true, images: false, onboarding: false });
  const delegate = fixture.listeners("request")[0];
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/chat/stream" && req.method === "POST") {
      state.streams += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (id, event, data) => res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send(1, "reply", { replyId: REPLY, detachable: true });
      send(2, "conversation", { conversationId: CONVERSATION });
      send(3, "status", { phase: "writing" });
      send(4, "delta", { text: "Here is the start of your timer page. " });
      state.open = { res, send, finish: () => { send(6, "delta", { text: "And the end." }); send(7, "complete", { conversationId: CONVERSATION, messageId: "m-done", reply: "Here is the start of your timer page. And the end.", modelKey: "tecton", model: "VibhavGPT Tecton" }); res.end(); state.open = null; } };
      req.on("close", () => { if (state.open?.res === res) state.open = null; });
      return;
    }
    if (path === `/api/chat/replies/${REPLY}/stop` && req.method === "POST") {
      state.stops.push(REPLY);
      if (state.stopStatus === 200 && state.open) { state.open.send(5, "error", { error: "Stopped.", code: "client-aborted" }); state.open.res.end(); state.open = null; }
      res.writeHead(state.stopStatus, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(state.stopStatus === 200 ? { stopped: true } : { error: "Unavailable." }));
    }
    if (path === "/api/chat/replies") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ replies: [] })); }
    return delegate(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

async function proPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 860 } });
  const page = await context.newPage();
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ subscription: { tier: "pro", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true }) }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "pro" } }); });
  await page.goto(`${base}/app/build`, { waitUntil: "networkidle" });
  return { context, page };
}
const byline = (page) => page.locator(".turn__byline").last();

test("Stop response: replaces Send while the Build reply runs, keeps the draft, stops that exact reply on the server, then Send returns", { skip }, async () => {
  Object.assign(state, { streams: 0, stops: [], stopStatus: 200 });
  const { context, page } = await proPage(1280);
  const box = page.locator("textarea").first();
  await box.fill("Build me a timer page");
  await box.press("Enter");
  await page.getByText("Here is the start of your timer page.").waitFor();
  assert.match(await byline(page).innerText(), /VibhavGPT Tecton/, "named while it streams");
  const stop = page.getByRole("button", { name: "Stop response" });
  assert.equal(await stop.count(), 1, "Send became Stop response");
  assert.equal(await page.getByRole("button", { name: "Send message" }).count(), 0);
  assert.equal(await page.locator(".chat__stop, .chat__cancel-wait").count(), 0, "no separate text Stop control");
  const size = await stop.boundingBox();
  assert.ok(size.width >= 43.5 && size.height >= 43.5, "a 44px target");
  await box.fill("Make the buttons bigger next");
  await box.press("Enter");
  assert.equal(state.streams, 1, "Enter sends nothing while the reply runs");
  assert.equal(await box.inputValue(), "Make the buttons bigger next", "the draft stays");
  await stop.click();
  await page.getByText("You stopped this response.").waitFor();
  assert.deepEqual(state.stops, [REPLY], "the server was asked to stop that exact reply");
  await page.getByRole("button", { name: "Send message" }).waitFor();
  assert.equal(await box.inputValue(), "Make the buttons bigger next", "the draft is still there");
  assert.equal(await page.getByText("Here is the start of your timer page.").count(), 1, "the partial answer is kept once");
  await context.close();
});

test("when the server refuses to stop, the page says so and the reply goes on; it completes as VibhavGPT Tecton", { skip }, async () => {
  Object.assign(state, { streams: 0, stops: [], stopStatus: 500 });
  const { context, page } = await proPage(390);
  const box = page.locator("textarea").first();
  await box.fill("Build me a timer page");
  await box.press("Enter");
  await page.getByText("Here is the start of your timer page.").waitFor();
  await page.getByRole("button", { name: "Stop response" }).click();
  await page.getByText("Couldn't stop this response. It's still running; try Stop again.").waitFor();
  assert.equal(await page.getByText("You stopped this response.").count(), 0, "no claim that it stopped");
  assert.equal(await page.getByRole("button", { name: "Stop response" }).count(), 1, "Stop is offered again");
  state.open.finish();
  await page.getByText("And the end.").waitFor();
  // On a phone Send shows only when there is text; what matters is that Stop is gone once the reply has ended.
  await page.getByRole("button", { name: "Stop response" }).waitFor({ state: "detached" });
  assert.match(await byline(page).innerText(), /VibhavGPT Tecton/, "the saved reply keeps its name");
  assert.equal(state.streams, 1);
  await context.close();
});

test("history: a reply recorded as Tecton reopens as VibhavGPT Tecton; one with no recorded model stays VibhavGPT", { skip }, async () => {
  const { context, page } = await proPage(1280);
  await page.route(`**/api/chat/conversations/${CONVERSATION}**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    conversation: { id: CONVERSATION, title: "Timer", model: "tecton", mode: "chat", temporary: false },
    history: [
      { id: "u1", role: "user", content: "Build me a timer page", createdAt: "2026-11-15T01:00:00.000Z", metadata: {} },
      // The API's shape: each reply carries the model recorded with it (repository.js replyModelKey), or null.
      { id: "a1", role: "assistant", content: "A timer page.", createdAt: "2026-11-15T01:00:05.000Z", model: "tecton", metadata: {} },
      { id: "u2", role: "user", content: "Older question", createdAt: "2026-11-15T01:01:00.000Z", metadata: {} },
      { id: "a2", role: "assistant", content: "An older answer.", createdAt: "2026-11-15T01:01:05.000Z", model: null, metadata: {} },
    ], hasMore: false, nextCursor: null,
  }) }));
  await page.goto(`${base}/app/build?conversation=${CONVERSATION}`, { waitUntil: "networkidle" });
  await page.getByText("A timer page.").waitFor();
  const bylines = (await page.locator(".turn__byline").allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(bylines, ["VibhavGPT Tecton", "VibhavGPT"], "named by the recorded model, never guessed");
  assert.doesNotMatch(await page.locator("body").innerText(), /qwen|cloudflare|openrouter/i);
  await context.close();
});
