import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { auditContrast } from "../scripts/contrast-audit.mjs";

// The two supplied animations on the built homepage, in real browsers: the
// glass reveal of the VibhavGPT logo, which leads the hero, and the curved row
// of designed feature artwork near the bottom. Served from frontend/dist with
// production's routes.
const dist = path.resolve("frontend/dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
const ROUTES = { "/": "home/index.html", "/home": "home/index.html" };

function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
// An engine that is not installed is reported as skipped, never as passed.
// Playwright's WebKit is its Windows build, not Safari.
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.join(dist, "home/index.html"));

for (const [engine, launch] of ENGINES) describe(`Homepage animation in ${engine}`, { concurrency: false, timeout: 400000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      // A signed-out visitor: the homepage asks who is signed in and is told no.
      if (url.pathname.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end("{}"); return undefined; }
      let file = path.join(dist, ROUTES[url.pathname] ?? url.pathname.slice(1));
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

  async function open({ width = 1440, height = 900, theme = "light", reducedMotion = "no-preference", javaScriptEnabled = true, init, blockEffects = false, eager = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, javaScriptEnabled });
    await context.addInitScript(([sky]) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, [theme]);
    if (init) await context.addInitScript(init);
    if (blockEffects) await context.route(/home-effects-[A-Za-z0-9_-]+\.js/, (route) => route.abort());
    const page = await context.newPage();
    const problems = []; const requests = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 160)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|Unauthorized|Failed to load resource/.test(message.text())) problems.push(`console: ${message.text().slice(0, 160)}`); });
    page.on("request", (request) => requests.push(request.url().replace(base, "")));
    // eager: return as soon as the document is parsed, so a test can watch the hero's reveal from its first frame.
    await page.goto(`${base}/`, { waitUntil: eager ? "domcontentloaded" : "networkidle" });
    if (!eager) await page.waitForTimeout(400);
    return { context, page, problems, requests };
  }
  // Brings an effect's stage to the middle of the window and waits for it to be live.
  async function show(page, selector, stage) {
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center", behavior: "instant" }), selector);
    await page.waitForFunction((kind) => document.querySelector(`[data-home-effect="${kind}"]`)?.dataset.homeEffectState === "live", stage, { timeout: 20000 });
  }
  // Frames per second this engine delivers, so a motion test is skipped, not guessed, when it cannot be observed.
  const fps = (page) => page.evaluate(() => new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < 400) requestAnimationFrame(tick); else resolve(Math.round(n / ((performance.now() - t0) / 1000))); }; requestAnimationFrame(tick); }));
  // Looks at a screenshot: how much of it differs from a reference colour, how blue it is, and the corner
  // colour itself. The page behind is a gradient, so for the glass stage the reference is the stage colour
  // and only its solid centre (inside the mask's opaque part) is counted: { ref: [r, g, b], inner: true }.
  async function look(page, png, { ref, inner = false } = {}) {
    return page.evaluate(async ([data, ref, inner]) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext("2d"); g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const corner = [px[0], px[1], px[2]];
      const bg = ref ?? corner;
      const reach = 0.2 * Math.min(img.width, img.height);
      let counted = 0, different = 0, blue = 0;
      for (let i = 0; i < px.length; i += 4) {
        const n = i / 4; const dx = (n % img.width) - img.width / 2; const dy = Math.floor(n / img.width) - img.height / 2;
        if (inner && Math.hypot(dx, dy) > reach) continue;
        counted += 1;
        if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 24) different += 1;
        if (px[i + 2] > px[i] + 50 && px[i + 2] > 120) blue += 1;
      }
      return { corner, different: different / counted, blue: blue / counted };
    }, [png.toString("base64"), ref ?? null, inner]);
  }
  // The stage colour the glass is painted with, as [r, g, b], from the theme token (a hex).
  const stageColour = (page) => page.evaluate(() => { const probe = document.createElement("span"); probe.style.cssText = "position:absolute;visibility:hidden;background-color:var(--wash-stage)"; document.body.appendChild(probe); const resolved = getComputedStyle(probe).backgroundColor; probe.remove(); const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); context.canvas.width = 1; context.canvas.height = 1; context.fillStyle = "#010203"; context.fillStyle = resolved; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); });
  // A small clip of the glass stage's solid centre, away from the logo itself, for reading its backdrop colour.
  const backdropClip = (page) => page.evaluate(() => { const r = document.querySelector("[data-home-effect=logo-reveal]").getBoundingClientRect(); const m = Math.min(r.width, r.height); return { x: r.x + r.width / 2 - 0.15 * m - 6, y: r.y + r.height / 2 + 0.12 * m - 6, width: 12, height: 12 }; });
  const logoStage = (page) => page.locator("[data-home-effect=logo-reveal]");
  const hasGlCanvas = (page) => page.evaluate(() => !!document.querySelector("[data-home-effect=logo-reveal] canvas"));



  test("the glass reveal leads the hero: it paints the VibhavGPT logo and settles on it (or falls back to the plain logo without WebGL2)", async (t) => {
    if (!needBrowser(t)) return;
    // Eager: watch from the first frame, because the reveal starts as soon as the hero mounts.
    const { context, page, problems } = await open({ eager: true });
    await page.waitForFunction(() => document.querySelector("[data-home-effect=logo-reveal]")?.dataset.homeEffectState === "live", null, { timeout: 20000 });
    const role = await page.evaluate(() => { const el = document.querySelector("[data-home-effect=logo-reveal]").firstElementChild; return { role: el.getAttribute("role"), label: el.getAttribute("aria-label") }; });
    assert.deepEqual(role, { role: "img", label: "VibhavGPT" }, "one named image for assistive technology");
    if (!(await hasGlCanvas(page))) {
      // No WebGL2 here: the component draws the plain logo from a mask instead.
      const plain = await page.evaluate(() => { const span = document.querySelector("[data-home-effect=logo-reveal] [role=img] > span"); return span ? { w: span.getBoundingClientRect().width, mask: getComputedStyle(span).maskImage || getComputedStyle(span).webkitMaskImage } : null; });
      assert.ok(plain && plain.w > 20 && /vibhavgpt-icon-512/.test(plain.mask), "the fallback is the VibhavGPT logo");
      t.diagnostic(`${engine}: no WebGL2 here, so the fallback was checked instead of the glass`);
      await context.close(); return;
    }
    const clip = await page.evaluate(() => { const r = document.querySelector("[data-home-effect=logo-reveal]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const ref = await stageColour(page);
    if ((await fps(page)) >= 8) {
      // Watch the whole reveal (about 3.5s) and judge its shape, not any one instant: the glass grows to a
      // large extent, then lets go, leaving the logo in its own blues on an unchanged backdrop. It plays once
      // and holds the finished logo, so the last frames are the settled state.
      const frames = [];
      for (let i = 0; i < 18; i += 1) { frames.push(await look(page, await page.screenshot({ clip }), { ref, inner: true })); await page.waitForTimeout(300); }
      const widest = Math.max(...frames.map((f) => f.different));
      const at = frames.findIndex((f) => f.different >= widest * 0.9);
      assert.ok(widest > 0.1, `the glass fills a large part of the stage's centre at its widest (${(widest * 100).toFixed(1)}%)`);
      // The finished logo fills most of the solid centre, so 'lets go' is a clear drop (a tenth) from the widest, not a return to nothing. How
      // many pixels differ depends on how far the logo's blues are from the stage colour, which is soft violet now.
      const settled = frames.slice(at + 1).filter((f) => f.different < widest * 0.9 && f.different > 0.003 && f.blue > 0.003);
      assert.ok(settled.length >= 2, `afterwards the glass lets go and the logo's blues remain (as % of the stage's centre: ${frames.map((f) => `${(f.different * 100).toFixed(1)}/${(f.blue * 100).toFixed(2)}`).join("  ")})`);
      assert.ok(frames.every((f) => f.corner.every((c, i) => Math.abs(c - frames[0].corner[i]) <= 1)), "the page behind the stage never changes");
      // It holds: the last frames are the same still logo, not a loop restarting.
      const [a, b] = frames.slice(-2);
      assert.ok(Math.abs(a.different - b.different) < 0.01 && b.blue > 0.003, "the finished logo holds still");
    } else t.diagnostic(`${engine}: too few frames per second here to wait out the reveal`);
    assert.deepEqual(problems, []);
    await context.close();
  });

  for (const theme of ["light", "dark"]) test(`${theme} theme: the glass takes the ${theme} stage colour`, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme });
    await show(page, "[data-home-effect=logo-reveal]", "logo-reveal");
    if (await hasGlCanvas(page)) {
      // The canvas is painted with the theme's stage colour (a flat colour, faded into the wash by a mask).
      const want = await stageColour(page);
      let seen;
      for (let i = 0; i < 12; i += 1) { await page.waitForTimeout(500); seen = (await look(page, await page.screenshot({ clip: await backdropClip(page) }))).corner; if (seen.every((c, k) => Math.abs(c - want[k]) <= 3)) break; }
      assert.ok(seen.every((c, i) => Math.abs(c - want[i]) <= 3), `the canvas backdrop ${seen} is the theme's stage colour ${want}`);
      assert.ok(theme === "dark" ? Math.max(...want) < 70 : Math.min(...want) > 200, `and it is a ${theme} colour taken from the token: ${want}`);
    }
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("switching theme while the glass is live repaints its backdrop", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ theme: "light" });
    await show(page, "[data-home-effect=logo-reveal]", "logo-reveal");
    await page.waitForTimeout(600);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    if (await hasGlCanvas(page)) {
      const want = await stageColour(page);
      assert.ok(Math.max(...want) < 70, `the token followed the theme: ${want}`);
      let seen;
      for (let i = 0; i < 12; i += 1) { await page.waitForTimeout(500); seen = (await look(page, await page.screenshot({ clip: await backdropClip(page) }))).corner; if (seen.every((c, k) => Math.abs(c - want[k]) <= 3)) break; }
      assert.ok(seen.every((c, i) => Math.abs(c - want[i]) <= 3), `the glass repaints on the dark stage colour (${seen} vs ${want})`);
    }
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("reduced motion: the logo stays a plain image (no glass, no WebGL)", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ reducedMotion: "reduce" });
    // The glass is left unmounted: its one-frame still mode does not present in every engine (WebKit
    // shows a blank band), and a plain image is the same everywhere.
    await page.evaluate(() => document.querySelector("[data-home-effect=logo-reveal]").scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForFunction(() => document.querySelector("[data-home-effect=logo-reveal]")?.dataset.homeEffectState === "still", null, { timeout: 15000 });
    assert.equal(await hasGlCanvas(page), false, "no WebGL canvas");
    assert.equal(await logoStage(page).locator("img").isVisible(), true, "the page's own still logo is on screen");
    assert.equal(await logoStage(page).locator("img").getAttribute("alt"), "VibhavGPT");
    assert.ok((await look(page, await logoStage(page).screenshot())).blue > 0.001, "and it is painted: the logo's blues are there");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("without script: the logo is still an image, the five features are links, the call to action stays", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open({ javaScriptEnabled: false });
    assert.equal(await page.locator(".cta .btn").isVisible(), true, "the call to action stays");
    assert.equal(await page.locator("[data-home-effect=logo-reveal] img").isVisible(), true);
    assert.equal(await page.locator("[data-home-effect=logo-reveal] img").getAttribute("alt"), "VibhavGPT");
    const links = await page.locator(".slide__copy h3 a").evaluateAll((els) => els.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href"), h: Math.round(a.getBoundingClientRect().height) })));
    assert.deepEqual(links.map((l) => l.text), ["Chat", "Image creation", "Study", "Diagrams", "The VibhavGPT Guarantee"]);
    assert.ok(links.every((l) => l.h >= 44), "each is a 44px target");
    for (const selector of ["h1", ".hero__lead", "#hero-start", "#hero-explore"]) assert.equal(await page.locator(selector).isVisible(), true, `${selector} is readable without script`);
    await context.close();
  });

  test("a reader who saves data keeps the text and the still logo, and no animation code is downloaded", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, requests, problems } = await open({ init: () => { Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true }); } });
    assert.equal(await page.locator(".slide__copy h3 a").count(), 5, "the five features are text");
    await page.evaluate(() => document.querySelector("#showcase").scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(1200);
    assert.equal(await page.locator("[data-home-effect=logo-reveal] img").isVisible(), true, "the logo stays a still image");
    assert.deepEqual(requests.filter((r) => /home-effects-|\.webp/.test(r)), [], "no animation code or artwork");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("if the animation's script cannot be loaded, the still logo and the whole page remain", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open({ blockEffects: true });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".slide__copy h3 a").count(), 5, "the five features are still there");
    assert.equal(await page.locator(".cta .btn").isVisible(), true, "and the call to action");
    assert.equal(await page.locator("[data-home-effect=logo-reveal] img").isVisible(), true, "and the still logo");
    await context.close();
  });

  test("the page: one h1, no pinned tour or sample window, nothing overflows, no label wraps", async (t) => {
    if (!needBrowser(t)) return;
    for (const [width, height, zoom] of [[1440, 900, 1], [820, 1180, 1], [390, 844, 1], [1440, 900, 2]]) {
      const { context, page, problems } = await open({ width: Math.round(width / zoom), height: Math.round(height / zoom) });
      const info = await page.evaluate(() => ({
        h1: document.querySelectorAll("h1").length,
        gone: document.querySelectorAll(".win, .tour, .fx__stage, [data-cap]").length,
        overflow: document.documentElement.scrollWidth - innerWidth,
        pinned: [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).position === "sticky").length,
        skipLink: document.querySelector(".skip")?.getAttribute("href") === "#main",
        wrapped: [...document.querySelectorAll(".nav-links a, .nav .btn")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().height > 44).map((el) => el.textContent.trim()),
      }));
      const label = `${width}px${zoom > 1 ? " at 200% zoom" : ""}`;
      assert.equal(info.h1, 1, label); assert.equal(info.gone, 0, `${label}: no tour, window or row`); assert.equal(info.pinned, 0, `${label}: nothing is pinned while scrolling`); assert.equal(info.skipLink, true, label);
      assert.equal(info.overflow, 0, `${label}: no horizontal overflow`);
      assert.deepEqual(info.wrapped, [], `${label}: no navigation label wraps`);
      assert.deepEqual(problems, [], label);
      await context.close();
    }
  });

  test("the hero: what it does, the logo and both actions are readable and reachable in the first screen, before any animation", async (t) => {
    if (!needBrowser(t)) return;
    // With the effects blocked, so this is the page as a visitor sees it before (or without) the animation.
    for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [375, 667]]) {
      const { context, page, problems } = await open({ width, height, blockEffects: true });
      const hero = await page.evaluate(() => {
        const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), opacity: Number(getComputedStyle(document.querySelector(selector)).opacity) }; };
        return { h1: box("h1"), lead: box(".hero__lead"), note: box(".hero__note"), start: box("#hero-start"), explore: box("#hero-explore"), mark: box(".hero__mark"), inner: innerHeight, innerW: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, h1Text: document.querySelector("h1").textContent };
      });
      const label = `${width}x${height}`;
      assert.equal(hero.h1Text, "AI chat, study tools and image creation.", label);
      for (const name of ["h1", "lead", "note", "start", "explore"]) assert.equal(hero[name].opacity, 1, `${label}: ${name} is fully visible straight away`);
      // The name and the message are in the first screen at every size; so are the two actions (the 667px-tall phone is the tightest case).
      assert.ok(hero.h1.top >= 0 && hero.h1.bottom <= hero.inner, `${label}: the headline is in the first screen (${hero.h1.top}-${hero.h1.bottom} of ${hero.inner})`);
      assert.ok(hero.start.bottom <= hero.inner && hero.explore.bottom <= hero.inner, `${label}: both actions are in the first screen (${hero.start.bottom}, ${hero.explore.bottom} of ${hero.inner})`);
      assert.ok(hero.start.h >= 44 && hero.explore.h >= 44, `${label}: both actions are 44px targets`);
      assert.ok(hero.start.right <= hero.innerW && hero.explore.right <= hero.innerW && hero.overflow === 0, `${label}: nothing runs off the side`);
      // The logo stands in its place with a fixed height: it is the identity, beside the copy on a wide screen and above it on a narrow one.
      if (width >= 900) assert.ok(hero.mark.left > hero.h1.left + 200 && hero.mark.h >= 340, `${label}: the logo stage sits beside the copy (${JSON.stringify(hero.mark)})`);
      else {
        // Above the copy, its empty faded edge overlapping the headline's top a little (a deliberate tightening); the copy paints above it.
        assert.ok(hero.mark.top < hero.h1.top && hero.mark.bottom <= hero.h1.top + 40 && hero.mark.h >= 190, `${label}: the logo stage sits above the copy (${JSON.stringify(hero.mark)} against the headline at ${hero.h1.top})`);
        assert.equal(await page.evaluate(() => { const r = document.querySelector("h1").getBoundingClientRect(); return !!document.elementFromPoint(r.left + 8, r.top + 4)?.closest(".hero__copy"); }), true, `${label}: the headline is not under the logo stage`);
      }
      assert.deepEqual(problems.filter((p) => !/Homepage effect failed|home-effects|ERR_FAILED|blocked/i.test(p)), [], label);
      await context.close();
    }
  });

  test("the hero's logo stage does not shift the page when the animation loads", async (t) => {
    if (!needBrowser(t)) return;
    const watch = () => { window.__cls = 0; window.__clsOk = false; try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value; }).observe({ type: "layout-shift", buffered: true }); window.__clsOk = true; } catch {} };
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const { context, page } = await open({ width, height, init: watch, eager: true });
      await page.waitForFunction(() => document.querySelector("[data-home-effect=logo-reveal]")?.dataset.homeEffectState === "live", null, { timeout: 20000 });
      await page.waitForTimeout(1500);
      const { cls, ok } = await page.evaluate(() => ({ cls: window.__cls, ok: window.__clsOk }));
      if (!ok) t.diagnostic(`${engine}: no layout-shift reporting here, so layout shift was not measured`);
      else assert.ok(cls < 0.02, `${width}px: the page shifted ${cls.toFixed(4)} while the glass loaded`);
      await context.close();
    }
  });

  test("the page order is the hero, the features with the call to action, and the footer, with no big gaps", async (t) => {
    if (!needBrowser(t)) return;
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const { context, page, problems } = await open({ width, height });
      const order = await page.evaluate(() => [".hero", ".showcase", ".cta", ".site-footer"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { s, top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY) }; }));
      for (let i = 1; i < order.length; i += 1) assert.ok(order[i].top >= order[i - 1].top, `${width}px: ${order[i].s} follows ${order[i - 1].s}`);
      const hero = order[0]; const features = order[1]; const footer = order[3];
      assert.ok(features.top - hero.bottom <= 24, `${width}px: the features follow the hero (gap ${features.top - hero.bottom}px)`);
      assert.ok(footer.top - order[2].bottom <= 160, `${width}px: the footer follows the call to action (gap ${footer.top - order[2].bottom}px)`);
      assert.ok(footer.bottom - hero.top < height * 3.2, `${width}px: the whole page is short (${footer.bottom - hero.top}px)`);
      assert.deepEqual(problems, [], `${width}px`);
      await context.close();
    }
  });

  for (const theme of ["light", "dark"]) test(`the wash is continuous: no step in the background from the features to the footer (${theme})`, async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open({ theme });
    // The background is a single fixed layer behind the page, so a seam would be a section painting its own
    // flat colour over it. Read a 4px column in the page margin (nothing but background there) at several scroll
    // positions and look for any step between the rows above and below each row. A one-pixel rule is ignored (median of eight rows).
    const range = await page.evaluate(() => ({ from: document.getElementById("showcase").getBoundingClientRect().top + scrollY - 80, to: document.documentElement.scrollHeight - innerHeight, h: innerHeight, w: innerWidth }));
    let worst = 0; let where = "";
    for (let y = Math.max(0, range.from); ; y += range.h - 120) {
      const at = Math.min(y, range.to);
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), at);
      await page.waitForTimeout(250);
      const png = await page.screenshot({ clip: { x: range.w - 6, y: 0, width: 4, height: range.h } });
      const rows = await page.evaluate(async (data) => {
        const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const g = canvas.getContext("2d"); g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, img.width, img.height).data; const out = [];
        for (let y = 0; y < img.height; y += 1) { let r = 0, gr = 0, b = 0; for (let x = 0; x < img.width; x += 1) { const i = (y * img.width + x) * 4; r += px[i]; gr += px[i + 1]; b += px[i + 2]; } out.push([r / img.width, gr / img.width, b / img.width]); }
        return out;
      }, png.toString("base64"));
      const mean = (from, to) => [0, 1, 2].map((c) => { const v = rows.slice(from, to).map((row) => row[c]).sort((a, b) => a - b); return v[v.length >> 1]; }); // the median, so a one-pixel rule is ignored but a step is not
      for (let r = 8; r < rows.length - 8; r += 1) {
        const above = mean(r - 8, r); const below = mean(r, r + 8);
        const step = Math.abs(above[0] - below[0]) + Math.abs(above[1] - below[1]) + Math.abs(above[2] - below[2]);
        if (step > worst) { worst = step; where = `scroll ${Math.round(at)} row ${r}`; }
      }
      if (at >= range.to) break;
    }
    assert.ok(worst < 6, `the largest step in the background is ${worst.toFixed(1)} levels (${where})`);
    await context.close();
  });

  test("the features: five cards or slides, each with its picture, name and one line; nothing overflows, in both themes", async (t) => {
    if (!needBrowser(t)) return;
    for (const theme of ["light", "dark"]) for (const [width, height] of [[1440, 900], [390, 844]]) {
      const { context, page, problems } = await open({ width, height, theme, reducedMotion: "reduce" });
      await page.evaluate(() => document.querySelector("#showcase").scrollIntoView({ block: "start", behavior: "instant" }));
      const info = await page.evaluate(() => ({
        heading: document.querySelector("#showcase-title").textContent,
        items: [...document.querySelectorAll(".slide")].map((slide) => { const r = slide.getBoundingClientRect(); return { name: slide.querySelector("h3").textContent, text: slide.querySelector("p").textContent, left: r.left, right: r.right, image: [...slide.querySelectorAll("img")].find((img) => getComputedStyle(img).display !== "none").getAttribute("src") }; }),
        overflow: document.documentElement.scrollWidth - innerWidth,
        presenting: document.documentElement.classList.contains("presenting"),
      }));
      const label = `${theme} ${width}px`;
      assert.equal(info.heading, "Features", label);
      assert.deepEqual(info.items.map((i) => i.name), ["Chat", "Image creation", "Study", "Diagrams", "The VibhavGPT Guarantee"], label);
      assert.ok(info.items.every((i) => i.left >= 0 && i.right <= width + 1 && i.text.length > 10), `${label}: every feature is whole and on screen`);
      assert.ok(info.items.every((i) => i.image.endsWith(`-${theme}.webp`)), `${label}: the ${theme} artwork is the one shown`);
      assert.equal(info.overflow, 0, `${label}: no horizontal overflow`);
      assert.equal(info.presenting, false, `${label}: with reduced motion the features are a still presentation`);
      assert.deepEqual(problems, [], label);
      await context.close();
    }
  });

  test("accessibility: nothing focusable inside the logo stage, and the links are 44px targets", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page, problems } = await open({ width: 1440, height: 900 });
    await show(page, "[data-home-effect=logo-reveal]", "logo-reveal");
    const inside = await page.evaluate(() => [...document.querySelectorAll("[data-home-effect] a, [data-home-effect] button, [data-home-effect] input, [data-home-effect] [tabindex]")].length);
    assert.equal(inside, 0, "nothing focusable sits in the animation");
    for (const target of await page.locator(".slide__copy h3 a, .cta .btn, .hero .btn").all()) assert.ok((await target.boundingBox()).height >= 44, "a 44px target");
    assert.deepEqual(problems, []);
    await context.close();
  });
});
