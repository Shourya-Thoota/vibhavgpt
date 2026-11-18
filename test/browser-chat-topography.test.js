import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";
import { topographyProfile, readTopographyPreference, readMotionPreference, readStudyTopographyPreference, resolveReducedMotion, TOPOGRAPHY_KEY, MOTION_KEY, STUDY_TOPOGRAPHY_KEY } from "../frontend/src/chat-topography.js";

// Chat's contour-line background in a real browser (WebGL2 through the software renderer). It is decorative: it must never take a click, a
// touch, a scroll or a text selection, must not move the message box, must be invisible to assistive technology, must stop when it cannot be
// seen, and must be gone (with its listeners) when Chat is left. Study keeps its own background and never shows it.

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

async function open({ width = 1280, height = 900, reducedMotion = "no-preference", sky = "dark", storage = {}, hasTouch = false, route = "/app/chat" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme: sky, hasTouch, isMobile: width < 500 });
  await context.addInitScript(([entries]) => {
    try { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); } catch { /* none */ }
    // Count window listeners for pointer events, to prove they are released.
    // Track window pointer listeners by function. The background's own handlers are the ones that touch its `pointer.inside` state, so they
    // can be told apart from the app's (which register their own pointer listeners on other screens).
    window.__listeners = new Set();
    const add = window.addEventListener.bind(window); const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, fn, ...rest) => { if (/^pointer/.test(type) && typeof fn === "function") window.__listeners.add(JSON.stringify([type, fn.toString().length]) + "|" + (window.__ids = window.__ids || new WeakMap()).get(fn)); if (/^pointer/.test(type) && typeof fn === "function") { (window.__fns = window.__fns || []).push({ type, fn }); } return add(type, fn, ...rest); };
    window.removeEventListener = (type, fn, ...rest) => { if (window.__fns) window.__fns = window.__fns.filter((entry) => !(entry.type === type && entry.fn === fn)); return remove(type, fn, ...rest); };
    window.__backgroundHandlers = () => (window.__fns || []).filter((entry) => /.inside/.test(entry.fn.toString())).map((entry) => entry.type).sort();
    // Count the background's own WebGL draw calls, to prove drawing stops when hidden (the app's other animations are not counted).
    window.__draws = 0;
    for (const name of ["drawArrays", "drawArraysInstanced"]) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) { window.__draws += 1; return original.apply(this, args); };
    }
  }, [{ "vibhavgpt-theme": sky, "vibhavgpt-theme-study": sky, "vibhavgpt-theme-chosen": "1", ...storage }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  await page.goto(`${fixture.url}${route}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}
const layer = (page) => page.locator(".chat-topography");
const ready = async (page) => { await layer(page).waitFor({ state: "attached", timeout: 20000 }); await page.locator(".chat-topography canvas").waitFor({ state: "attached", timeout: 20000 }); await page.waitForTimeout(600); };

// ---- The decision logic ------------------------------------------------------------------------------------------------------------------

test("the profile starts from the specification's values, and only ever reduces them", () => {
  const full = topographyProfile({ resolved: "light" });
  assert.equal(full.enabled, true);
  assert.equal(full.interactive, true);
  assert.deepEqual(
    { lineCount: full.props.lineCount, lineWidth: full.props.lineWidth, elevation: full.props.elevation, foreground: full.props.foreground, tilt: full.props.tilt, speed: full.props.speed, direction: full.props.direction, glow: full.props.glow, depthOfField: full.props.depthOfField, fog: full.props.fog, hoverEffect: full.props.hoverEffect, clickEffect: full.props.clickEffect, color: full.props.color, lightMode: full.props.lightMode },
    { lineCount: 22, lineWidth: 1.2, elevation: 1, foreground: 0.2, tilt: 32, speed: 0.25, direction: "forward", glow: 0.6, depthOfField: 0.4, fog: 0.35, hoverEffect: "lift", clickEffect: "pulse", color: "#2554d8", lightMode: true },
  );
  assert.equal(topographyProfile({ resolved: "dark" }).props.lightMode, false, "a dark sky is not drawn in light mode");
});

test("reduced motion makes it still; a phone or touch screen makes it non-interactive and cheaper; data saver and weak devices turn it off", () => {
  const still = topographyProfile({ reducedMotion: true });
  assert.equal(still.enabled, true);
  assert.equal(still.interactive, false);
  assert.deepEqual([still.props.speed, still.props.morph, still.props.intro, still.props.mouseInteraction, still.props.parallax, still.props.clickEffect], [0, 0, false, false, 0, "none"]);
  const phone = topographyProfile({ narrow: true });
  assert.equal(phone.interactive, false);
  assert.deepEqual([phone.props.mouseInteraction, phone.props.clickEffect, phone.props.glow, phone.props.dpr], [false, "none", 0, 1], "no pointer response, no bloom passes, one pixel per pixel");
  assert.ok(phone.props.lineCount < 22);
  assert.equal(topographyProfile({ coarsePointer: true }).interactive, false);
  assert.equal(topographyProfile({ saveData: true }).enabled, false);
  assert.equal(topographyProfile({ lowPower: true }).enabled, false);
});

test("the preference is on unless this device turned it off, and unreadable storage means on", () => {
  const store = (value) => ({ getItem: () => value });
  assert.equal(readTopographyPreference(store(null)), "on");
  assert.equal(readTopographyPreference(store("off")), "off");
  assert.equal(readTopographyPreference(store("anything else")), "on");
  assert.equal(readTopographyPreference({ getItem() { throw new Error("blocked"); } }), "on");
});

// ---- In a real browser -----------------------------------------------------------------------------------------------------------------

test("Chat shows it, hidden from assistive technology, behind everything and taking no pointer events", { skip: skipReason }, async () => {
  const { context, page, errors } = await open();
  await ready(page);
  const facts = await page.evaluate(() => {
    const el = document.querySelector(".chat-topography"); const style = getComputedStyle(el); const canvas = el.querySelector("canvas"); const box = canvas.getBoundingClientRect();
    return { ariaHidden: el.getAttribute("aria-hidden"), pointerEvents: style.pointerEvents, canvasPointer: getComputedStyle(canvas).pointerEvents, position: style.position, zIndex: style.zIndex, w: Math.round(box.width), h: Math.round(box.height), vw: innerWidth, vh: innerHeight, focusable: el.querySelectorAll("a, button, input, textarea, [tabindex]").length };
  });
  assert.equal(facts.ariaHidden, "true");
  assert.equal(facts.pointerEvents, "none");
  assert.equal(facts.canvasPointer, "none");
  assert.equal(facts.position, "fixed");
  assert.equal(facts.zIndex, "-1");
  assert.equal(facts.focusable, 0, "nothing in it can take focus");
  assert.ok(facts.w >= facts.vw - 2 && facts.h >= facts.vh - 2, "it covers the screen");
  assert.deepEqual(errors, [], "no page errors");
  await context.close();
});

test("it does not intercept clicks, typing, scrolling or text selection, and the message box does not move", { skip: skipReason }, async () => {
  const { context, page } = await open();
  await ready(page);
  const composer = page.locator("textarea, [contenteditable='true'], [role='textbox']").first();
  await composer.waitFor({ timeout: 15000 });
  const before = await composer.boundingBox();
  // Nothing in front of the message box is the canvas: a click lands on the box itself.
  const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { canvas: Boolean(el?.closest(".chat-topography")), tag: el?.tagName }; }, { x: before.x + before.width / 2, y: before.y + before.height / 2 });
  assert.equal(hit.canvas, false, `the point over the message box is ${hit.tag}, not the background`);
  await composer.click();
  await page.keyboard.type("hello there, this is a longer message to type while the background draws");
  const after = await composer.boundingBox();
  assert.ok(Math.abs(after.y - before.y) < 60 && Math.abs(after.x - before.x) < 2, `the message box did not jump (before y ${before.y}, after y ${after.y})`);
  assert.match(await composer.evaluate((el) => el.value ?? el.textContent ?? ""), /hello there/, "typing reached the box");
  // Moving the pointer across the screen and pressing does not change what is under it.
  await page.mouse.move(300, 200); await page.mouse.down(); await page.mouse.up();
  assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(300, 200)?.closest(".chat-topography"))), false);
  // Text can still be selected: the layer is not selectable and does not block selection.
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".chat-topography")).userSelect), "none");
  await context.close();
});

// The owner asked (2026-11-09) for Study to support Chat's background, and (Slice 6) for parity: Study shows the same contours by default.
// Study's choice stays separate (a reader can turn it off for Study alone); Image never shows it.
const toStudy = async (page) => { await page.getByRole("button", { name: /^Study$/ }).first().click().catch(async () => { await page.getByText("Study", { exact: true }).first().click(); }); await page.waitForTimeout(800); };

test("Study shows the same contours as Chat by default, off when turned off for Study, Image never; Study's saved sky is untouched", { skip: skipReason }, async () => {
  const { context, page } = await open({ storage: { "vibhavgpt-theme": "dark", "vibhavgpt-theme-study": "light" } });
  await ready(page);
  await toStudy(page);
  await layer(page).waitFor({ state: "attached", timeout: 20000 });
  assert.equal(await layer(page).count(), 1, "in Study by default, like Chat");
  assert.equal(await page.evaluate(() => localStorage.getItem("vibhavgpt-theme-study")), "light", "Study's saved sky is untouched");
  await page.goto(`${fixture.url}/app/image`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  assert.equal(await layer(page).count(), 0, "not in Image");
  await context.close();
  const off = await open({ storage: { [STUDY_TOPOGRAPHY_KEY]: "off" } });
  await ready(off.page);
  await toStudy(off.page);
  assert.equal(await layer(off.page).count(), 0, "a reader who turned it off for Study keeps it off");
  await off.context.close();
});

test("Study can show the same contours by its own choice, independent of Chat's", { skip: skipReason }, async () => {
  const { context, page } = await open({ storage: { [STUDY_TOPOGRAPHY_KEY]: "on", "vibhavgpt-chat-topography": "off" } });
  await page.waitForTimeout(1500);
  assert.equal(await layer(page).count(), 0, "Chat's own choice (Plain) is respected");
  await toStudy(page);
  await layer(page).waitFor({ state: "attached", timeout: 20000 });
  assert.equal(await layer(page).count(), 1, "Study shows it by its own choice");
  assert.equal(await page.locator(".chat-topography canvas").count(), 1, "one background canvas, no second loop");
  await page.goto(`${fixture.url}/app/image`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  assert.equal(await layer(page).count(), 0, "still never in Image");
  await context.close();
});

test("the Settings choice turns it off, is remembered across a reload, and leaves the sky alone", { skip: skipReason }, async () => {
  const { context, page } = await open();
  await ready(page);
  const sky = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.goto(`${fixture.url}/app/settings/appearance`, { waitUntil: "domcontentloaded" });
  const plain = page.getByRole("radio", { name: "Plain" }).or(page.getByRole("button", { name: "Plain" })).first();
  await plain.waitFor({ timeout: 20000 });
  await plain.click();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), TOPOGRAPHY_KEY), "off");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), sky, "the sky did not change");
  await page.goto(`${fixture.url}/app/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  assert.equal(await layer(page).count(), 0, "off stays off after a reload");
  await context.close();
});

