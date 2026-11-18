// Slice 3 in the built app: the Memory page shows where each memory came from and can make a project memory personal; Settings has
// separate use/save switches; a new chat can be made temporary, which the request carries and the thread then shows. Emulated phone
// (390x844, touch) and desktop in headless Chromium against a fixture: no real account, model or provider. Not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture } from "./support/extensions-fixture.js";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const now = new Date("2026-11-09T12:00:00Z").toISOString();
const later = new Date("2026-11-10T09:00:00Z").toISOString();
const facts = () => [
  { id: "11111111-1111-4111-8111-111111111111", content: "User prefers answers in metric units.", category: "preferences", scope: "personal", projectId: null, projectName: null, origin: "manual", source: "manual", sourceConversationId: null, createdAt: now, updatedAt: now },
  { id: "22222222-2222-4222-8222-222222222222", content: "User's Quillmoss launch city is Tromso.", category: "recent_work", scope: "project", projectId: "33333333-3333-4333-8333-333333333333", projectName: "Quillmoss launch", origin: "explicit", source: "assistant", sourceConversationId: "44444444-4444-4444-8444-444444444444", createdAt: now, updatedAt: later },
  { id: "55555555-5555-4555-8555-555555555555", content: "User studies marine biology.", category: "academics", scope: "personal", projectId: null, projectName: null, origin: "inferred", source: "auto", sourceConversationId: null, createdAt: now, updatedAt: now },
];

let browser; let fixture;
test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
  fixture = await startFixture({ memory: { facts: facts(), useEnabled: true, saveEnabled: true } });
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open(route, { width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}) });
  await context.addInitScript(() => { localStorage.setItem("vibhavgpt-theme", "dark"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); });
  const page = await context.newPage();
  await page.goto(`${fixture.url}${route}`, { waitUntil: "load" });
  return { context, page };
}

test("Memory page on a phone: scope, origin, source and dates for each memory; no sideways scroll; 44px actions", { skip: skipReason }, async () => {
  fixture.state.memory.facts = facts();
  const { context, page } = await open("/app/memory");
  await page.getByText("Quillmoss launch city is Tromso").waitFor({ timeout: 20000 });
  const project = page.locator(".memory-fact", { hasText: "Tromso" });
  assert.match(await project.locator(".memory-fact__meta").innerText(), /Project: Quillmoss launch/);
  assert.match(await project.locator(".memory-fact__meta").innerText(), /You asked VibhavGPT to remember this/);
  assert.match(await project.locator(".memory-fact__meta").innerText(), /Saved .*updated/i, "created and updated dates are shown");
  assert.equal(await project.getByRole("button", { name: "Open the chat" }).count(), 1, "links to the chat it came from");
  const manual = page.locator(".memory-fact", { hasText: "metric units" });
  assert.match(await manual.locator(".memory-fact__meta").innerText(), /Personal/);
  assert.match(await manual.locator(".memory-fact__meta").innerText(), /Added by you/);
  assert.equal(await manual.getByRole("button", { name: "Make personal" }).count(), 0, "only project memories can be made personal");
  assert.match(await page.locator(".memory-fact", { hasText: "marine biology" }).locator(".memory-fact__meta").innerText(), /VibhavGPT saved this from a chat/);
  const metrics = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - innerWidth,
    // Layout height: the cards' entrance animation scales them for a moment, which a bounding box would include.
    small: [...document.querySelectorAll(".memory-fact .fact__actions .btn")].filter((el) => el.offsetHeight < 44).length,
  }));
  assert.ok(metrics.over <= 1, `sideways scroll by ${metrics.over}px`);
  assert.equal(metrics.small, 0, "every memory action is at least 44px tall on a phone");
  await project.getByRole("button", { name: "Make personal" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".memory-fact")].some((el) => /Tromso/.test(el.textContent) && /Personal/.test(el.querySelector(".memory-fact__meta")?.textContent ?? "")));
  assert.ok(fixture.state.calls.includes("PATCH /api/memory/22222222-2222-4222-8222-222222222222"));
  assert.deepEqual(fixture.state.bodies.at(-1), { scope: "personal" });
  await context.close();
});

