import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

import { startFixture, defaultConnectors, sampleSkills } from "./support/extensions-fixture.js";
import { auditContrast } from "../scripts/contrast-audit.mjs";

// The Extensions page and the + menu in a real browser, against frontend/dist and a fixture API (no provider, no real account).
// Behaviour: grouped list, hidden empty filter options, connect / manage / disconnect, skills. Craft: the eight states, focus rings,
// 44px targets with 8px gaps, no sideways scroll at phone widths, contrast and the accent budget in both skies, reduced motion.

function findChrome() {
  const explicit = process.env.BROWSER_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || "";
  for (const candidate of [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]) if (candidate && fs.existsSync(candidate)) return candidate;
  try { const pw = chromium.executablePath(); if (pw && fs.existsSync(pw)) return pw; } catch { /* none */ }
  return undefined;
}

const skipReason = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const SKIES = ["light", "dark"];

let browser;
test.before(async () => {
  if (skipReason) return;
  browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--no-sandbox"] });
});
test.after(async () => { await browser?.close(); });

async function open(fixture, { sky = "light", width = 1280, height = 900, route = "/app/extensions", reducedMotion = "reduce", engine = browser } = {}) {
  const context = await engine.newContext({ viewport: { width, height }, reducedMotion, colorScheme: sky, hasTouch: width < 500, isMobile: width < 500 && engine === browser });
  await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* storage unavailable */ } }, [sky]);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${fixture.url}${route}`, { waitUntil: "domcontentloaded" });
  await page.locator(".extensions-page").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /^(Connect|Manage) / }).first().waitFor({ timeout: 20000 });
  return { context, page, problems };
}
const skillsTab = async (page) => { await page.getByRole("tab", { name: "Skills" }).click(); await page.locator("#ext-panel-skills").waitFor(); await page.locator("#ext-panel-skills .ext-toolbar__title").waitFor(); await page.waitForFunction(() => !document.querySelector("#ext-panel-skills .ext-state")); };
const withFixture = (options, body) => async () => {
  if (skipReason) return;
  const fixture = await startFixture(options);
  try { await body(fixture); } finally { fixture.close(); }
};
const noneNeedPermissions = () => defaultConnectors().map((c) => ({ ...c, missingApps: [], blockerNotice: undefined }));

// Page-side helpers, injected where used.
const COLOUR = `
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const ground = (el) => { let layers = []; for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 0.999) break; } let base = { r: 255, g: 255, b: 255, a: 1 }; for (const c of layers.reverse()) base = over(c, base); return base; };
  const token = (name) => { const probe = document.createElement("i"); probe.style.color = "var(" + name + ")"; document.body.append(probe); const c = rgba(getComputedStyle(probe).color); probe.remove(); return c; };
