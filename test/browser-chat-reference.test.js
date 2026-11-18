import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The new-chat screen measured against the owner's reference screenshot (1900 by 991): the sidebar, the greeting, the
// composer pill, the tabs and suggestions under it, the glow. Served from frontend/dist with the design fixtures (a
// fictitious account). Tolerances are a couple of pixels: the engines round text differently.
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

for (const [engine, launch] of ENGINES) describe(`The new-chat screen in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true, emptyLibrary: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });

  async function open({ width, height, theme = "light" }) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    const requests = []; const problems = [];
    page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|Failed to load resource|interactive-widget/.test(message.text())) problems.push(`console: ${message.text().slice(0, 140)}`); });
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    await page.locator(".opening__title").waitFor();
    await page.waitForTimeout(900);
    return { context, page, requests, problems };
  }
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  test("at the reference's size: the sidebar's width, rows and account area", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ width: 1900, height: 991 });
    const m = await page.evaluate(() => {
      const box = (selector) => { const e = document.querySelector(selector); const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const rows = [...document.querySelectorAll(".sidebar__new, .sidebar__link, .library__new, .library-group__row, .conversation-item")].map((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; });
      return { sidebar: box(".sidebar"), brand: box(".sidebar__head"), first: box(".sidebar__new"), account: box(".account"), rows, labels: [...document.querySelectorAll(".sidebar .library__head")].map((e) => e.textContent.trim()), text: document.querySelector(".sidebar").innerText };
    });
    // The reference's numbers, scaled by 0.84: the sidebar 351 -> 295, rows 40 -> 33.5, the first row at 81 -> 68.
    near(m.sidebar.w, 295, 1, "the sidebar is 295px wide");
    near(m.brand.y, 17, 1, "the brand row starts at 17");
    near(m.first.y, 68, 1.5, "New chat is the first row, at 68");
    assert.ok(m.rows.length >= 9, `${m.rows.length} rows`);
    for (const row of m.rows) { near(row.h, 33.5, 1, "every row is about 33.5px high"); near(row.left, 2, 1, "rows start at x 2"); near(row.right, 287, 1.5, "and end at x 287"); }
    near(m.account.y + m.account.h / 2, 961, 6, "the account row is centred near the bottom");
    assert.deepEqual(m.labels.slice(0, 1), ["Projects"], "Projects in sidebar");
    assert.match(m.text, /New project/);
    assert.doesNotMatch(m.text, /Notebook/i, "no Notebooks anywhere in the sidebar");
    assert.doesNotMatch(m.text, /Folders/i, "no Folders anywhere in the sidebar");
    assert.match(m.text, /Avery Sample/, "the signed-in user's own name, not the reference's");
    assert.match(m.text, /Plus plan/, "and their own plan");
    assert.doesNotMatch(m.text, /Shourya|Thoota|Homework|Gildan/, "nothing copied from the reference account");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("the greeting, the composer pill and everything under it sit where the reference has them", async (t) => {
    if (skip(t)) return;
    const { context, page, requests, problems } = await open({ width: 1900, height: 991 });
    const m = await page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2, bottom: b.bottom, right: b.right }; };
      const composer = document.querySelector(".composer"); const style = getComputedStyle(composer);
      const title = document.querySelector(".opening__title");
      return {
        title: { ...r(title), size: parseFloat(getComputedStyle(title).fontSize), family: getComputedStyle(title).fontFamily, align: getComputedStyle(title).textAlign },
        composer: { ...r(composer), radius: parseFloat(style.borderTopLeftRadius), bg: style.backgroundColor, shadow: style.boxShadow !== "none" },
        add: r(document.querySelector(".composer__add-trigger")), mic: document.querySelector(".composer__mic") ? r(document.querySelector(".composer__mic")) : null, model: r(document.querySelector(".composer__model")),
        placeholder: document.querySelector(".composer__input").getAttribute("placeholder"),
        tablist: (() => { const e = [...document.querySelectorAll('[role="tablist"]')].find((x) => x.getBoundingClientRect().width > 0 && x.closest(".start-below")); return e && r(e); })(),
        selectedTab: (() => { const e = document.querySelector(".start-below .mode-tabs__tab[aria-selected=true]"); return e && { text: e.textContent.trim(), bg: getComputedStyle(e).backgroundColor, fontWeight: getComputedStyle(e).fontWeight, pseudoDisplay: getComputedStyle(e.parentElement, "::before").display, containerBg: getComputedStyle(e.parentElement).backgroundColor }; })(),
        suggestionRows: document.querySelectorAll(".chat-starters").length,
        main: r(document.querySelector(".workspace__main")),
        topBar: !!document.querySelector(".mode-tabs-bar") && getComputedStyle(document.querySelector(".mode-tabs-bar")).display,
        getApp: document.querySelector(".get-app"),
        fontLoaded: document.fonts.check('20px "Google Sans"'),
      };
    });
    // The greeting: centred over the composer, at the reference's size and height.
    near(m.title.size, 41.5, 0.6, "the greeting's size: the reference's 49.5 scaled by 0.84");
    assert.match(m.title.family, /Google Sans/);
    near(m.title.cy, 319, 6, "the greeting's centre");
    near(m.title.cx, m.composer.cx, 3, "centred on the composer");
    assert.equal(m.fontLoaded, true, "Google Sans is loaded from our own files");
    // The composer: 693 by 67 (the reference's 825 by 80, scaled), a full pill, solid white, with the plus left and the pickers and microphone right.
    near(m.composer.w, 693, 2, "the composer's width"); assert.ok(m.composer.h >= 66 && m.composer.h <= 71, `and height (${m.composer.h}px; the minimum is 67)`); near(m.composer.y, 387, 8, "and top");
    assert.ok(m.composer.radius >= 33, `a full pill (${m.composer.radius})`);
    assert.equal(m.composer.bg, "rgb(255, 255, 255)"); assert.equal(m.composer.shadow, true);
    assert.ok(m.add.cx < m.composer.x + 60 && m.model.right <= m.composer.right - 15, "plus on the left, the model picker on the right");
    if (m.mic) assert.ok(m.mic.cx > m.composer.right - 60 && m.model.right < m.mic.x, "and the microphone, where the browser has speech input, after the picker");
    assert.equal(m.placeholder, "Ask VibhavGPT");
    // Under it: the tabs, and nothing else. The three suggested-question rows are gone from the Chat home.
    assert.ok(m.tablist && m.tablist.y > m.composer.bottom, "the tabs are under the composer");
    near(m.tablist.cy, 488, 8, "the tabs' height"); near(m.tablist.cx, m.composer.cx, 4, "centred");
    assert.deepEqual(m.selectedTab?.text, "Chat");
    assert.ok(m.selectedTab?.bg === "rgba(0, 0, 0, 0)" || m.selectedTab?.bg === "transparent", "the segment itself is transparent: the white surface belongs to the container");
    assert.equal(m.selectedTab?.containerBg, "rgb(255, 255, 255)", "Chat | Study sits on a real white surface in light mode");
    assert.equal(m.selectedTab?.pseudoDisplay, "block", "the selected segment is drawn by the container's sliding thumb");
    assert.ok(parseInt(m.selectedTab?.fontWeight, 10) >= 600, "selected tab has modest font-weight emphasis");
    assert.equal(m.suggestionRows, 0, "no suggestion rows");
    assert.notEqual(m.topBar, "none", "the Chat | Image strip above is drawn on a new chat, beside the Chat | Study control under the composer");
    assert.equal(m.getApp, null, "redundant standalone Get app button is absent");
    // Behaviour: nothing was sent, and no font came from another site.
    await page.waitForTimeout(400);
    assert.deepEqual(requests.filter((r) => r.method === "POST" && /\/api\/chat\/(stream|message|messages)/.test(r.url)), [], "nothing was sent");
    assert.deepEqual(requests.filter((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.url)), [], "no font came from another site");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("the glow: a soft pool of the selected accent that peaks just under the composer and is gone by the edges", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open({ width: 1900, height: 991 });
    const png = await page.screenshot();
    const colour = await page.evaluate(async ([data, points]) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
      return points.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
    }, [png.toString("base64"), [[1141, 600], [1141, 700], [900, 700], [1850, 700], [400, 700], [1141, 980]]]);
    // The first three are in the pool (the closer to its centre, the deeper the accent); the last three are out near the edges, where
    // The ground is warm ivory. The default accent is Mars copper, so a pool leans peach: red above blue.
    const ivory = [246, 240, 230];
    for (const [i, got] of colour.slice(0, 3).entries()) {
      assert.ok(got[0] > got[2] + 6, `sample ${i + 1} ${got} is warm (red above blue)`);
      assert.ok(got[0] > 160, `sample ${i + 1} ${got} stays light`);
    }
    for (const [i, got] of colour.slice(3).entries()) near(Math.max(...got.map((v, k) => Math.abs(v - ivory[k]))), 0, 18, `the glow is gone at edge sample ${i + 1} ${got}`);
    await context.close();
  });

  for (const [theme, width, height] of [["dark", 1900, 991], ["light", 390, 844], ["dark", 390, 844]]) test(`${theme}, ${width}px wide: the same design holds, with no overflow and no console errors`, async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ width, height, theme });
    const m = await page.evaluate(() => {
      const c = document.querySelector(".composer").getBoundingClientRect();
      const visible = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight; };
      return { overflow: document.documentElement.scrollWidth - innerWidth, composer: { w: c.width, h: c.height, left: c.left, right: c.right, radius: parseFloat(getComputedStyle(document.querySelector(".composer")).borderTopLeftRadius) }, suggestionRows: document.querySelectorAll(".chat-starters").length, title: visible(document.querySelector(".opening__title")), bg: getComputedStyle(document.querySelector(".composer")).backgroundColor, placeholder: document.querySelector(".composer__input").getAttribute("placeholder"), tabs: [...document.querySelectorAll('[role="tab"]')].filter(visible).map((e) => e.textContent.trim()) };
    });
    assert.equal(m.overflow, 0, "no horizontal overflow");
    assert.ok(m.title && m.suggestionRows === 0, "the greeting is on screen and there are no suggestion rows");
    assert.ok(m.composer.radius >= 28, `a pill (${m.composer.radius})`);
    assert.equal(m.placeholder, "Ask VibhavGPT");
    assert.ok(m.tabs.includes("Chat") && m.tabs.includes("Image") && m.tabs.includes("Study"), "Chat, Image and Study are all reachable");
    assert.equal(m.tabs.filter((label) => label === "Study").length, 1, "Study is offered once, not in both controls");
    if (width > 760) near(m.composer.w, 693, 2, "the composer's width");
    else assert.ok(m.composer.left >= 8 && m.composer.right <= width - 8, "the composer fits the phone");
    if (theme === "dark") assert.notEqual(m.bg, "rgb(255, 255, 255)", "the composer is dark at night");
    assert.deepEqual(problems, []);
    await context.close();
  });
});