test("Settings: using and saving memory are separate switches, and turning saving off says nothing is deleted", { skip: skipReason }, async () => {
  fixture.state.memory = { facts: facts(), useEnabled: true, saveEnabled: true };
  const { context, page } = await open("/app/settings/personalization", { width: 1280, height: 900 });
  const save = page.getByRole("radiogroup", { name: "Save new memories" }).or(page.getByRole("group", { name: "Save new memories" }));
  await save.first().waitFor({ timeout: 20000 });
  assert.equal(await page.getByRole("radiogroup", { name: "Use memory when answering" }).or(page.getByRole("group", { name: "Use memory when answering" })).count() >= 1, true);
  await save.first().getByText("Off", { exact: true }).click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  assert.equal(fixture.state.memory.saveEnabled, false);
  assert.equal(fixture.state.memory.useEnabled, true, "use is left alone");
  assert.deepEqual(fixture.state.bodies.at(-1), { save: false });
  assert.match(await page.locator("#memory-settings").innerText(), /deletes nothing/);
  await context.close();
  // Restore the fixture's setting for any later test.
  fixture.state.memory.saveEnabled = true;
});

const streamFixture = (temporary) => async (route) => {
  const sent = JSON.parse(route.request().postData() || "{}");
  route.request().sentBody = sent;
  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: frame("conversation", { conversationId: "66666666-6666-4666-8666-666666666666", messageId: "77777777-7777-4777-8777-777777777777" }) + frame("complete", { conversationId: "66666666-6666-4666-8666-666666666666", messageId: "88888888-8888-4888-8888-888888888888", reply: "Fixture reply.", model: "VibhavGPT Nova", modelKey: "nova", sources: [], activitySummary: [], temporary }) });
};
const TOOLTIP = "Temporary chat \u2014 no memory used or saved, not kept.";

// Slice 4.1: the temporary-chat entry is one icon button at the top right of the header, not a pill under the greeting.
for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }], ["small phone", { width: 320, height: 640 }]]) {
  test(`${label}: the temporary-chat icon sits top right in the header, the old pill and caption are gone, nothing overflows`, { skip: skipReason }, async () => {
    const { context, page } = await open("/app/chat", size);
    const button = page.getByRole("button", { name: "Temporary chat" });
    await button.waitFor({ timeout: 20000 });
    assert.equal(await button.count(), 1, "exactly one, in the header");
    assert.equal(await button.getAttribute("title"), TOOLTIP, "native tooltip");
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    const metrics = await page.evaluate(() => {
      const el = document.querySelector(".temporary-chat-button");
      const r = el.getBoundingClientRect();
      const neighbour = [...document.querySelectorAll(".topbar-mobile .ui-icon-button, .sidebar__toggle")].find((n) => n !== el && n.getBoundingClientRect().width > 0);
      return {
        inHeader: Boolean(el.closest(".mode-tabs-bar, .topbar-mobile")),
        rightGap: innerWidth - r.right, top: r.top, width: el.offsetWidth, height: el.offsetHeight,
        neighbourSize: neighbour ? [neighbour.offsetWidth, neighbour.offsetHeight] : null,
        over: document.documentElement.scrollWidth - innerWidth,
        pill: Boolean(document.querySelector(".temporary-toggle, .temporary-choice, #temporary-chat-note")),
        caption: /Start a chat that doesn/.test(document.body.innerText),
      };
    });
    assert.ok(metrics.inHeader, "the button is in the header");
    assert.ok(metrics.top < 60, `top of the screen (${metrics.top}px)`);
    assert.ok(metrics.rightGap < (size.width <= 760 ? 70 : 30), `right side (${metrics.rightGap}px from the edge)`);
    assert.equal(metrics.pill, false, "the centred pill is gone");
    assert.equal(metrics.caption, false, "the caption is gone");
    assert.ok(metrics.over <= 1, `no sideways scroll (${metrics.over}px)`);
    if (size.width <= 760) {
      assert.ok(metrics.width >= 44 && metrics.height >= 44, `44px touch target (${metrics.width}x${metrics.height})`);
      assert.deepEqual([metrics.width, metrics.height], metrics.neighbourSize, "the same size as the header's other icon buttons");
    } else {
      assert.deepEqual([metrics.width, metrics.height], metrics.neighbourSize, "the same size as the header's other icon buttons");
    }
    await context.close();
  });
}

