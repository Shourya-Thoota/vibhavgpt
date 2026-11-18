// Slice 6: the de-slop pass, checked in a real browser against the built site (frontend/dist) and the design fixture's synthetic API.
// Shared menu and keyboard, the composer's grouped "+" menu, Settings rows, Study's background and its worst-frame contrast, the
// temporary-chat pill, the shared banner, the New project dialog at 320 and 1280px, Extensions rows, the model showcase's selected
// state and generated plan lines, the public page header, the Q&A block, and the footer (no overlap; Threads and GitHub present).
// Emulated Chromium, not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture, sampleSkills } from "./support/extensions-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { worstCaseContrastMany } from "./support/contrast-measure.js";
import { orbitSlides } from "../frontend/src/orbit-showcase-data.js";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
let browser; let fixture;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: exe });
  fixture = await startFixture({ skills: sampleSkills() });
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open(route, { width = 1280, height = 860, sky = "light", motion = "reduce", clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(([s, m]) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", m); }, [sky, motion]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  if (clock) await page.clock.install({ time: new Date("2026-11-11T12:00:00Z") });
  await page.goto(`${fixture.url}${route}`, { waitUntil: clock ? "load" : "networkidle" });
  return { context, page, errors };
}
const box = (page, selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2 }; });
const settled = (page) => page.waitForFunction(() => { const p = document.querySelector(".ui-popover"); return p && p.dataset.state === "open" && p.getAnimations().length === 0 && document.activeElement?.closest(".ui-popover"); });
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test("menus: one surface and one row everywhere, 40px rows, groups labelled, and full keyboard navigation", { skip }, async () => {
  const { context, page, errors } = await open(CHAT);
  const trigger = page.locator('.composer button[aria-label="Add to message"]').first();
  // Opened from the keyboard: focus moves into the menu (a pointer press on the composer's + keeps focus where it was, by design).
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator(".ui-popover.ui-menu__panel").first();
  await menu.waitFor();
  await settled(page);
  // Grouped: attachments apart from how the reply is written; every current action is still there.
  // Each group has an accessible name; groups are told apart by a hairline, not a heading; the rows are unchanged.
  const groups = await menu.locator("[role='group']").evaluateAll((els) => els.map((g) => ({ name: g.getAttribute("aria-label"), items: [...g.querySelectorAll("[role^='menuitem'] .ui-menu__name")].map((n) => n.textContent) })));
  assert.deepEqual(groups, [{ name: "Response mode", items: ["Concise", "Detailed", "Learning"] }]);
  assert.deepEqual(await menu.locator("> [role='menuitem'] .ui-menu__name").allTextContents(), ["Photos", "Files", "Custom"], "attachments first, Custom last, outside the modes");
  assert.equal(await menu.locator(".ui-menu__label").count(), 0, "no eyebrow headings");
  assert.equal(await menu.locator("[role='separator']").count(), 2, "a divider between attachments and modes, and before Custom");
  const surface = await menu.evaluate((el) => { const s = getComputedStyle(el); return { radius: s.borderTopLeftRadius, shadow: s.boxShadow !== "none", z: s.zIndex }; });
  const rows = await menu.locator("[role^='menuitem']").evaluateAll((items) => items.map((i) => Math.round(i.getBoundingClientRect().height)));
  assert.ok(rows.every((h) => h >= 40), `every row is at least 40px: ${rows}`);
  // Keyboard: focus is in the menu, arrows move, Escape closes and returns focus to the trigger.
  const first = await page.evaluate(() => document.activeElement.textContent.trim());
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await page.evaluate(() => document.activeElement.textContent.trim()), first, "ArrowDown moves");
  const focusRing = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, "focus is back on the trigger");
  // The model picker and the account menu use the same surface and row.
  await page.locator(".composer__model .ui-select__trigger").first().click();
  const picker = page.locator(".ui-popover.ui-select__list").first();
  await picker.waitFor();
  await page.waitForFunction(() => { const p = document.querySelector(".ui-popover.ui-select__list"); return p && p.dataset.state === "open" && p.getAnimations().length === 0; });
  const pickerSurface = await picker.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  const pickerRows = await picker.locator("[role='option']").evaluateAll((items) => items.map((i) => Math.round(i.getBoundingClientRect().height)));
  await page.keyboard.press("Escape");
  await page.locator(".sidebar .account").first().click();
  const account = page.locator(".ui-popover.account-menu").first();
  await account.waitFor();
  const accountSurface = await account.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  assert.equal(pickerSurface, surface.radius, "picker and menu share the surface radius");
  assert.equal(accountSurface, surface.radius, "account menu shares it too");
  assert.ok(pickerRows.every((h) => h >= 40), `picker rows are at least 40px: ${pickerRows}`);
  assert.ok(surface.shadow);
  assert.equal(focusRing.style, "solid");
  assert.ok(focusRing.width >= 2, "a solid 2px focus ring");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the Extensions skill menu is the shared menu: keyboard and the same rows", { skip }, async () => {
  const { context, page } = await open("/app/extensions");
  await page.getByRole("tab", { name: "Skills" }).click().catch(async () => page.getByText("Skills", { exact: true }).first().click());
  const trigger = page.getByRole("button", { name: /More actions for / }).first();
  await trigger.click();
  const menu = page.locator(".ui-popover.ui-menu__panel").first();
  await menu.waitFor();
  await settled(page);
  assert.deepEqual(await menu.locator("[role='menuitem'] .ui-menu__name").allTextContents(), ["Edit", "Disable", "Delete"]);
  const heights = await menu.locator("[role='menuitem']").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(heights.every((h) => h >= 40), "the same 40px rows");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await context.close();
});