test("reduced motion: a still drawing that does not respond to the pointer", { skip: skipReason }, async () => {
  const { context, page } = await open({ reducedMotion: "reduce" });
  await ready(page);
  assert.equal(await page.evaluate(() => document.querySelector(".chat-topography").hasAttribute("data-interactive")), false);
  await context.close();
});

test("a phone gets the lighter, non-interactive version, and the layout does not overflow", { skip: skipReason }, async () => {
  const { context, page } = await open({ width: 390, height: 844, hasTouch: true });
  await ready(page);
  const facts = await page.evaluate(() => { const canvas = document.querySelector(".chat-topography canvas"); return { interactive: document.querySelector(".chat-topography").hasAttribute("data-interactive"), css: Math.round(canvas.getBoundingClientRect().width), pixels: canvas.width, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
  assert.equal(facts.interactive, false);
  assert.ok(facts.pixels <= facts.css * 1.01, "one drawn pixel per screen pixel on a phone");
  assert.ok(facts.overflow <= 1, "no sideways scroll");
  await context.close();
});

test("it stops drawing when the tab is hidden and resumes when it is shown", { skip: skipReason }, async () => {
  const { context, page } = await open();
  await ready(page);
  // Software rendering is slow, so count draws over a few seconds rather than expecting a frame rate.
  const draws = (ms) => page.evaluate(async (wait) => { const start = window.__draws; await new Promise((resolve) => setTimeout(resolve, wait)); return window.__draws - start; }, ms);
  assert.ok((await draws(3000)) > 0, "it draws while visible");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(1500); // let a frame already in flight finish
  assert.equal(await draws(2500), 0, "it does not draw at all while hidden");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.ok((await draws(3500)) > 0, "it resumes when shown");
  await context.close();
});

test("leaving Chat inside the app removes the layer and releases its listeners", { skip: skipReason }, async () => {
  const { context, page } = await open();
  await ready(page);
  const during = await page.evaluate(() => window.__backgroundHandlers());
  assert.deepEqual(during, ["pointercancel", "pointerdown", "pointermove", "pointerup"], "the background registered its four window pointer listeners while on show");
  await page.getByRole("link", { name: /Extensions/ }).or(page.getByText("Extensions", { exact: true })).first().click();
  await page.waitForFunction(() => !document.querySelector(".chat-topography"), null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => window.__backgroundHandlers()), [], "every one of them was released");
  await context.close();
});

// The empty new-chat screen is the first thing a person sees, and it paints its own glow behind the conversation area. In the light sky that
// glow was built from opaque colour stops and painted over the lines, so the background showed in a conversation but not on this screen. The
// proof is a picture: the same screen with the background on and with it off must differ by the lines.
test("the empty new-chat screen shows the contour lines in both skies, not only inside a conversation", { skip: skipReason }, async () => {
  for (const sky of ["light", "dark"]) {
    const shot = async (storage, waitForLayer) => {
      const { context, page } = await open({ sky, reducedMotion: "reduce", storage });
      if (waitForLayer) await ready(page); else await page.waitForTimeout(2500);
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => Boolean(document.querySelector(".chat__scroll[data-empty]"))), true, `${sky}: this is the empty new-chat screen`);
      const png = (await page.screenshot()).toString("base64");
      await context.close();
      return png;
    };
    const withLines = await shot({}, true);
    const without = await shot({ "vibhavgpt-chat-topography": "off" }, false);
    const decoder = await browser.newContext();
    const page = await decoder.newPage();
    const share = await page.evaluate(async ([a, b]) => {
      const bitmap = async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const [one, two] = await Promise.all([bitmap(a), bitmap(b)]);
      const read = (bmp) => { const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const x = c.getContext("2d"); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height).data; };
      const [p, q] = [read(one), read(two)];
      let differing = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 18 || Math.abs(p[i + 1] - q[i + 1]) > 18 || Math.abs(p[i + 2] - q[i + 2]) > 18) differing += 1;
      return differing / (p.length / 4);
    }, [withLines, without]);
    await decoder.close();
    assert.ok(share > 0.01, `${sky}: the lines are visible on the empty new-chat screen (${(share * 100).toFixed(2)}% of pixels differ from the same screen without them)`);
  }
});

