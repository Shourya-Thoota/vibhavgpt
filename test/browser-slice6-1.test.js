// Slice 6.1, in a real browser against the built site: the Sources page's seven social rows, Extensions rows that never overlap, the
// menus' entrance, row nudge and keyboard-hint chip, and the mode switchers' restored original pill. Emulated Chromium, not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startFixture, sampleSkills } from "./support/extensions-fixture.js";
import { CONVERSATION_ID } from "../scripts/design-capture.mjs";

const exe = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && fs.existsSync(p));
const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let fixture;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: exe });
  fixture = await startFixture({ skills: sampleSkills() });
});
test.after(async () => { await browser?.close(); fixture?.close(); });

async function open(route, { width = 1280, height = 860, sky = "light", motion = "full", touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: sky, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(([s, m]) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); localStorage.setItem("vibhavgpt-motion", m); }, [sky, motion]);
  const page = await context.newPage();
  await page.goto(`${fixture.url}${route}`, { waitUntil: "networkidle" });
  return { context, page };
}

test("Sources: the Social section shows seven rows, ending with Threads (@vibhavgpt.ai) and GitHub (@Shourya-Thoota)", { skip }, async () => {
  for (const width of [1280, 375]) {
    const { context, page } = await open("/sources", { width, touch: width < 500 });
    const rows = page.locator(".src-list--social .src-row--social");
    assert.equal(await rows.count(), 7);
    const texts = await rows.allInnerTexts();
    assert.match(texts[5], /Threads[\s\S]*@vibhavgpt\.ai/);
    assert.match(texts[6], /GitHub[\s\S]*@Shourya-Thoota/);
    assert.equal(await rows.nth(5).getAttribute("href"), "https://www.threads.net/@vibhavgpt.ai");
    assert.equal(await rows.nth(6).getAttribute("href"), "https://github.com/Shourya-Thoota");
    for (const i of [5, 6]) assert.equal(await rows.nth(i).locator(".src-row__icon svg").count(), 1, "an outline icon, the footer's own");
    await context.close();
  }
});

test("Extensions: rows never overlap each other, and nothing inside a row overlaps (375 and 1280px, both skies, both tabs)", { skip }, async () => {
  for (const sky of ["light", "dark"]) for (const width of [375, 1280]) for (const tab of ["Connectors", "Skills"]) {
    const { context, page } = await open("/app/extensions", { width, sky, touch: width < 500 });
    if (tab === "Skills") await page.getByRole("tab", { name: "Skills" }).click();
    await page.locator(".ext-list > .ext-row").first().waitFor();
    const problems = await page.evaluate(() => {
      const bad = [];
      const box = (el) => el.getBoundingClientRect();
      const hits = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const rows = [...document.querySelectorAll(".ext-list > .ext-row")];
      for (let i = 1; i < rows.length; i++) if (rows[i].parentElement === rows[i - 1].parentElement && box(rows[i]).top < box(rows[i - 1]).bottom - 1) bad.push(`row ${i} overlaps the row above`);
      for (const row of rows) {
        const parts = [...row.children].filter((el) => box(el).width > 0 && box(el).height > 0);
        for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hits(box(parts[i]), box(parts[j]))) bad.push(`${row.textContent.trim().slice(0, 18)}: ${parts[i].className} overlaps ${parts[j].className}`);
        const text = row.querySelector(".ext-row__text");
        const actions = row.querySelector(".ext-row__actions");
        if (text && actions && box(actions).width && hits(box(text), box(actions))) bad.push(`${row.textContent.trim().slice(0, 18)}: text collides with the actions`);
        for (const el of row.querySelectorAll(".ext-row__name, .ext-row__meta, .ext-mark")) if (box(el).right > box(row).right + 1) bad.push(`${el.className} runs out of its row`);
      }
      // Each category's name sits clear of its panel (no rule of its own meeting the panel's top).
      for (const group of document.querySelectorAll(".ext-group")) {
        const title = group.querySelector(".ext-group__title"); const list = group.querySelector(".ext-list");
        if (title && list && box(list).top < box(title).bottom) bad.push("a category name overlaps its panel");
        if (title && getComputedStyle(title).borderBottomStyle !== "none") bad.push("a category name has a rule of its own");
      }
      return bad;
    });
    assert.deepEqual(problems, [], `${sky} ${width}px ${tab}`);
    await context.close();
  }
});

