import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";

// Interruptibility, in real browsers. Every moving part of the workspace has
// to be catchable mid-motion and continue from where it is on screen, never
// jump to an end state and start over (the Apple Design skill's "spatial
// consistency" and "interruptible" rules). Served from the built site with a
// fixed, fictitious account; nothing here reaches the network.
const dist = path.resolve("frontend/dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
const CHAT_ID = "5b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";
const HISTORY = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", model: "nova", content: `Message ${i + 1} about the moons of Jupiter and their orbits.`, createdAt: `2026-10-30T14:5${i}:00.000Z` }));

function fixture(res, url) {
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const p = url.pathname;
  if (p === "/api/me") return json(200, { user: { id: "usr_test", name: "Avery Sample", email: "avery@example.com", surveyCompleted: true } });
  if (p === "/api/usage") return json(200, { tier: "plus", monthly: {}, rolling: {}, creditBalance: 0, periodEndsAt: "2026-11-15T00:00:00.000Z" });
  if (p.startsWith("/api/profile")) return json(200, { preferredModel: "nova", lastUsedModel: "nova", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "", memoryEnabled: true });
  if (p === "/api/chat/conversations") return json(200, { conversations: [{ id: CHAT_ID, title: "Jupiter's moons", model: "nova", mode: "chat", updatedAt: "2026-10-30T15:00:00.000Z" }] });
  if (p === "/api/chat/groups") return json(200, { groups: [] });
  if (p.startsWith(`/api/chat/conversations/${CHAT_ID}`)) return json(200, { conversation: { id: CHAT_ID, title: "Jupiter's moons", model: "nova", mode: "chat" }, history: HISTORY, hasMore: false, nextCursor: null });
  if (p === "/api/billing/subscription") return json(200, { subscription: { tier: "plus", status: "active", billingSource: "stripe" }, maxAvailable: false });
  if (p.startsWith("/api/memory")) return json(200, { facts: [], memories: [], enabled: true });
  return json(404, {});
}

function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
// As in browser-redesign: an engine that is not installed is reported as
// skipped, never as passed. Playwright's WebKit is its Windows build, not Safari.
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];

// Frames per second this engine actually delivers. Headless Firefox on this
// machine varies from run to run, at times down to a few frames a second,
// which freezes transitions and springs mid-way; a timing test then would
// measure the harness, not the UI.
const fps = (page) => page.evaluate(() => new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < 400) requestAnimationFrame(tick); else resolve(Math.round(n / ((performance.now() - t0) / 1000))); }; requestAnimationFrame(tick); }));
// SPRINGS.standard.response in frontend/src/motion/spring.js.
const SPRING_RESPONSE = 0.35;
// The collapsed rail on a desktop: .workspace[data-collapsed="true"] { --sidebar-w: 62px } in compact.css (74px in styles.css, scaled
// with the rest of the app; a phone keeps its own sizes and has no rail).
const RAIL_WIDTH = 62;

// The sidebar's spring is critically damped (useSidebarWidth). Collapsing
// from rest at `from` toward `rail`, its position fixes how long it has run,
// tau, and so its exact velocity:
//   x(tau) = rail + D (1 + w tau) e^(-w tau),  v(tau) = -D w^2 tau e^(-w tau)
// with D = from - rail and w = 2 pi / response. Reversed at `at` toward
// `from`, the error e = x - from then follows (e0 + (v0 + w e0) t) e^(-w t);
// reversalPath is that path t seconds after the reversal; predictedCoast is
// how far below `at` it goes before it turns.
function reversalPath({ from, rail, at, t, response = SPRING_RESPONSE }) {
  const w = (2 * Math.PI) / response;
  const D = from - rail;
  const x = (tau) => rail + D * (1 + w * tau) * Math.exp(-w * tau);
  let lo = 0; let hi = 3;
  for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (x(mid) > at) lo = mid; else hi = mid; }
  const tau = (lo + hi) / 2;
  const v0 = -D * w * w * tau * Math.exp(-w * tau);
  const e0 = at - from;
  return from + (e0 + (v0 + w * e0) * t) * Math.exp(-w * t);
}
function predictedCoast(options) {
  let lowest = options.at;
  for (let t = 0; t <= 1; t += 0.0005) lowest = Math.min(lowest, reversalPath({ ...options, t }));
  return options.at - lowest;
}
const translateY = (page, selector) => page.evaluate((s) => { const t = getComputedStyle(document.querySelector(s)).transform; return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0; }, selector);

