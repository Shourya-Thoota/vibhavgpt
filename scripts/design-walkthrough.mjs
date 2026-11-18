// Records the interactions round 4 corrected, as videos for review, from the
// built site with the design fixtures (no network, a fictitious account).
//
//   node scripts/design-walkthrough.mjs <outDir> [--slow=4] [--only=name1,name2]
//
// --slow=N plays the same scenario N times slower. CSS transitions are slowed
// with the DevTools animation playback rate; the springs (sidebar, sheet,
// drawer) read their clock from performance.now(), which is scaled in the
// page, so it is the real motion code running slowly, not a re-timed video.
// Input events keep real time, so a gesture is judged exactly as at speed.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CONVERSATION_ID, serve, systemBrowser } from "./design-capture.mjs";

const outDir = path.resolve(process.argv[2] ?? "design-walkthrough");
const slow = Number(process.argv.find((arg) => arg.startsWith("--slow="))?.slice(7) ?? 1);
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
fs.mkdirSync(outDir, { recursive: true });

const state = { signedIn: true, emptyLibrary: false, images: false, onboarding: false };
const server = serve(state);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
const pause = (page, ms) => page.waitForTimeout(ms * slow);

async function open(route, { width = 1440, height = 900, hasTouch = false, onboarding = false } = {}) {
  state.onboarding = onboarding;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch, recordVideo: { dir: outDir, size: { width, height } } });
  await context.addInitScript((factor) => {
    try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {}
    if (factor > 1) {
      const real = performance.now.bind(performance);
      const start = real();
      performance.now = () => start + (real() - start) / factor;
    }
  }, slow);
  const page = await context.newPage();
  if (slow > 1) { const cdp = await context.newCDPSession(page); await cdp.send("Animation.enable"); await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / slow }); }
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { context, page };
}