// ---- Reduce motion (motion sickness) -------------------------------------------------------------------------------------------------------

test("the motion choice: follow the device unless the reader chose; unknown or unreadable means follow the device", () => {
  const store = (value) => ({ getItem: () => value });
  assert.equal(readMotionPreference(store(null)), "system");
  assert.equal(readMotionPreference(store("reduce")), "reduce");
  assert.equal(readMotionPreference(store("full")), "full");
  assert.equal(readMotionPreference(store("weird")), "system");
  assert.equal(readMotionPreference({ getItem() { throw new Error("blocked"); } }), "system");
  assert.equal(resolveReducedMotion("system", true), true);
  assert.equal(resolveReducedMotion("system", false), false);
  assert.equal(resolveReducedMotion("reduce", false), true, "the reader's choice wins over the device");
  assert.equal(resolveReducedMotion("full", true), false);
  assert.equal(readStudyTopographyPreference(store(null)), "on", "Study matches Chat unless turned off for Study");
  assert.equal(readStudyTopographyPreference(store("on")), "on");
  assert.equal(readStudyTopographyPreference(store("off")), "off");
});

const drawsOver = (page, ms) => page.evaluate(async (wait) => { const start = window.__draws; await new Promise((resolve) => setTimeout(resolve, wait)); return window.__draws - start; }, ms);

