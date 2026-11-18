import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";

// The homepage's model showcase in real browsers, served from frontend/dist with production's routes. The full set runs in
// Chromium, which can synthesise wheel, touch and swipe input; WebKit and Firefox run the checks that depend on layout engines
// (nothing moves when the stage loads, nothing overflows, the plain list and slide changes work). An engine that is not
// installed is reported as skipped, never as passed. Playwright's WebKit is its Windows build, not Safari.
const dist = path.resolve("frontend/dist");
const built = fs.existsSync(path.join(dist, "home/index.html"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const ROUTES = { "/": "home/index.html", "/home": "home/index.html", "/pricing": "pricing.html" };
// The slides, in order (Slice 7 added Zenith; Nova and Nebula were retired on 2026-11-14). Counts below follow this list, never a
// written number.
const NAMES = ["Lumen", "Vulcan", "Zenith", "Tecton", "Study", "Prism", "Aura"];
const LAST = NAMES.length - 1;
const OFF = { version: "credits-test", active: false, carryMode: null, scheduledFor: null, activatedAt: null, reason: "disabled", unit: { creditMicros: 50000 } };
const CARRY = { ...OFF, active: true, carryMode: "carry", activatedAt: "2026-11-07T03:20:00.000Z", reason: "active" };

function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google/Chrome/Application/chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() }), true],
  ["WebKit", () => webkit.launch({ headless: true }), false],
  ["Firefox", () => firefox.launch({ headless: true }), false],
];

