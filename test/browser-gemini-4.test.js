// Gemini 4 in the model picker (owner request, 2026-11-16), in a real browser against the built app: a Max account sees a Google section
// with the three Gemini 4 models under their real names and Google's mark; choosing Carbon sends gemini-4-carbon at its default level,
// the composer's own level control offers exactly the levels Google documents for it, and the reply carries the Gemini mark. Nothing is
// sent to a model: the stream is stubbed. At 1280 and 375px. Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
const LINEUP = { models: [], groups: [], userPlan: "max", lineup: { house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })), providers: ["glm", "gpt-6", "gemini-4"].map((p) => ({ id: p, name: providerName(p), models: THIRD_PARTY_MODELS.filter((m) => m.provider === p).map((m) => ({ id: m.id, name: m.name })) })) } };

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const sent = [];
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: LINEUP }));
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: { subscription: { tier: "max", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true } }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "max" } }); });
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { conversation: { id: CONVERSATION_ID } } });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, conversation: { ...body.conversation, model: "lumen" } } });
  });
  await page.route("**/api/chat/stream", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    sent.push(payload);
    const events = [["complete", { reply: `An answer from ${payload.model}.`, modelKey: payload.model, messageId: "m-reply", userMessageId: "m-user", conversationId: CONVERSATION_ID, sources: [], activitySummary: [] }]]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: events });
  });
  await page.goto(`${base}${CHAT}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return { context, page, sent };
}

async function openPicker(page, width) {
  if (width < 500) {
    await page.locator('button[aria-label="Add to message"]').first().click();
    await page.locator(".add-sheet__row", { hasText: "Model" }).click();
  } else {
    await page.locator(".model-trigger").first().click();
  }
  await page.locator(".model-modal").waitFor();
  await page.waitForTimeout(200);
}

for (const width of [1280, 375]) {
  test(`${width}px: the Google section lists Gemini 4 by name; Carbon is sent at its default level with only Google's levels offered`, { skip }, async () => {
    const { context, page, sent } = await open(width);
    await openPicker(page, width);
    const modal = page.locator(".model-modal");
    for (const name of ["Gemini 4 Hydrogen", "Gemini 4 Argon", "Gemini 4 Carbon"]) assert.equal(await modal.locator(".model-modal__option", { hasText: name }).count(), 1, name);
    assert.ok(await modal.getByText("Google", { exact: true }).count() >= 1, "a Google section");
    const mark = modal.locator('img[src="/brand/providers/gemini.png"]').first();
    assert.equal(await mark.count(), 1, "Google's mark, from a local file");
    assert.equal(await mark.evaluate((img) => img.complete && img.naturalWidth > 0), true, "and it loads");
    await modal.locator(".model-modal__option", { hasText: "Gemini 4 Carbon" }).click();
    await page.locator(".model-modal__done").click();
    await page.locator(".model-modal").waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    if (width >= 500) {
      assert.match(await page.locator(".model-trigger").first().innerText(), /^Gemini 4 Carbon$/, "the button names only the model");
      const level = page.locator(".composer__level").first();
      assert.match(await level.innerText(), /Medium/, "Carbon's default level");
      await (await level.locator("button").count() ? level.locator("button").first() : level).click();
      const list = page.getByRole("listbox", { name: "Thinking level for your next response" });
      await list.locator("[role=option]").first().waitFor();
      const options = (await list.locator("[role=option] .ui-option__label").allTextContents()).map((t) => t.trim());
      assert.deepEqual(options, ["Low", "Medium", "High"], "exactly the levels Google documents for Carbon");
      await page.keyboard.press("Escape");
    }
    await page.locator(".composer__input").first().fill("Which moon is largest?");
    await page.locator('button[aria-label="Send message"]').first().click();
    await page.waitForFunction(() => document.body.innerText.includes("An answer from"), null, { timeout: 10_000 });
    assert.equal(sent[0]?.model, "gemini-4-carbon");
    assert.equal(sent[0]?.thinkingLevel, "medium");
    assert.equal(await page.locator(".turn__mark").last().getAttribute("data-brand"), "gemini", "the reply carries the Gemini mark");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "nothing overflows");
    await context.close();
  });
}

test("the Gemini mark keeps its own colours in the dark theme, while the single-colour marks are drawn in white", { skip }, async () => {
  const { context, page } = await open(1280);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await openPicker(page, 1280);
  const filterOf = (src) => page.locator(`.model-modal img[src="${src}"]`).first().evaluate((img) => getComputedStyle(img).filter);
  assert.equal(await filterOf("/brand/providers/gemini.png"), "none", "Gemini is not inverted");
  assert.equal(await page.locator('.model-modal img[src="/brand/providers/gemini.png"]').first().getAttribute("data-mono"), null);
  assert.match(await filterOf("/brand/providers/openai.png"), /invert/, "OpenAI's single-colour mark still is");
  await context.close();
});