for (const [engine, launch] of ENGINES) describe(`Motion in ${engine}`, { concurrency: false, timeout: 300000 }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return fixture(res, url);
      let file = path.join(dist, url.pathname.slice(1));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return undefined;
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });

  const needBrowser = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return false; } return true; };
  async function open(route, { width = 1440, height = 900, hasTouch = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch, reducedMotion: "no-preference" });
    await context.addInitScript(() => { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); });
    const page = await context.newPage();
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    // Network idle is not "rendered": under load the app can still be
    // mounting. Wait for the workspace itself (attached, since on a phone
    // the sidebar is an off-screen drawer).
    if (route.startsWith("/app")) await page.waitForSelector(".sidebar .account", { state: "attached", timeout: 30000 });
    await page.waitForTimeout(400);
    return { context, page };
  }
  // Skips a mid-motion test, with the measured rate as the reason, when the
  // engine is not producing frames steadily enough to observe one: the
  // bounds below are relative to frames, and assume they keep coming.
  async function needFrames(t, page) {
    const rate = await fps(page);
    if (rate >= 35) return true;
    t.skip(`${engine} headless delivers ${rate} frames/s here, so mid-motion state cannot be observed`);
    return false;
  }

  // Runs a motion, reverses it part-way, and samples the moving value on
  // every frame, all inside the page: a round trip from the test process
  // takes tens of milliseconds, long enough to miss or invent a jump.
  function reverseMidway(page, { kind, first, second, waitMs = 80, settleMs = 650 }) {
    return page.evaluate(async ({ kind, first, second, waitMs, settleMs }) => {
      const measure = {
        scale: () => { const el = document.querySelector(".account-menu"); if (!el) return null; const t = getComputedStyle(el).transform; return t === "none" ? 1 : new DOMMatrixReadOnly(t).a; },
        // While the spring runs, the workspace's inline column is exactly the
        // value it last painted; at rest the stylesheet owns it again.
        width: () => { const column = document.querySelector(".workspace").style.gridTemplateColumns; return column ? parseFloat(column) : document.querySelector(".sidebar").getBoundingClientRect().width; },
        indicator: () => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".ui-segmented[data-indicator] .ui-segmented__indicator")).transform).m41,
      }[kind];
      const run = (action) => (action === "escape" ? document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) : document.querySelector(action).click());
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const menu = () => document.querySelector(".account-menu");
      if (menu()) menu().dataset.probe = "same";
      const samples = []; let sampling = true;
      const tick = () => { samples.push({ t: performance.now(), v: measure() }); if (sampling) requestAnimationFrame(tick); };
      tick();
      const initial = measure();
      const firstAt = performance.now();
      run(first);
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      // The leaving state is written when React commits, not when a frame
      // paints: wait for the commit on zero-delay tasks. Waiting a frame
      // instead let a slow frame outlast the 160 ms exit itself.
      for (let i = 0; i < 50 && menu() && menu().dataset.state !== "closed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      const leaving = menu() ? { state: menu().dataset.state, inert: menu().hasAttribute("inert") } : null;
      // Reverse a set time after the motion has visibly begun, not after
      // the action: a stalled frame must not let the motion finish (or not
      // start) before the reversal.
      let frameAt = performance.now(); let frameGap = 0;
      // Stops when motion shows, or when the element is gone (its exit ended).
      for (let i = 0; i < 30 && measure() !== null && Math.abs(measure() - initial) < 1e-4; i += 1) { await nextFrame(); frameGap = performance.now() - frameAt; frameAt = performance.now(); }
      const seenAfter = performance.now() - firstAt;
      if (waitMs > 0) await wait(waitMs);
      const mid = measure();
      const reversedAt = samples.length;
      run(second);
      // Settled: unchanged for 200ms (at least settleMs, at most 3s, so a
      // loaded machine waits longer rather than reading mid-motion).
      const began = performance.now();
      let lastValue = measure(); let still = performance.now();
      while (performance.now() - began < 3000) {
        await nextFrame();
        const value = measure();
        if (value !== lastValue) { lastValue = value; still = performance.now(); }
        if (performance.now() - began >= settleMs && performance.now() - still >= 200) break;
      }
      sampling = false;
      // frameGap: how long the frame that first showed the motion took.
      // seenAfter: ms from the first action until motion showed (or the
      // element was gone).
      return { samples, mid, reversedAt, final: measure(), leaving, probe: menu()?.dataset.probe ?? null, frameGap, seenAfter };
    }, { kind, first, second, waitMs, settleMs });
  }
  // After the reversal the value turns toward its new target exactly once.
  // It may coast on in the old direction while it slows (a CSS transition
  // for the frame already in flight, a spring for as long as its velocity
  // carries it), but once it heads for the target it never moves back, and
  // it never loses its element (a remount) or restarts from the far end.
  // Returns how far it coasted, or the problem. `direction` is +1 or -1.
  const reversal = (samples, reversedAt, direction) => {
    const start = samples[reversedAt - 1]?.v;
    let turned = false; let extreme = start;
    for (let i = reversedAt; i < samples.length; i += 1) {
      const a = samples[i - 1]; const b = samples[i];
      if (a.v === null || b.v === null) return { problem: `frame ${i} has no element` };
      const step = (b.v - a.v) * direction;
      const tolerance = 0.5e-3 * Math.max(1, Math.abs(a.v));
      if (step > tolerance) turned = true;
      else if (step < -tolerance) {
        if (turned) return { problem: `frame ${i} moved back after turning (${a.v.toFixed(4)} -> ${b.v.toFixed(4)})` };
        extreme = b.v;
      }
    }
    // How far the motion already in flight can carry it before the reversal
    // shows: its speed going in times the longest frame around the reversal,
    // which on a stalled frame is much longer than 16ms. The speed is over
    // single frames: a quick reversal leaves only a frame or two of motion
    // to measure, and aliasing can only overstate it here, never understate.
    const speed = fastest(samples.slice(0, reversedAt), 1, 1, 64);
    let gap = 16.7;
    for (let i = Math.max(1, reversedAt - 2); i < Math.min(samples.length, reversedAt + 5); i += 1) gap = Math.max(gap, samples[i].t - samples[i - 1].t);
    return { problem: turned ? null : "never turned toward the new target", coast: Math.abs(extreme - start), inFlight: speed * gap * 2, speed };
  };
  // The fastest the value moved, per ms, over three-frame windows. One frame
  // is too short: the sampler and the spring are separate frame callbacks
  // whose order within a frame is not fixed (WebKit's headless frames are
  // irregular), so a single sample can see two spring steps and the next
  // none, and a stalled frame can sit between them. Three frames cancel that;
  // a real snap (the old grid transition jumped 67px at once) still shows.
  // `maxFrame` caps each frame's duration, to measure on the spring's own
  // clock: it advances at most 64ms per frame, so a slower frame moves it
  // less than the wall clock says and would understate its speed.
  const fastest = (samples, from = 3, window = 3, maxFrame = Infinity) => {
    let rate = 0;
    for (let i = Math.max(window, from); i < samples.length; i += 1) {
      const a = samples[i - window]; const b = samples[i];
      if (a.v === null || b.v === null) return Infinity;
      rate = Math.max(rate, Math.abs(b.v - a.v) / Math.max(1, Math.min(b.t - a.t, maxFrame * window)));
    }
    return rate;
  };

  test("menu: closing mid-way and reopening mid-exit reverses the same panel from where it is", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`);
    if (!await needFrames(t, page)) { await context.close(); return; }
    await page.evaluate(() => document.querySelector(".sidebar .account").click());
    await page.waitForSelector(".account-menu[data-state=open]");
    await page.waitForTimeout(300);
    // Scale carries the motion back into the trigger (0.96 closed, 1 open);
    // opacity is nearly gone within a frame or two by design.
    // Reversed on the very first frame that shows the exit.
    const run = await reverseMidway(page, { kind: "scale", first: "escape", second: ".sidebar .account", waitMs: 0 });
    assert.deepEqual(run.leaving, { state: "closed", inert: true }, "closing starts at once, and a leaving menu cannot be focused or clicked");
    const over = run.mid === null || run.mid <= 0.9601;
    if (over && (run.frameGap > 70 || run.seenAfter >= 140)) {
      // The exit (140ms, then unmounted at 160ms) was over before any frame
      // showed it: there was no mid-exit state on screen to catch.
      t.skip(`${engine}: the exit was over before a frame showed it (first frame ${Math.round(run.frameGap)}ms; ${Math.round(run.seenAfter)}ms after Escape)`);
      await context.close();
      return;
    }
    assert.ok(!over && run.mid < 0.9999, `caught mid-exit (scale ${run.mid?.toFixed(4) ?? "gone"}; first frame ${Math.round(run.frameGap)}ms, ${Math.round(run.seenAfter)}ms after Escape)`);
    assert.equal(run.probe, "same", "the reopened menu is the same element, not a remount");
    const back = reversal(run.samples, run.reversedAt, +1);
    assert.equal(back.problem, null, "it grows back from where it was, without restarting");
    assert.ok(back.coast <= back.inFlight + 1e-3, `coasts no further than the frames in flight carry it (${back.coast.toFixed(4)} of ${back.inFlight.toFixed(4)})`);
    assert.equal(run.final, 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".account-menu").count(), 0, "a closed menu leaves nothing focusable behind");
    await context.close();
  });

  test("menu: a reopen during the exit reaches the DOM before the next frame, even on a busy machine", async (t) => {
    if (!needBrowser(t)) return;
    if (engine !== "Chromium") { t.skip("CPU throttling is driven through the Chrome DevTools Protocol"); return; }
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await page.evaluate(() => document.querySelector(".sidebar .account").click());
    await page.waitForSelector(".account-menu[data-state=open]");
    await page.waitForTimeout(1500);
    // Close, then reopen while it is still leaving, ten times. Each time,
    // `data-state` must be back to "open" by the first frame after the click
    // (a passive effect landed it up to ~100ms late, nearly the whole exit).
    const result = await page.evaluate(async () => {
      const menu = () => document.querySelector(".account-menu");
      let reopens = 0; const late = [];
      for (let i = 0; i < 10; i += 1) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!menu()) { await new Promise((resolve) => setTimeout(resolve, 300)); document.querySelector(".sidebar .account").click(); await new Promise((resolve) => setTimeout(resolve, 900)); continue; }
        let openedAt = null; let frameAt = null;
        const observer = new MutationObserver(() => { if (menu()?.dataset.state === "open" && openedAt === null) openedAt = performance.now(); });
        observer.observe(menu(), { attributes: true, attributeFilter: ["data-state"] });
        const clickedAt = performance.now();
        requestAnimationFrame(() => { frameAt = performance.now(); });
        document.querySelector(".sidebar .account").click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        observer.disconnect();
        reopens += 1;
        if (openedAt === null || openedAt > frameAt) late.push(openedAt === null ? "never" : `${Math.round(openedAt - clickedAt)}ms after the click, ${Math.round(openedAt - frameAt)}ms after the frame`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      return { reopens, late };
    });
    assert.ok(result.reopens >= 4, `enough reopens landed mid-exit to measure (${result.reopens} of 10)`);
    assert.deepEqual(result.late, [], `every reopen reached the DOM before the next frame (${result.reopens} measured)`);
    await context.close();
  });

  test("sidebar: reversing collapse mid-motion continues from the current width", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`);
    if (!await needFrames(t, page)) { await context.close(); return; }
    const expanded = await page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().width);
    const run = await reverseMidway(page, { kind: "width", first: ".sidebar__toggle", second: ".sidebar__toggle", waitMs: 70 });
    assert.ok(run.mid > RAIL_WIDTH + 1 && run.mid < expanded - 1, `mid-collapse width ${run.mid.toFixed(1)} is between the rail and ${expanded}`);
    const back = reversal(run.samples, run.reversedAt, +1);
    assert.equal(back.problem, null, "the reversal turns once, from where it was");
    // How far it coasts is predicted by the spring itself, not estimated
    // from frame timing (which a loaded machine distorts). `run.mid` is the
    // spring's exact painted value, read in the same task as the reversal.
    const predicted = predictedCoast({ from: expanded, rail: RAIL_WIDTH, at: run.mid });
    const after = run.samples.slice(run.reversedAt);
    const coast = run.mid - Math.min(run.mid, ...after.map((sample) => sample.v));
    // Never further than the spring goes (the app steps the spring exactly;
    // the margin is subpixel layout): extra travel would be a jump or a
    // restart.
    assert.ok(coast <= predicted + 1, `it coasts no further than the spring carries it (${coast.toFixed(1)}px, predicted ${predicted.toFixed(1)}px)`);
    // The frames show the path only at their own times, and the turn falls
    // between them. The spring is exact (stepSpring), so what they should
    // show is known: the same path evaluated at each frame's time, counted
    // from the spring's last tick before the reversal and capped at 64ms a
    // frame as the spring caps it. Compare that with what they did show.
    const lastTick = run.samples[run.reversedAt - 1].t;
    let springTime = 0; let previous = lastTick; let expectedLowest = run.mid;
    for (const sample of after) {
      springTime += Math.min(64, sample.t - previous) / 1000;
      previous = sample.t;
      expectedLowest = Math.min(expectedLowest, reversalPath({ from: expanded, rail: RAIL_WIDTH, at: run.mid, t: springTime }));
    }
    const shown = run.mid - expectedLowest;
    assert.ok(Math.abs(coast - shown) <= 1.5, `the frames showed the turn the spring makes at their times (${coast.toFixed(1)}px; at these frame times the path dips ${shown.toFixed(1)}px, and ${predicted.toFixed(1)}px between frames)`);
    const rate = fastest(run.samples);
    assert.ok(rate < 2.1, `one continuous motion, no jump (fastest ${(rate * 16.7).toFixed(1)}px per frame)`);
    assert.ok(Math.abs(run.final - expanded) < 1, "it comes back to the expanded width");
    assert.equal(await page.locator(".workspace").getAttribute("data-collapsed"), "false");
    assert.equal(await page.evaluate(() => document.querySelector(".workspace").style.gridTemplateColumns), "", "at rest the stylesheet owns the column again");
    await context.close();
  });

  test("segmented: a new choice while the indicator moves retargets from where it is", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/app/billing");
    if (!await needFrames(t, page)) { await context.close(); return; }
    const group = page.locator(".ui-segmented[data-indicator]").first();
    await group.waitFor();
    const options = await group.evaluate((el) => [...el.querySelectorAll("[role=radio]")].map((o) => ({ value: o.dataset.value, x: o.offsetLeft, checked: o.getAttribute("aria-checked") === "true" })));
    const from = options.find((o) => o.checked); const to = options.find((o) => !o.checked);
    const pick = (o) => `.ui-segmented[data-indicator] [data-value="${o.value}"]`;
    const run = await reverseMidway(page, { kind: "indicator", first: pick(to), second: pick(from), waitMs: 60 });
    const lo = Math.min(from.x, to.x); const hi = Math.max(from.x, to.x);
    assert.ok(run.mid > lo + 1 && run.mid < hi - 1, `indicator is between options when the choice changes (${run.mid.toFixed(1)} in ${lo}-${hi})`);
    const back = reversal(run.samples, run.reversedAt, Math.sign(from.x - to.x));
    assert.equal(back.problem, null, "after the new choice it heads there from where it was");
    assert.ok(back.coast <= back.inFlight + 1, `coasts no further than the frames in flight carry it (${back.coast.toFixed(1)}px of ${back.inFlight.toFixed(1)}px)`);
    const rate = fastest(run.samples);
    assert.ok(rate < (hi - lo) * 0.04, `retargets from where it is, no jump (fastest ${(rate * 16.7).toFixed(1)}px per frame)`);
    assert.ok(Math.abs(run.final - from.x) < 1, "it settles on the final choice");
    await context.close();
  });

  test("press: feedback on pointer-down, the action on release, nothing if released elsewhere", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`);
    if (!await needFrames(t, page)) { await context.close(); return; }
    const button = page.locator(".sidebar__new");
    await page.evaluate(() => { window.__clicks = 0; document.querySelector(".sidebar__new").addEventListener("click", (event) => { window.__clicks += 1; event.preventDefault(); event.stopImmediatePropagation(); }, true); });
    const box = await button.boundingBox();
    const scale = () => button.evaluate((el) => { const t = getComputedStyle(el).transform; return t === "none" ? 1 : new DOMMatrixReadOnly(t).a; });
    // Waits for the button's own transitions to finish (the Web Animations
    // API), not for a fixed time a slow engine can outlast.
    const settled = () => button.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(20);
    await settled();
    assert.ok(await scale() < 0.995, "the button answers the finger on pointer-down");
    assert.equal(await page.evaluate(() => window.__clicks), 0, "nothing is committed on pointer-down");
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__clicks), 1, "the action commits on release");
    await page.waitForTimeout(20);
    await settled();
    assert.ok(Math.abs(await scale() - 1) < 0.001, "and the press is undone");
    // Pressed, dragged off and released elsewhere: a cancelled press.
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 400, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(20);
    await settled();
    assert.equal(await page.evaluate(() => window.__clicks), 1, "released away from the button does nothing");
    assert.ok(Math.abs(await scale() - 1) < 0.001, "and leaves it at rest");
    await context.close();
  });

  // Records, in the page, where the sheet or drawer was at the instant a
  // press arrived (a capture listener on the document runs before the app's
  // own handlers). Reading the position from the test process and then
  // pressing leaves a round trip between the two in which, under load, the
  // motion can move on or even finish.
  const recordPresses = (page) => page.evaluate(() => {
    window.__presses = [];
    const where = () => {
      const panel = document.querySelector(".ui-sheet__panel");
      const t = panel && getComputedStyle(panel).transform;
      return { sheetY: panel ? (t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0) : null, drawerX: document.querySelector(".sidebar")?.getBoundingClientRect().left ?? null };
    };
    for (const type of ["pointerdown", "touchstart"]) document.addEventListener(type, () => window.__presses.push(where()), true);
  });
  const lastPress = (page) => page.evaluate(() => window.__presses.at(-1) ?? null);
  // Waits, in the page, for the sheet or drawer to stop moving, counted in
  // frames rather than wall time: the spring advances at most 64ms per frame,
  // so on a loaded machine that delivers a few frames a second it takes
  // longer in wall time but the same number of frames. Rest is 10 unchanged
  // frames in a row; `moving` says whether the ceiling was reached first.
  const rest = (page, kind) => page.evaluate(async (which) => {
    const read = () => (which === "sheet"
      ? (() => { const panel = document.querySelector(".ui-sheet__panel"); if (!panel) return null; const t = getComputedStyle(panel).transform; return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0; })()
      : document.querySelector(".sidebar").getBoundingClientRect().left);
    let value = read(); let unchanged = 0; let frames = 0;
    while (unchanged < 10 && frames < 1200) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames += 1;
      const next = read();
      unchanged = next === value ? unchanged + 1 : 0;
      value = next;
    }
    return { value, frames, moving: unchanged < 10 };
  }, kind);

  test("sheet: tracks the pointer 1:1, can be caught while settling, and a caught dismissal stays open", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`, { width: 390, height: 844 });
    if (!await needFrames(t, page)) { await context.close(); return; }
    await page.evaluate(() => document.querySelector(".composer__row button").click());
    await page.waitForSelector(".ui-sheet[data-shown]");
    await page.waitForTimeout(500);
    await recordPresses(page);
    const panel = ".ui-sheet__panel";
    const sheetY = () => translateY(page, panel);
    const height = (await page.locator(panel).boundingBox()).height;
    const grab = async () => { const b = await page.locator(".ui-sheet__grab").boundingBox(); return { x: b.x + b.width / 2, y: b.y + 12 }; };
    // Drag the grab strip by `dy`, hold still so the release carries no
    // momentum, and let go.
    async function dragAndRelease(dy) {
      const start = await grab();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y + dy, { steps: 10 });
      await page.waitForTimeout(160);
      await page.mouse.move(start.x, start.y + dy + 1);
      await page.mouse.up();
    }

    // 1:1 tracking: 80px of pointer is 80px of sheet.
    let p = await grab();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x, p.y + 80, { steps: 8 });
    assert.ok(Math.abs(await sheetY() - 80) < 2, "the sheet follows the pointer exactly");
    // Held still before letting go: released straight after a quick drag,
    // the throw would carry it past the dismissal point.
    await page.waitForTimeout(160);
    await page.mouse.move(p.x, p.y + 81);
    await page.mouse.up();
    await rest(page, "sheet");

    // Let go short of the dismissal point: it springs home. Pressed at once
    // (anywhere on the panel; 760px is inside it all the way home), it is
    // caught where it is and held there.
    await dragAndRelease(height * 0.45);
    p = { x: 195, y: 760 };
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const caught = (await lastPress(page)).sheetY;
    assert.ok(caught > 1 && caught < height * 0.45 + 2, `caught on its way home, at ${caught.toFixed(1)}px, not snapped to either end`);
    await page.waitForTimeout(150);
    assert.ok(Math.abs(await sheetY() - caught) < 1.5, `held where it was caught (${(await sheetY()).toFixed(1)} vs ${caught.toFixed(1)})`);
    // Toward home: further down could cross the dismissal line.
    await page.mouse.move(p.x, p.y - 30, { steps: 4 });
    assert.ok(Math.abs(await sheetY() - (caught - 30)) < 2, "and the new drag continues from there");
    await page.waitForTimeout(160);
    await page.mouse.move(p.x, p.y - 31);
    await page.mouse.up();
    const home = await rest(page, "sheet");
    assert.ok(Math.abs(home.value) < 1, `released gently, it comes home (${home.value?.toFixed(1)} after ${home.frames} frames${home.moving ? ", still moving" : ""})`);

    // Past half its height it leaves, at the dismissal's minimum speed (a
    // hard fling is off-screen before anyone could reach it). Caught while
    // still on screen, it must not close under the finger.
    await dragAndRelease(height * 0.55);
    p = { x: 195, y: 836 };
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const leaving = (await lastPress(page)).sheetY;
    assert.ok(leaving !== null && leaving > height * 0.5, `caught on its way out, at ${leaving?.toFixed(1)}px`);
    await page.waitForTimeout(400);
    assert.equal(await page.locator(panel).count(), 1, "a sheet caught on its way out does not close under the finger");
    await page.mouse.move(p.x, p.y - 500, { steps: 12 });
    await page.waitForTimeout(160);
    await page.mouse.move(p.x, p.y - 501);
    await page.mouse.up();
    const back = await rest(page, "sheet");
    assert.ok(back.value !== null && Math.abs(back.value) < 1, `pulled back up, it comes home (${back.value?.toFixed(1)} after ${back.frames} frames${back.moving ? ", still moving" : ""})`);
    assert.equal(await page.locator(".ui-sheet[data-shown]").count(), 1, "and stays open");
    await context.close();
  });

  test("drawer: a touch mid-settle catches the phone drawer where it is", async (t) => {
    if (!needBrowser(t)) return;
    if (engine !== "Chromium") { t.skip("touch input is driven through the Chrome DevTools Protocol"); return; }
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`, { width: 390, height: 844, hasTouch: true });
    await recordPresses(page);
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const left = () => page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().left);
    const closed = await left();
    // A slow, short pull, released with no momentum: the drawer settles on
    // its own, back toward closed or on to open.
    await touch("touchStart", 40, 420);
    for (let x = 60; x <= 160; x += 10) await touch("touchMove", x, 422);
    await page.waitForTimeout(160);
    await touch("touchMove", 161, 422);
    await touch("touchEnd");
    // Touched at once: caught where it is, and held there.
    await touch("touchStart", 60, 420);
    const caught = (await lastPress(page)).drawerX;
    assert.ok(caught > closed + 1 && caught < -1, `caught mid-settle at ${caught.toFixed(1)} (closed is ${closed.toFixed(1)}, open is 0)`);
    await page.waitForTimeout(150);
    assert.ok(Math.abs(await left() - caught) < 1.5, `held where it was caught (${(await left()).toFixed(1)} vs ${caught.toFixed(1)})`);
    await touch("touchEnd");
    // The spring rests within 0.4px and hands back to the stylesheet, whose
    // closed position is the same -100%. If it has not settled, say enough to
    // tell a stall from slowness.
    const end = await rest(page, "drawer");
    const state = await page.evaluate(() => { const s = document.querySelector(".sidebar"); return { inline: s.style.transform || "(stylesheet)", className: s.className }; });
    assert.ok(Math.abs(end.value) < 1 || Math.abs(end.value - closed) < 1, `settles to an end (${end.value.toFixed(1)} after ${end.frames} frames${end.moving ? ", still moving" : ""}; caught at ${caught.toFixed(1)}, closed is ${closed.toFixed(1)}, open is 0; transform ${state.inline}; class "${state.className}")`);
    await context.close();
  });
});
