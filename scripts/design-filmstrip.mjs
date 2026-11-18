// Frame-accurate strips of the interactions round 4 corrected, for review.
//
//   node scripts/design-filmstrip.mjs <outDir> [--only=sidebar,drawer,sheet]
//
// Video recordings (design-walkthrough.mjs) come from the browser's
// screencast, which drops and repeats frames under load, so a still taken
// from them can show a state that was never on screen. These strips are real
// rendered screenshots taken in a loop while the motion runs eight times
// slower (the springs read a scaled performance.now()), each labelled with
// the position measured in the page at that moment.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CONVERSATION_ID, serve, systemBrowser } from "./design-capture.mjs";

const outDir = path.resolve(process.argv[2] ?? "design-filmstrip");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const SLOW = 8;
fs.mkdirSync(outDir, { recursive: true });
const server = serve({ signedIn: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });

async function open({ width, height, hasTouch = false }) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch });
  await context.addInitScript((factor) => {
    try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {}
    const real = performance.now.bind(performance); const start = real();
    performance.now = () => start + (real() - start) / factor;
  }, SLOW);
  const page = await context.newPage();
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { context, page };
}

// Screenshots for `ms` (at speed; real time is ms * SLOW), labelled.
async function film(page, frames, label, ms, clip, measure) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms * SLOW) {
    const value = await page.evaluate(measure);
    frames.push({ label: `${label} +${Math.round((Date.now() - t0) / SLOW)}ms · ${value}`, img: (await page.screenshot({ clip })).toString("base64") });
  }
}

async function sheet(frames, file, columns) {
  const page = await browser.newPage();
  const step = Math.max(1, Math.ceil(frames.length / 24));
  const pick = frames.filter((_, i) => i % step === 0);
  await page.setContent(`<body style="margin:0;background:#666;font:600 13px system-ui;color:#fff"><div style="display:grid;grid-template-columns:repeat(${columns},1fr);gap:6px;padding:6px">${pick.map((f) => `<figure style="margin:0"><figcaption style="padding:2px 0 4px">${f.label}</figcaption><img style="width:100%;display:block" src="data:image/png;base64,${f.img}"></figure>`).join("")}</div>`);
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  await page.close();
  console.log(`wrote ${file}: ${frames.length} rendered frames, ${pick.length} shown`);
}

const STRIPS = {
  // Collapse, reversed after 110ms.
  sidebar: async () => {
    const { context, page } = await open({ width: 1440, height: 900 });
    const measure = () => `${Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)}px`;
    const frames = [];
    const clip = { x: 0, y: 0, width: 520, height: 330 };
    await page.evaluate(() => document.querySelector(".sidebar__toggle").click());
    await film(page, frames, "collapse", 110, clip, measure);
    await page.evaluate(() => document.querySelector(".sidebar__toggle").click());
    await film(page, frames, "reversed", 650, clip, measure);
    await context.close();
    await sheet(frames, "filmstrip-sidebar-reversal.png", 4);
  },
  // Pulled open by touch and released; then swiped closed and released.
  drawer: async () => {
    const { context, page } = await open({ width: 390, height: 844, hasTouch: true });
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const measure = () => { const s = document.querySelector(".sidebar"); return `left ${s.getBoundingClientRect().left.toFixed(1)} of -${s.offsetWidth}${s.style.transform ? "" : " (stylesheet)"}`; };
    const frames = [];
    const clip = { x: 0, y: 0, width: 390, height: 520 };
    // Started on message text: a code block (y 420 here) keeps sideways
    // swipes for its own scrolling, by design.
    await touch("touchStart", 30, 640);
    for (let x = 40; x <= 300; x += 20) { await touch("touchMove", x, 642); await page.waitForTimeout(16); }
    await touch("touchEnd");
    await film(page, frames, "opening", 500, clip, measure);
    // Closed from the scrim beside it, so no link is under the finger.
    await touch("touchStart", 370, 640);
    for (let x = 350; x >= 30; x -= 20) { await touch("touchMove", x, 642); await page.waitForTimeout(16); }
    await touch("touchEnd");
    await film(page, frames, "closing", 600, clip, measure);
    await context.close();
    await sheet(frames, "filmstrip-drawer.png", 6);
  },
  // Let go past half its height, then caught on the way out and pulled back.
  sheet: async () => {
    const { context, page } = await open({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelector(".composer__row button").click());
    await page.waitForTimeout(700 * SLOW);
    const measure = () => { const p = document.querySelector(".ui-sheet__panel"); if (!p) return "closed"; const t = getComputedStyle(p).transform; return `y ${t && t !== "none" ? new DOMMatrixReadOnly(t).m42.toFixed(0) : 0}px`; };
    const frames = [];
    const clip = { x: 0, y: 300, width: 390, height: 544 };
    const height = (await page.locator(".ui-sheet__panel").boundingBox()).height;
    const g = await page.locator(".ui-sheet__grab").boundingBox();
    await page.mouse.move(195, g.y + 12); await page.mouse.down();
    await page.mouse.move(195, g.y + 12 + height * 0.55, { steps: 10 });
    await page.waitForTimeout(160); await page.mouse.move(195, g.y + 13 + height * 0.55); await page.mouse.up();
    await film(page, frames, "leaving", 120, clip, measure);
    await page.mouse.move(195, 830); await page.mouse.down();
    await film(page, frames, "caught", 120, clip, measure);
    await page.mouse.move(195, 330, { steps: 12 }); await page.waitForTimeout(160); await page.mouse.move(195, 329); await page.mouse.up();
    await film(page, frames, "released", 500, clip, measure);
    await context.close();
    await sheet(frames, "filmstrip-sheet-catch.png", 6);
  },
};

try {
  for (const [name, run] of Object.entries(STRIPS)) if (!only || only.includes(name)) await run();
} finally {
  await browser.close();
  server.close();
}
