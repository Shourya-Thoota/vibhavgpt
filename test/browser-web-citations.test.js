import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";

// In the real client (owner request 2026-11-15): [n] in a searched reply is a small numbered link to the nth source, opening that page in
// a new tab; a number with no source stays plain text; code is left alone; and the Sources list under the reply is numbered the same
// way. The reply and its sources come from a stubbed stream; nothing is fetched from the sources' sites.
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

const SOURCES = [
  { n: 1, title: "Eiffel Tower facts", url: "https://www.toureiffel.paris/en/the-monument", domain: "toureiffel.paris", publishedDate: "2026-10-01" },
  { n: 2, title: "Paris guide", url: "https://example.org/paris", domain: "example.org", publishedDate: null },
];
const REPLY = "The tower is 330 metres tall [1] and stands in Paris [2]. A stray [7] stays text. In code, `items[1]` is untouched.";
const frames = [
  `event: conversation\ndata: ${JSON.stringify({ conversationId: "conv_cite" })}\n\n`,
  `event: delta\ndata: ${JSON.stringify({ text: REPLY })}\n\n`,
  `event: complete\ndata: ${JSON.stringify({ conversationId: "conv_cite", messageId: "m1", reply: REPLY, sources: SOURCES, activitySummary: ["Searched the web"], model: "lumen", webSearched: true })}\n\n`,
].join("");

for (const [width, sky] of [[1280, "light"], [390, "dark"]]) {
  test(`citations at ${width}px (${sky}): numbered links to the real sources, and a matching numbered Sources list`, { skip: skipReason }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: sky, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript((s) => { try { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, sky);
    const page = await context.newPage();
    const thirdParty = [];
    page.on("request", (request) => { if (/toureiffel|example\.org/.test(request.url())) thirdParty.push(request.url()); });
    await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: frames }));
    // The fixture's saved conversation already has a model, so Enter sends.
    await page.goto(`${fixture.url}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
    const input = page.locator(".composer__input, textarea").first();
    await input.waitFor({ timeout: 20000 });
    await input.fill("Tell me about the Eiffel Tower");
    await input.press("Enter");
    const citations = page.locator(".bubble--assistant a.citation");
    await citations.first().waitFor({ timeout: 15000 });

    const found = await citations.evaluateAll((links) => links.map((a) => ({ text: a.textContent, href: a.href, target: a.target, rel: a.rel, label: a.getAttribute("aria-label") })));
    assert.deepEqual(found, [
      { text: "1", href: "https://www.toureiffel.paris/en/the-monument", target: "_blank", rel: "noopener noreferrer", label: "Source 1: Eiffel Tower facts, toureiffel.paris" },
      { text: "2", href: "https://example.org/paris", target: "_blank", rel: "noopener noreferrer", label: "Source 2: Paris guide, example.org" },
    ]);
    // The new reply is the last one in the saved conversation.
    const lastProse = page.locator(".bubble--assistant .prose").last();
    const prose = (await lastProse.innerText()).replace(/\s+/g, " ");
    assert.match(prose, /A stray \[7\] stays text\./, "a number with no source is not a link");
    assert.equal(await lastProse.locator("code").innerText(), "items[1]", "code is untouched");
    const box = await citations.first().boundingBox();
    assert.ok(box.height < 24, "the citation is a small pill inside the line, not a block");

    await page.getByRole("button", { name: "Sources (2)" }).click();
    const list = page.getByRole("list", { name: "Web sources, numbered as the reply cites them" });
    await list.waitFor();
    const rows = await list.locator("li").evaluateAll((items) => items.map((li) => ({ value: li.value, title: li.querySelector(".sources-list__title")?.textContent, meta: li.querySelector(".sources-list__meta")?.textContent, href: li.querySelector("a")?.href })));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.value, row.title, row.href]), [[1, "Eiffel Tower facts", "https://www.toureiffel.paris/en/the-monument"], [2, "Paris guide", "https://example.org/paris"]]);
    assert.match(rows[0].meta, /^toureiffel\.paris · Oct 1, 2026$/);
    assert.equal(rows[1].meta, "example.org · date not stated", "a missing date is said, never invented");
    for (const link of await list.locator("a").all()) assert.ok((await link.boundingBox()).height >= 44, "each source row is a 44px target");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no sideways scroll");
    assert.deepEqual(thirdParty, [], "nothing was requested from the sources' own sites");
    await page.screenshot({ path: path.resolve(`test-results/web-citations-${width}-${sky}.png`) }).catch(() => {});
    await context.close();
  });
}

test("a reply saved with cited sources reopens with the same citations, and its Sources list opens with the cited ones first", { skip: skipReason }, async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const saved = [
    { id: "u1", role: "user", content: "How tall is the Eiffel Tower?", createdAt: "2026-11-15T10:00:00.000Z" },
    { id: "a1", role: "assistant", content: "It is 330 metres tall [1].", model: "lumen", createdAt: "2026-11-15T10:00:05.000Z",
      sources: [{ ...SOURCES[0], cited: true }, { ...SOURCES[1], cited: false }], activitySummary: ["Searched the web"] },
  ];
  // Only this conversation's history is replaced; everything else is the fixture's.
  await page.route((url) => url.pathname === `/api/chat/conversations/${CONVERSATION_ID}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, history: saved, hasMore: false, nextCursor: null } });
  });
  await page.goto(`${fixture.url}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  const citation = page.locator(".bubble--assistant a.citation").last();
  await citation.waitFor({ timeout: 15000 });
  assert.equal(await citation.getAttribute("href"), "https://www.toureiffel.paris/en/the-monument");
  const box = await citation.evaluate((el) => { const r = el.getBoundingClientRect(); const a = getComputedStyle(el, "::after"); return { inset: a.inset, h: r.height }; });
  assert.notEqual(box.inset, "auto", "the small pill has a larger touch area");
  const cited = page.getByRole("list", { name: "Sources cited in this reply" });
  await cited.waitFor();
  assert.equal(await cited.locator("li").count(), 1, "only the cited source is in the cited list");
  assert.equal(await page.getByText("Also searched").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Sources (2)" }).getAttribute("aria-expanded"), "true", "open by default");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  await page.screenshot({ path: path.resolve("test-results/web-citations-reload-375.png") }).catch(() => {});
  await context.close();
});
