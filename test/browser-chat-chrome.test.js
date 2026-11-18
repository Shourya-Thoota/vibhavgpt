import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";

// The composer's menus, the assistant's mark, the top of a scrolled chat, and the Sources page, in a real browser at desktop and phone size.

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
  browser = await chromium.launch({ headless: true, executablePath: findChrome(), args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  fixture = await startFixture({});
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open({ width = 1280, height = 900, sky = "light", route = "/app/chat", topography = "off" } = {}) {
  const phone = width < 500;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addInitScript(([theme, background]) => { try { localStorage.setItem("vibhavgpt-theme", theme); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-chat-topography", background); } catch { /* none */ } }, [sky, topography]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(`${fixture.url}${route}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer, .src-section, main").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(2500); // the app has finished starting
  return { context, page, errors };
}


// Waits until keyboard focus is on one of the menu's rows (it is placed there a moment after the menu opens).
async function focusInMenu(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.evaluate(() => Boolean(document.activeElement?.getAttribute("role")?.startsWith("menuitem")))) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`focus never moved into the menu: ${await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className} menus=${document.querySelectorAll('[role=\"menu\"]').length} state=${document.querySelector('[role=\"menu\"]')?.dataset.state}`)}`);
}

// --- the composer's "+" menu -------------------------------------------------------------------------------------------------------------
test("the + menu is one restrained panel: Response mode is a labelled group inside it, not a second floating panel opened by hovering", { skip: skipReason }, async () => {
  const { context, page, errors } = await open();
  const trigger = page.getByRole("button", { name: "Add to message" }).first();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Add to message" });
  await menu.waitFor();
  await menu.getByRole("menuitem").first().waitFor();
  await page.waitForTimeout(500); // the panel has finished opening, so every row is in the accessibility tree
  assert.equal(await page.locator(".ui-menu__submenu").count(), 0, "no nested panel");
  assert.equal(await menu.locator('[aria-haspopup="menu"]').count(), 0, "no row opens another menu");
  const names = (role) => menu.getByRole(role).locator(".ui-menu__name").allTextContents();
  assert.deepEqual(await names("menuitem"), ["Photos", "Files", "Custom"], "the add actions, and Custom, which opens Settings");
  assert.deepEqual(await names("menuitemradio"), ["Concise", "Detailed", "Learning"], "every mode is still there, under the same names");
  assert.equal(await menu.locator(".ui-menu__aside").textContent(), "Settings", "Custom says it leads to Settings");
  assert.equal(await menu.locator('[role="group"] [role="menuitem"]').count(), 0, "Custom is not one of the modes: it sits outside the group, after a divider");
  assert.equal(await menu.getByRole("separator").count() >= 2, true, "dividers set the groups apart");
  assert.equal(await menu.getByRole("group", { name: "Response mode" }).count(), 1, "the group has an accessible name, and no heading");
  const style = await menu.evaluate((node) => {
    const cs = getComputedStyle(node);
    const item = node.querySelector(".ui-menu__item");
    return { radius: parseFloat(cs.borderTopLeftRadius), width: node.getBoundingClientRect().width, row: item.getBoundingClientRect().height, sparkles: node.querySelectorAll(".lucide-sparkles, [class*='sparkle']").length };
  });
  assert.ok(style.radius <= 12, `a small radius (${style.radius}px)`);
  assert.ok(style.width <= 240, `compact (${style.width}px)`);
  // Slice 6: menu rows are at least 40px on a desktop (the shared menu row, --menu-row), still single-line and compact.
  assert.ok(style.row >= 40 && style.row <= 44, `compact rows of at least 40px (${style.row}px)`);
  assert.equal(style.sparkles, 0, "no decorative sparkle icons");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the + menu is placed above the composer and inside the window, at a short height too, with nothing clipped", { skip: skipReason }, async () => {
  for (const [width, height] of [[1280, 900], [1280, 560], [1024, 640]]) {
    const { context, page } = await open({ width, height });
    await page.getByRole("button", { name: "Add to message" }).first().click();
    const menu = page.getByRole("menu", { name: "Add to message" });
    await menu.waitFor();
    await page.waitForTimeout(300);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('[role="menu"]').getBoundingClientRect();
      const trigger = document.querySelector(".composer__add-trigger").getBoundingClientRect();
      const composer = document.querySelector(".composer").getBoundingClientRect();
      return { panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right }, triggerTop: trigger.top, composerTop: composer.top, vw: innerWidth, vh: innerHeight, scrollable: document.querySelector('[role="menu"]').scrollHeight > document.querySelector('[role="menu"]').clientHeight + 1 };
    });
    const where = `${width}x${height}`;
    assert.ok(geometry.panel.top >= 0 && geometry.panel.bottom <= geometry.vh, `${where}: inside the window ${JSON.stringify(geometry.panel)}`);
    assert.ok(geometry.panel.left >= 0 && geometry.panel.right <= geometry.vw, `${where}: inside horizontally`);
    assert.ok(geometry.panel.bottom <= geometry.triggerTop + 1 || geometry.panel.top >= geometry.composerTop, `${where}: does not cover the button it opened from`);
    assert.equal(geometry.scrollable, false, `${where}: no clipped rows inside the panel`);
    await context.close();
  }
});

test("the + menu works by keyboard: arrows move, Enter chooses, Escape closes and puts focus back on the button", { skip: skipReason }, async () => {
  const { context, page } = await open();
  const trigger = page.getByRole("button", { name: "Add to message" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Add to message" });
  await menu.waitFor();
  await focusInMenu(page);
  const first = await page.evaluate(() => document.activeElement.textContent.trim());
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement.textContent.trim());
  assert.notEqual(first, second, "the arrow key moved focus to the next row");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Add to message", "focus is back on the button");
  await page.waitForTimeout(500); // the closing animation has finished
  // Reaching a response mode by arrows alone, and choosing it.
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await focusInMenu(page);
  for (let i = 0; i < 20; i += 1) {
    if (await page.evaluate(() => document.activeElement?.querySelector(".ui-menu__name")?.textContent === "Detailed")) break;
    await page.keyboard.press("ArrowDown");
  }
  assert.equal(await page.evaluate(() => document.activeElement.querySelector(".ui-menu__name").textContent), "Detailed");
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "detached" });
  assert.ok(fixture.state.calls.some((call) => /profile\/preferences/.test(call)), "choosing a mode saves it, as before");
  await context.close();
});

test("on a phone the add sheet has no sparkle icons, every row is at least 44px, and the modes keep their names", { skip: skipReason }, async () => {
  const { context, page } = await open({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add to message" }).first().click();
  const sheet = page.getByRole("dialog").first();
  await sheet.waitFor();
  await page.waitForTimeout(400);
  const rows = await sheet.locator(".add-sheet__row").evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent.replace(/\s+/g, " ").trim(), height: Math.round(node.getBoundingClientRect().height) })));
  assert.ok(rows.length >= 6, "the rows are there");
  for (const row of rows) assert.ok(row.height >= 44, `${row.text}: ${row.height}px is a touch target`);
  const modes = await sheet.getByRole("radio").allTextContents();
  assert.deepEqual(modes.map((t) => t.trim()), ["Concise", "Detailed", "Learning"]);
  assert.equal(await sheet.locator(".lucide-sparkles").count(), 0);
  await context.close();
});

// --- the assistant's mark -----------------------------------------------------------------------------------------------------------------
test("the assistant's mark sits straight on the page: no tile, halo or clipping behind it, in both skies, saved and live", { skip: skipReason }, async () => {
  for (const sky of ["light", "dark"]) {
    const { context, page, errors } = await open({ sky, route: `/app/chat?conversation=${CONVERSATION_ID}` });
    await page.locator(".turn__mark").first().waitFor({ timeout: 15_000 });
    const marks = await page.locator(".turn__mark").evaluateAll((nodes) => nodes.map((node) => {
      const cs = getComputedStyle(node);
      const img = node.querySelector("img");
      return { bg: cs.backgroundColor, bgImage: cs.backgroundImage, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius, overflow: cs.overflow, fit: getComputedStyle(img).objectFit, loaded: img.complete && img.naturalWidth > 0 };
    }));
    assert.ok(marks.length >= 2, `${sky}: the replies show the mark`);
    for (const mark of marks) {
      assert.equal(mark.bg, "rgba(0, 0, 0, 0)", `${sky}: no tile colour`);
      assert.equal(mark.bgImage, "none");
      assert.equal(mark.shadow, "none", `${sky}: no halo`);
      assert.equal(mark.fit, "contain", `${sky}: the whole mark is shown, not cropped`);
      assert.equal(mark.loaded, true);
    }
    // And on the screen: the pixels at the mark's corner (transparent in the image) are the page's own, same as just outside it.
    const box = await page.locator(".turn__mark").first().boundingBox();
    const shot = await page.screenshot({ clip: { x: box.x - 8, y: box.y - 4, width: box.width + 16, height: box.height + 8 } });
    const pixels = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      const at = (px, py) => Array.from(x.getImageData(px, py, 1, 1).data.slice(0, 3));
      return { outside: at(2, 2), corner: at(8, 4), farCorner: at(8 + 23, 4 + 23) };
    }, shot.toString("base64"));
    const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 3);
    assert.ok(close(pixels.corner, pixels.outside), `${sky}: the mark's corner is the page's colour ${JSON.stringify(pixels)}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("while a reply is being written the mark has no tile either", { skip: skipReason }, async () => {
  const { context, page } = await open({ route: "/app/chat" });
  await page.route("**/api/chat/stream", async () => { await new Promise((resolve) => setTimeout(resolve, 6000)); });
  const input = page.locator("textarea.composer__input").first();
  await input.waitFor();
  await input.click();
  await input.pressSequentially("hello");
  await input.press("Enter");
  await page.locator(".turn__mark").first().waitFor({ timeout: 8000 });
  const bgs = await page.locator(".turn__mark").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
  assert.ok(bgs.length >= 1);
  for (const bg of bgs) assert.equal(bg, "rgba(0, 0, 0, 0)");
  await context.close();
});

// --- the top of a scrolled chat ------------------------------------------------------------------------------------------------------------
async function scrolledTop(width, height, sky) {
  const { context, page } = await open({ width, height, sky, topography: "on", route: `/app/chat?conversation=${CONVERSATION_ID}` });
  await page.locator(".chat__scroll").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector(".chat")?.dataset.scrolled === "true", null, { timeout: 8000 });
  const state = await page.evaluate(() => {
    const scroll = document.querySelector(".chat__scroll");
    const fade = getComputedStyle(scroll, "::before");
    return { mask: getComputedStyle(scroll).maskImage, fadeOpacity: fade.opacity, fadePaint: fade.backgroundImage, topography: document.querySelector(".workspace")?.dataset.topography };
  });
  await context.close();
  return state;
}

test("when the chat is scrolled nothing is painted over the contour lines under the Chat/Image control: the edge is a mask on the messages", { skip: skipReason }, async () => {
  for (const [width, height, sky] of [[1280, 900, "light"], [1280, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]]) {
    const state = await scrolledTop(width, height, sky);
    const where = `${width}x${height} ${sky}`;
    assert.equal(state.topography, "on", `${where}: the background is on`);
    assert.equal(state.fadeOpacity, "0", `${where}: the gradient in the page's wash colour is not painted (it was a flat band over the lines)`);
    assert.match(state.mask, /linear-gradient/, `${where}: the messages fade out at the top by a mask instead`);
  }
});

test("with the background off the soft edge is exactly as it was: the painted fade, and no mask", { skip: skipReason }, async () => {
  const { context, page } = await open({ topography: "off", route: `/app/chat?conversation=${CONVERSATION_ID}` });
  await page.waitForFunction(() => document.querySelector(".chat")?.dataset.scrolled === "true", null, { timeout: 8000 });
  const state = await page.evaluate(() => { const scroll = document.querySelector(".chat__scroll"); return { mask: getComputedStyle(scroll).maskImage, fadeOpacity: getComputedStyle(scroll, "::before").opacity }; });
  assert.equal(state.fadeOpacity, "1");
  assert.equal(state.mask, "none");
  await context.close();
});

test("a scrolled chat still scrolls, still takes clicks on its messages, and keeps the soft edge off when it is not scrolled", { skip: skipReason }, async () => {
  const { context, page } = await open({ topography: "on", route: `/app/chat?conversation=${CONVERSATION_ID}` });
  const scroll = page.locator(".chat__scroll");
  await scroll.waitFor();
  await page.waitForFunction(() => document.querySelector(".chat")?.dataset.scrolled === "true");
  const before = await scroll.evaluate((n) => n.scrollTop);
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction((start) => document.querySelector(".chat__scroll").scrollTop < start, before, { timeout: 4000 }).catch(() => {});
  assert.ok((await scroll.evaluate((n) => n.scrollTop)) < before, "the wheel scrolls the messages");
  const hit = await page.evaluate(() => { const el = document.elementFromPoint(700, 300); return el?.closest(".chat__thread") !== null; });
  assert.equal(hit, true, "a click at a message lands on the message, not on a layer over it");
  await scroll.evaluate((n) => { n.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector(".chat")?.dataset.scrolled !== "true");
  assert.equal(await scroll.evaluate((n) => getComputedStyle(n).maskImage), "none", "at the top nothing is masked");
  await context.close();
});

// --- Sources ------------------------------------------------------------------------------------------------------------------------------
test("Sources: a Social section with the seven destinations, platform icons, 44px rows, safe links, no overflow on a phone, and the old resources kept", { skip: skipReason }, async () => {
  for (const [width, height] of [[1280, 900], [390, 844]]) {
    const { context, page, errors } = await open({ width, height, route: "/sources" });
    await page.getByRole("heading", { name: "Social", level: 2 }).waitFor();
    const links = await page.locator("a.src-row--social").evaluateAll((nodes) => nodes.map((node) => ({
      href: node.href, name: node.querySelector("strong").textContent, target: node.target, rel: node.rel, height: Math.round(node.getBoundingClientRect().height),
      icon: (() => { const r = node.querySelector(".src-row__icon svg").getBoundingClientRect(); return r.width > 10 && r.height > 10; })(),
    })));
    assert.deepEqual(links.map((l) => [l.name, l.href]), [
      ["YouTube", "https://www.youtube.com/@vibhavthoota"],
      ["Instagram", "https://www.instagram.com/vibhavgpt.ai/"],
      ["X", "https://x.com/VibhavGPT"],
      ["Bluesky", "https://bsky.app/profile/vibhavgpt.bsky.social"],
      ["Reddit", "https://www.reddit.com/user/Cool-Issue-2311/"],
      ["Threads", "https://www.threads.net/@vibhavgpt.ai"],
      ["GitHub", "https://github.com/Shourya-Thoota"],
    ]);
    for (const link of links) {
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
      assert.ok(link.height >= 44, `${width}px ${link.name}: ${link.height}px tall`);
      assert.equal(link.icon, true, `${link.name} shows its platform icon`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px: no horizontal scroll`);
    // The code, license, security and navigation resources are all still there.
    for (const needle of ["View the source code", "See the releases", "LICENSE", "README.md", "SECURITY.md", "See all apps"]) assert.ok(await page.getByText(needle).first().isVisible(), `${needle} is still on the page`);
    // Keyboard: the social links are reached by Tab, in order, each showing a focus ring.
    await page.locator("a.src-row--social").first().focus();
    const order = [];
    for (let i = 0; i < 5; i += 1) { order.push(await page.evaluate(() => document.activeElement.querySelector?.("strong")?.textContent)); await page.keyboard.press("Tab"); }
    assert.deepEqual(order, ["YouTube", "Instagram", "X", "Bluesky", "Reddit"]);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