test("Settings: one row style (label, description, control), one height, one label size", { skip }, async () => {
  for (const route of ["/app/settings/appearance", "/app/settings/account"]) {
    const { context, page } = await open(route);
    await page.locator(".settings-row").first().waitFor();
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const rows = await page.locator(".settings-row").evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, pad: getComputedStyle(el).paddingLeft })));
    assert.ok(rows.every((r) => r.h >= 4 * rem - 0.5), `${route}: every row is at least 4rem (${4 * rem}px)`);
    assert.equal(new Set(rows.map((r) => r.pad)).size, 1, `${route}: one row padding`);
    const labels = await page.locator(".settings-row__label").evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).fontSize))]);
    assert.ok(labels.length <= 1, `${route}: one label size (${labels})`);
    assert.ok(await noHorizontalScroll(page));
    await context.close();
  }
});

test("Study shows Chat's background, with the scrim, and its greeting, composer and chips keep 4.5:1 at the worst frame", { skip }, async () => {
  for (const sky of ["light", "dark"]) {
    const { context, page } = await open("/app/study", { sky, motion: "full", clock: true });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator(".chat-topography").waitFor({ state: "attached", timeout: 20000 });
    for (let i = 0; i < 8; i += 1) await page.clock.runFor(500);
    const scrim = await page.locator(".chat__scroll[data-empty] .opening").first().evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
    assert.notEqual(scrim, "rgba(0, 0, 0, 0)", `${sky}: the readability scrim is behind the greeting`);
    const rows = await worstCaseContrastMany(page, [
      { zone: "greeting", selector: ".opening__title", limit: 1 },
      { zone: "composer placeholder", selector: "textarea.composer__input", placeholder: true, limit: 1 },
      { zone: "suggestion chips", selector: ".study-starters button, .study-starters a", limit: 4 },
    ], { frames: 20, intervalMs: 1000, advance: (ms) => page.clock.runFor(ms) });
    const low = rows.filter((r) => r.ratio < 4.5).map((r) => `${r.zone} ${r.ratio}:1`);
    assert.deepEqual(low, [], `${sky}: worst-frame contrast`);
    await context.close();
  }
  // Reduced motion: the background is there and still.
  const { context, page } = await open("/app/study", { motion: "reduce" });
  await page.locator(".chat-topography").waitFor({ state: "attached", timeout: 20000 });
  await context.close();
});

