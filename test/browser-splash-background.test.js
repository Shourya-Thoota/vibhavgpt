import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";

// The homepage's fluid background in real browsers, served from frontend/dist with production's routes. What the pixels show is
// measured by photographing the page with the layer shown and with it hidden and comparing, so "it paints" and "it darkens on a
// light sky and brightens on a dark one" are facts about the screen, not about the source. The drawing needs WebGL2: where the
// browser has none the effect draws nothing by design, and those tests are reported as skipped, never passed. Chromium runs
// everything; WebKit and Firefox run what does not depend on it. Playwright's WebKit is its Windows build, not Safari.
const dist = path.resolve("frontend/dist");
const built = fs.existsSync(path.join(dist, "home/index.html"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json" };
const ROUTES = { "/": "home/index.html", "/home": "home/index.html" };

function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google/Chrome/Application/chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() }), true],
  ["WebKit", () => webkit.launch({ headless: true }), false],
  ["Firefox", () => firefox.launch({ headless: true }), false],
];

for (const [engine, launch, full] of ENGINES) describe(`The homepage background in ${engine}`, { concurrency: false, timeout: 400000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  const requests = [];
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      requests.push(url.pathname);
      if (url.pathname === "/api/usage/policy") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ active: false })); return; }
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

  async function open({ width = 1280, height = 800, theme = "dark", reducedMotion = "no-preference", saveData = false, javaScriptEnabled = true, wait = "live" } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, javaScriptEnabled });
    await context.addInitScript(([sky, save]) => {
      try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {}
      if (save) Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
      window.__shift = 0;
      try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
      document.addEventListener("DOMContentLoaded", () => { window.__docHeightAtParse = document.documentElement.scrollHeight; });
    }, [theme, saveData]);
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 200)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|Unauthorized|Failed to load resource/.test(message.text())) problems.push(`console: ${message.text().slice(0, 200)}`); });
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    if (wait === "live") await page.waitForFunction(() => document.querySelector('[data-home-effect="splash-cursor"]')?.dataset.homeEffectState === "live", null, { timeout: 25000 });
    return { context, page, problems };
  }

  const webgl2 = (page) => page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  const layer = (page, visible) => page.evaluate((v) => { document.querySelector(".splash-bg").style.visibility = v ? "visible" : "hidden"; }, visible);
  // The region the logo's own animation does not touch and the intro's path crosses: the middle of the page's left two thirds.
  const regionOf = (page) => page.evaluate(() => ({ x: Math.round(innerWidth * 0.2), y: Math.round(innerHeight * 0.35), w: Math.round(innerWidth * 0.42), h: Math.round(innerHeight * 0.3) }));
  // Two photographs of the same page, the layer shown and hidden: how many pixels moved, and by how much the region brightened.
  // `threshold` is how many levels of a colour channel count as "moved": the intro is bright, a pointer's trail on a dark sky is faint.
  async function effect(page, region, threshold = 24) {
    await layer(page, true);
    const shown = await page.screenshot();
    await layer(page, false);
    const hidden = await page.screenshot();
    await layer(page, true);
    return page.evaluate(async ([a, b, r, limit]) => {
      const load = async (data) => { const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0); return g.getImageData(r.x, r.y, r.w, r.h).data; };
      const [A, B] = [await load(a), await load(b)];
      let changed = 0; let lumA = 0; let lumB = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > limit) changed += 1;
        lumA += 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2]; lumB += 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
      }
      const n = A.length / 4;
      return { changed, brighter: (lumA - lumB) / n };
    }, [shown.toString("base64"), hidden.toString("base64"), region, threshold]);
  }

  // ------------------------------------------------------------------------------------------------------
  // Where it is, and that it never gets in the way
  // ------------------------------------------------------------------------------------------------------

  test("it is a layer over the whole screen, behind every piece of content, that holds no space and takes no click", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      const g = await page.evaluate(() => {
        const mount = document.querySelector(".splash-bg"); const el = document.querySelector(".splash-cursor"); const canvas = document.querySelector(".splash-cursor__canvas");
        const r = canvas.getBoundingClientRect();
        return { mount: { position: getComputedStyle(mount).position, z: getComputedStyle(mount).zIndex, pe: getComputedStyle(mount).pointerEvents, aria: mount.getAttribute("aria-hidden") }, el: { position: getComputedStyle(el).position, pe: getComputedStyle(el).pointerEvents, aria: el.getAttribute("aria-hidden") }, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], view: [innerWidth, innerHeight], tabbable: canvas.tabIndex };
      });
      assert.deepEqual(g.mount, { position: "fixed", z: "-1", pe: "none", aria: "true" });
      assert.deepEqual(g.el, { position: "fixed", pe: "none", aria: "true" });
      assert.deepEqual(g.rect, [0, 0, ...g.view], "exactly the screen");
      assert.equal(g.tabbable, -1, "not a stop for the keyboard");

      // Paint order, top to bottom, at a point on the heading: the heading, then the page, then the layer, then the root. With the
      // layer made hittable only for this question, so the browser lists it.
      const order = await page.evaluate(() => {
        document.querySelector(".splash-cursor").style.pointerEvents = "auto";
        const h = document.querySelector("#hero-title").getBoundingClientRect();
        const stack = document.elementsFromPoint(h.left + 12, h.top + h.height / 2);
        document.querySelector(".splash-cursor").style.pointerEvents = "";
        const at = (match) => stack.findIndex(match);
        return { h1: at((e) => e.id === "hero-title"), main: at((e) => e.id === "main"), body: at((e) => e === document.body), canvas: at((e) => e.classList.contains("splash-cursor__canvas")), html: at((e) => e === document.documentElement) };
      });
      assert.ok(order.h1 >= 0 && order.canvas >= 0, `both are at that point (${JSON.stringify(order)})`);
      assert.ok(order.h1 < order.main && order.main < order.body && order.body < order.canvas && order.canvas < order.html, `the heading, the page and the body are above the layer, and the root below it (${JSON.stringify(order)})`);

      // It holds no space: the page is as tall with the effect live as it was as it parsed, and nothing shifted.
      const m = await page.evaluate(() => ({ atParse: window.__docHeightAtParse, now: document.documentElement.scrollHeight, shift: window.__shift }));
      assert.ok(Math.abs(m.now - m.atParse) <= 2, `the page is ${m.now}px, was ${m.atParse}px as it parsed`);
      assert.ok(m.shift < 0.01, `layout shift ${m.shift}`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("links and buttons under it work: a click goes to the button, not the layer", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open();
    try {
      await page.getByRole("link", { name: "Explore features" }).click();
      await page.waitForFunction(() => location.hash === "#showcase", null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => location.hash), "#showcase");
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      const [request] = await Promise.all([page.waitForRequest((r) => new URL(r.url()).pathname === "/signup", { timeout: 8000 }), page.locator("#hero-start").click()]);
      assert.equal(new URL(request.url()).pathname, "/signup", "Get started free goes to sign-up");
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("it is not started for a reader who asked for reduced motion or to save data, and the page is whole without script", async (t) => {
    if (!needBrowser(t)) return;
    const reduced = await open({ reducedMotion: "reduce", wait: "none" });
    try {
      await reduced.page.waitForFunction(() => document.querySelector('[data-home-effect="splash-cursor"]')?.dataset.homeEffectState === "still", null, { timeout: 15000 });
      assert.equal(await reduced.page.locator(".splash-cursor").count(), 0, "no layer: nothing moves");
      assert.equal(await reduced.page.locator("#hero-title").isVisible(), true);
      assert.deepEqual(reduced.problems, []);
    } finally { await reduced.context.close(); }

    const saving = await open({ saveData: true, wait: "none" });
    try {
      await saving.page.waitForTimeout(2500);
      assert.equal(await saving.page.locator(".splash-cursor").count(), 0, "no layer for a reader saving data");
      assert.equal(await saving.page.locator('[data-home-effect="splash-cursor"]').getAttribute("data-home-effect-state"), null, "never even started");
      assert.deepEqual(saving.problems, []);
    } finally { await saving.context.close(); }

    const plain = await open({ javaScriptEnabled: false, wait: "none" });
    try {
      assert.equal(await plain.page.locator("#hero-title").isVisible(), true);
      assert.equal(await plain.page.locator(".splash-bg").evaluate((el) => el.childElementCount), 0, "an empty layer: nothing without script");
    } finally { await plain.context.close(); }
  });

  test("it loads after the page has: the page's first load names no part of it", async (t) => {
    if (!needBrowser(t)) return;
    requests.length = 0;
    const { context, page, problems } = await open();
    try {
      // The page as it was served (the loader adds its own preload link to the live document, which is not the page naming it).
      const served = await (await page.request.get(`${base}/`)).text();
      assert.doesNotMatch(served, /assets\/splash-cursor-island|modulepreload/, "the served page does not name it");
      const chunk = requests.findIndex((p) => /\/assets\/splash-cursor-island-.*\.js$/.test(p));
      const boot = requests.findIndex((p) => /\/assets\/homeEffects-.*\.js$/.test(p));
      assert.ok(boot >= 0 && chunk > boot, `the chunk is requested after the page's one script (${boot} then ${chunk})`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  // ------------------------------------------------------------------------------------------------------
  // What it draws (needs WebGL2)
  // ------------------------------------------------------------------------------------------------------

  for (const theme of ["dark", "light"]) test(`${theme}: it paints on its own at the start, and the ink is ${theme === "dark" ? "light on the dark sky" : "dark on the light sky"}`, { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme });
    try {
      if (!await webgl2(page)) { t.skip(`${engine} has no WebGL2 here: the effect draws nothing by design`); return; }
      await page.waitForTimeout(650); // the intro sweeps across the middle of the screen
      const region = await regionOf(page);
      const m = await effect(page, region);
      assert.ok(m.changed > 1500, `${m.changed} pixels of the region are ink`);
      if (theme === "dark") assert.ok(m.brighter > 0.5, `on a dark sky the ink brightens the region (${m.brighter.toFixed(2)})`);
      else assert.ok(m.brighter < -0.5, `on a light sky the ink darkens the region (${m.brighter.toFixed(2)})`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("it follows the sky when the sky changes, without being reloaded", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme: "dark" });
    try {
      if (!await webgl2(page)) { t.skip("no WebGL2 here"); return; }
      await page.waitForTimeout(4800); // the intro and its fade are over
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForTimeout(300);
      const region = await regionOf(page);
      await page.mouse.move(300, 300);
      for (let i = 0; i < 36; i++) { await page.mouse.move(300 + i * 16, 300 + 110 * Math.sin(i / 3), { steps: 2 }); await page.waitForTimeout(12); }
      const m = await effect(page, region);
      assert.ok(m.changed > 800, `ink was drawn (${m.changed} pixels)`);
      assert.ok(m.brighter < -0.3, `and it is dark ink now the sky is light (${m.brighter.toFixed(2)})`);
      assert.equal(await page.locator(".splash-cursor__canvas").count(), 1, "the same canvas, not a second one");
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  test("it answers the pointer and a click, then goes quiet and clears itself: nothing is left on the screen", { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme: "dark" });
    try {
      if (!await webgl2(page)) { t.skip("no WebGL2 here"); return; }
      await page.waitForTimeout(4800); // the intro and its fade are over
      const region = await regionOf(page);
      const rest = await effect(page, region, 6);
      assert.ok(rest.changed < 60, `at rest nothing is drawn (${rest.changed} pixels)`);

      await page.mouse.move(280, 330);
      for (let i = 0; i < 36; i++) { await page.mouse.move(280 + i * 16, 330 + 90 * Math.sin(i / 3), { steps: 2 }); await page.waitForTimeout(12); }
      const moved = await effect(page, region, 6);
      assert.ok(moved.changed > 800, `a swipe of the pointer leaves ink (${moved.changed} pixels)`);

      // A click on bare page makes a burst.
      await page.waitForTimeout(4800);
      const click = await page.evaluate(() => ({ x: Math.round(innerWidth * 0.7), y: Math.round(innerHeight * 0.9) }));
      const clickRegion = { x: click.x - 160, y: click.y - 100, w: 320, h: 100 };
      await page.mouse.click(click.x, click.y);
      await page.waitForTimeout(250);
      const burst = await effect(page, clickRegion);
      assert.ok(burst.changed > 400, `a click makes a burst where it lands (${burst.changed} pixels)`);
      assert.equal(await page.evaluate(() => location.pathname), "/", "and went nowhere: it was bare page");

      // Quiet: after a few seconds the canvas is cleared and no frame is being drawn.
      await page.waitForTimeout(5200);
      const quiet = await effect(page, region, 6);
      assert.ok(quiet.changed < 60, `it has cleared itself (${quiet.changed} pixels)`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });

  for (const [label, size, touch] of [["a phone", [390, 844], true]]) test(`on ${label} it draws with the lighter simulation and does not stop a swipe from scrolling`, { skip: !full && "Chromium runs this" }, async (t) => {
    if (!needBrowser(t)) return;
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: touch, isMobile: touch });
    await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "dark"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (m) => { if (m.type() === "error" && !/401|Unauthorized|Failed to load resource/.test(m.text())) problems.push(m.text()); });
    try {
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector('[data-home-effect="splash-cursor"]')?.dataset.homeEffectState === "live", null, { timeout: 25000 });
      assert.equal(await page.evaluate(() => { const c = document.querySelector(".splash-cursor__canvas"); return c.width === innerWidth || c.width === Math.floor(innerWidth * devicePixelRatio); }), true, "the canvas matches the screen");
      // A finger dragging up scrolls the page: the layer takes no touch.
      const cdp = await context.newCDPSession(page);
      const before = await page.evaluate(() => scrollY);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 600 }] });
      for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: 600 - 30 * i }] }); await page.waitForTimeout(8); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(600);
      assert.ok(await page.evaluate(() => scrollY) > before + 200, "the page scrolled under the finger");
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  });
});