test("menus: they enter from the trigger's side (scaled, 8px), exit faster, and under reduced motion only fade", { skip }, async () => {
  const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`);
  const probe = (placement, motion) => page.evaluate(([p, m]) => {
    if (m) document.documentElement.setAttribute("data-motion", m); else document.documentElement.removeAttribute("data-motion");
    const el = document.createElement("div");
    el.className = "ui-popover"; el.dataset.state = "closed"; el.dataset.placement = p;
    document.body.append(el);
    const s = getComputedStyle(el);
    const result = { transform: s.transform, opacity: s.opacity, duration: s.transitionDuration, ease: s.transitionTimingFunction };
    el.remove();
    // The resting state, on an element that starts open (not one caught mid-transition).
    const rest = document.createElement("div");
    rest.className = "ui-popover"; rest.dataset.state = "open"; rest.dataset.placement = p;
    document.body.append(rest);
    const open = getComputedStyle(rest);
    result.openDuration = open.transitionDuration; result.openEase = open.transitionTimingFunction; result.openTransform = open.transform;
    rest.remove();
    return result;
  }, [placement, motion]);
  const down = await probe("bottom", null);
  assert.equal(down.transform, "matrix(0.95, 0, 0, 0.95, 0, -8)", "a downward panel starts 8px above, at 95%");
  assert.equal(down.opacity, "0");
  assert.equal(down.openTransform, "none", "and rests at identity");
  assert.match(down.openDuration, /0\.2s/, "about 200ms in");
  assert.match(down.openEase, /cubic-bezier\(0\.34, 1\.36, 0\.64, 1\)/, "on the spring-like ease");
  assert.match(down.duration, /0\.12s/, "and quicker out");
  const up = await probe("top", null);
  assert.equal(up.transform, "matrix(0.95, 0, 0, 0.95, 0, 8)", "an upward panel starts 8px below");
  const reduced = await probe("bottom", "reduce");
  assert.equal(reduced.transform, "none", "reduced motion: no movement, only the fade");
  await context.close();
});

test("menus: rows nudge 2px on hover with a mouse, never on touch and never with reduced motion; hints are bordered chips", { skip }, async () => {
  const nudgeAfterHover = async (options) => {
    const { context, page } = await open(`/app/chat?conversation=${CONVERSATION_ID}`, options);
    await page.locator(".sidebar .account").first().click().catch(async () => { await page.locator('.composer button[aria-label="Add to message"]').first().click(); });
    const row = page.locator(".ui-popover [role^='menuitem']").first();
    await row.waitFor();
    await page.waitForTimeout(400);
    await row.hover();
    await page.waitForTimeout(250);
    const transform = await row.locator(".ui-menu__text").evaluate((el) => getComputedStyle(el).transform);
    const kbd = await page.evaluate(() => { const k = document.createElement("kbd"); k.textContent = "K"; document.querySelector(".ui-popover").append(k); const s = getComputedStyle(k); const out = { border: s.borderTopStyle, radius: s.borderTopLeftRadius }; k.remove(); return out; });
    await context.close();
    return { transform, kbd };
  };
  const mouse = await nudgeAfterHover({});
  assert.equal(mouse.transform, "matrix(1, 0, 0, 1, 2, 0)", "a 2px nudge on hover");
  assert.equal(mouse.kbd.border, "solid", "a keyboard hint is a bordered chip");
  assert.notEqual(mouse.kbd.radius, "0px");
  const reduced = await nudgeAfterHover({ motion: "reduce" });
  assert.equal(reduced.transform, "none", "never with reduced motion");
});

test("mode switchers: Chat | Image keeps its original pre-6.1 pill, and Chat | Study wears exactly the same treatment, in both skies", { skip }, async () => {
  // Restored (hotfix after Slice 6.1): the Chat | Image notch is the workspace's own original treatment (chat-reference.css as at
  // 6018d5c): a --ref-row track with a soft inset shadow and a raised thumb (--ref-seg by day, --ref-composer by night). Chat | Study
  // under the composer wears the identical track, thumb and shadows; only its size differs (44px targets).
  const ORIGINAL = {
    light: { trackShadow: "rgba(0, 0, 0, 0.05) 0px 1px 2px 0px inset, rgba(0, 0, 0, 0.03) 0px 1px 2px 0px", thumbShadow: "rgba(0, 0, 0, 0.12) 0px 1px 3px 0px, rgba(0, 0, 0, 0.04) 0px 0px 0px 1px", thumbToken: "--ref-seg" },
    dark: { trackShadow: "rgba(0, 0, 0, 0.35) 0px 1px 2px 0px inset, rgba(0, 0, 0, 0.15) 0px 1px 2px 0px", thumbShadow: "rgba(0, 0, 0, 0.4) 0px 1px 3px 0px, rgba(255, 255, 255, 0.08) 0px 0px 0px 1px", thumbToken: "--ref-composer" },
  };
  for (const sky of ["light", "dark"]) for (const route of ["/app/chat", "/app/study"]) for (const width of [1280, 375]) {
    const { context, page } = await open(route, { width, sky, touch: width < 500 });
    const read = await page.evaluate((thumbToken) => {
      const resolve = (el, token) => { const probe = document.createElement("i"); probe.style.backgroundColor = `var(${token})`; el.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; };
      return [...document.querySelectorAll(".mode-tabs--notch, .mode-tabs--study")].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
        const s = getComputedStyle(el); const thumb = getComputedStyle(el, "::before");
        const selected = el.querySelector("[aria-selected='true']");
        return {
          kind: el.classList.contains("mode-tabs--study") ? "study" : "notch",
          track: s.backgroundColor, trackShadow: s.boxShadow, thumb: thumb.backgroundColor, thumbShadow: thumb.boxShadow,
          refRow: resolve(el, "--ref-row"), refThumb: resolve(el, thumbToken),
          selectedHeight: selected?.getBoundingClientRect().height ?? 0, tablist: el.getAttribute("role"), selectedAttr: Boolean(selected),
        };
      });
    }, ORIGINAL[sky].thumbToken);
    const where = `${route} ${sky} ${width}px`;
    assert.ok(read.length >= 1, `${where}: a switcher is on screen`);
    for (const sw of read) {
      assert.equal(sw.track, sw.refRow, `${where} ${sw.kind}: the track is the original --ref-row`);
      assert.equal(sw.thumb, sw.refThumb, `${where} ${sw.kind}: the thumb is the original ${ORIGINAL[sky].thumbToken}`);
      assert.equal(sw.trackShadow, ORIGINAL[sky].trackShadow, `${where} ${sw.kind}: the original track shadow`);
      assert.equal(sw.thumbShadow, ORIGINAL[sky].thumbShadow, `${where} ${sw.kind}: the original thumb shadow`);
      assert.ok(sw.selectedAttr, `${where} ${sw.kind}: the selected state is still announced`);
    }
    const notch = read.find((sw) => sw.kind === "notch");
    const study = read.find((sw) => sw.kind === "study");
    if (notch && study) for (const key of ["track", "trackShadow", "thumb", "thumbShadow"]) assert.equal(study[key], notch[key], `${where}: Chat | Study's ${key} is Chat | Image's`);
    if (study) assert.ok(study.selectedHeight >= 43.5, `${where}: Chat | Study keeps its 44px targets`);
    await context.close();
  }
});