test("Reduce motion stops the drawing loop itself (no draws once still), not merely hiding a moving canvas", { skip: skipReason }, async () => {
  const { context, page } = await open({ storage: { [MOTION_KEY]: "reduce" } });
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-motion")), "reduce", "set before or at first paint");
  assert.equal(await layer(page).count(), 1, "a still background remains");
  await page.waitForTimeout(1500);
  assert.equal(await drawsOver(page, 2500), 0, "no frames are drawn while still");
  const composer = page.locator("textarea, [contenteditable='true'], [role='textbox']").first();
  await composer.click(); await page.keyboard.type("typing does not restart the animation");
  await page.mouse.move(400, 300); await page.mouse.move(600, 400);
  assert.equal(await drawsOver(page, 2000), 0, "still no frames after typing and pointer movement");
  await context.close();
});

test("Allow overrides the device setting: it moves even when the device asks for reduced motion", { skip: skipReason }, async () => {
  const { context, page } = await open({ reducedMotion: "reduce", storage: { [MOTION_KEY]: "full" } });
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-motion")), false);
  assert.ok((await drawsOver(page, 3000)) > 0, "it draws");
  await context.close();
});

test("the Settings choice applies at once without a reload, and is remembered", { skip: skipReason }, async () => {
  const { context, page } = await open();
  await ready(page);
  await page.goto(`${fixture.url}/app/settings/appearance`, { waitUntil: "domcontentloaded" });
  const reduce = page.getByRole("radio", { name: "Reduce", exact: true }).or(page.getByRole("button", { name: "Reduce", exact: true })).first();
  await reduce.waitFor({ timeout: 20000 });
  const before = await page.evaluate(() => performance.timeOrigin);
  await reduce.click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-motion")), "reduce", "applied immediately");
  assert.equal(await page.evaluate(() => performance.timeOrigin), before, "no reload happened");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), MOTION_KEY), "reduce");
  const duration = await page.evaluate(() => { const el = document.createElement("div"); el.style.animation = "spin 2s linear infinite"; document.body.append(el); const d = getComputedStyle(el).animationDuration; el.remove(); return d; });
  assert.ok(parseFloat(duration) < 0.001, `decorative animation is stopped (${duration})`);
  await context.close();
});
