import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The app at its smaller size, with Study's tools as chips, Writing tools in place, compact menus, calmer Settings and the new
// Usage page, in three engines. Served from frontend/dist with the design fixtures (a fictitious account).
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const near = (value, want, tolerance, label) => assert.ok(Math.abs(value - want) <= tolerance, `${label}: ${value} is not within ${tolerance} of ${want}`);

for (const [engine, launch] of ENGINES) describe(`The compact app in ${engine}`, { concurrency: false, timeout: 400000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true, emptyLibrary: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function open({ route, width = 1920, height = 1080, theme = "light", reducedMotion = "no-preference", wait = ".opening__title" }) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    const problems = []; const requests = [];
    page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|Failed to load resource|interactive-widget|frame-ancestors|Refused to frame|net::ERR|Unable to post message to https:\/\/widgets\.cleverhumanizer\.ai/.test(message.text())) problems.push(`console: ${message.text().slice(0, 140)}`); });
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.locator(wait).first().waitFor();
    await page.waitForTimeout(700);
    return { context, page, problems, requests };
  }

  test("size: body text is 14px, the sidebar and greeting are the smaller sizes at 1920, 1536 and 1366, and a phone is untouched", async (t) => {
    if (skip(t)) return;
    for (const [width, height, sidebar] of [[1920, 1080, 295], [1536, 864, 252], [1366, 768, 235]]) {
      const { context, page, problems } = await open({ route: "/app/chat", width, height });
      const m = await page.evaluate(() => ({ root: getComputedStyle(document.documentElement).fontSize, body: getComputedStyle(document.body).fontSize, sidebar: document.querySelector(".sidebar").getBoundingClientRect().width, title: parseFloat(getComputedStyle(document.querySelector(".opening__title")).fontSize), composer: (({ width: w, height: h }) => ({ w, h }))(document.querySelector(".composer").getBoundingClientRect()), overflow: document.documentElement.scrollWidth - innerWidth, sidebarText: parseFloat(getComputedStyle(document.querySelector(".sidebar__link")).fontSize) }));
      assert.equal(m.root, "14px", `${width}px: 1rem is 14px`);
      assert.equal(m.body, "14px", `${width}px: body text is 14px`);
      near(m.sidebar, sidebar, 1, `${width}px: the sidebar`);
      near(m.title, 41.5, 0.6, `${width}px: the greeting`);
      near(m.composer.w, 693, 2, `${width}px: the composer's width`); assert.ok(m.composer.h >= 66 && m.composer.h <= 71, `${width}px: and height (${m.composer.h}px; the stylesheet's minimum is 67)`);
      near(m.sidebarText, 14, 0.2, `${width}px: sidebar rows are 14px text`);
      assert.equal(m.overflow, 0, `${width}px: no horizontal overflow`);
      assert.deepEqual(problems, []);
      await context.close();
    }
    { const { context, page } = await open({ route: "/app/chat", width: 390, height: 844 });
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "16px", "a phone keeps its sizes: they are set for touch");
      await context.close(); }
    { const { context, page } = await open({ route: "/pricing", width: 1920, height: 1080, wait: "h1" });
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "16px", "pages outside the app (Pricing, sign-in) are not scaled");
      await context.close(); }
  });

  test("the gradient follows the selected accent in both themes, from the shared tokens", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const { context, page } = await open({ route: "/app/chat", theme });
      const seen = {};
      for (const accent of ["cerulean", "nebula", "pine", "ember", "amber"]) {
        await page.evaluate((id) => document.documentElement.setAttribute("data-accent", id), accent);
        const m = await page.evaluate(() => ({
          token: getComputedStyle(document.documentElement).getPropertyValue("--page-wash"),
          painted: getComputedStyle(document.body, "::before").backgroundImage,
          calm: getComputedStyle(document.documentElement).getPropertyValue("--page-wash-calm"),
        }));
        assert.match(m.token, /color-mix\(in srgb,/, `${theme} ${accent}: the wash is a mix of the accent into the sky`);
        assert.doesNotMatch(m.token, /rgb\(138 104 245|rgb\(150 112 255|#0a061c|#faf8ff/, `${theme} ${accent}: no fixed violet is left in the wash`);
        assert.match(m.painted, /radial-gradient/, `${theme} ${accent}: the wash is painted`);
        seen[accent] = m.painted;
      }
      assert.equal(new Set(Object.values(seen)).size, 5, `${theme}: each accent paints a different gradient`);
      await context.close();
    }
  });

  test("Chat's home has the greeting, the composer and the switcher, and no suggestion rows", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ route: "/app/chat" });
    assert.equal(await page.locator(".chat-starters, .chat-starters button").count(), 0, "no suggestion rows");
    for (const selector of [".opening__title", ".composer", ".start-below [role=tablist]"]) assert.equal(await page.locator(selector).first().isVisible(), true, selector);
    assert.deepEqual(await page.locator(".start-below [role=tab]").allTextContents(), ["Chat", "Study"], "under the composer: Chat | Study");
    assert.deepEqual(await page.locator(".mode-tabs-bar [role=tab]").allTextContents(), ["Chat", "Image"], "at the top: Chat | Image, with no Study");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("Study's tools are one row of chips at every desktop size, wrap on a phone and never stack in a column", async (t) => {
    if (skip(t)) return;
    for (const [width, height] of [[1920, 1080], [1536, 864], [1366, 768]]) {
      const { context, page } = await open({ route: "/app/study", width, height });
      const chips = await page.locator(".study-starters .btn").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), x: r.left, y: r.top, right: r.right, h: r.height }; }));
      assert.deepEqual(chips.map((c) => c.text), ["Explain a topic", "Flashcards", "Quiz me", "Summary", "Study plan", "Writing tools"]);
      assert.ok(chips.every((c) => Math.abs(c.y - chips[0].y) <= 2), `${width}px: all six on one row`);
      assert.ok(chips.every((c, i) => i === 0 || c.x > chips[i - 1].right - 1), `${width}px: left to right`);
      assert.ok(chips.every((c) => c.x >= 0 && c.right <= width), `${width}px: all on screen`);
      near(chips[0].h, 34, 1, `${width}px: compact`);
      await context.close();
    }
    const { context, page } = await open({ route: "/app/study", width: 390, height: 844 });
    const chips = await page.locator(".study-starters .btn").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: Math.round(r.top), right: r.right, h: r.height }; }));
    assert.equal(chips.length, 6);
    assert.ok(new Set(chips.map((c) => c.y)).size >= 2, "wraps onto more than one row on a phone");
    assert.ok(Math.abs(chips[0].y - chips[1].y) <= 2, "and is not a column: the first two sit side by side");
    assert.ok(chips.every((c) => c.x >= 0 && c.right <= 390 && c.h >= 40), "inside the screen, each a 40px touch target");
    await context.close();
  });

  test("a Study tool works in place; Writing tools opens in place, with no reload and no sidebar item, and Back closes just the panel", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ route: "/app/study" });
    await page.evaluate(() => { window.__sameDocument = "yes"; });
    const path = await page.evaluate(() => location.pathname + location.search);
    assert.equal(await page.locator(".sidebar").getByText("Writing Tools").count(), 0, "no Writing Tools item in the sidebar");
    // A tool fills the box and sends nothing.
    await page.locator(".study-starters .btn", { hasText: "Quiz me" }).click();
    assert.equal(await page.locator(".composer__input").inputValue(), "Quiz me");
    // Type something of our own, then open the tools.
    await page.locator(".composer__input").fill("half-typed message");
    const before = await page.evaluate(() => history.length);
    await page.locator(".study-starters__tool").click();
    await page.locator(".writing-tools-inline").waitFor();
    assert.equal(await page.locator(".writing-tools-inline h2").textContent(), "AI Detector");
    assert.equal(await page.locator(".study-starters__tool").getAttribute("aria-expanded"), "true");
    assert.equal(await page.evaluate(() => location.pathname + location.search), path, "the address did not change: no separate page");
    assert.equal(await page.evaluate(() => window.__sameDocument), "yes", "no reload");
    assert.equal(await page.evaluate(() => history.length), before + 1, "one history entry");
    assert.equal(await page.locator(".composer__input").inputValue(), "half-typed message", "the message is still there");
    assert.equal(await page.locator(".study-starters .btn").count(), 6, "the chips are still there");
    // Back closes the panel and nothing else.
    await page.goBack();
    await page.locator(".writing-tools-inline").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.__sameDocument), "yes", "Back did not leave Study");
    assert.equal(await page.evaluate(() => location.pathname + location.search), path);
    assert.equal(await page.locator(".composer__input").inputValue(), "half-typed message", "Back rebuilt nothing: the half-typed message is still there");
    assert.equal(await page.locator(".study-starters__tool").getAttribute("aria-expanded"), "false");
    // The panel's own Close button does the same, and the chip toggles it.
    await page.locator(".study-starters__tool").click();
    await page.locator(".writing-tools-inline").waitFor();
    await page.locator(".writing-tools__back").click();
    await page.locator(".writing-tools-inline").waitFor({ state: "detached" });
    await page.locator(".study-starters__tool").click();
    await page.locator(".writing-tools-inline").waitFor();
    await page.locator(".study-starters__tool").click();
    await page.locator(".writing-tools-inline").waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("the + menu: single-line rows, dividers, no subtitles, and Response mode is a keyboard-operable submenu", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ route: "/app/chat" });
    await page.locator(".composer__add-trigger").click();
    const menu = page.locator(".ui-menu__panel");
    await menu.waitFor();
    const rows = await menu.locator("> .ui-menu__item, > .ui-menu__sub > .ui-menu__item").evaluateAll((els) => els.map((e) => ({ name: e.querySelector(".ui-menu__name").textContent.trim(), h: e.getBoundingClientRect().height, sub: e.getAttribute("aria-haspopup") })));
    assert.deepEqual(rows.map((r) => r.name), ["Photos", "Files", "Response mode"]);
    for (const row of rows) assert.ok(row.h >= 36 && row.h <= 40.5, `${row.name}: ${row.h}px is a 36 to 40px row`);
    assert.equal(rows[2].sub, "menu", "Response mode opens a submenu");
    assert.equal(await menu.locator("> [role=separator]").count(), 1, "one divider between the groups");
    assert.equal(await menu.locator(".ui-menu__label").count(), 0, "no group headings");
    const hidden = await menu.locator(".ui-menu__description").evaluateAll((els) => els.every((e) => e.getBoundingClientRect().width <= 1.5));
    assert.equal(hidden, true, "no subtitle line is drawn");
    // Keyboard: ArrowDown to Response mode, ArrowRight opens it and focuses its first row.
    await page.waitForFunction(() => document.querySelector(".ui-menu__panel")?.contains(document.activeElement), null, { timeout: 5000 });
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    const active = () => page.evaluate(() => document.activeElement?.querySelector(".ui-menu__name")?.textContent.trim());
    assert.equal(await active(), "Response mode");
    await page.keyboard.press("ArrowRight");
    const sub = page.locator(".ui-menu__submenu");
    await sub.waitFor();
    assert.deepEqual(await sub.locator("[role^=menuitem] .ui-menu__name").allTextContents(), ["Concise", "Detailed", "Learning", "Custom"]);
    const described = await sub.locator("[role^=menuitem]").first().textContent();
    assert.match(described, /Short, direct answers/, "the help line is still in the page for assistive technology");
    assert.equal(await page.locator(".ui-menu__item--sub").getAttribute("aria-expanded"), "true");
    await page.waitForTimeout(150);
    assert.equal(await active(), "Concise", "focus moves into the submenu");
    await page.keyboard.press("ArrowDown");
    assert.equal(await active(), "Detailed");
    // Escape closes just the submenu and returns to its row; a second Escape closes the menu.
    await page.keyboard.press("Escape");
    await sub.waitFor({ state: "detached" });
    assert.equal(await menu.isVisible(), true, "the menu is still open");
    assert.equal(await active(), "Response mode");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    // The mouse path works too: open, hover the row, choose.
    await page.locator(".composer__add-trigger").click();
    await page.locator(".ui-menu__item--sub").click();
    await page.locator(".ui-menu__submenu").waitFor();
    await page.locator(".ui-menu__submenu").getByText("Detailed").click();
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("Study's + menu has the writing tools, each opening its own tab in place, and no Response mode", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open({ route: "/app/study" });
    await page.locator(".composer__add-trigger").click();
    const menu = page.locator(".ui-menu__panel");
    await menu.waitFor();
    assert.deepEqual(await menu.locator("[role^=menuitem] .ui-menu__name").allTextContents(), ["Photos", "Files", "AI Detector", "AI Humanizer"]);
    assert.equal(await menu.locator("> [role=separator]").count(), 1, "one divider, between the files and the writing tools");
    assert.notEqual(await menu.locator("> :last-child").getAttribute("role"), "separator", "and none dangling at the end, where Response mode would have been");
    await menu.getByText("AI Humanizer").click();
    await page.locator(".writing-tools-inline").waitFor();
    assert.equal(await page.locator('.writing-tools-inline [data-value="humanizer"]').getAttribute("aria-checked"), "true", "its own tab");
    await context.close();
  });

  test("the model and thinking pickers: single-line rows, no subtitles, every option still there and keyboard operable", async (t) => {
    if (skip(t)) return;
    const { context, page, problems, requests } = await open({ route: "/app/chat" });
    await page.locator(".composer__model .ui-select__trigger").click();
    const list = page.locator(".ui-select__list");
    await list.waitFor();
    const options = await list.locator(".ui-option").evaluateAll((els) => els.map((e) => ({ name: e.textContent.trim(), h: e.getBoundingClientRect().height })));
    assert.deepEqual(await list.locator(".model-row__name").allTextContents(), ["Lumen", "Nova", "Nebula", "Vulcan"], "the branded tiers, all there");
    assert.match(options[0].name, /Entry/, "and each model's blurb is still in the page for assistive technology");
    for (const option of options) assert.ok(option.h >= 36 && option.h <= 44, `${option.name}: ${option.h}px, one line`);
    assert.equal(await list.locator(".model-row__desc").evaluateAll((els) => els.every((e) => e.getBoundingClientRect().width <= 1.5)), true, "no description line is drawn");
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    // Thinking: open by keyboard, move, choose.
    const trigger = page.locator(".composer__effort .ui-select__trigger");
    const first = (await trigger.textContent()).trim();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const effort = page.locator(".ui-select__list");
    await effort.waitFor();
    const effortOptions = await effort.locator(".ui-option").evaluateAll((els) => els.map((e) => ({ name: e.textContent.trim(), h: e.getBoundingClientRect().height, small: !!e.querySelector("small") && e.querySelector("small").getBoundingClientRect().width > 1.5 })));
    assert.ok(effortOptions.length >= 2);
    for (const option of effortOptions) assert.ok(option.h >= 36 && option.h <= 44 && !option.small, `${option.name}: one line, no visible subtitle (${option.h}px)`);
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await effort.waitFor({ state: "detached" });
    // The design fixture's profile endpoint always answers "low", so the visible value snaps back; the change reaching the server is the proof.
    assert.ok(requests.some((r) => r.method !== "GET" && /\/api\/profile/.test(r.url)), "choosing with the keyboard saved the change");
    assert.equal(await effort.count(), 0, "and closed the list");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("Settings: every section is still there, with plain muted icons and a grey selected row", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ route: "/app/settings/account", wait: ".settings-dock" });
    const m = await page.evaluate(() => {
      const icons = [...document.querySelectorAll(".settings-dock__icon")].map((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, w: e.getBoundingClientRect().width, shadow: s.boxShadow }; });
      const selected = getComputedStyle(document.querySelector('.settings-dock__item[aria-current="page"]')).backgroundColor;
      return { names: [...document.querySelectorAll(".settings-dock__name")].map((e) => e.textContent.trim()), icons, selected };
    });
    assert.deepEqual(m.names, ["Account", "Personality", "Appearance", "Replies", "Memory", "Media", "Security", "Location", "Your data", "Delete account"], "all sections kept, and the two new ones");
    for (const icon of m.icons) { assert.equal(icon.bg, "rgba(0, 0, 0, 0)", "no coloured tile"); assert.equal(icon.shadow, "none"); near(icon.w, 20, 1, "icon box"); }
    const [r, g, b] = m.selected.match(/[\d.]+/g).map(Number);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, `the selected row is a neutral grey, not an accent tint (${m.selected})`);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("Usage limits: the title with the plan, one description, when it was updated, and one card per window, from the real counters", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const { context, page, problems } = await open({ route: "/app/usage", theme, wait: ".usage-card" });
      const m = await page.evaluate(() => ({
        title: document.querySelector(".usage-head__title").childNodes[0].textContent.trim(), plan: document.querySelector(".usage-head__plan")?.textContent.trim(),
        lede: document.querySelector(".usage-head__lede")?.textContent.trim(), updated: document.querySelector(".usage-head__updated")?.textContent.trim(),
        cards: [...document.querySelectorAll(".usage-card")].map((c) => ({ title: c.querySelector("h2").textContent.trim(), percent: c.querySelector(".usage-card__percent").textContent.trim(), reset: c.querySelector(".usage-card__reset")?.textContent.trim(), bar: c.querySelector("[role=progressbar]").getAttribute("aria-valuenow"), barH: c.querySelector(".usage-card__track").getBoundingClientRect().height })),
        text: document.body.innerText, credits: document.querySelector("#credit-purchase-title")?.textContent, history: !!document.querySelector("#credit-purchase-history-title"),
      }));
      assert.equal(m.title, "Usage limits"); assert.equal(m.plan, "Plus");
      assert.ok(m.lede && m.lede.length < 120, "one short plain description");
      assert.match(m.updated, /^Updated \d{1,2}:\d{2}/, "when the numbers were fetched");
      assert.deepEqual(m.cards.map((c) => c.title), ["Current usage", "This month"], "the 5-hour window, then the month");
      // The fixture's real counters: 108,000 of 2,180,000 tokens in the window and 540,000 of 21,800,000 in the month.
      assert.deepEqual(m.cards.map((c) => c.percent), ["5% used", "2% used"]);
      assert.deepEqual(m.cards.map((c) => c.bar), ["5", "2"]);
      assert.match(m.cards[0].reset, /^Resets in 2 h( \d+ min)?$/, "the rolling window's own release time, from the server");
      assert.match(m.cards[1].reset, /^Resets /, "the monthly reset");
      for (const card of m.cards) assert.ok(card.barH >= 5 && card.barH <= 7, `a thin bar (${card.barH}px)`);
      assert.doesNotMatch(m.text, /gemini/i);
      assert.equal(m.credits, "Flex Credits", "credits are untouched"); assert.equal(m.history, true, "and so is the purchase history");
      assert.deepEqual(problems, []);
      await context.close();
    }
  });

  test("reduced motion: Study's chips and the in-place panel behave the same, with no errors", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ route: "/app/study", reducedMotion: "reduce" });
    assert.equal(await page.locator(".study-starters .btn").count(), 6);
    await page.locator(".study-starters__tool").click();
    await page.locator(".writing-tools-inline").waitFor();
    await page.goBack();
    await page.locator(".writing-tools-inline").waitFor({ state: "detached" });
    assert.deepEqual(problems, []);
    await context.close();
  });
});
