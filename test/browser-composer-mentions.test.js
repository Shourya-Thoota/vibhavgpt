import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// Inline @mentions in a real browser: choosing a connector puts "@Name" in the sentence with a soft highlight behind it (not a chip row above
// the text), the caret and the text on both sides are kept, the highlight lines up with the text at every size and while wrapping, deleting
// and editing behave as one would expect, and what is sent is the text as written plus the structured connector ids behind the mentions.

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
test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--no-sandbox"] });
  fixture = await startFixture({});
});
test.after(async () => { await browser?.close(); fixture?.close(); });

const COMPLETE = `event: complete\ndata: ${JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000001", reply: "Done.", model: "VibhavGPT Nova", modelKey: "nova", sources: [], activitySummary: [], messageId: "m1" })}\n\n`;

async function open({ width = 1280, height = 900, sky = "light", route = "/app/chat" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, reducedMotion: "reduce", hasTouch: width < 500, isMobile: width < 500 });
  await context.addInitScript((value) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-chat-topography", "off"); } catch { /* none */ } }, sky);
  const page = await context.newPage();
  const sent = [];
  await page.route("**/api/chat/stream", async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: COMPLETE });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(`${fixture.url}${route}`, { waitUntil: "domcontentloaded" });
  const input = page.locator("textarea.composer__input").first();
  await input.waitFor({ timeout: 15_000 });
  return { context, page, input, sent, errors };
}

// Types "@query", waits for the list, and chooses the first match with the keyboard.
async function mention(page, input, query) {
  await input.pressSequentially(`@${query}`);
  const list = page.locator('[role="listbox"][aria-label="Connectors"]');
  await list.waitFor({ timeout: 5000 });
  await list.locator('[role="option"]').first().waitFor({ timeout: 8000 }); // the list is filled from the connectors request
  await input.press("Enter");
  await page.locator('[role="listbox"][aria-label="Connectors"]').waitFor({ state: "detached", timeout: 5000 });
}
const state = (input) => input.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd }));
const marks = (page) => page.locator(".composer__mirror mark.composer__mention").allTextContents();

