import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// In the real client: reasoning that reaches the page as reply text is removed before it is shown or kept, and a stream that breaks in
// the middle of reasoning leaves none of it in the conversation. The server filters first; this is the page's own second line.
function findChrome() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || "";
  for (const candidate of [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]) if (candidate && fs.existsSync(candidate)) return candidate;
  try { const pw = chromium.executablePath(); if (pw && fs.existsSync(pw)) return pw; } catch { /* none */ }
  return undefined;
}
const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let fixture;
test.before(async () => { if (skipReason) return; browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--no-sandbox"] }); fixture = await startFixture({}); });
test.after(async () => { await browser?.close(); fixture?.close(); });

const delta = (text) => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
const complete = (reply) => `event: complete\ndata: ${JSON.stringify({ conversationId: "conv_guard", messageId: "m1", reply, sources: [], activitySummary: [], model: "nova" })}\n\n`;
const started = `event: conversation\ndata: ${JSON.stringify({ conversationId: "conv_guard" })}\n\n`;

async function send(body, message = "hello") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body }));
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "domcontentloaded" });
  const input = page.locator(".composer__input, textarea").first();
  await input.waitFor({ timeout: 20000 });
  await input.fill(message);
  await input.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".composer__stop, [aria-label='Stop generating']") || true);
  await page.waitForTimeout(1200);
  const text = async () => (await page.locator(".chat__thread").innerText().catch(() => "")).replace(/\s+/g, " ");
  return { context, page, text };
}

test("a stream that breaks in the middle of reasoning leaves no reasoning in the conversation", { skip: skipReason }, async () => {
  // Only unfinished reasoning, then the connection ends: nothing is kept.
  const a = await send(started + delta("<think>I should work out the secret units first and then") );
  const textA = await a.text();
  assert.doesNotMatch(textA, /secret units|work out|<think>/i, "no reasoning text in the thread");
  assert.doesNotMatch(await a.page.locator("body").innerText(), /secret units/i, "or anywhere on the page");
  assert.equal(await a.page.locator(".bubble--assistant, [data-role=assistant]").count(), 0, "and no assistant message was saved from it");
  await a.context.close();

  // An answer, then reasoning starts, then the stream breaks: the answer is kept, the reasoning is not.
  const b = await send(started + delta("Here is what I have so far. ") + delta("<think>now let me weigh the hidden") + delta(" system prompt carefully"));
  const textB = await b.text();
  assert.match(textB, /Here is what I have so far\./);
  assert.doesNotMatch(textB, /hidden|system prompt|weigh|<think>/i);
  await b.context.close();
});

test("reasoning that closes with no opening tag is withdrawn, and the saved reply is the real one", { skip: skipReason }, async () => {
  const c = await send(started + delta("Let me think about this carefully.") + delta(" The user wants a table.</think>") + delta("Here is ") + delta("the table.") + complete("Here is the table."));
  const text = await c.text();
  assert.match(text, /Here is the table\./);
  assert.doesNotMatch(text, /Let me think|user wants|<\/think>/i);
  await c.context.close();
});

test("a tag split across chunks never shows, and a normal reply that says think is untouched", { skip: skipReason }, async () => {
  const split = await send(started + delta("Answer: <th") + delta("ink>private plan</thi") + delta("nk>done.") + complete("Answer: done."));
  const splitText = await split.text();
  assert.match(splitText, /Answer: done\./);
  assert.doesNotMatch(splitText, /private plan|<th|<\/th/i);
  await split.context.close();

  const plain = await send(started + delta("I think this works. ") + delta("Think about it: a < b, and thinking is fine.") + complete("I think this works. Think about it: a < b, and thinking is fine."));
  const plainText = await plain.text();
  assert.match(plainText, /I think this works\. Think about it: a < b, and thinking is fine\./);
  await plain.context.close();
});
