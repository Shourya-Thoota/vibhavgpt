import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

import { startFixture } from "./support/extensions-fixture.js";

// The home page's Features presenter is a slide show: five static slides, one at a time, each complete inside its frame, with the caption
// in a strip below the picture and never over it. It advances every 6 seconds by itself, pauses, jumps from a dot, answers the arrow keys,
// holds while the tab is hidden or the show is off screen, and under reduced motion does not play and does not fade. Time is faked.
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

const WIDTHS = [[1440, 900], [1024, 768], [760, 900], [390, 844]];

async function open({ width = 1440, height = 900, reducedMotion = "no-preference", sky = "light", clock = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme: sky, hasTouch: width < 800, isMobile: width < 500 });
  await context.addInitScript(([value]) => { try { localStorage.setItem("vibhavgpt-theme", value); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch { /* none */ } }, [sky]);
  const page = await context.newPage();
  if (clock) await page.clock.install({ time: new Date("2026-11-07T12:00:00Z") });
  await page.goto(`${fixture.url}/home/`, { waitUntil: "load" });
  await page.evaluate(() => document.querySelector("#presenter").scrollIntoView({ block: "center", behavior: "instant" }));
  // The section starts when it is near the screen.
  await page.waitForFunction(() => document.querySelector("#presenter")?.hasAttribute("data-ready"));
  return { context, page };
}
const current = (page) => page.evaluate(() => [...document.querySelectorAll("#presenter .slide")].findIndex((slide) => slide.hasAttribute("data-on")));
const live = (page) => page.locator("#presenter .presenter__slides").getAttribute("aria-live");

// ---- One complete slide, with the caption outside the picture ----------------------------------------------------------------

