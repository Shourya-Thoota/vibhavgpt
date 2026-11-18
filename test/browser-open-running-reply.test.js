// "Open chat" on a reply that is still running elsewhere (owner report, 2026-11-15: it looked like the reply restarted and its timer went
// back to 0). Reopening attaches to the same run: the timer carries on from when the run started on the server, the partial reply already
// written is shown, and nothing is sent again. A small server in front of the shared fixture plays a run that started 45 s ago.
// Needs `npm run build` in frontend/ first.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url));
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
const REPLY = "reply-running-elsewhere";
const RUN_AGE_SECONDS = 45;

const state = { partial: "", sends: 0, startedAt: null, attaches: [] };
let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath });
  const fixture = serve({ signedIn: true });
  const delegate = fixture.listeners("request")[0];
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/chat/replies") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ replies: [{ replyId: REPLY, conversationId: CONVERSATION_ID, mode: "chat", startedAt: state.startedAt, phase: "thinking" }] }));
    }
    if (url.pathname === `/api/chat/replies/${REPLY}/events`) {
      state.attaches.push(url.searchParams.get("after"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`id: 1\nevent: status\ndata: ${JSON.stringify({ phase: "thinking" })}\n\n`);
      if (state.partial) res.write(`id: 2\nevent: delta\ndata: ${JSON.stringify({ text: state.partial })}\n\n`);
      // The run is still going: the stream stays open.
      return;
    }
    if (url.pathname === "/api/chat/stream") { state.sends += 1; res.writeHead(500); return res.end(); }
    return delegate(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.closeAllConnections?.(); server?.close(); });

async function openFromBanner(width) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${base}/app/image`, { waitUntil: "domcontentloaded" });
  const open = page.locator(".background-task__open");
  await open.waitFor({ timeout: 15000 });
  await open.click();
  await page.waitForURL(new RegExp(`conversation=${CONVERSATION_ID}`), { timeout: 15000 });
  return { context, page };
}

for (const width of [1280, 375]) {
  test(`${width}px: Open chat follows the running reply with its own elapsed time, not from 0`, { skip }, async () => {
    Object.assign(state, { partial: "", sends: 0, attaches: [], startedAt: new Date(Date.now() - RUN_AGE_SECONDS * 1000).toISOString() });
    const { context, page } = await openFromBanner(width);
    const label = page.getByText(/^Thinking\.\.\. \(\d+ s\)$/).last();
    await label.waitFor({ timeout: 15000 });
    const seconds = Number((await label.innerText()).match(/\((\d+) s\)/)[1]);
    assert.ok(seconds >= RUN_AGE_SECONDS - 1, `the timer continues from the run's start (${seconds} s, run started ${RUN_AGE_SECONDS} s ago)`);
    assert.deepEqual(state.attaches, ["0"], "attached once, replaying the run from its first event");
    assert.equal(state.sends, 0, "nothing was sent again");
    await context.close();
  });

  test(`${width}px: Open chat shows the partial reply already written, and sends nothing`, { skip }, async () => {
    Object.assign(state, { partial: "The first half of an answer that is still being written.", sends: 0, attaches: [], startedAt: new Date(Date.now() - RUN_AGE_SECONDS * 1000).toISOString() });
    const { context, page } = await openFromBanner(width);
    await page.getByText(state.partial).waitFor({ timeout: 15000 });
    assert.equal(state.sends, 0, "the reply was not started again");
    assert.equal(await page.getByText(state.partial).count(), 1, "the partial reply is shown once");
    await context.close();
  });
}
