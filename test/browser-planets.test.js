import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The two planets (the Guarantee page's and the onboarding welcome's) were flat black circles in the light theme: the
// light rule filled them with the ink colour, which is #000 by day, and gave them no gradient, so no shading, and a glow
// too pale to see on a pale page. This looks at what is actually painted: the pixels of the disc and of the air around
// it, by day and by night, on a desktop and a phone, with motion allowed and reduced. A CSS string can be right while
// the rendering is wrong; the pixels cannot.
const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("source: the light planets are filled with a gradient of the theme's own colours, never the ink colour", () => {
  const css = read("frontend/src/theme/orbital.css");
  const light = css.match(/:root\[data-theme="light"\] \.guarantee__planet,\s*:root\[data-theme="light"\] \.survey__orb \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(light, "there is a light-theme rule for both planets");
  assert.match(light, /radial-gradient\(/, "a gradient, so it has shading");
  assert.match(light, /var\(--color-atmosphere\)/, "in the atmosphere blue");
  assert.match(light, /box-shadow:/, "with a rim and a glow");
  assert.doesNotMatch(light, /var\(--color-ink\)/, "the ink colour is #000 by day: it made the black disc");
  assert.doesNotMatch(css.slice(css.indexOf("Planetary marks")), /background:\s*color-mix\(in srgb, var\(--color-ink\) 92%/, "the old black fill is gone");
});

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

// Each planet's page: where it is, how to reach it, and what to point at.
const PLANETS = [
  { name: "onboarding welcome orb", route: "/app", selector: ".survey__orb", state: { signedIn: true, onboarding: true } },
];

for (const [engine, launch] of ENGINES) describe(`The planets, as painted, in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  const state = { signedIn: false, emptyLibrary: false, images: false, onboarding: false };
  before(async () => {
    server = serve(state);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  // The planet's own rectangle, and the colour of any pixel of a screenshot of the page, measured inside the page.
  async function measure({ route, selector, theme, width, height, reducedMotion, onboarding, signedIn }) {
    state.signedIn = signedIn; state.onboarding = onboarding;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme: theme });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    // The planet's box is read before and after the photograph, and the photograph is only used when the two agree: a page
    // that re-renders or settles while the shot is taken (slow engines, a busy machine) must not be measured at the wrong place.
    let box = null; let png = null;
    for (let attempt = 0; attempt < 6 && !box; attempt += 1) {
      await page.locator(selector).waitFor();
      await page.waitForTimeout(attempt === 0 ? 700 : 400);
      const before = await page.locator(selector).boundingBox().catch(() => null);
      png = await page.screenshot();
      const after = await page.locator(selector).boundingBox().catch(() => null);
      if (before && after && Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5 && Math.abs(before.width - after.width) < 0.5) box = after;
    }
    assert.ok(box, "the planet held still long enough to be measured");
    const data = await page.evaluate(async ([image, placed]) => {
      const rect = { left: placed.x, top: placed.y, width: placed.width, height: placed.height, right: placed.x + placed.width, bottom: placed.y + placed.height };
      const img = new Image(); img.src = `data:image/png;base64,${image}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const luma = ([r, g2, b]) => 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
      const px = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
      const cx = rect.left + rect.width / 2; const cy = rect.top + rect.height / 2; const radius = rect.width / 2;
      // The disc's inside: a grid of points within 88% of the radius, so the antialiased edge is not in it.
      const inside = []; const upperLeft = []; const lowerRight = [];
      for (let dy = -0.88; dy <= 0.88; dy += 0.04) for (let dx = -0.88; dx <= 0.88; dx += 0.04) {
        if (dx * dx + dy * dy > 0.88 * 0.88) continue;
        const l = luma(px(cx + dx * radius, cy + dy * radius));
        inside.push(l);
        if (dx + dy < -0.5) upperLeft.push(l); else if (dx + dy > 0.5) lowerRight.push(l);
      }
      const mean = (list) => list.reduce((a, b) => a + b, 0) / (list.length || 1);
      // The air around it, up and to the left (where its glow and lit rim fall), and a point well clear of it.
      const toward = (distance) => px(cx - (distance * Math.SQRT1_2), cy - (distance * Math.SQRT1_2));
      const near = toward(radius + 7); const far = toward(radius + Math.min(150, radius * 2.4));
      // The lit limb is a crescent two pixels wide on the upper left: look along it, not at one point.
      const rimPoints = [];
      for (const angle of [-2.55, -2.4, -2.25, -2.1]) for (const distance of [1.2, 2.2]) rimPoints.push(px(cx + Math.cos(angle) * (radius + distance), cy + Math.sin(angle) * (radius + distance)));
      const rim = rimPoints.reduce((best, p) => (luma(p) > luma(best) ? p : best));
      return { radius, width: rect.width, mean: mean(inside), nearBlack: inside.filter((l) => l < 45).length / inside.length, upperLeft: mean(upperLeft), lowerRight: mean(lowerRight), near, far, rim, nearLuma: luma(near), farLuma: luma(far), rimLuma: luma(rim), centre: px(cx, cy), inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 };
    }, [png.toString("base64"), box]);
    await context.close();
    return data;
  }

  for (const planet of PLANETS) for (const [width, height, view] of [[1440, 900, "desktop"], [390, 844, "phone"]]) for (const reducedMotion of ["no-preference", "reduce"]) {
    test(`light, ${view}, motion ${reducedMotion}: the ${planet.name} is a lit, shaded sphere with a glow, not a black disc`, async (t) => {
      if (skip(t)) return;
      const m = await measure({ ...planet, ...planet.state, theme: "light", width, height, reducedMotion });
      assert.ok(m.inViewport, "the planet is on screen");
      assert.ok(m.mean > 100, `the disc is light enough to read as lit, mean luminance ${m.mean.toFixed(0)} (the black disc was about 13)`);
      assert.ok(m.nearBlack < 0.12, `almost none of it is near-black: ${(m.nearBlack * 100).toFixed(1)}% of its pixels`);
      assert.ok(m.centre.some((v) => v > 60), `its centre is not black: rgb(${m.centre})`);
      assert.ok(m.upperLeft - m.lowerRight > 40, `it is shaded: lit side ${m.upperLeft.toFixed(0)}, shadow side ${m.lowerRight.toFixed(0)}`);
      assert.ok(m.near[2] - m.near[0] > m.far[2] - m.far[0] + 6, `it glows: the air beside it is bluer (${m.near}) than the page further off (${m.far})`);
    });

    test(`dark, ${view}, motion ${reducedMotion}: the ${planet.name} keeps its dark body and its lit rim`, async (t) => {
      if (skip(t)) return;
      const m = await measure({ ...planet, ...planet.state, theme: "dark", width, height, reducedMotion });
      assert.ok(m.mean < 60, `a dark body at night, mean luminance ${m.mean.toFixed(0)}`);
      assert.ok(m.rimLuma > m.farLuma + 20, `its limb is lit: ${m.rimLuma.toFixed(0)} against the sky at ${m.farLuma.toFixed(0)}`);
    });
  }
});