for (const [width, height] of WIDTHS) {
  test(`${width}px: every slide is complete inside its frame, with no clipping, no inner scrollbar, and the caption clear of the picture`, { skip: skipReason }, async () => {
    for (const sky of ["light", "dark"]) {
      const { context, page } = await open({ width, height, sky, clock: false });
      for (let i = 0; i < 5; i += 1) {
        await page.evaluate((n) => document.querySelectorAll(".presenter__dot")[n].click(), i);
        await page.waitForTimeout(500);
        const m = await page.evaluate(() => {
          const frame = document.querySelector("#presenter .presenter__slides").getBoundingClientRect();
          const slide = document.querySelector("#presenter .slide[data-on]");
          const art = [...slide.querySelectorAll(".slide__art")].find((img) => getComputedStyle(img).display !== "none")?.getBoundingClientRect();
          const copy = slide.querySelector(".slide__copy").getBoundingClientRect();
          const badge = slide.querySelector(".slide__badge").getBoundingClientRect();
          const out = [];
          for (const el of slide.querySelectorAll("*")) { const r = el.getBoundingClientRect(); if (r.width && r.height && (r.left < frame.left - 1 || r.right > frame.right + 1 || r.bottom > frame.bottom + 1 || r.top < frame.top - 1)) out.push(`${el.tagName}.${el.className}`); }
          const overflowing = [slide, document.querySelector("#presenter .presenter__slides"), document.querySelector("#presenter")].map((el) => ({ y: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
          const hit = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return { frame: { w: frame.width, h: frame.height }, art: art && { top: art.top, bottom: art.bottom, left: art.left, right: art.right, w: art.width, h: art.height }, copyOverlapsArt: hit(copy, art), badgeOverlapsArt: hit(badge, art), out, overflowing, docW: document.documentElement.scrollWidth, innerW: innerWidth };
        });
        assert.ok(m.art, `slide ${i}: a picture is shown`);
        assert.equal(m.copyOverlapsArt, false, `${width}px ${sky} slide ${i}: the caption does not touch the picture`);
        assert.equal(m.badgeOverlapsArt, false, `${width}px ${sky} slide ${i}: nor does the pill`);
        assert.deepEqual(m.out, [], `${width}px ${sky} slide ${i}: nothing sticks out of the frame`);
        assert.ok(Math.abs(m.art.w / m.art.h - 16 / 9) < 0.02, `slide ${i}: the whole 16:9 picture is shown, not a crop (${m.art.w}x${m.art.h})`);
        for (const o of m.overflowing) { assert.notEqual(o.y, "scroll"); assert.notEqual(o.y, "auto"); assert.ok(o.sh <= o.ch + 1, `no inner scroll: ${o.sh} vs ${o.ch}`); assert.ok(o.sw <= o.cw + 1); }
        assert.ok(m.docW <= m.innerW, "no sideways scroll");
      }
      await context.close();
    }
  });

  test(`${width}px: the frame is the same size on every slide, so nothing moves when it changes`, { skip: skipReason }, async () => {
    const { context, page } = await open({ width, height, clock: false });
    const sizes = [];
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate((n) => document.querySelectorAll(".presenter__dot")[n].click(), i);
      await page.waitForTimeout(450);
      sizes.push(await page.evaluate(() => { const r = document.querySelector("#presenter").getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top + scrollY) }; }));
    }
    assert.equal(new Set(sizes.map((s) => s.h)).size, 1, `one height: ${JSON.stringify(sizes)}`);
    assert.equal(new Set(sizes.map((s) => s.top)).size, 1, "and one place on the page");
    await context.close();
  });

  test(`${width}px: the controls are 44px to touch, and the dots, Pause and arrows all work`, { skip: skipReason }, async () => {
    const { context, page } = await open({ width, height });
    const boxes = await page.evaluate(() => [...document.querySelectorAll("#presenter .presenter__dot, #presenter .presenter__toggle, #presenter .slide[data-on] .slide__copy h3 a")].map((el) => { const r = el.getBoundingClientRect(); return { name: el.className || el.textContent.trim(), w: r.width, h: r.height }; }));
    for (const box of boxes) { assert.ok(box.h >= 43.9, `${box.name}: ${box.h}px tall`); assert.ok(box.w >= 43.9, `${box.name}: ${box.w}px wide`); }
    // A dot jumps to its slide.
    await page.locator(".presenter__dot").nth(3).click();
    assert.equal(await current(page), 3);
    assert.equal(await page.locator(".presenter__dot").nth(3).getAttribute("aria-current"), "true");
    // Pause stops it and Play resumes it.
    await page.locator(".presenter__toggle").click();
    assert.equal(await page.locator(".presenter__toggle").getAttribute("aria-pressed"), "true");
    assert.equal((await page.locator(".presenter__toggle").innerText()).trim(), "Play");
    await page.clock.runFor(20000);
    assert.equal(await current(page), 3, "paused: it stayed");
    await page.locator(".presenter__toggle").click();
    assert.equal((await page.locator(".presenter__toggle").innerText()).trim(), "Pause");
    await page.mouse.move(2, 2);
    await page.clock.runFor(6100);
    assert.equal(await current(page), 4, "playing again: it moved on");
    await context.close();
  });
}

// ---- Playback ------------------------------------------------------------------------------------------------------------------

test("it advances every 6 seconds by itself, and a dot restarts the 6 seconds", { skip: skipReason }, async () => {
  const { context, page } = await open({});
  // The page's clock has been running since it loaded. Freeze it, then restart the 6 seconds from a known instant with the first dot.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 4000); // well ahead of real time, even on a slow machine
  await page.locator(".presenter__dot").nth(0).click();
  await page.mouse.move(2, 2);
  assert.equal(await current(page), 0);
  await page.clock.runFor(5900);
  assert.equal(await current(page), 0, "not before 6 seconds");
  await page.clock.runFor(200);
  assert.equal(await current(page), 1, "at 6 seconds");
  await page.clock.runFor(6000);
  assert.equal(await current(page), 2);
  // A dot: jumps there, and the next change is 6 seconds from the click, not from before it.
  await page.clock.runFor(4000);
  await page.locator(".presenter__dot").nth(0).click();
  await page.mouse.move(2, 2);
  assert.equal(await current(page), 0);
  await page.clock.runFor(5900);
  assert.equal(await current(page), 0, "the clock restarted at the click");
  await page.clock.runFor(200);
  assert.equal(await current(page), 1);
  // It wraps round.
  await page.locator(".presenter__dot").nth(4).click();
  await page.mouse.move(2, 2);
  await page.clock.runFor(6100);
  assert.equal(await current(page), 0);
  await context.close();
});

