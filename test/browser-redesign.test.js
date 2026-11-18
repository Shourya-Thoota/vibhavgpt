import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";

// The redesigned pages in real browsers, served from the built site with
// production's routes (see the Caddyfile). The public pages see a signed-out
// API; the workspace checks use a fixed, fictitious account (no network, no
// real data) the way scripts/design-capture.mjs does.
const dist = path.resolve("frontend/dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
const ROUTES = { "/": "home/index.html", "/home": "home/index.html", "/pricing": "pricing.html" };

const CHAT_ID = "5b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";
const LONG_REPLY = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: the three moons keep their rhythm because each pulls on the next at the same points in every orbit.`).join("\n\n");
const HISTORY = [
  { id: "m1", role: "user", content: "Why do Io, Europa and Ganymede line up 1:2:4?", createdAt: "2026-10-30T14:58:00.000Z" },
  { id: "m2", role: "assistant", model: "nova", content: LONG_REPLY, createdAt: "2026-10-30T14:58:20.000Z" },
  { id: "m3", role: "user", content: "And the last line?", createdAt: "2026-10-30T14:59:00.000Z" },
  { id: "m4", role: "assistant", model: "nova", content: "This is the final sentence of the conversation.", createdAt: "2026-10-30T14:59:20.000Z" },
];
function fixture(req, res, url, account) {
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const p = url.pathname;
  if (!account.signedIn) return json(401, {});
  if (p === "/api/me") return json(200, { user: { id: "usr_test", name: "Avery Sample", email: "avery@example.com", surveyCompleted: true } });
  if (p === "/api/usage") return json(200, { tier: "plus", monthly: {}, rolling: {}, creditBalance: 0, periodEndsAt: "2026-11-15T00:00:00.000Z" });
  if (p.startsWith("/api/profile")) return json(200, { preferredModel: "nova", lastUsedModel: "nova", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "", memoryEnabled: true });
  if (p === "/api/chat/conversations") return json(200, { conversations: account.empty ? [] : [{ id: CHAT_ID, title: "Jupiter's moons", model: "nova", mode: "chat", updatedAt: "2026-10-30T15:00:00.000Z" }] });
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
// Every engine Playwright can launch here: the installed Chrome, and
// Playwright's own WebKit and Firefox builds when they are downloaded
// (npx playwright install webkit firefox). An engine that is not installed is
// reported as skipped, never as passed. Playwright's WebKit is its Windows
// build, not Safari.
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];

for (const [engine, launch] of ENGINES) describe(`Redesign in ${engine}`, { concurrency: false, timeout: 400000 }, () => {
  let server; let base; let browser; let launchError = null;
  const account = { signedIn: false, empty: false };
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return fixture(req, res, url, account);
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
  async function open(route, { width = 1440, height = 900, reducedMotion = "no-preference", theme = "light", storage = {}, signedIn = false, empty = false } = {}) {
    account.signedIn = signedIn; account.empty = empty;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    await context.addInitScript(([sky, extra]) => {
      if (sky) { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); }
      for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value);
    }, [theme, storage]);
    const page = await context.newPage();
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });
    await page.waitForTimeout(300);
    return { context, page };
  }
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  test("1. homepage: real destinations, skip link first, Features goes to the features, Pricing opens the Pricing page", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/");
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.locator("#nav-enroll").getAttribute("href"), "/signup");
    assert.equal(await page.locator(".nav-links a", { hasText: "Pricing" }).getAttribute("href"), "/pricing", "Pricing opens the Pricing page; the homepage has no plans section to scroll to");
    assert.equal(await page.locator("#plans, #features, #tour").count(), 0, "no leftover plans, features or tour anchors");
    assert.equal(await page.locator(".cta .btn-primary").getAttribute("href"), "/signup");
    if (engine === "WebKit") {
      // WebKit, like Safari by default, leaves links out of the Tab order.
      assert.equal(await page.evaluate(() => document.querySelector("a")?.className), "skip");
    } else {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.className), "skip");
    }
    await page.locator('.nav-links a[href="#showcase"]').click();
    await page.waitForFunction(() => { const r = document.getElementById("showcase-title").getBoundingClientRect(); return r.top > 0 && r.top < 220; }, null, { timeout: 15000 }).catch(() => {});
    const features = await page.evaluate(() => { const r = document.getElementById("showcase-title").getBoundingClientRect(); return { top: r.top, h: innerHeight, atEnd: Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2 }; });
    assert.ok(features.top > 0 && (features.top < 220 || features.atEnd) && features.top < features.h / 2, `Features lands on the features (${JSON.stringify(features)})`);
    assert.equal(await overflow(page), 0);
    await context.close();
  });

  test("6. mobile: readable text, no overflow, 44px targets, and a menu that closes on Escape", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/", { width: 390, height: 844 });
    assert.equal(await overflow(page), 0);
    assert.ok(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".slide__copy p")).fontSize)) >= 14, "the feature text is readable");
    const toggle = page.locator(".menu-toggle");
    assert.ok((await toggle.boundingBox()).height >= 44);
    await toggle.click();
    for (const link of await page.locator("#site-sheet a").all()) assert.ok((await link.boundingBox()).height >= 44);
    const label = await page.locator("#site-sheet .btn-primary").evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    assert.notEqual(label[0], label[1], "Get started is readable in the menu");
    await page.keyboard.press("Escape");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("menu-toggle")), true);
    for (const target of await page.locator(".site-footer a, .showcase .btn").all()) assert.ok((await target.boundingBox()).height >= 32);
    await context.close();
  });

  test("7. glass: a translucent material with its backdrop under the labels, and solid when asked or required", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/");
    const material = await page.evaluate(() => { const nav = document.getElementById("top-nav"); const layer = getComputedStyle(nav, "::before"); return { tint: getComputedStyle(nav).backgroundColor, filter: layer.backdropFilter ?? layer.webkitBackdropFilter, z: layer.zIndex }; });
    assert.match(material.tint, /rgba\(255, 255, 255, 0\.52\)/, "the regular-weight light tint (--lg-m), over a blurred backdrop");
    if (engine === "WebKit" && material.filter === "none") t.diagnostic("WebKit for Windows does not render backdrop-filter; blur not verified in this engine");
    else assert.match(material.filter, /blur\(14px\)/);
    assert.equal(material.z, "-1", "the material sits behind the labels");
    await context.close();
    const solid = await open("/", { storage: { "vibhavgpt-effects": "solid" } });
    assert.equal(await solid.page.evaluate(() => document.documentElement.dataset.effects), "solid");
    assert.equal(await solid.page.evaluate(() => getComputedStyle(document.getElementById("top-nav")).backgroundColor), "rgb(255, 255, 255)");
    assert.equal(await solid.page.evaluate(() => { const layer = getComputedStyle(document.getElementById("top-nav"), "::before"); return layer.backdropFilter ?? layer.webkitBackdropFilter; }), "none");
    await solid.context.close();
    if (engine === "Chromium") {
      const reduced = await open("/");
      const cdp = await reduced.context.newCDPSession(reduced.page);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      if (await reduced.page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)) {
        assert.equal(await reduced.page.evaluate(() => getComputedStyle(document.getElementById("top-nav")).backgroundColor), "rgb(255, 255, 255)", "reduced transparency gives a solid bar");
      }
      await reduced.context.close();
    }
  });

  test("8. dark appearance is applied before paint", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/", { theme: "dark" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    // The root holds the flat paper colour (what shows before anything else paints, so nothing flashes
    // light); the body is transparent over the page wash, which is one fixed gradient layer.
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(0, 0, 0)");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgba(0, 0, 0, 0)");
    const wash = await page.evaluate(() => { const s = getComputedStyle(document.body, "::before"); return { position: s.position, image: s.backgroundImage }; });
    assert.equal(wash.position, "fixed");
    assert.match(wash.image, /radial-gradient/, "the wash is there on the first paint");
    await context.close();
  });

  test("9. pricing: readable on a phone, Max purchasable, its comparison column never blank, and prerendered", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open("/pricing", { width: 390, height: 844 });
    assert.equal(await overflow(page), 0);
    assert.match(await page.locator("body").textContent(), /Choose Max/);
    const maxCells = await page.$$eval(".compare__table tbody tr:not(.compare__group)", (rows) => rows.map((row) => row.querySelectorAll("td")[3]?.textContent.trim() || (row.querySelectorAll("td")[3]?.querySelector("svg") ? "check" : "")));
    assert.ok(maxCells.length > 5);
    for (const cell of maxCells) assert.ok(cell && cell !== "–", `Max cell is filled (${cell})`);
    await context.close();
    assert.match(fs.readFileSync(path.join(dist, "pricing.html"), "utf8"), /<div id="root" data-prerendered>/);
  });

  test("10. workspace: the sidebar rows are labelled, with one icon treatment and a clear current page, and its links navigate", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`, { signedIn: true });
    await page.locator(".sidebar").waitFor();
    const links = page.locator(".sidebar__nav .sidebar__link");
    assert.ok(await links.count() >= 3);
    const iconColours = new Set();
    for (const link of await links.all()) {
      assert.ok((await link.innerText()).trim().length > 0, "every row has a visible label");
      const icon = await link.evaluate((el) => { const svg = el.querySelector("svg"); return svg && { display: getComputedStyle(svg).display, colour: getComputedStyle(svg).color, width: svg.getBoundingClientRect().width }; });
      assert.ok(icon && icon.display !== "none", "each row keeps its icon while expanded");
      assert.equal(Math.round(icon.width), 17, "one icon size (the reference's 20px, scaled by 0.84)");
      iconColours.add(icon.colour);
    }
    assert.equal(iconColours.size, 1, "one icon colour across the rows");
    const current = page.locator('.sidebar__link[aria-current="page"]');
    assert.equal((await current.innerText()).trim(), "Chat");
    assert.notEqual(await current.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "the current page is tinted, not only coloured");
    await page.locator(".sidebar__link", { hasText: "Memory" }).click();
    await page.waitForURL(/\/app\/memory$/);
    assert.equal((await page.locator(".page__title").innerText()).trim(), "Memory");
    assert.equal((await page.locator('.sidebar__link[aria-current="page"]').innerText()).trim(), "Memory");
    await context.close();
  });

  test("11. workspace: the composer floats over the thread but never hides the last message, and an empty chat is one cluster", async (t) => {
    if (!needBrowser(t)) return;
    const { context, page } = await open(`/app/chat?conversation=${CHAT_ID}`, { signedIn: true });
    await page.getByText("This is the final sentence of the conversation.").waitFor();
    await page.evaluate(() => { const scroller = document.querySelector(".chat__scroll"); scroller.scrollTop = scroller.scrollHeight; });
    await page.waitForTimeout(300);
    const gap = await page.evaluate(() => {
      const last = [...document.querySelectorAll(".chat__thread p")].find((p) => p.textContent.includes("final sentence")).getBoundingClientRect();
      return document.querySelector(".composer").getBoundingClientRect().top - last.bottom;
    });
    assert.ok(gap >= 0, `the last line ends above the composer (${gap}px)`);
    await context.close();
    const empty = await open("/app/chat", { signedIn: true, empty: true });
    await empty.page.locator(".opening__title").waitFor();
    const cluster = await empty.page.evaluate(() => {
      const title = document.querySelector(".opening__title").getBoundingClientRect();
      const composer = document.querySelector(".composer").getBoundingClientRect();
      return { between: composer.top - title.bottom, size: Number.parseFloat(getComputedStyle(document.querySelector(".opening__title")).fontSize), lede: document.querySelector(".opening__lede")?.textContent ?? "" };
    });
    assert.ok(cluster.between > 0 && cluster.between < 140, `the composer sits right under the greeting (${cluster.between}px)`);
    assert.ok(cluster.size > 38 && cluster.size < 46, `the greeting is the reference's size scaled by 0.84, about 41.5px (${cluster.size}px)`);
    assert.match(cluster.lede, /Type a question below/);
    await empty.context.close();
  });

  test("12. no development fixtures or previews ship on public pages, and the SEO head is intact", async (t) => {
    if (!needBrowser(t)) return;
    for (const file of ["home/index.html", "pricing.html"]) {
      const html = fs.readFileSync(path.join(dist, file), "utf8");
      assert.doesNotMatch(html, /fixture|preview=catalog|Synthetic|lorem ipsum|Avery Sample/i, file);
    }
    const home = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
    for (const tag of [/<title>VibhavGPT: Private AI Chat/, /rel="canonical" href="https:\/\/vibhavgpt\.com\/home"/, /application\/ld\+json/]) assert.match(home, tag);
  });
});