// A drag with a still hold before release, so it carries no momentum.
async function drag(page, from, to, { steps = 12, hold = 160 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.waitForTimeout(hold);
  await page.mouse.move(to.x, to.y + 1);
  await page.mouse.up();
}

const SCENARIOS = {
  // Collapse, reversed part-way; then expand-collapse once more.
  "sidebar-reversal": async () => {
    const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`);
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => document.querySelector(".sidebar__toggle").click());
      await pause(page, 110);
      await page.evaluate(() => document.querySelector(".sidebar__toggle").click());
      await pause(page, 900);
    }
    return context;
  },
  // Open the account menu, close it, reopen it while it is still leaving.
  "menu-reopen": async () => {
    const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`);
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => document.querySelector(".sidebar .account").click());
      await pause(page, 500);
      await page.keyboard.press("Escape");
      await pause(page, 40);
      await page.evaluate(() => document.querySelector(".sidebar .account").click());
      await pause(page, 700);
      await page.keyboard.press("Escape");
      await pause(page, 600);
    }
    return context;
  },
  // The phone sheet: released short of dismissal and caught on its way home;
  // dragged by a row, which is not picked; let go past half and caught on
  // its way out, then pulled back. Finally closed by tapping outside.
  "sheet-catch": async () => {
    const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`, { width: 390, height: 844 });
    await page.evaluate(() => document.querySelector(".composer__row button").click());
    await pause(page, 700);
    const panel = page.locator(".ui-sheet__panel");
    const height = (await panel.boundingBox()).height;
    const grab = async () => { const b = await page.locator(".ui-sheet__grab").boundingBox(); return { x: b.x + b.width / 2, y: b.y + 12 }; };
    let g = await grab();
    await drag(page, g, { x: g.x, y: g.y + height * 0.45 });
    await page.mouse.move(195, 760); await page.mouse.down();      // caught on the way home
    await pause(page, 500);
    await page.mouse.move(195, 700, { steps: 8 }); await page.waitForTimeout(160); await page.mouse.move(195, 699); await page.mouse.up();
    await pause(page, 900);
    // Let go past half its height, then caught by the "Detailed" row while
    // it is leaving and pulled back up: it stays open and the row is not
    // picked by the release.
    const row = page.locator(".add-sheet__list button", { hasText: "Detailed" });
    const before = await row.getAttribute("aria-checked");
    g = await grab();
    await drag(page, g, { x: g.x, y: g.y + height * 0.55 });   // past half: on its way out
    const box = await panel.boundingBox();
    const r = await row.boundingBox();
    const catchY = Math.min(r ? r.y + r.height / 2 : box.y + 150, 836);
    await page.mouse.move(195, catchY); await page.mouse.down();   // caught on a row, on its way out
    await pause(page, 500);
    await page.mouse.move(195, catchY - 500, { steps: 14 }); await page.waitForTimeout(160); await page.mouse.move(195, catchY - 501); await page.mouse.up();
    await pause(page, 1100);
    console.log(`  sheet-catch: sheet open ${await page.locator(".ui-sheet[data-shown]").count() === 1}, "Detailed" unchanged ${(await row.getAttribute("aria-checked")) === before}`);
    await page.mouse.click(195, 60);                                  // outside: closes
    await pause(page, 700);
    return context;
  },
  // The phone drawer, by touch: pulled open, then swiped closed. It lands
  // exactly where the stylesheet keeps a closed drawer, with no last nudge.
  "drawer-swipe": async () => {
    const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`, { width: 390, height: 844, hasTouch: true });
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    for (let i = 0; i < 2; i += 1) {
      await touch("touchStart", 30, 420);
      for (let x = 40; x <= 300; x += 20) { await touch("touchMove", x, 422); await page.waitForTimeout(16); }
      await touch("touchEnd");
      await pause(page, 900);
      await touch("touchStart", 300, 420);
      for (let x = 280; x >= 20; x -= 20) { await touch("touchMove", x, 422); await page.waitForTimeout(16); }
      await touch("touchEnd");
      await pause(page, 900);
    }
    const end = await page.evaluate(() => ({ left: document.querySelector(".sidebar").getBoundingClientRect().left, width: document.querySelector(".sidebar").offsetWidth, inline: document.querySelector(".sidebar").style.transform }));
    console.log(`  drawer-swipe: closed at ${end.left.toFixed(1)} for width ${end.width} (stylesheet in control: ${!end.inline})`);
    return context;
  },
  // Onboarding: welcome, name, a multiple choice and a single choice.
  onboarding: async () => {
    const { context, page } = await open("/app", { onboarding: true });
    await pause(page, 600);
    for (let step = 0; step < 2; step += 1) { await page.locator(".survey .btn--primary").click(); await pause(page, 900); }
    await page.locator(".survey-word").first().click(); await pause(page, 300);
    await page.locator(".survey-word").nth(2).click(); await pause(page, 700);
    await page.locator(".survey .btn--primary").click(); await pause(page, 900);
    await page.locator(".survey-option").nth(2).click(); await pause(page, 900);
    return context;
  },
  // The homepage tour, scrolled down through every scene and back up.
  "homepage-tour": async () => {
    state.signedIn = false;
    const { context, page } = await open("/", { width: 1366, height: 768 });
    const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    for (let y = 0; y < total; y += 60) { await page.mouse.wheel(0, 60); await page.waitForTimeout(40); }
    await page.waitForTimeout(600);
    const back = await page.evaluate(() => { const tour = document.getElementById("tour"); return tour.getBoundingClientRect().top + scrollY; });
    for (let y = await page.evaluate(() => scrollY); y > back; y -= 60) { await page.mouse.wheel(0, -60); await page.waitForTimeout(40); }
    await page.waitForTimeout(600);
    state.signedIn = true;
    return context;
  },
};

try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue;
    if (slow > 1 && (name === "onboarding" || name === "homepage-tour")) continue; // nothing time-based to slow: steps and scroll-linked
    const context = await run();
    const page = context.pages()[0];
    const video = page.video();
    await context.close();
    const file = path.join(outDir, `${name}${slow > 1 ? `-slow${slow}` : ""}.webm`);
    fs.renameSync(await video.path(), file);
    console.log(`recorded ${path.basename(file)}`);
  }
} finally {
  await browser.close();
  server.close();
}