test("the arrow keys change slide when the stage has focus, and restart the 6 seconds", { skip: skipReason }, async () => {
  const { context, page } = await open({});
  await page.locator("#presenter").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await current(page), 1);
  await page.keyboard.press("ArrowRight");
  assert.equal(await current(page), 2);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await current(page), 1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await current(page), 4, "left from the first goes to the last");
  // The stage has keyboard focus, which holds the show: nothing changes by itself while the reader is there.
  await page.clock.runFor(20000);
  assert.equal(await current(page), 4);
  // Nothing is stolen from the page's other keys.
  const prevented = await page.evaluate(() => { const e = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }); document.querySelector("#presenter").dispatchEvent(e); return e.defaultPrevented; });
  assert.equal(prevented, false);
  await context.close();
});

test("it holds while the tab is hidden and while it is off screen, and picks up again", { skip: skipReason }, async () => {
  const { context, page } = await open({});
  await page.mouse.move(2, 2);
  // Hidden tab.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(20000);
  assert.equal(await current(page), 0, "hidden: it did not move");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(6100);
  assert.equal(await current(page), 1, "visible again: it plays");
  // Off screen.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => { const r = document.querySelector("#presenter").getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; });
  await page.waitForTimeout(100);
  await page.clock.runFor(20000);
  assert.equal(await current(page), 1, "off screen: it did not move");
  await page.evaluate(() => document.querySelector("#presenter").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(100);
  await page.mouse.move(2, 2);
  await page.clock.runFor(6100);
  assert.equal(await current(page), 2, "back on screen: it plays");
  await context.close();
});

test("the page's own scroll does not drive it and nothing scrolls inside it", { skip: skipReason }, async () => {
  const { context, page } = await open({});
  await page.locator(".presenter__toggle").click(); // paused: so only scrolling could move it
  const before = await current(page);
  for (const y of [0, 600, 1500, 2600, 3400]) { await page.evaluate((top) => window.scrollTo(0, top), y); await page.waitForTimeout(60); assert.equal(await current(page), before, `scrolled to ${y}`); }
  const sticky = await page.evaluate(() => getComputedStyle(document.querySelector("#presenter")).position);
  assert.notEqual(sticky, "sticky", "no pinned stage");
  const showcase = await page.evaluate(() => { const el = document.querySelector("#showcase"); return { minHeight: getComputedStyle(el).minHeight, h: el.getBoundingClientRect().height }; });
  assert.ok(showcase.h < 1100, `the section is one stage tall, not a scroll stretch: ${showcase.h}px`);
  const source = fs.readFileSync(path.resolve("frontend/public/home/index.html"), "utf8");
  assert.doesNotMatch(source.slice(source.indexOf("// Features: a slide show")), /addEventListener\("scroll"|scrollTo\(|requestAnimationFrame/, "the show has no scroll handling");
  await context.close();
});

// ---- Transitions, announcements and reduced motion --------------------------------------------------------------------------------

test("slides crossfade in about 350ms and nothing else animates", { skip: skipReason }, async () => {
  const { context, page } = await open({ clock: false });
  const style = await page.evaluate(() => { const s = getComputedStyle(document.querySelector("#presenter .slide")); return { property: s.transitionProperty, duration: s.transitionDuration }; });
  assert.match(style.property, /opacity/);
  assert.ok(/^0\.3[0-9]*s/.test(style.duration) || /^0\.4s/.test(style.duration), `a short fade: ${style.duration}`);
  const dur = parseFloat(style.duration);
  assert.ok(dur >= 0.3 && dur <= 0.4, `300 to 400ms: ${dur}s`);
  const props = await page.evaluate(() => { const found = new Set(); for (const el of document.querySelectorAll("#presenter, #presenter *")) { const s = getComputedStyle(el); const d = s.transitionDuration.split(","); s.transitionProperty.split(",").forEach((p, i) => { if (parseFloat(d[i % d.length]) > 0) found.add(`${el.className.toString().split(" ")[0] || el.tagName}:${p.trim()}`); }); } return [...found]; });
  for (const entry of props) assert.ok(/(^|:)(opacity|visibility)$/.test(entry) || /slide/.test(entry.split(":")[0]) && /opacity|visibility/.test(entry), `only the fade animates: ${entry}`);
  // Once it has settled, no animation runs inside the show.
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest?.("#presenter")).length), 0);
  await context.close();
});