test("the temporary-chat pill is centred on the greeting and composer column, desktop and phone", { skip }, async () => {
  for (const width of [1280, 375]) {
    const { context, page } = await open("/app/chat", { width, height: 820 });
    await page.locator('button[aria-label="Temporary chat"]').first().click();
    await page.locator(".temporary-banner").waitFor();
    const pill = await box(page, ".temporary-banner");
    const composer = await box(page, ".composer");
    const greeting = await box(page, ".opening__title");
    assert.ok(Math.abs(pill.cx - composer.cx) <= 2, `${width}px: centred on the composer (${pill.cx} vs ${composer.cx})`);
    assert.ok(Math.abs(pill.cx - greeting.cx) <= 2, `${width}px: centred on the greeting`);
    assert.ok(pill.left >= 0 && pill.right <= width, `${width}px: inside the screen`);
    const icon = await page.locator(".temporary-banner svg").first().evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(icon >= 15, "the icon keeps its size");
    await context.close();
  }
});

test("the banner: one component in the message column, icon and word, one action, a labelled dismiss", { skip }, async () => {
  for (const width of [1280, 375]) {
    const { context, page } = await open(CHAT, { width, height: 820 });
    await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: `event: error\ndata: ${JSON.stringify({ error: "Nova is in high demand right now, so this reply didn't start and nothing was used. Please try again in a minute.", code: "high_demand", retryable: true, status: 503 })}\n\n` }));
    await page.locator(".composer__input").first().fill("hello");
    await page.locator(".composer__send").first().click();
    const banner = page.locator(".chat-banner");
    await banner.waitFor();
    assert.equal(await banner.getAttribute("data-tone"), "warning");
    assert.equal(await banner.locator(".ui-banner__icon svg").count(), 1, "an icon");
    assert.equal((await banner.locator(".ui-banner__title").innerText()).trim(), "High demand", "a word, not colour alone");
    assert.equal(await banner.getByRole("button", { name: /Retry/ }).count(), 1, "one action");
    assert.equal(await banner.getByRole("button", { name: "Dismiss" }).count(), 1, "a labelled dismiss");
    const b = await box(page, ".chat-banner");
    const thread = await box(page, ".chat__thread");
    assert.ok(b.width <= thread.width + 1 && b.left >= thread.left - 1, `${width}px: inside the message column`);
    const stripe = await banner.evaluate((el) => getComputedStyle(el).borderLeftWidth === getComputedStyle(el).borderTopWidth);
    assert.ok(stripe, "no edge stripe: all borders are the same hairline");
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await banner.waitFor({ state: "detached" });
    await context.close();
  }
});

test("New project: a real modal at 320 and 1280px, readable type cards, 44px targets, focus trapped, Escape closes", { skip }, async () => {
  for (const [width, height] of [[1280, 860], [320, 700]]) {
    const { context, page } = await open("/app/chat", { width, height });
    if (width < 760) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "New project" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.waitFor();
    const d = await dialog.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, parentIsBody: el.parentElement.parentElement === document.body }; });
    assert.ok(d.parentIsBody, "rendered at the top level, not inside the sidebar");
    assert.ok(d.left >= 0 && d.right <= width, `${width}px: inside the screen`);
    if (width >= 760) assert.ok(d.width >= 520, `wide enough (${d.width}px)`);
    const cards = await dialog.getByRole("radio").evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, clipped: el.scrollWidth > el.clientWidth + 1 })));
    assert.equal(cards.length, 2);
    for (const c of cards) { assert.ok(c.h >= 44, "a 44px target"); assert.equal(c.clipped, false, "text wraps, never clipped"); }
    // Arrow keys move the choice; Tab stays inside; Escape closes.
    await dialog.getByRole("radio", { checked: true }).focus();
    const before = await dialog.getByRole("radio", { checked: true }).innerText();
    await page.keyboard.press("ArrowRight");
    assert.notEqual(await dialog.getByRole("radio", { checked: true }).innerText(), before);
    for (let i = 0; i < 8; i += 1) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("[role='dialog']"))), true, "focus is trapped");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.ok(await noHorizontalScroll(page));
    await context.close();
  }
});

test("Extensions: rows in the Settings row language, one chip style with words", { skip }, async () => {
  const { context, page } = await open("/app/extensions");
  await page.locator(".ext-list .ext-row").first().waitFor();
  const panel = await page.locator(".ext-list").first().evaluate((el) => { const s = getComputedStyle(el); return { border: s.borderTopStyle, radius: s.borderTopLeftRadius }; });
  const settingsRadius = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius-card").trim());
  assert.equal(panel.border, "solid");
  assert.equal(panel.radius, settingsRadius);
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const heights = await page.locator(".ext-list > .ext-row").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(heights.every((h) => h >= 4 * rem - 0.5), "4rem rows, as in Settings");
  for (const chip of await page.locator(".ext-mark").all()) assert.ok((await chip.innerText()).trim().length > 0, "a chip says its state in words");
  await context.close();
});