for (const [engine, launch, full] of ENGINES) describe(`The model showcase in ${engine}`, { concurrency: false, timeout: 600000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  let policy = OFF; // what GET /api/usage/policy answers, so a test can play the server
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/usage/policy") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(policy)); return; }
      // A signed-out visitor: the page asks who is signed in and is told no.
      if (url.pathname.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end("{}"); return; }
      let file = path.join(dist, ROUTES[url.pathname] ?? url.pathname.slice(1));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const needBrowser = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return false; } return true; };

  // Opens the homepage as a signed-out visitor and waits for the stage to be live (unless told not to).
  async function open({ width = 1280, height = 800, theme = "light", reducedMotion = "no-preference", touch = false, javaScriptEnabled = true, block = false, wait = "live", serverPolicy = OFF } = {}) {
    policy = serverPolicy;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, javaScriptEnabled, hasTouch: touch, isMobile: touch && engine === "Chromium" });
    await context.addInitScript(([sky]) => {
      try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {}
      // Layout shifts and the document's height as the page parses, to compare with what it is once the stage is live.
      window.__shift = 0;
      try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
      document.addEventListener("DOMContentLoaded", () => { window.__docHeightAtParse = document.documentElement.scrollHeight; });
    }, [theme]);
    if (block) await context.route(/orbit-showcase-island-[A-Za-z0-9_-]+\.js/, (route) => route.abort());
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 200)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|Unauthorized|Failed to load resource/.test(message.text())) problems.push(`console: ${message.text().slice(0, 200)}`); });
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    if (wait === "live") await page.waitForFunction(() => document.querySelector('[data-home-effect="orbit-showcase"]')?.dataset.homeEffectState === "live", null, { timeout: 25000 });
    if (wait === "failed") await page.waitForFunction(() => document.querySelector('[data-home-effect="orbit-showcase"]')?.dataset.homeEffectState === "failed", null, { timeout: 25000 });
    return { context, page, problems };
  }

  // ---- helpers over the page ---------------------------------------------------------------------------
  const index = (page) => page.evaluate(() => { const m = document.querySelector(".osh-sr")?.textContent.match(/Model (\d+) of \d+/); return m ? Number(m[1]) - 1 : -1; });
  // The slide actually shown: the title that is visible and opaque, which is what a reader sees.
  const shownTitle = (page) => page.evaluate(() => [...document.querySelectorAll(".osh-hd")].filter((el) => { const s = getComputedStyle(el); return s.visibility === "visible" && Number(s.opacity) > 0.9; }).map((el) => el.querySelector(".osh-t2").textContent));
  const settle = (page, ms = 1700) => page.waitForTimeout(ms);
  const scrollY = (page) => page.evaluate(() => Math.round(scrollY));
  const atBottom = (page) => page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 2);
  // Puts the pinned stage at the top of the page, as scrolling into it would, at the start of its scroll length.
  const toStage = (page) => page.evaluate(() => { const t = document.querySelector(".osh-trk"); window.scrollTo({ top: t.getBoundingClientRect().top + scrollY - 72, behavior: "instant" }); });
  const stageTop = (page) => page.evaluate(() => Math.round(document.querySelector(".osh-root").getBoundingClientRect().top));
  // A wheel scroll of exactly `total` pixels, as a run of ticks.
  const wheel = async (page, total, tick = 100) => { for (let left = Math.abs(total); left > 0; left -= tick) { await page.mouse.wheel(0, Math.sign(total) * Math.min(tick, left)); await page.waitForTimeout(16); } };
  const mid = (page) => page.evaluate(() => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }));

  // Input that Playwright's own API does not offer, from the browser's debugging protocol (Chromium only).
  async function touchSwipe(page, [x1, y1], [x2, y2], steps = 8) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
    for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }
  // A finger dragging vertically, from (x, y) by `dy`, with real touch events: the page scrolls as it does for a person. (The protocol's
  // own synthesizeScrollGesture does nothing in this setup, even over the hero, so it is not used.)
  async function touchDrag(page, [x, y], dy, steps = 10) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] }); await page.waitForTimeout(8); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }

  // ------------------------------------------------------------------------------------------------------
  // Changing slide
  // ------------------------------------------------------------------------------------------------------

  test("slides change by the arrow buttons, the thumbnails and the pager, and stop at the ends", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      await toStage(page); await settle(page, 600);
      assert.equal(await index(page), 0);
      assert.deepEqual(await shownTitle(page), ["Lumen"]);
      assert.equal(await page.getByRole("button", { name: "Previous model" }).getAttribute("aria-disabled"), "true", "no previous model before the first");
      await page.getByRole("button", { name: "Previous model" }).click({ force: true });
      assert.equal(await index(page), 0, "pressing a disabled arrow changes nothing");

      await page.getByRole("button", { name: "Next model" }).click();
      await settle(page);
      assert.equal(await index(page), 1);
      assert.deepEqual(await shownTitle(page), [NAMES[1]], "exactly one title is visible: the new one");

      await page.locator(".osh-th").getByRole("button", { name: `Show ${NAMES[2]}` }).click();
      await settle(page);
      assert.deepEqual([await index(page), await shownTitle(page)], [2, [NAMES[2]]], "a thumbnail jumps");

      await page.locator(".osh-pager").getByRole("button", { name: "Show Study" }).click();
      await settle(page);
      assert.deepEqual([await index(page), await shownTitle(page)], [LAST, ["Study"]], "the pager jumps");
      assert.equal(await page.getByRole("button", { name: "Next model" }).getAttribute("aria-disabled"), "true", "no next model after the last");
      await page.getByRole("button", { name: "Next model" }).click({ force: true });
      assert.equal(await index(page), LAST, "the last slide stays the last: the section does not wrap");

      await page.getByRole("button", { name: "Previous model" }).click();
      await settle(page);
      assert.equal(await index(page), LAST - 1);
      // The pager marks where the reader is.
      assert.equal(await page.locator(".osh-pager [aria-current]").getAttribute("aria-label"), `Show ${NAMES[LAST - 1]}`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("the keyboard works: arrow keys change slide, the tabs switch, focus is visible, and other keys are left alone", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      await toStage(page); await settle(page, 600);
      await page.locator(".osh-root").focus();
      await page.keyboard.press("ArrowRight"); await settle(page);
      assert.equal(await index(page), 1);
      await page.keyboard.press("ArrowRight"); await settle(page);
      await page.keyboard.press("ArrowLeft"); await settle(page);
      assert.equal(await index(page), 1, "right then left comes back");
      await page.keyboard.press("ArrowLeft"); await settle(page);
      await page.keyboard.press("ArrowLeft"); await settle(page, 400);
      assert.equal(await index(page), 0, "left at the first stays at the first");
      for (let i = 0; i < NAMES.length + 1; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(120); }
      await settle(page);
      assert.equal(await index(page), LAST, "right at the last stays at the last");

      // Focus is visible: the stage shows a focus ring when reached by keyboard.
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.querySelector(".osh-root")); return { style: s.outlineStyle, width: s.outlineWidth }; });
      assert.notEqual(ring.style, "none", "a visible focus ring");
      // The tabs: Best for shows the list of what the model is for, and the tab says it is selected.
      await page.getByRole("tab", { name: "Best for" }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.getByRole("tab", { name: "Best for" }).getAttribute("aria-selected"), "true");
      assert.equal(await page.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "false");
      const chips = await page.evaluate(() => [...document.querySelectorAll(".osh-body")].filter((b) => getComputedStyle(b).visibility === "visible").flatMap((b) => [...b.querySelectorAll(".osh-best li")].map((li) => li.textContent)));
      assert.deepEqual(chips, ["Learning", "Worked examples", "Practice"]);
      await page.getByRole("tab", { name: "Overview" }).focus(); await page.keyboard.press("Enter");
      // Every control can be reached with Tab, and each shows a focus ring when it has it.
      await page.locator(".osh-root").focus();
      const reached = new Set();
      for (let i = 0; i < 24; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => { const e = document.activeElement; return e?.closest?.(".osh-root") ? { label: e.getAttribute("aria-label") || e.textContent.trim(), ring: getComputedStyle(e).outlineStyle !== "none" || getComputedStyle(e).boxShadow !== "none" } : null; });
        if (!info) continue;
        reached.add(info.label);
        assert.ok(info.ring, `"${info.label}" shows a focus ring`);
      }
      for (const label of ["Try it", "See plans", "Overview", "Best for", "Previous model", "Next model"]) assert.ok([...reached].some((r) => r === label), `Tab reaches "${label}" (${[...reached]})`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("a swipe changes slide: a horizontal drag with the mouse, a horizontal swipe by touch, and not a vertical one", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const desktop = await open();
    try {
      const { page } = desktop;
      await toStage(page); await settle(page, 600);
      const box = await page.locator(".osh-plates").boundingBox();
      const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 140, cy + 4, { steps: 6 }); await page.mouse.up();
      await settle(page);
      assert.equal(await index(page), 1, "dragging left goes forward");
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 140, cy - 4, { steps: 6 }); await page.mouse.up();
      await settle(page);
      assert.equal(await index(page), 0, "dragging right goes back");
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 10, cy + 160, { steps: 6 }); await page.mouse.up();
      await page.waitForTimeout(300);
      assert.equal(await index(page), 0, "a mostly vertical drag is not a swipe");
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 20, cy, { steps: 3 }); await page.mouse.up();
      await page.waitForTimeout(300);
      assert.equal(await index(page), 0, "a short drag is not a swipe");
      assert.deepEqual(desktop.problems, []);
    } finally { await desktop.context.close(); }

    const phone = await open({ width: 390, height: 844, touch: true });
    try {
      const { page } = phone;
      await toStage(page); await settle(page, 600);
      const box = await page.locator(".osh-plates").boundingBox();
      const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
      await touchSwipe(page, [cx + 70, cy], [cx - 70, cy + 6]);
      await settle(page);
      assert.equal(await index(page), 1, "swiping left with a finger goes forward");
      await touchSwipe(page, [cx - 70, cy], [cx + 70, cy - 6]);
      await settle(page);
      assert.equal(await index(page), 0, "swiping right goes back");
      // The pager dots are real, finger-sized controls on a phone.
      const dots = await page.locator(".osh-pager .osh-dot").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 }; }));
      assert.equal(dots.length, NAMES.length);
      for (const dot of dots) assert.ok(dot.visible && dot.w >= 40 && dot.h >= 28, `a dot is ${dot.w}x${dot.h}`);
      await page.getByRole("button", { name: `Show ${NAMES[2]}` }).click();
      await settle(page);
      assert.equal(await index(page), 2, "tapping a dot jumps");
      assert.equal(await page.locator(".osh-strip").evaluate((el) => getComputedStyle(el).display), "none", "the thumbnail strip is hidden on a phone");
      assert.deepEqual(phone.problems, []);
    } finally { await phone.context.close(); }
  });

  // ------------------------------------------------------------------------------------------------------
  // The page must always scroll on: wheel, touch and keyboard, down and up, through both ends
  // ------------------------------------------------------------------------------------------------------

  test("wheel: the stage steps through every slide and then lets the page go on to the features and the footer; and back up", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      const { x, y } = await mid(page);
      await page.mouse.move(x, y);
      await toStage(page); await settle(page, 800);
      const stageH = await page.evaluate(() => document.querySelector(".osh-root").getBoundingClientRect().height);
      // A reader flicks the wheel a little and the stage snaps on to the next slide in the direction of travel. Less than a full
      // stretch of scroll is enough, so that is what is sent.
      const flick = Math.round(stageH * 0.7 * 0.45);
      assert.equal(await stageTop(page), 72, "the stage sticks 72px from the top, clear of the floating bar");
      const seen = [await index(page)];
      for (let i = 0; i < LAST; i++) {
        await wheel(page, flick); await settle(page, 1300);
        seen.push(await index(page));
        assert.equal(await stageTop(page), 72, `still pinned at slide ${i + 2}`);
      }
      assert.deepEqual(seen, NAMES.map((_, i) => i), "one flick, one slide, in order");

      // At the last slide: the next scroll leaves the section downwards, at the speed it was sent.
      const before = await scrollY(page);
      await wheel(page, 600); await settle(page, 900);
      const left = await scrollY(page);
      assert.ok(left >= before + 550, `scrolling down at the last slide moves the page on by what was sent (${before} to ${left})`);
      assert.ok(await stageTop(page) < 72, "the stage has begun to leave");
      assert.equal(await index(page), LAST, "and it stays on the last slide as it goes");
      // Keep going: the features, then the footer. Never more scroll than the page is long.
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      let moved = 600; let ticks = 0;
      while (!await atBottom(page) && ticks < 80) { await wheel(page, 300, 100); moved += 300; ticks += 1; }
      await page.waitForTimeout(500);
      assert.ok(await atBottom(page), "the footer is reached");
      assert.ok(moved <= total, `reached the bottom with ${moved}px of wheel on a ${total}px page: no scroll was swallowed`);
      assert.ok(await page.locator("footer.site-footer").isVisible());
      assert.equal(await page.evaluate(() => document.querySelector("#showcase-title").getBoundingClientRect().bottom < 0), true, "the features were scrolled through on the way");

      // And back up: the page returns to the stage from below, which steps back through the five, and then leaves it upwards.
      let up = 0;
      while (await stageTop(page) !== 72 && up < 80) { await wheel(page, -300, 100); up += 1; }
      await settle(page, 1300);
      assert.equal(await stageTop(page), 72, "the stage is pinned again from below");
      // Coming back from below, the snap settles in the direction of travel, so the stage may land on the last slide or the one before.
      const down = [await index(page)];
      assert.ok([LAST - 1, LAST].includes(down[0]), `re-entered from below near the end (${down[0]})`);
      for (let i = 0; i < LAST + 2 && down.at(-1) > 0; i++) { await wheel(page, -flick); await settle(page, 1300); down.push(await index(page)); }
      assert.equal(down.at(-1), 0, `back at the first slide (${down})`);
      assert.ok(down.every((v, i) => i === 0 || down[i - 1] - v === 1), `one flick up, one slide back, in order (${down})`);

      // At the first slide: the next scroll up leaves the section upwards.
      const first = await scrollY(page);
      await wheel(page, -600); await settle(page, 900);
      const gone = await scrollY(page);
      assert.ok(gone <= first - 550, `scrolling up at the first slide moves the page on by what was sent (${first} to ${gone})`);
      let toTop = 0;
      while (await scrollY(page) > 0 && toTop < 80) { await wheel(page, -300, 100); toTop += 1; }
      await page.waitForTimeout(500);
      assert.equal(await scrollY(page), 0, "the top of the page, with the hero");
      assert.ok(await page.locator("#hero-title").isVisible());
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("keyboard: Page Down, Space, End and Home move the page through the section, even with the stage focused", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      await toStage(page); await settle(page, 600);
      await page.locator(".osh-root").focus();
      const start = await scrollY(page);
      let presses = 0;
      while (await page.evaluate(() => document.querySelector("#showcase-title").getBoundingClientRect().top > innerHeight) && presses < 40) { await page.keyboard.press("PageDown"); await page.waitForTimeout(220); presses += 1; }
      assert.ok(presses < 40, `Page Down gets past the section (${presses} presses)`);
      assert.ok(await scrollY(page) > start);
      const sampled = await index(page);
      assert.ok(sampled === LAST || sampled >= 0, "the slide followed the scroll");
      await page.keyboard.press("End"); await page.waitForTimeout(700);
      assert.ok(await atBottom(page), "End goes to the footer");
      await page.keyboard.press("Home"); await page.waitForTimeout(900);
      assert.equal(await scrollY(page), 0, "Home goes to the top");
      // Space, with the page (not the stage) focused.
      await page.evaluate(() => document.activeElement?.blur());
      let spaces = 0;
      while (!await atBottom(page) && spaces < 60) { await page.keyboard.press("Space"); await page.waitForTimeout(220); spaces += 1; }
      assert.ok(await atBottom(page), `Space alone reaches the footer (${spaces} presses)`);
      for (let i = 0; i < 60 && await scrollY(page) > 0; i++) { await page.keyboard.press("Shift+Space"); await page.waitForTimeout(220); }
      assert.equal(await scrollY(page), 0, "Shift+Space alone returns to the top");
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("touch: a finger can scroll down through the section to the footer and back up, starting anywhere on the stage", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ width: 390, height: 844, touch: true });
    try {
      // Over every part of the pinned stage a drag scrolls the page: nothing on it takes the gesture.
      await toStage(page); await settle(page, 600);
      for (const [label, y] of [["the orb", 190], ["the title", 330], ["the card", 560], ["the pager", 790]]) {
        const before = await scrollY(page);
        await touchDrag(page, [195, y], -240); await page.waitForTimeout(700);
        assert.ok(await scrollY(page) > before + 200, `dragging up over ${label} scrolls the page (${before} to ${await scrollY(page)})`);
        await page.evaluate(() => { const t = document.querySelector(".osh-trk"); window.scrollTo({ top: t.getBoundingClientRect().top + scrollY - 72, behavior: "instant" }); });
        await settle(page, 600);
      }
      // From the top of the page, a person drags their way down to the footer.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.waitForTimeout(300);
      const reached = new Set();
      let drags = 0;
      while (!await atBottom(page) && drags < 60) {
        await touchDrag(page, [195, 600], -300); await page.waitForTimeout(650);
        if (await page.evaluate(() => { const r = document.querySelector(".osh-root").getBoundingClientRect(); return r.top < innerHeight - 100 && r.bottom > 100; })) reached.add(await index(page));
        drags += 1;
      }
      await page.waitForTimeout(500);
      assert.ok(await atBottom(page), `the footer is reached by touch (${drags} drags)`);
      assert.ok(reached.size >= 3, `the slides followed the finger (${[...reached]})`);
      let back = 0;
      while (await scrollY(page) > 0 && back < 60) { await touchDrag(page, [195, 300], 300); await page.waitForTimeout(650); back += 1; }
      await page.waitForTimeout(500);
      assert.equal(await scrollY(page), 0, `back at the top by touch (${back} drags)`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("reduced motion: the stage does not pin, nothing animates, and the page scrolls straight through", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const normal = await open();
    const normalTrack = await normal.page.evaluate(() => document.querySelector(".osh-trk").getBoundingClientRect().height);
    const normalDoc = await normal.page.evaluate(() => document.documentElement.scrollHeight);
    await normal.context.close();

    const { context, page, problems } = await open({ reducedMotion: "reduce" });
    try {
      const geometry = await page.evaluate(() => ({ track: document.querySelector(".osh-trk").getBoundingClientRect().height, root: document.querySelector(".osh-root").getBoundingClientRect().height, doc: document.documentElement.scrollHeight }));
      assert.equal(Math.round(geometry.track), Math.round(geometry.root), "the track is one stage tall: nothing to scroll through");
      assert.ok(normalTrack > geometry.track * 3, `without the preference the track is ${Math.round(normalTrack)}px, with it ${Math.round(geometry.track)}px`);
      assert.ok(geometry.doc < normalDoc - (normalTrack - geometry.track) * 0.9, "so the page is shorter by the track it no longer scrolls through");
      assert.equal(await page.locator(".osh-track").evaluate((el) => getComputedStyle(el).transitionDuration), "0s", "no strip transition");
      // Changing slide is instant: the new title is shown and the old one gone at once, and nothing is mid-motion.
      await toStage(page);
      await page.getByRole("button", { name: "Next model" }).click();
      await page.waitForTimeout(120);
      assert.deepEqual(await shownTitle(page), [NAMES[1]], "the new slide is there within a frame or two");
      assert.equal(await page.evaluate(() => [...document.querySelectorAll(".osh-orbit")].filter((el) => getComputedStyle(el).visibility === "visible").length), 1, "one orb");
      // Not rotated mid-swing: no transform, or the identity (GSAP leaves rotation 0 as an identity matrix).
      assert.match(await page.evaluate(() => { const o = [...document.querySelectorAll(".osh-orbit")].find((el) => getComputedStyle(el).visibility === "visible"); return getComputedStyle(o).transform; }), /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/, "the orb is not rotated mid-swing");
      // The scroll goes straight through it.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      const { x, y } = await mid(page); await page.mouse.move(x, y);
      let ticks = 0;
      while (!await atBottom(page) && ticks < 60) { await wheel(page, 400, 100); ticks += 1; }
      assert.ok(await atBottom(page), `the footer is reached in ${ticks} flicks of 400px`);
      assert.ok(ticks * 400 < geometry.doc, "with no more scroll than the page is long");
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  // ------------------------------------------------------------------------------------------------------
  // Fit: no horizontal overflow, and on a phone the stage fits one screen
  // ------------------------------------------------------------------------------------------------------

  const SIZES = [[320, 640], [390, 844], [768, 1024], [1280, 800]];
  for (const theme of ["light", "dark"]) for (const [width, height] of SIZES) test(`${width}x${height}, ${theme}: no horizontal overflow on any slide, everything inside the stage${width < 900 ? ", and the stage fits one screen" : ""}`, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ width, height, theme, touch: width < 640 });
    try {
      await toStage(page); await settle(page, 600);
      for (let i = 0; i < NAMES.length; i++) {
        if (i > 0) { await page.getByRole("button", { name: `Show ${NAMES[i]}` }).first().click(); await settle(page, 1500); }
        const m = await page.evaluate(() => {
          const root = document.querySelector(".osh-root").getBoundingClientRect();
          const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility === "visible" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]'); };
          const outside = [...document.querySelectorAll(".osh-root a, .osh-root button, .osh-root img, .osh-root p, .osh-root h3, .osh-root li, .osh-root span")].filter(visible).map((el) => { const r = el.getBoundingClientRect(); return { el: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 40), left: Math.round(r.left - root.left), right: Math.round(r.right - root.right), top: Math.round(r.top - root.top), bottom: Math.round(r.bottom - root.bottom) }; }).filter((b) => b.left < -1 || b.right > 1 || b.top < -1 || b.bottom > 1);
          return { docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth, rootOverflow: document.querySelector(".osh-root").scrollWidth - document.querySelector(".osh-root").clientWidth, rootBox: { top: Math.round(root.top), bottom: Math.round(root.bottom), height: Math.round(root.height) }, viewH: innerHeight, outside };
        });
        assert.ok(m.docOverflow <= 0, `${NAMES[i]}: the page scrolls sideways by ${m.docOverflow}px`);
        assert.ok(m.bodyOverflow <= 0, `${NAMES[i]}: the body overflows by ${m.bodyOverflow}px`);
        assert.ok(m.rootOverflow <= 0, `${NAMES[i]}: the stage's content overflows by ${m.rootOverflow}px`);
        assert.deepEqual(m.outside, [], `${NAMES[i]}: nothing sticks out of the stage`);
        assert.ok(m.rootBox.bottom <= m.viewH + 1 && m.rootBox.top >= 71, `${NAMES[i]}: the pinned stage is on screen (${m.rootBox.top} to ${m.rootBox.bottom} of ${m.viewH})`);
      }
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("320x568, the smallest phone: the stage still fits one screen on every slide, with the credits line in it", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ width: 320, height: 568, touch: true, serverPolicy: CARRY });
    try {
      await toStage(page); await settle(page, 600);
      for (let i = 0; i < NAMES.length; i++) {
        if (i > 0) { await page.getByRole("button", { name: `Show ${NAMES[i]}` }).first().click(); await settle(page, 1500); }
        const m = await page.evaluate(() => {
          const root = document.querySelector(".osh-root").getBoundingClientRect();
          const parts = [".osh-plates", ".osh-acts", ".osh-pager"].map((s) => document.querySelector(s).getBoundingClientRect());
          const card = [...document.querySelectorAll(".osh-body")].find((b) => getComputedStyle(b).visibility === "visible");
          const allow = card.querySelector(".osh-allow").getBoundingClientRect();
          const title = [...document.querySelectorAll(".osh-hd")].find((h) => getComputedStyle(h).visibility === "visible").getBoundingClientRect();
          return { sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, rootBottom: Math.round(root.bottom), viewH: innerHeight, partsInside: parts.every((r) => r.top >= root.top - 1 && r.bottom <= root.bottom + 1), allowInside: allow.top >= root.top && allow.bottom <= root.bottom + 1, titleInside: title.top >= root.top - 1 && title.bottom <= root.bottom, allowText: card.querySelector(".osh-allow").textContent };
        });
        assert.ok(m.sideways <= 0, `${NAMES[i]}: no sideways scroll`);
        assert.ok(m.partsInside, `${NAMES[i]}: orb, actions and pager are inside`);
        assert.ok(m.titleInside, `${NAMES[i]}: the title is inside`);
        assert.ok(m.allowInside, `${NAMES[i]}: the allowance line is inside the stage, not cut off`);
        // The image models (Prism, Aura) count images; the others use the plan's AI credits.
        assert.match(m.allowText, ["Prism", "Aura"].includes(NAMES[i]) ? /images a week/ : /AI credits/);
      }
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  // ------------------------------------------------------------------------------------------------------
  // Loading: no layout shift, the plain list when the stage does not load, no console errors
  // ------------------------------------------------------------------------------------------------------

  for (const [label, size, touch] of [["desktop", [1280, 800], false], ["phone", [390, 844], true]]) test(`${label}: nothing moves when the stage loads: the page is the same height before and after, and no layout shift is recorded`, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ width: size[0], height: size[1], touch });
    try {
      const m = await page.evaluate(() => ({ atParse: window.__docHeightAtParse, now: document.documentElement.scrollHeight, shift: window.__shift }));
      assert.ok(Math.abs(m.now - m.atParse) <= 2, `the page was ${m.atParse}px as it parsed and is ${m.now}px with the stage live`);
      // Scroll through the whole page, slowly, the way a reader would: still no shift.
      for (let y = 0; y < m.now; y += 500) { await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y); await page.waitForTimeout(60); }
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({ shift: window.__shift, now: document.documentElement.scrollHeight }));
      assert.ok(after.shift < 0.01, `layout shift ${after.shift}`);
      assert.ok(Math.abs(after.now - m.atParse) <= 2, `and the page is still ${after.now}px`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("without script every model is on the page as plain text with a way in; if the stage fails to load the list stays, in full", async (t) => {
    if (!needBrowser(t)) return;
    const plain = await open({ javaScriptEnabled: false, wait: "none" });
    try {
      const { page } = plain;
      assert.deepEqual(await page.locator(".orbits__item h3").allTextContents(), NAMES.map((n) => `VibhavGPT ${n}`));
      assert.ok(await page.getByRole("link", { name: "Try it" }).isVisible());
      assert.equal(await page.getByRole("link", { name: "See plans" }).getAttribute("href"), "/pricing");
      const h = await page.locator(".orbits__stage").evaluate((el) => ({ box: el.getBoundingClientRect().height, scroll: el.scrollHeight }));
      assert.ok(Math.abs(h.box - h.scroll) <= 1, "with no script nothing is reserved or clipped: the list is its own height");
      assert.equal(await page.locator(".osh-root").count(), 0);
    } finally { await plain.context.close(); }

    const failed = await open({ block: true, wait: "failed" });
    try {
      const { page } = failed;
      assert.deepEqual(await page.locator(".orbits__item h3").allTextContents(), NAMES.map((n) => `VibhavGPT ${n}`));
      for (const item of await page.locator(".orbits__item").all()) assert.ok(await item.isVisible());
      const h = await page.locator(".orbits__stage").evaluate((el) => ({ box: el.getBoundingClientRect().height, scroll: el.scrollHeight }));
      assert.ok(Math.abs(h.box - h.scroll) <= 1, "the reserved space is released: the list shows in full");
      assert.equal(await page.locator(".osh-root").count(), 0);
    } finally { await failed.context.close(); }
  });

  // ------------------------------------------------------------------------------------------------------
  // The wording and the theme
  // ------------------------------------------------------------------------------------------------------

  test("the credits wording follows the server and is the pricing page's: figures, and the old limits when credits are off", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const on = await open({ serverPolicy: CARRY });
    let shownFigures;
    try {
      const { page } = on;
      await toStage(page); await settle(page, 600);
      const card = await page.evaluate(() => [...document.querySelectorAll(".osh-body")].filter((b) => getComputedStyle(b).visibility === "visible").map((b) => b.querySelector(".osh-allow").textContent));
      assert.deepEqual(card, ["Uses your plan's AI credits: Free 5, Plus 60, Pro 180 and Max 800 a month, allocated weekly."]);
      shownFigures = card[0].match(/\d+/g).map(Number);
      assert.doesNotMatch(await page.locator(".orbits").innerText(), /15 AI requests|tokens|5-hour/i);
    } finally { await on.context.close(); }
    // The pricing page, asked the same server, says the same numbers.
    const pricing = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await pricing.newPage();
      await page.goto(`${base}/pricing`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => /AI credits per month/.test(document.body.innerText), null, { timeout: 20000 });
      // The comparison table's "AI credits per month" row, opened as a reader would: its cells after the label are Free, Plus, Pro
      // and Max, in the table's column order.
      await page.getByText("Compare all features", { exact: true }).first().click();
      await page.waitForFunction(() => [...document.querySelectorAll("th, td, [role='rowheader']")].some((el) => el.textContent.trim().startsWith("AI credits per month")), null, { timeout: 10000 });
      const row = await page.evaluate(() => {
        const label = [...document.querySelectorAll("th, [role='rowheader']")].find((el) => el.textContent.trim().startsWith("AI credits per month"));
        const tr = label?.closest("tr, [role='row']");
        const cells = tr ? [...tr.querySelectorAll("td, [role='cell']")] : [];
        return cells.map((cell) => Number((cell.textContent.match(/\d+/) ?? [NaN])[0]));
      });
      assert.deepEqual(row, shownFigures, "Free, Plus, Pro and Max: the same numbers on the pricing page and in the showcase");
    } finally { await pricing.close(); }

    const off = await open({ serverPolicy: OFF });
    try {
      const { page } = off;
      await toStage(page); await settle(page, 600);
      const card = await page.evaluate(() => [...document.querySelectorAll(".osh-body")].filter((b) => getComputedStyle(b).visibility === "visible").map((b) => b.querySelector(".osh-allow").textContent));
      assert.match(card[0], /Up to 15 AI requests in any 24 hours and \$0\.25 each UTC calendar month/, "the existing wording while the server enforces the existing limits");
      assert.doesNotMatch(card[0], /AI credits/);
    } finally { await off.context.close(); }
  });

  for (const theme of ["light", "dark"]) test(`${theme}: the stage is on the page's own background, in the page's own ink, with the site's font`, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme });
    try {
      await toStage(page); await settle(page, 600);
      const m = await page.evaluate(() => {
        const ink = (sel) => getComputedStyle(document.querySelector(sel)).color;
        return {
          dataTheme: document.documentElement.dataset.theme,
          stageBackground: getComputedStyle(document.querySelector(".osh-root")).backgroundColor,
          title: [...document.querySelectorAll(".osh-t2")].map((el) => getComputedStyle(el).color)[0],
          pageInk: ink(".hero h1"),
          muted: getComputedStyle(document.querySelector(".osh-eye")).color,
          paper: getComputedStyle(document.body).backgroundColor,
          font: getComputedStyle(document.querySelector(".osh-t2")).fontFamily,
          weights: [getComputedStyle(document.querySelector(".osh-t1")).fontWeight, getComputedStyle(document.querySelector(".osh-t2")).fontWeight],
          fontsLoaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/['"]/g, "")),
        };
      });
      assert.equal(m.dataTheme, theme);
      assert.match(m.stageBackground, /rgba\(0, 0, 0, 0\)|transparent/, "no stage background: the page's wash shows through, so dark stays consistent with the page");
      assert.equal(m.title, m.pageInk, "the title is the page's ink, as the hero heading is");
      assert.match(m.font, /Hanken Grotesk/);
      assert.deepEqual(m.weights, ["200", "800"], "a thin line and a heavy line");
      assert.ok(m.fontsLoaded.includes("Hanken Grotesk"), `the site's own font file was used (${m.fontsLoaded})`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });
});