test("a slide is announced only when the reader changes it, never on autoplay", { skip: skipReason }, async () => {
  const { context, page } = await open({});
  await page.mouse.move(2, 2);
  assert.equal(await live(page), "off");
  await page.clock.runFor(6100);
  assert.equal(await current(page), 1);
  assert.equal(await live(page), "off", "autoplay: quiet");
  await page.locator(".presenter__dot").nth(3).click();
  assert.equal(await live(page), "polite", "a dot: announced");
  await page.mouse.move(2, 2);
  await page.clock.runFor(6100);
  assert.equal(await live(page), "off", "and quiet again when it moves by itself");
  await page.locator("#presenter").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await live(page), "polite", "an arrow key: announced");
  await context.close();
});

test("with reduced motion it does not play, does not fade, and the dots still work", { skip: skipReason }, async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page } = await open({ width, height, reducedMotion: "reduce" });
    await page.mouse.move(2, 2);
    assert.equal(await current(page), 0);
    await page.clock.runFor(30000);
    assert.equal(await current(page), 0, "no autoplay");
    assert.equal(await page.locator(".presenter__toggle").isVisible(), false, "nothing to pause");
    const duration = await page.evaluate(() => getComputedStyle(document.querySelector("#presenter .slide")).transitionDuration);
    // The site's own reduced-motion rule sets durations to a hair above zero (1e-05s), which is no visible transition.
    assert.ok(duration.split(",").every((part) => parseFloat(part) < 0.001), `no transition: ${duration}`);
    await page.locator(".presenter__dot").nth(2).click();
    assert.equal(await current(page), 2, "the dots move it");
    await page.keyboard.press("Tab");
    await page.clock.runFor(30000);
    assert.equal(await current(page), 2);
    // The slide is complete and the page does not move.
    const docW = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(docW[0] <= docW[1]);
    await context.close();
  }
});

test("without script the five features are still five cards", { skip: skipReason }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${fixture.url}/home/`, { waitUntil: "load" });
  assert.equal(await page.locator("#presenter .slide").count(), 5);
  assert.equal(await page.locator(".presenter__bar").isVisible(), false);
  const visible = await page.locator("#presenter .slide").evaluateAll((els) => els.every((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && getComputedStyle(el).visibility === "visible" && getComputedStyle(el).opacity === "1"; }));
  assert.equal(visible, true, "all five are shown");
  await context.close();
});

test("the Models section above it is untouched by this", { skip: skipReason }, async () => {
  const source = fs.readFileSync(path.resolve("frontend/public/home/index.html"), "utf8");
  assert.match(source, /html\.presenting:not\(\.save-data\) \.orbits__stage:not\(\[data-home-effect-state="live"\]\)/, "its reserved height still keys on html.presenting");
  assert.match(source, /<section class="orbits" id="models"/);
  assert.match(source, /data-home-effect="orbit-showcase"/);
});