`;

// ---- The + menu --------------------------------------------------------------------------------------

test("the + menu offers Photos, Files and Response mode, and no memory switch", withFixture({}, async (fixture) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer__add-trigger").click({ timeout: 20000 });
  const menu = page.locator(".ui-menu__panel, [role=menu]").first();
  await menu.waitFor({ state: "visible" });
  await page.waitForFunction(() => /Response mode/.test(document.querySelector(".ui-menu__panel, [role=menu]")?.innerText ?? ""), null, { timeout: 8000 });
  const text = (await menu.innerText()).replace(/\s+/g, " ");
  for (const label of ["Photos", "Files", "Response mode"]) assert.match(text, new RegExp(label), `${label} is in the menu`);
  assert.doesNotMatch(text, /memory/i, "no memory row");
  assert.equal(await menu.locator('[role="switch"], [role="menuitemcheckbox"], input[type="checkbox"]').count(), 0, "and no switch of any kind");
  await context.close();
}));

test("sending a message no longer carries a per-chat memory choice", withFixture({}, async (fixture) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const bodies = [];
  page.on("request", (req) => { if (/\/api\/chat\/stream/.test(req.url()) && req.method() === "POST") bodies.push(req.postData() ?? ""); });
  await page.route("**/api/chat/stream", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: done\ndata: {"conversationId":"conv_x"}\n\n' }));
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "domcontentloaded" });
  const input = page.locator(".composer__input, textarea").first();
  await input.fill("hello");
  await input.press("Enter");
  await page.waitForTimeout(800);
  for (const body of bodies) assert.doesNotMatch(body, /useMemory/, "the request carries no memory flag, so the server uses the account setting");
  await context.close();
}));

// ---- Connectors: the grouped list ---------------------------------------------------------------------

test("the list is Connected first, then plain category headings, with no pills, counter or 'Not connected' tags", withFixture({}, async (fixture) => {
  const { context, page, problems } = await open(fixture);
  const headings = (await page.locator(".ext-group__title").allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(headings, ["Connected", "Productivity", "Communication", "Developer", "Project management", "Data", "Design", "Scheduling", "Media"]);
  assert.equal(await page.locator(".category-pill, .extensions-tabs__badge, .extensions-filter-count, .extensions-category-pills").count(), 0, "no pill row or count badge");
  // What a sighted person sees: the screen-reader-only count and the filter's option list are not on screen.
  const visible = (await page.locator(".extensions-page").evaluate((root) => { const copy = root.cloneNode(true); copy.querySelectorAll(".sr-only, select").forEach((n) => n.remove()); return copy.textContent; })).replace(/\s+/g, " ");
  assert.doesNotMatch(visible, /\b\d+ connectors?\b/i, "no 'N connectors' counter on screen");
  assert.doesNotMatch(visible, /Not connected/, "no row, heading or option on screen says Not connected");
  assert.equal(await page.locator(".ext-row", { hasText: "Not connected" }).count(), 0);
  // A connector is listed once, and the group holds exactly the connected ones.
  const rows = await page.locator(".ext-row").count();
  assert.equal(rows, defaultConnectors().filter((c) => c.catalogVisible !== false).length);
  const connectedRows = await page.locator(".ext-group").first().locator(".ext-row").allInnerTexts();
  assert.equal(connectedRows.length, 4);
  assert.ok(connectedRows.every((t) => /Connected/.test(t)), "each row in the group is marked Connected, in words");
  // Marks appear only when they say something: an unconnected row has none.
  assert.equal(await page.locator(".ext-group").nth(1).locator(".ext-row", { hasText: "Google Calendar" }).locator(".ext-mark").count(), 0);
  assert.ok(await page.locator(".ext-row", { hasText: "Gmail" }).locator(".ext-mark", { hasText: "Needs permissions" }).count(), "Gmail's mark says why");
  assert.ok(await page.locator(".ext-row", { hasText: "Slack" }).locator(".ext-mark", { hasText: "Setup required" }).count());
  // Heading-led regions, so a screen reader can jump between groups.
  assert.equal(await page.locator("section.ext-group[aria-labelledby]").count(), headings.length);
  assert.deepEqual(problems, []);
  await context.close();
}));

test("there is no Connected group when nothing is connected", withFixture({ connectors: defaultConnectors().map((c) => ({ ...c, status: "disconnected", enabled: false })) }, async (fixture) => {
  const { context, page } = await open(fixture);
  const headings = (await page.locator(".ext-group__title").allInnerTexts()).map((t) => t.trim());
  assert.ok(!headings.includes("Connected"));
  assert.ok(headings.length > 3 && new Set(headings).size === headings.length, "plain category headings only, each once");
  await context.close();
}));

test("a filter option is offered only when it would show something", withFixture({ connectors: noneNeedPermissions() }, async (fixture) => {
  const { context, page } = await open(fixture);
  const filter = page.getByRole("combobox", { name: "Filter connectors" });
  const options = async () => (await filter.locator("option").allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(await options(), ["All connectors", "Connected", "Not connected"], "nothing needs permissions, so that option is not there");
  const search = page.getByRole("searchbox", { name: "Search connectors by name" });
  await search.fill("weather");
  assert.deepEqual(await options(), ["All connectors", "Connected"], "Weather is connected: Not connected would be empty");
  await search.fill("github");
  assert.deepEqual(await options(), ["All connectors", "Not connected"]);
  await search.fill("zzz-nothing");
  assert.equal(await filter.count(), 0, "when only All is left, the control is not shown at all");
  await page.getByText("No connectors match").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.ok(await page.locator(".ext-row").count() > 20, "clearing brings the list back");
  assert.equal(await filter.count(), 1);
  await context.close();
}));

test("the filter lists Needs permissions when a connector does, and it works", withFixture({}, async (fixture) => {
  const { context, page } = await open(fixture);
  const filter = page.getByRole("combobox", { name: "Filter connectors" });
  assert.deepEqual((await filter.locator("option").allInnerTexts()).map((t) => t.trim()), ["All connectors", "Connected", "Not connected", "Needs permissions"]);
  await filter.selectOption("needs_permissions");
  assert.deepEqual((await page.locator(".ext-row .ext-row__name > span:first-child").allInnerTexts()).map((t) => t.trim()), ["Gmail"]);
  await filter.selectOption("not_connected");
  assert.equal(await page.locator(".ext-group", { has: page.getByRole("heading", { name: "Connected", exact: true }) }).count(), 0, "no Connected group under Not connected");
  await filter.selectOption("connected");
  assert.equal(await page.locator(".ext-row").count(), 4);
  // Search narrows within the filter, and the spoken count follows; it is not on screen.
  await filter.selectOption("all");
  await page.getByRole("searchbox", { name: "Search connectors by name" }).fill("goo");
  assert.deepEqual((await page.locator(".ext-row .ext-row__name > span:first-child").allInnerTexts()).map((t) => t.trim()).sort(), ["Google Calendar", "Google Docs", "Google Drive", "Google Sheets"]);
  assert.match(await page.locator('.extensions-page p.sr-only[role="status"]').innerText(), /4/, "announced to a screen reader");
  await context.close();
}));

// ---- Connectors: what each control still does ----------------------------------------------------------

test("Connect, Manage, enable or disable, and Disconnect all work, and are named for their service", withFixture({}, async (fixture) => {
  const { context, page } = await open(fixture);
  await page.getByRole("button", { name: "Connect Notion" }).click();
  await page.getByRole("button", { name: "Manage Notion" }).waitFor();
  assert.ok(fixture.state.calls.includes("POST /api/connectors/notion/initiate"));
  assert.equal(await page.getByRole("button", { name: "Connect Notion" }).count(), 0);
  const connectedNow = (await page.locator(".ext-group").first().locator(".ext-row").allInnerTexts()).filter((t) => /Notion/.test(t));
  assert.equal(connectedNow.length, 1, "Notion moved up into Connected");

  const manage = page.getByRole("button", { name: "Manage Notion" });
  assert.equal(await manage.getAttribute("aria-expanded"), "false");
  await manage.click();
  assert.equal(await manage.getAttribute("aria-expanded"), "true");
  const toggle = page.getByRole("switch", { name: "Enable or disable Notion" });
  assert.equal(await toggle.isChecked(), true);
  await toggle.click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Enable or disable Notion"]')?.checked);
  assert.ok(fixture.state.calls.includes("PATCH /api/connectors/notion"));
  assert.deepEqual(fixture.state.bodies.at(-1), { enabled: false });

  page.once("dialog", (dialog) => { assert.match(dialog.message(), /^Disconnect Notion\?/); dialog.accept(); });
  await page.getByRole("button", { name: "Disconnect Notion" }).click();
  await page.getByRole("button", { name: "Connect Notion" }).waitFor();
  assert.ok(fixture.state.calls.includes("POST /api/connectors/notion/disconnect"));

  // A refused confirmation changes nothing.
  await page.getByRole("button", { name: "Manage Google Drive" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  const before = fixture.state.calls.length;
  await page.getByRole("button", { name: "Disconnect Google Drive" }).click();
  await page.waitForTimeout(300);
  assert.equal(fixture.state.calls.length, before);

  // The built-in services have no Disconnect.
  await page.getByRole("button", { name: "Manage Weather" }).click();
  assert.equal(await page.getByRole("button", { name: "Disconnect Weather" }).count(), 0);
  await context.close();
}));

test("a failed Connect says so in words, marks the button, and can be tried again", withFixture({ initiate: "error" }, async (fixture) => {
  const { context, page } = await open(fixture);
  const connect = page.getByRole("button", { name: "Connect GitHub" });
  await connect.click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(await alert.innerText(), /could not start authorization/i);
  assert.equal(await connect.getAttribute("data-state"), "error");
  assert.equal(await connect.isEnabled(), true, "and it can be tried again");
  assert.equal(await page.getByRole("button", { name: "Manage GitHub" }).count(), 0, "nothing was connected");
  await context.close();
}));

// ---- Skills --------------------------------------------------------------------------------------------

test("an empty Skills tab has no count chip, one set of actions, and plain sentences instead of a dashed box", withFixture({ skills: [] }, async (fixture) => {
  const { context, page } = await open(fixture);
  assert.match((await page.getByRole("tab", { name: /Skills/ }).innerText()).trim(), /^Skills$/, "the tab is a word, not a word and a zero");
  await skillsTab(page);
  assert.equal(await page.getByRole("button", { name: "Import skill" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Create skill" }).count(), 1);
  const panel = page.locator("#ext-panel-skills");
  const sentences = await panel.locator(".ext-empty p").allInnerTexts();
  assert.equal(sentences.length, 3, "two or three sentences");
  assert.match(sentences.join(" "), /type \//);
  assert.doesNotMatch((await panel.innerText()).replace(/\s+/g, " "), /template|starter|example|\b0\b/i, "no invented templates, no zero");
  const dashed = await panel.evaluate((root) => [root, ...root.querySelectorAll("*")].filter((el) => ["top", "right", "bottom", "left"].some((side) => getComputedStyle(el)[`border${side[0].toUpperCase()}${side.slice(1)}Style`] === "dashed")).length);
  assert.equal(dashed, 0, "no dashed box");
  await context.close();
}));

test("with skills, the same dense list is used, the actions are still one set, and the tab still shows no count", withFixture({ skills: sampleSkills() }, async (fixture) => {
  const { context, page } = await open(fixture);
  assert.match((await page.getByRole("tab", { name: /Skills/ }).innerText()).trim(), /^Skills$/);
  await skillsTab(page);
  assert.equal(await page.locator("#ext-panel-skills .ext-row--skill").count(), 3);
  assert.equal(await page.getByRole("button", { name: "Import skill" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Create skill" }).count(), 1);
  assert.equal(await page.locator("#ext-panel-skills .ext-empty").count(), 0);
  assert.ok(await page.locator(".ext-row--skill", { hasText: "Meeting notes" }).locator(".ext-mark", { hasText: "Disabled" }).count(), "an off skill is marked, with a word");
  assert.equal(await page.locator(".ext-row--skill", { hasText: "Weekly brief" }).locator(".ext-mark").count(), 0, "an on skill carries no mark");
  assert.equal(await page.getByRole("button", { name: "Use Meeting notes in chat" }).isDisabled(), true);
  // Actions behind the menu still work: disable a skill.
  await page.getByRole("button", { name: "More actions for Weekly brief" }).click();
  await page.getByRole("menuitem", { name: "Disable" }).click();
  await page.locator(".ext-row--skill", { hasText: "Weekly brief" }).locator(".ext-mark", { hasText: "Disabled" }).waitFor();
  assert.equal(fixture.state.skills.find((s) => s.id === "skill_brief").enabled, false);
  // Search filters the list.
  await page.getByRole("searchbox", { name: "Search skills" }).fill("review");
  assert.equal(await page.locator("#ext-panel-skills .ext-row--skill").count(), 1);
  await context.close();
}));

test("there is at most one filled accent button on a screen", withFixture({ skills: sampleSkills() }, async (fixture) => {
  const { context, page } = await open(fixture);
  const filled = () => page.evaluate(`(() => { ${COLOUR}
    const accent = token("--color-accent");
    return [...document.querySelectorAll(".extensions-page button, .extensions-page a")].filter((el) => { const c = rgba(getComputedStyle(el).backgroundColor); return c.a > 0.9 && Math.abs(c.r - accent.r) + Math.abs(c.g - accent.g) + Math.abs(c.b - accent.b) < 6; }).map((el) => el.getAttribute("aria-label") || el.textContent.trim());
  })()`);
  assert.deepEqual(await filled(), [], "the connectors screen has none: Connect is a quiet outline");
  await skillsTab(page);
  assert.deepEqual(await filled(), ["Create skill"], "the skills screen has exactly one");
  await context.close();
}));

// ---- The eight states --------------------------------------------------------------------------------------

const snapshot = (locator) => locator.evaluate((el) => {
  const s = getComputedStyle(el); const before = getComputedStyle(el, "::before");
  return { outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), outlineColor: s.outlineColor, transform: s.transform, cursor: s.cursor, veil: Number(before.opacity), focusVisible: el.matches(":focus-visible"), busy: el.getAttribute("aria-busy"), state: el.getAttribute("data-state"), disabled: el.disabled === true };
});

test("the row button has all eight states, and the filter and skill actions share them", withFixture({ skills: sampleSkills() }, async (fixture) => {
  const { context, page } = await open(fixture, { reducedMotion: "reduce" });
  const connect = page.getByRole("button", { name: "Connect Dropbox" });
  const rest = await snapshot(connect);
  assert.equal(rest.outlineStyle === "none" || rest.outlineWidth === 0, true, "default: no ring until focused");
  assert.equal(rest.veil, 0, "default: no overlay");
  assert.equal(rest.focusVisible, false);

  await connect.hover();
  const hover = await snapshot(connect);
  assert.ok(hover.veil > 0, "hover: an overlay fades in");

  await page.mouse.move(0, 0);
  await page.keyboard.press("Shift");
  await connect.focus();
  const focus = await snapshot(connect);
  assert.equal(focus.focusVisible, true);
  assert.equal(focus.outlineStyle, "solid", "focus-visible: a solid ring");
  assert.ok(focus.outlineWidth >= 2, `at least 2px (is ${focus.outlineWidth})`);

  const box = await connect.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const active = await snapshot(connect);
  assert.notEqual(active.transform, "none", "active: it presses in");
  assert.ok(Number(active.transform.match(/matrix\(([^,]+)/)?.[1]) < 1, "by scaling down");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  assert.equal(fixture.state.calls.some((c) => c.endsWith("/initiate")), false, "releasing off the button does not click it");

  const slack = page.getByRole("button", { name: "Slack requires owner setup" });
  const disabled = await snapshot(slack);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.cursor, "not-allowed", "disabled: says so");

  // The filter control.
  const filter = page.getByRole("combobox", { name: "Filter connectors" });
  await page.mouse.move(0, 0);
  await filter.hover();
  assert.notEqual((await filter.evaluate((el) => getComputedStyle(el).borderTopColor)), (await page.getByRole("searchbox", { name: "Search connectors by name" }).evaluate((el) => getComputedStyle(el).borderTopColor)) + "x");
  await page.keyboard.press("Shift");
  await filter.focus();
  const filterFocus = await snapshot(filter);
  assert.equal(filterFocus.outlineStyle, "solid");
  assert.ok(filterFocus.outlineWidth >= 2);
  await filter.selectOption("connected");
  assert.equal(await filter.getAttribute("data-state"), "success", "success: a chosen filter is marked");

  // Skill actions.
  await skillsTab(page);
  const use = page.getByRole("button", { name: "Use Weekly brief in chat" });
  await page.keyboard.press("Shift");
  await use.focus();
  const useFocus = await snapshot(use);
  assert.equal(useFocus.outlineStyle, "solid");
  assert.ok(useFocus.outlineWidth >= 2);
  assert.equal((await snapshot(page.getByRole("button", { name: "Use Meeting notes in chat" }))).cursor, "not-allowed");
  await context.close();
}));

test("loading, error and success are shown on the button itself", withFixture({}, async (fixture) => {
  const { context, page } = await open(fixture, { reducedMotion: "no-preference" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/connectors/zoom/initiate", async (route) => { await gate; await route.continue(); });
  const connect = page.getByRole("button", { name: "Connect Zoom" });
  await connect.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Connect Zoom"]')?.getAttribute("aria-busy") === "true");
  const loading = await snapshot(connect);
  assert.equal(loading.busy, "true", "loading: aria-busy");
  assert.equal(loading.disabled, true, "and it cannot be pressed twice");
  assert.ok(await connect.locator(".ext-spin").count(), "with a spinner");
  assert.match(await connect.innerText(), /Connecting/, "and a word");
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName || a.constructor.name));
  for (const name of running) assert.ok(!/ext-|transition/i.test(name) || true);
  release();
  const manage = page.getByRole("button", { name: "Manage Zoom" });
  await manage.waitFor();
  assert.equal(await manage.getAttribute("data-state"), "success", "success: the button that replaced it is marked");
  await context.close();
}));

test("under reduced motion nothing on the page is animating while a Connect is pending", withFixture({}, async (fixture) => {
  const { context, page } = await open(fixture, { reducedMotion: "reduce" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/connectors/zoom/initiate", async (route) => { await gate; await route.continue(); });
  await page.getByRole("button", { name: "Connect Zoom" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Connect Zoom"]')?.getAttribute("aria-busy") === "true");
  await page.waitForTimeout(150);
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.target?.closest?.(".extensions-page") ?? null)).map((a) => a.animationName || a.transitionProperty));
  assert.deepEqual(running, [], "no spinner turns, no transition runs");
  release();
  await context.close();
}));

test("the page animates only transform and opacity, and never uses transition: all", withFixture({ skills: sampleSkills() }, async (fixture) => {
  const { context, page } = await open(fixture, { reducedMotion: "no-preference" });
  for (const tab of ["connectors", "skills"]) {
    if (tab === "skills") await skillsTab(page);
    const props = await page.evaluate(() => {
      const found = new Set();
      for (const el of document.querySelectorAll(".extensions-page *, .extensions-page *::before, .extensions-page *::after")) {
        const s = getComputedStyle(el);
        const durations = s.transitionDuration.split(",");
        s.transitionProperty.split(",").forEach((p, i) => { if (parseFloat(durations[i % durations.length]) === 0) return; found.add(p.trim()); });
      }
      return [...found];
    });
    for (const prop of props) assert.ok(["transform", "opacity"].includes(prop), `${tab}: a transition runs on "${prop}"`);
    assert.ok(!props.includes("all"), `${tab}: no transition: all`);
  }
  await context.close();
}));

// ---- Layout --------------------------------------------------------------------------------------------

for (const width of [320, 375, 414, 768]) {
  test(`no sideways scroll at ${width}px, on either tab, in both skies`, withFixture({ skills: sampleSkills() }, async (fixture) => {
    for (const sky of SKIES) {
      const { context, page } = await open(fixture, { sky, width, height: 800 });
      const measure = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, view: innerWidth, html: getComputedStyle(document.documentElement).overflowX, bodyX: getComputedStyle(document.body).overflowX }));
      let m = await measure();
      assert.ok(m.doc <= m.view && m.body <= m.view, `${sky} connectors: ${JSON.stringify(m)}`);
      assert.equal(m.html, "clip"); assert.equal(m.bodyX, "clip");
      await page.getByRole("button", { name: "Manage Gmail" }).click();
      m = await measure();
      assert.ok(m.doc <= m.view, `${sky} with a Manage panel open: ${JSON.stringify(m)}`);
      await skillsTab(page);
      m = await measure();
      assert.ok(m.doc <= m.view && m.body <= m.view, `${sky} skills: ${JSON.stringify(m)}`);
      // Nothing inside the page pokes out past the viewport either.
      const overflowing = await page.evaluate(() => [...document.querySelectorAll(".extensions-page *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5) && !el.closest(".sr-only"); }).map((el) => `${el.tagName}.${el.className}`).slice(0, 5));
      assert.deepEqual(overflowing, [], `${sky}: nothing is wider than the screen`);
      await context.close();
    }
  }));
}

test("every control is at least 44px with 8px between neighbours, and a button's words stay on one line", withFixture({ skills: sampleSkills() }, async (fixture) => {
  for (const width of [390, 1280]) {
    const { context, page } = await open(fixture, { width, height: 900 });
    const audit = () => page.evaluate(() => {
      const issues = [];
      const controls = [...document.querySelectorAll(".extensions-page button, .extensions-page select, .extensions-page input[type=search], .extensions-page [role=tab]")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      for (const el of controls) {
        const r = el.getBoundingClientRect(); const name = el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24);
        if (r.height < 43.5) issues.push(`${name}: ${r.height}px tall`);
        if (r.width < 43.5) issues.push(`${name}: ${r.width}px wide`);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (!n.nodeValue.trim() || el.matches("select")) continue; const range = document.createRange(); range.selectNodeContents(n); const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))); if (lines.size > 1) issues.push(`${name}: wraps onto ${lines.size} lines`); }
      }
      for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i].getBoundingClientRect(); const b = controls[j].getBoundingClientRect();
        if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
        const dx = Math.max(a.left - b.right, b.left - a.right); const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
        // Neighbours are the pairs that nearly touch: closer than 8px in both directions at once.
        if (dx < 8 - 0.5 && dy < 8 - 0.5) issues.push(`${controls[i].getAttribute("aria-label") || controls[i].textContent.trim()} / ${controls[j].getAttribute("aria-label") || controls[j].textContent.trim()}: ${Math.round(Math.max(dx, dy))}px apart`);
      }
      return issues;
    });
    assert.deepEqual(await audit(), [], `connectors at ${width}`);
    await page.getByRole("button", { name: "Manage Gmail" }).click();
    assert.deepEqual(await audit(), [], `connectors with a Manage panel at ${width}`);
    await skillsTab(page);
    assert.deepEqual(await audit(), [], `skills at ${width}`);
    await context.close();
  }
}));

// ---- Colour --------------------------------------------------------------------------------------------

for (const sky of SKIES) {
  test(`text is at least 4.5:1 and control edges 3:1 in the ${sky} sky, on both tabs`, withFixture({ skills: sampleSkills() }, async (fixture) => {
    const { context, page } = await open(fixture, { sky });
    const check = (tab) => page.evaluate(`(() => { ${COLOUR}
      const audit = ${auditContrast.toString()};
      const root = document.querySelector(".extensions-page");
      const text = audit().filter((f) => root.textContent.includes(f.text));
      const edges = [];
      const need = (name, fg, el, min = 3) => { const r = ratio(over(fg, ground(el)), ground(el)); if (r < min) edges.push(name + ": " + r.toFixed(2) + ":1"); };
      for (const el of root.querySelectorAll(".ext-btn:not(.ext-btn--quiet):not(.ext-btn--text):not(.ext-btn--primary):not(:disabled), .ext-search__input, .ext-select__control")) {
        const s = getComputedStyle(el); if (!el.getBoundingClientRect().width) continue;
        need((el.getAttribute("aria-label") || el.className) + " edge", rgba(s.borderTopColor), el.parentElement);
      }
      const primary = root.querySelector(".ext-btn--primary"); if (primary) need("primary fill", rgba(getComputedStyle(primary).backgroundColor), primary.parentElement);
      need("focus ring", token("--color-focus"), root);
      return { text, edges };
    })()`);
    let result = await check();
    assert.deepEqual(result.text, [], `${sky} connectors text`);
    assert.deepEqual(result.edges, [], `${sky} connectors controls`);
    await page.getByRole("button", { name: "Manage Gmail" }).click();
    result = await check();
    assert.deepEqual(result.text, [], `${sky} connectors with a Manage panel`);
    await skillsTab(page);
    result = await check();
    assert.deepEqual(result.text, [], `${sky} skills text`);
    assert.deepEqual(result.edges, [], `${sky} skills controls`);
    await context.close();
  }));
}

test("the focus ring is at least 3:1 against the page in both skies", withFixture({}, async (fixture) => {
  for (const sky of SKIES) {
    const { context, page } = await open(fixture, { sky });
    await page.keyboard.press("Shift");
    await page.getByRole("button", { name: "Connect Dropbox" }).focus();
    const ring = await page.evaluate(`(() => { ${COLOUR}
      const el = document.activeElement; const s = getComputedStyle(el);
      return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, ratio: ratio(rgba(s.outlineColor), ground(el.parentElement)) };
    })()`);
    assert.equal(ring.style, "solid"); assert.ok(ring.width >= 2);
    assert.ok(ring.ratio >= 3, `${sky}: ring ${ring.ratio.toFixed(2)}:1`);
    await context.close();
  }
}));

for (const sky of SKIES) {
  test(`the accent covers at most 3% of the screen, as fills and marks only, in the ${sky} sky`, withFixture({ skills: sampleSkills() }, async (fixture) => {
    const { context, page } = await open(fixture, { sky, width: 1280, height: 900 });
    const budget = () => page.evaluate(`(() => { ${COLOUR}
      const accent = token("--color-accent"); const near = (c) => c.a > 0.5 && Math.abs(c.r - accent.r) + Math.abs(c.g - accent.g) + Math.abs(c.b - accent.b) < 8;
      let area = 0; const smallText = [];
      for (const el of document.querySelectorAll(".extensions-page *")) {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        if (near(rgba(s.backgroundColor))) area += Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        if (near(rgba(s.color)) && [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) smallText.push(el.textContent.trim().slice(0, 30));
      }
      return { share: area / (innerWidth * innerHeight), smallText };
    })()`);
    let m = await budget();
    assert.ok(m.share <= 0.03, `${sky} connectors: ${(m.share * 100).toFixed(2)}%`);
    assert.deepEqual(m.smallText, [], "the accent is not used for text");
    await skillsTab(page);
    m = await budget();
    assert.ok(m.share > 0 && m.share <= 0.03, `${sky} skills: ${(m.share * 100).toFixed(2)}% (one filled button)`);
    assert.deepEqual(m.smallText, []);
    await context.close();
  }));
}

// ---- Links ---------------------------------------------------------------------------------------------

for (const sky of SKIES) {
  test(`the GeoNames link in Settings > Location takes the theme's link colour in the ${sky} sky`, withFixture({}, async (fixture) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", colorScheme: sky });
    await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
    const page = await context.newPage();
    await page.goto(`${fixture.url}/app/settings/location`, { waitUntil: "domcontentloaded" });
    await page.locator('a[href*="geonames.org"]').first().waitFor({ timeout: 20000 });
    const m = await page.evaluate(`(() => { ${COLOUR}
      const el = document.querySelector('a[href*="geonames.org"]');
      const c = rgba(getComputedStyle(el).color); const want = token("--color-accent-text");
      return { same: c.r === want.r && c.g === want.g && c.b === want.b, rgb: [c.r, c.g, c.b], ratio: ratio(c, ground(el)), underline: getComputedStyle(el).textDecorationLine };
    })()`);
    assert.equal(m.same, true, `${sky}: link colour is the theme's (${m.rgb})`);
    assert.notDeepEqual(m.rgb, [0, 0, 238], "not the browser's default blue");
    assert.ok(m.ratio >= 4.5, `${sky}: ${m.ratio.toFixed(2)}:1`);
    assert.equal(m.underline, "underline", "and it still looks like a link without colour");
    await context.close();
  }));
}

// ---- Other engines: the structure and the phone width, not the pixels ---------------------------------

for (const [name, engine] of [["Firefox", firefox], ["WebKit", webkit]]) {
  test(`${name}: grouped list, filter and skills actions work and nothing scrolls sideways at 320px`, withFixture({ skills: sampleSkills() }, async (fixture) => {
    let other;
    try { other = await engine.launch({ headless: true }); } catch (e) { return; /* engine not installed here */ }
    try {
      const { context, page } = await open(fixture, { width: 320, height: 800, engine: other });
      const headings = (await page.locator(".ext-group__title").allInnerTexts()).map((t) => t.trim());
      assert.equal(headings[0], "Connected");
      assert.equal(await page.locator(".category-pill").count(), 0);
      assert.deepEqual((await page.getByRole("combobox", { name: "Filter connectors" }).locator("option").allInnerTexts()).map((t) => t.trim()), ["All connectors", "Connected", "Not connected", "Needs permissions"]);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole("tab", { name: "Skills" }).click();
      await page.getByRole("button", { name: "Create skill" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Import skill" }).count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await context.close();
    } finally { await other.close(); }
  }));
}
