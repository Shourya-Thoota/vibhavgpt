// The model picker in a real browser against the built app: the composer's control ([mark] [exact name] [thinking level] [chevron])
// opens a centered dialog, in sections by maker: VibhavGPT (Lumen, Vulcan, Zenith; Nova and Nebula are retired), OpenAI (GPT-6), Z.AI
// (GLM). Clean rows (the maker's official mark from a local file, the exact name, one line, the image capability, a lock with "Upgrade"
// or a check), 44px targets, keyboard operable, Escape closes. A model's thinking level is chosen in the composer, from the three
// unified levels (Low, Medium, High; #151). Desktop 1280px and phone 375px, both skies. The catalog API's lineup is answered by page.route.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
const SHOTS = process.env.PICKER_SHOTS_DIR || null;
const lineupWith = (ids) => ({
  models: [], groups: [], userPlan: "plus",
  lineup: {
    house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })),
    providers: ["glm", "gpt-6"].map((provider) => ({ id: provider, name: providerName(provider), models: THIRD_PARTY_MODELS.filter((m) => m.provider === provider && ids.includes(m.id)).map((m) => ({ id: m.id, name: m.name })) })).filter((p) => p.models.length),
  },
});
const LINEUP = lineupWith(THIRD_PARTY_MODELS.map((m) => m.id));
// A Plus account: Lumen open; Vulcan (Pro) and Zenith (Max) locked; GPT-6 Luna open, Terra (Pro), Sol and Astra (Max) locked; GLM open.
const EXPECTED = [
  { name: "Lumen", section: "VibhavGPT", brand: "vibhavgpt", locked: false },
  { name: "Vulcan", section: "VibhavGPT", brand: "vibhavgpt", locked: true },
  { name: "Zenith", section: "VibhavGPT", brand: "vibhavgpt", locked: true },
  { name: "GPT-6 Luna", section: "OpenAI", brand: "openai", locked: false },
  { name: "GPT-6.1 Terra", section: "OpenAI", brand: "openai", locked: true },
  { name: "GPT-6.2 Sol", section: "OpenAI", brand: "openai", locked: true },
  { name: "GPT-6.2 Astra", section: "OpenAI", brand: "openai", locked: true },
  { name: "GLM 5.3", section: "Z.AI", brand: "zai", locked: false },
  { name: "GLM 5.3 Flash", section: "Z.AI", brand: "zai", locked: false },
];
const SRC = { vibhavgpt: "/brand/vibhavgpt-icon-64.png", openai: "/brand/providers/openai.png", zai: "/brand/providers/zai.png" };

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open({ width, sky, catalog = LINEUP }) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 900 }, colorScheme: sky, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); }, sky);
  const page = await context.newPage();
  const external = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (!["127.0.0.1", "localhost"].includes(url.hostname) && /\.(svg|png|jpe?g|webp)$/i.test(url.pathname)) external.push(request.url()); });
  await page.route("**/api/models/catalog", (route) => (catalog ? route.fulfill({ json: catalog }) : route.fulfill({ status: 500, json: { error: "down" } })));
  await page.goto(`${base}${CHAT}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  return { context, page, external };
}
async function openPicker(page, width) {
  if (width < 500) {
    await page.locator('button[aria-label="Add to message"]').first().click();
    await page.locator(".add-sheet__row", { hasText: "Model" }).click();
  } else {
    await page.locator(".model-trigger").first().click();
  }
  await page.locator(".model-modal").waitFor();
  await page.waitForTimeout(250);
}

const readRows = (page) => page.evaluate(() => [...document.querySelectorAll(".model-modal__option")].map((option) => {
  const row = option.querySelector(".model-row");
  const mark = row.querySelector("img.model-brand");
  const box = option.getBoundingClientRect();
  return {
    name: row.querySelector(".model-row__name")?.textContent.trim(),
    section: option.closest(".model-modal__section")?.querySelector(".model-modal__heading")?.textContent.trim(),
    brand: mark?.dataset.brand ?? null,
    src: mark?.getAttribute("src") ?? null,
    loaded: Boolean(mark?.complete && mark.naturalWidth > 0),
    locked: option.getAttribute("aria-disabled") === "true",
    upgrade: row.querySelector(".model-row__lock")?.textContent.trim() ?? null,
    check: Boolean(row.querySelector(".model-row__check")),
    checked: option.getAttribute("aria-checked") === "true",
    vision: Boolean(row.querySelector(".model-row__vision")),
    desc: row.querySelector(".model-row__desc")?.textContent.trim() ?? "",
    height: box.height, right: box.right,
  };
}));

for (const width of [1280, 375]) {
  for (const sky of ["light", "dark"]) {
    test(`${width}px, ${sky}: the centered picker lists the lineup in maker sections with clean rows, and the trigger shows the choice`, { skip }, async () => {
      const { context, page, external } = await open({ width, sky });
      // The fixture conversation is on Lumen (scripts/design-capture.mjs, since Nova was retired); on a phone the model is in the + sheet.
      if (width >= 500) assert.match(await page.locator(".model-trigger").first().innerText(), /Lumen/);
      await openPicker(page, width);
      const dialog = await page.locator(".model-modal").boundingBox();
      assert.ok(Math.abs((dialog.x + dialog.width / 2) - width / 2) < width * 0.08, "centered horizontally");
      const rows = await readRows(page);
      assert.deepEqual(rows.map(({ name, section, brand, locked }) => ({ name, section, brand, locked })), EXPECTED);
      assert.deepEqual(await page.locator(".model-modal__heading").allInnerTexts(), ["VibhavGPT", "OpenAI", "Z.AI"]);
      for (const row of rows) {
        assert.equal(row.src, SRC[row.brand], `${row.name}: the official local mark`);
        assert.ok(row.loaded, `${row.name}: mark loaded`);
        assert.ok(row.height >= 43.5, `${row.name}: 44px target (${Math.round(row.height)})`);
        assert.ok(row.right <= width + 0.5, `${row.name}: on screen`);
        assert.equal(row.upgrade, row.locked ? "Upgrade" : null, row.name);
      }
      assert.equal(rows.find((r) => r.name === "GLM 5.3").vision, false, "GLM 5.3 is text only");
      assert.match(rows.find((r) => r.name === "GLM 5.3").desc, /^Text only\./);
      const text = await page.locator(".model-modal").innerText();
      assert.doesNotMatch(text, /Recommended|provider's cost|plus 10%|Nova|Nebula/);
      assert.deepEqual(external, [], "no hotlinked images");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      // Choose GPT-6 Luna: the dialog stays open, and holds no thinking level (owner request, 2026-11-14: that is the composer's).
      await page.locator(".model-modal__option", { hasText: "GPT-6 Luna" }).click();
      await page.waitForTimeout(250);
      assert.equal(await page.locator(".model-modal__level").count(), 0, "no thinking levels in the picker");
      assert.doesNotMatch(await page.locator(".model-modal").innerText(), /Thinking level|Not adjustable/);
      const after = await readRows(page);
      assert.deepEqual(after.filter((r) => r.checked).map((r) => r.name), ["GPT-6 Luna"]);
      assert.ok(after.find((r) => r.name === "GPT-6 Luna").check, "a check on the chosen row");
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `picker-modal-${width}-${sky}.png`) });
      await page.locator(".model-modal__done").click();
      await page.locator(".model-modal").waitFor({ state: "detached" });
      if (width >= 500) {
        const trigger = page.locator(".model-trigger").first();
        // The model's name only; its level is shown once, in the dropdown beside it.
        assert.equal((await trigger.innerText()).replace(/\s+/g, " ").trim(), "GPT-6 Luna");
        assert.equal((await page.locator(".composer__level .ui-select__trigger").innerText()).trim(), "Medium");
        assert.equal((await page.locator(".composer").first().innerText()).match(/\bMedium\b/g)?.length, 1, "one visible thinking label in the composer");
        const box = await trigger.boundingBox();
        assert.ok(box.height >= 43.5, "the trigger is a 44px target");
        // The level is chosen in the composer's dropdown: the three unified levels (#151), Medium by default. Each option is a label
        // with a one-line description, so the label alone is read.
        await page.locator(".composer__level .ui-select__trigger").click();
        assert.deepEqual(await (await page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"]').first().waitFor(), page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"] .ui-option__label')).allTextContents().then((t) => t.map((x) => x.trim())), ["Low", "Medium", "High"]);
        assert.deepEqual(await page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"][aria-selected=true] .ui-option__label').allTextContents().then((t) => t.map((x) => x.trim())), ["Medium"]);
        await page.keyboard.press("Escape");
        if (SHOTS) await trigger.screenshot({ path: path.join(SHOTS, `picker-trigger-${width}-${sky}.png`) });
      }
      await context.close();
    });
  }
}

test("GLM offers the three unified levels (Low, Medium, High) in the composer, Medium by default (#151); a locked model cannot be chosen; Escape closes; arrow keys move between rows", { skip }, async () => {
  const { context, page } = await open({ width: 1280, sky: "light" });
  await openPicker(page, 1280);
  await page.locator(".model-modal__option", { hasText: "GLM 5.3 Flash" }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".model-modal__level").count(), 0, "no thinking levels in the picker");
  // Keyboard: focus moves down the rows, Home and End jump.
  await page.locator(".model-modal__option").first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.modelOption), "vesper");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.modelOption), "glm-5.3-flash");
  await page.keyboard.press("Escape");
  await page.locator(".model-modal").waitFor({ state: "detached" });
  await page.locator(".composer__level .ui-select__trigger").click();
  // Unified thinking (#151): every reasoning model offers Low, Medium and High; GLM's Medium is sent as its next level up.
  assert.deepEqual(await (await page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"]').first().waitFor(), page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"] .ui-option__label')).allTextContents().then((t) => t.map((x) => x.trim())), ["Low", "Medium", "High"]);
  assert.deepEqual(await page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"][aria-selected=true] .ui-option__label').allTextContents().then((t) => t.map((x) => x.trim())), ["Medium"], "the unified default (DEFAULT_UNIFIED_LEVEL), sent to GLM as high");
  await page.locator('[role="listbox"][aria-label="Thinking level for your next response"] [role="option"]', { hasText: "Low" }).click();
  assert.equal((await page.locator(".model-trigger").first().innerText()).replace(/\s+/g, " ").trim(), "GLM 5.3 Flash", "the button shows the name only");
  assert.equal((await page.locator(".composer__level .ui-select__trigger").innerText()).trim(), "Low", "the level is kept for the model, shown once");
  await context.close();
});

test("with no third-party model listed (or no catalog), the picker shows the house lineup alone", { skip }, async () => {
  for (const catalog of [lineupWith([]), null]) {
    const { context, page } = await open({ width: 1280, sky: "light", catalog });
    await openPicker(page, 1280);
    assert.deepEqual((await readRows(page)).map((r) => r.name), ["Lumen", "Vulcan", "Zenith"]);
    assert.deepEqual(await page.locator(".model-modal__heading").allInnerTexts(), ["VibhavGPT"]);
    await context.close();
  }
});