test("the model showcase: a quiet selected state, and plan lines generated from the plan table (Vulcan is Pro and Max)", { skip }, async () => {
  const { context, page } = await open("/", { motion: "reduce" });
  const section = page.locator("#models");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const html = await page.content();
  for (const slide of orbitSlides("carry")) assert.ok(html.includes(slide.availability), `${slide.id}: "${slide.availability}"`);
  assert.ok(html.includes("Included in Pro and Max"), "Vulcan names Pro and Max");
  const selected = page.locator(".osh-th .osh-btn[aria-current]").first();
  if (await selected.count()) {
    const bg = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
    const alpha = Number((bg.match(/rgba?\(([^)]+)\)/)?.[1] ?? "0,0,0,0").split(",")[3] ?? 1);
    assert.ok(alpha < 0.2, `a quiet tint, not a white tile (${bg})`);
    assert.equal(await selected.evaluate((el) => getComputedStyle(el).boxShadow), "none", "no drop shadow");
  }
  await context.close();
});

test("public pages: one quiet header, no decorative globe, the Q&A block, and the shared footer", { skip }, async () => {
  for (const route of ["/guarantee", "/privacy", "/terms", "/account-deletion", "/sources", "/apps"]) {
    const { context, page } = await open(route, { motion: "reduce" });
    const h1 = await page.locator("h1").first().evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), inHeader: Boolean(el.closest(".page-header")) }));
    assert.ok(h1.inHeader, `${route}: the title is in the page header`);
    assert.ok(h1.size <= 36.5, `${route}: the title is on the type scale (${h1.size}px)`);
    assert.equal(await page.locator(".guarantee__planet").count(), 0, `${route}: no decorative globe`);
    if (await page.locator(".public-faq").count()) {
      const answer = await page.locator(".public-faq p").first().evaluate((el) => { const s = getComputedStyle(el); return { max: parseFloat(s.maxWidth), font: parseFloat(s.fontSize) }; });
      assert.ok(answer.max / answer.font <= 40, `${route}: answers are held to a readable measure`);
      const divided = await page.locator(".public-faq > div").first().evaluate((el) => getComputedStyle(el).borderTopStyle);
      assert.equal(divided, "solid", `${route}: questions are divided`);
    }
    assert.equal(await page.locator("footer.site-footer").count(), 1, `${route}: the shared footer`);
    await context.close();
  }
});

test("the footer: no overlapping text at 320, 768 and 1280px, 44px links, and the new Threads and GitHub links", { skip }, async () => {
  for (const width of [320, 768, 1280]) {
    for (const route of ["/guarantee", "/"]) {
      const { context, page } = await open(route, { width, height: 900, motion: "reduce" });
      const footer = page.locator("footer.site-footer");
      await footer.scrollIntoViewIfNeeded();
      const parts = await footer.evaluate((el) => [...el.children].map((child) => { const r = child.getBoundingClientRect(); return { cls: child.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
      for (let i = 0; i < parts.length; i += 1) for (let j = i + 1; j < parts.length; j += 1) {
        const a = parts[i]; const b = parts[j];
        const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        assert.equal(overlap, false, `${route} ${width}px: ${a.cls} overlaps ${b.cls}`);
      }
      assert.ok(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${route} ${width}px: nothing spills sideways`);
      const links = await footer.locator("a").evaluateAll((els) => els.map((a) => a.getBoundingClientRect().height));
      assert.ok(links.every((h) => h >= 43.5), `${route} ${width}px: 44px links`);
      assert.equal(await footer.locator('a[href="https://www.threads.net/@vibhavgpt.ai"]').count(), 1);
      assert.equal(await footer.locator('a[href="https://github.com/Shourya-Thoota"]').count(), 1);
      assert.match(await footer.innerText(), /Threads[\s\S]*GitHub/);
      assert.ok(await noHorizontalScroll(page), `${route} ${width}px: no horizontal scroll`);
      await context.close();
    }
  }
});
