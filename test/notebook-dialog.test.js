import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The notebook dialog, in the built app, in three engines: its padding, the counter's alignment and size, focus on the accent (not a
// stray colour), the danger colour kept for errors, and that it fits a phone. Served from frontend/dist with the design fixtures.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe")].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));

for (const [engine, launch] of ENGINES) describe(`The notebook dialog in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function openNotebook({ width = 1440, height = 900, theme = "light" } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^New project/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.waitFor();
    return { context, page, dialog };
  }

  test("the instructions box has a textarea's own padding and line height, not a single-line field's", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openNotebook();
    const box = await page.locator("textarea.library__instructions").evaluate((el) => { const s = getComputedStyle(el); return { padTop: parseFloat(s.paddingTop), padLeft: parseFloat(s.paddingLeft), lineHeight: parseFloat(s.lineHeight), h: el.getBoundingClientRect().height, placeholder: el.placeholder }; });
    assert.ok(box.padTop >= 10, `top padding ${box.padTop}px: the placeholder is not flush against the border`);
    assert.ok(box.padLeft >= 12, `side padding ${box.padLeft}px`);
    assert.ok(box.lineHeight >= 20, `line height ${box.lineHeight}px`);
    assert.ok(box.h >= 110, `a box of ${box.h}px is room for several lines`);
    assert.match(box.placeholder, /Cite sources/);
    await context.close();
  });

  test("the counter shares the label's row, the helper text matches the counter's size, and both stay on screen", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openNotebook();
    const m = await page.evaluate(() => {
      const label = document.querySelector(".ui-field__row .ui-field__label");
      const counter = document.querySelector(".library__count");
      const hint = document.querySelector(".ui-field__hint");
      // Same row: the two text boxes share a vertical band (they overlap in y), and neither sits above the other.
      const lr = label.getBoundingClientRect(); const cr = counter.getBoundingClientRect();
      const overlap = Math.min(lr.bottom, cr.bottom) - Math.max(lr.top, cr.top);
      return { sameRow: overlap > Math.min(lr.height, cr.height) * 0.5, counterText: counter.textContent, counterFs: parseFloat(getComputedStyle(counter).fontSize), hintFs: hint ? parseFloat(getComputedStyle(hint).fontSize) : null, hintText: hint?.textContent, rightEdge: cr.right <= document.querySelector(".ui-modal").getBoundingClientRect().right };
    });
    assert.equal(m.sameRow, true, "the counter is on the label's line");
    assert.equal(m.counterText, "0/2000");
    assert.equal(m.counterFs, m.hintFs, "counter and helper text are the same size");
    assert.match(m.hintText, /Shown to the assistant in every conversation in this project/);
    assert.equal(m.rightEdge, true, "the counter does not run off the dialog");
    await context.close();
  });

  test("focus uses the selected accent, never a stray colour, and a danger colour is defined for errors", async (t) => {
    if (skip(t)) return;
    const { context, page } = await openNotebook();
    const name = page.locator(".ui-modal input.input").first();
    await name.focus();
    const focused = await name.evaluate((el) => ({ border: getComputedStyle(el).borderTopColor, shadow: getComputedStyle(el).boxShadow }));
    const accentRgb = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(); document.body.appendChild(probe); const rgb = getComputedStyle(probe).color; probe.remove(); return rgb; });
    assert.equal(focused.border, accentRgb, `the focused border is the accent (${accentRgb})`);
    assert.doesNotMatch(focused.shadow, /rgb\(2[0-9]{2}, ?[0-9]{2,3}, ?[0-9]{2}\)/, "no orange or terracotta glow");
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-danger").trim().length > 0), true, "a danger colour is defined for errors");
    await context.close();
  });

  test("the dialog fits a phone with no sideways scroll and keeps its buttons reachable", async (t) => {
    if (skip(t)) return;
    // On a phone the sidebar is closed and "New project" sits inside it, so it is opened first, as a person would open it.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, "light");
    const page = await context.newPage();
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /^New project/ }).first().click();
    await page.getByRole("dialog", { name: "New project" }).waitFor();
    const fit = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".ui-modal__actions button")].map((b) => b.getBoundingClientRect());
      return { inside: d.left >= 0 && d.right <= innerWidth + 0.5, overflow: document.documentElement.scrollWidth - innerWidth, buttonsOk: buttons.every((r) => r.height >= 40 && r.right <= innerWidth + 0.5) };
    });
    assert.equal(fit.inside, true, "the dialog is inside the screen");
    assert.equal(fit.overflow, 0, "no sideways scroll");
    assert.equal(fit.buttonsOk, true, "each button is tall enough and on screen");
    await context.close();
  });
});