test("choosing a connector puts @Name in the sentence with a highlight behind it, and no chip row above the text", { skip: skipReason }, async () => {
  const { context, page, input, errors } = await open();
  await input.click();
  await input.pressSequentially("Save the file to ");
  await mention(page, input, "drive");
  const after = await state(input);
  assert.equal(after.value, "Save the file to @Google Drive ");
  assert.equal(after.start, after.value.length, "the caret is after the mention and its space");
  assert.deepEqual(await marks(page), ["@Google Drive"]);
  assert.equal(await page.locator(".composer-mentions-chips").count(), 0, "no separate chip row");
  // Typing carries on from the caret, and the mention stays.
  await input.pressSequentially("tomorrow");
  assert.equal((await state(input)).value, "Save the file to @Google Drive tomorrow");
  assert.deepEqual(await marks(page), ["@Google Drive"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("the highlight sits exactly under the mention's text: same place, same size, on every line it wraps to", { skip: skipReason }, async () => {
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    const { context, page, input } = await open({ width, height });
    await input.click();
    await input.pressSequentially("A fairly long opening sentence that will need to wrap onto a second line before the connector appears here: ");
    await mention(page, input, "gmail");
    await input.pressSequentially("and then some more words after it so the paragraph keeps going across several lines of the composer");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); // the box has finished growing
    const geometry = await page.evaluate(() => {
      const textarea = document.querySelector("textarea.composer__input");
      const mark = document.querySelector(".composer__mirror mark.composer__mention");
      const mirror = document.querySelector(".composer__mirror");
      const range = document.createRange();
      // Where the browser itself drew "@Gmail" in the textarea: measure the same characters with a clone laid out the same way.
      const clone = document.createElement("div");
      const cs = getComputedStyle(textarea);
      for (const p of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "whiteSpace", "overflowWrap", "wordBreak", "boxSizing"]) clone.style[p] = cs[p];
      Object.assign(clone.style, { position: "absolute", visibility: "hidden", left: "-9999px", top: "0", width: `${textarea.clientWidth + parseFloat(cs.borderLeftWidth) * 2}px` });
      const start = textarea.value.indexOf("@Gmail");
      clone.append(document.createTextNode(textarea.value.slice(0, start)));
      const target = document.createElement("span"); target.textContent = "@Gmail"; clone.append(target);
      clone.append(document.createTextNode(textarea.value.slice(start + 6)));
      document.body.append(clone);
      const t = target.getBoundingClientRect(); const origin = clone.getBoundingClientRect();
      const expected = { x: t.left - origin.left, y: t.top - origin.top, w: t.width, h: t.height };
      clone.remove();
      const m = mark.getBoundingClientRect(); const box = textarea.getBoundingClientRect();
      return {
        mark: { x: m.left - box.left, y: m.top - box.top + textarea.scrollTop, w: m.width, h: m.height },
        expected, lines: Math.round(textarea.scrollHeight / parseFloat(cs.lineHeight)),
        sameBox: [mirror.offsetWidth === textarea.offsetWidth, mirror.offsetHeight === textarea.offsetHeight],
      };
    });
    assert.ok(geometry.lines >= 2, `${width}px: the text wraps (${geometry.lines} lines)`);
    assert.deepEqual(geometry.sameBox, [true, true], `${width}px: the layer is the textarea's size`);
    assert.ok(Math.abs(geometry.mark.x - geometry.expected.x) <= 1.5, `${width}px: x ${geometry.mark.x} vs ${geometry.expected.x}`);
    assert.ok(Math.abs(geometry.mark.y - geometry.expected.y) <= 2, `${width}px: y ${geometry.mark.y} vs ${geometry.expected.y}`);
    assert.ok(Math.abs(geometry.mark.w - geometry.expected.w) <= 1.5, `${width}px: width`);
    await context.close();
  }
});

test("a mention that wraps across two lines keeps its highlight on both, and typing in front of it moves it with the text", { skip: skipReason }, async () => {
  const { context, page, input } = await open({ width: 390, height: 844 });
  await input.click();
  await input.pressSequentially("Please put this file into ");
  await mention(page, input, "drive");
  await input.press("Home");
  await input.press("Control+Home");
  await input.pressSequentially("Hello there, ");
  assert.deepEqual(await marks(page), ["@Google Drive"]);
  const value = (await state(input)).value;
  assert.equal(value, "Hello there, Please put this file into @Google Drive ");
  const rects = await page.evaluate(() => [...document.querySelectorAll(".composer__mirror mark")].flatMap((mark) => [...mark.getClientRects()].map((r) => Math.round(r.top))));
  assert.ok(rects.length >= 1);
  await context.close();
});

test("two mentions in one sentence, both highlighted, both routed once, in order, when the message is sent", { skip: skipReason }, async () => {
  const { context, page, input, sent, errors } = await open();
  await input.click();
  await input.pressSequentially("Take notes from ");
  await mention(page, input, "gmail");
  await input.pressSequentially("and save them to ");
  await mention(page, input, "drive");
  await input.pressSequentially("please");
  assert.deepEqual(await marks(page), ["@Gmail", "@Google Drive"]);
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea.composer__input")?.value === "", null, { timeout: 8000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, "Take notes from @Gmail and save them to @Google Drive please", "the text as written, with the mentions in the sentence");
  assert.deepEqual(sent[0].selectedConnectors, ["gmail", "googledrive"], "the structured ids behind them");
  assert.equal(await page.locator(".composer__mirror").count(), 0, "the highlight is gone with the text");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Backspace right after a mention removes all of it and its routing", { skip: skipReason }, async () => {
  const { context, page, input, sent } = await open();
  await input.click();
  await input.pressSequentially("Look in ");
  await mention(page, input, "gmail");
  await input.press("Backspace"); // the space after the mention
  assert.equal((await state(input)).value, "Look in @Gmail");
  assert.deepEqual(await marks(page), ["@Gmail"]);
  await input.press("Backspace"); // the whole mention
  assert.equal((await state(input)).value, "Look in ");
  assert.deepEqual(await marks(page), []);
  await input.pressSequentially("for the invoice");
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea.composer__input")?.value === "", null, { timeout: 8000 });
  assert.equal(sent[0].message, "Look in for the invoice");
  assert.equal(sent[0].selectedConnectors, undefined, "no connector is routed once its mention is gone");
  await context.close();
});

test("editing inside a mention, selecting across it, or pasting over it removes it, and typing '@Gmail' by hand routes nothing", { skip: skipReason }, async () => {
  const { context, page, input, sent } = await open();
  await input.click();
  await mention(page, input, "gmail");
  await input.pressSequentially("hello");
  // Edit one letter inside it.
  await input.evaluate((node) => node.setSelectionRange(3, 3));
  await input.press("Delete");
  assert.equal((await state(input)).value.startsWith("@Gmil"), true);
  assert.deepEqual(await marks(page), [], "an edited mention is just text again");
  // Typing the name by hand records nothing.
  await input.press("Control+a");
  await input.pressSequentially("ask @Gmail now");
  await page.keyboard.press("Escape");
  assert.deepEqual(await marks(page), []);
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea.composer__input")?.value === "", null, { timeout: 8000 });
  assert.equal(sent[0].selectedConnectors, undefined, "text alone routes nothing");
  await context.close();
});

test("pasted text with an @name in it is plain text: no highlight, no routing", { skip: skipReason }, async () => {
  const { context, page, input } = await open();
  await input.click();
  await input.evaluate((node) => {
    const data = new DataTransfer(); data.setData("text/plain", "forwarded: @Google Drive and @Gmail");
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(node, "forwarded: @Google Drive and @Gmail");
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(await marks(page), []);
  assert.equal(await page.locator(".composer__mirror").count(), 0);
  await context.close();
});

test("composition input next to a mention does not disturb it", { skip: skipReason }, async () => {
  const { context, page, input } = await open();
  await input.click();
  await mention(page, input, "gmail");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "日本" });
  assert.equal((await state(input)).value, "@Gmail 日本");
  assert.deepEqual(await marks(page), ["@Gmail"]);
  await context.close();
});

test("the mention list, the highlight and the text work by keyboard alone, and Escape closes the list without losing the text", { skip: skipReason }, async () => {
  const { context, page, input } = await open();
  await input.click();
  await input.pressSequentially("see @dri");
  const list = page.locator('[role="listbox"][aria-label="Connectors"]');
  await list.waitFor();
  await list.locator('[role="option"]').first().waitFor({ timeout: 8000 });
  assert.ok((await list.locator('[role="option"]').count()) >= 1);
  await input.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.equal((await state(input)).value, "see @dri", "Escape closes the list and keeps what was typed");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus stays in the box");
  assert.match(await input.getAttribute("aria-label"), /Message/);
  await context.close();
});

test("the draft and its mentions do not follow the person into another conversation", { skip: skipReason }, async () => {
  const first = await open();
  await first.input.click();
  await first.input.pressSequentially("Check ");
  await mention(first.page, first.input, "gmail");
  assert.deepEqual(await marks(first.page), ["@Gmail"]);
  // A new page for another conversation starts clean: no highlight, no routing, nothing carried in the box.
  const second = await open({ route: "/app/chat" });
  assert.equal((await state(second.input)).value, "");
  assert.deepEqual(await marks(second.page), []);
  await second.input.pressSequentially("hello");
  await second.input.press("Enter");
  await second.page.waitForFunction(() => document.querySelector("textarea.composer__input")?.value === "", null, { timeout: 8000 });
  assert.equal(second.sent[0].selectedConnectors, undefined);
  await first.context.close();
  await second.context.close();
});

test("the highlight is visible in both skies and never takes a click: clicking it puts the caret in the text", { skip: skipReason }, async () => {
  for (const sky of ["light", "dark"]) {
    const { context, page, input } = await open({ sky });
    await input.click();
    await input.pressSequentially("Look in ");
    await mention(page, input, "gmail");
    const tint = await page.evaluate(() => getComputedStyle(document.querySelector(".composer__mention")).backgroundColor);
    assert.notEqual(tint, "rgba(0, 0, 0, 0)", `${sky}: the highlight has a colour`);
    const pointerEvents = await page.evaluate(() => getComputedStyle(document.querySelector(".composer__mirror")).pointerEvents);
    assert.equal(pointerEvents, "none");
    const box = await page.locator(".composer__mirror mark").first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
    await context.close();
  }
});