test("a temporary chat: the header icon presses on, the first request carries it, the thread shows the notice, and the icon offers to leave", { skip: skipReason }, async () => {
  const { context, page } = await open("/app/chat");
  let sent = null;
  await page.route("**/api/chat/stream", async (route) => { sent = JSON.parse(route.request().postData() || "{}"); await streamFixture(true)(route); });
  const toggle = page.getByRole("button", { name: "Temporary chat" });
  await toggle.waitFor({ timeout: 20000 });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.match(await page.locator(".temporary-banner").innerText(), /isn't used or saved.*deleted after 24 hours/, "the one notice explains it once it is on");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "false", "on the new-chat screen it toggles back off");
  assert.equal(await page.locator(".temporary-banner").count(), 0);
  await toggle.click();
  await page.locator("textarea.composer__input").first().fill("A synthetic temporary question.");
  await page.keyboard.press("Enter");
  await page.locator(".chat__thread .temporary-banner").waitFor({ timeout: 15000 });
  assert.equal(sent?.temporary, true, "the first request asks for a temporary chat");
  assert.equal(await page.locator(".temporary-banner").count(), 1, "the notice is not duplicated");
  assert.equal(await toggle.getAttribute("aria-pressed"), "true", "inside the temporary chat the icon is pressed");
  await toggle.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5000 });
  assert.match(await dialog.innerText(), /Leave this temporary chat\?/);
  await dialog.getByRole("button", { name: "Stay here" }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".chat__thread .temporary-banner").count(), 1, "staying keeps the temporary chat");
  await toggle.click();
  await page.getByRole("dialog").getByRole("button", { name: "Start a normal chat" }).click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".chat__thread").count(), 0, "a fresh chat");
  assert.equal(await page.getByRole("button", { name: "Temporary chat" }).getAttribute("aria-pressed"), "false", "and it is a normal one");
  await context.close();
});

test("inside a normal chat, the header icon starts a new temporary chat", { skip: skipReason }, async () => {
  const { context, page } = await open("/app/chat");
  const bodies = [];
  await page.route("**/api/chat/stream", async (route) => { bodies.push(JSON.parse(route.request().postData() || "{}")); await streamFixture(bodies.length > 1)(route); });
  await page.locator("textarea.composer__input").first().fill("A synthetic normal question.");
  await page.keyboard.press("Enter");
  await page.locator(".chat__thread").waitFor({ timeout: 15000 });
  assert.equal(bodies[0]?.temporary, undefined, "a normal chat sends no temporary flag");
  const toggle = page.getByRole("button", { name: "Temporary chat" });
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".chat__thread").count(), 0, "a new chat opened");
  assert.equal(await page.getByRole("button", { name: "Temporary chat" }).getAttribute("aria-pressed"), "true", "already temporary");
  await page.locator("textarea.composer__input").first().fill("A synthetic temporary question.");
  await page.keyboard.press("Enter");
  await page.locator(".chat__thread .temporary-banner").waitFor({ timeout: 15000 });
  assert.equal(bodies[1]?.temporary, true);
  assert.equal(bodies[1]?.conversationId ?? null, null, "it is a new conversation, not the old one turned temporary");
  await context.close();
});
