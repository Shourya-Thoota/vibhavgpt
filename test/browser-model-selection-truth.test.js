// Production bug (owner, 2026-11-13): a model was clicked, the picker's check stayed on Lumen, and the reply was labelled "VibhavGPT
// Vulcan". Three readings of "the model" disagreed:
//   - the picker: changeModel selected the new model, then moved the selection back when a background save failed, after the message
//     had already gone with the new model;
//   - the request: sent the new model;
//   - the reply: the server, finding the chosen tier unavailable, silently re-ran the turn on another tier, and the reply was truthfully
//     labelled with a model nobody chose.
// Now one source of truth: the model clicked is the model sent, the check stays on it, and the reply's label is the model that answered,
// which for a chosen model is always that model (only Auto may answer from another tier). The model here is GPT-6 Luna (the tier used
// before, Nova, was retired on 2026-11-14). Real browser against the built app; the picker is the centered dialog.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
const LINEUP = { models: [], groups: [], userPlan: "plus", lineup: { house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })), providers: ["glm", "gpt-6"].map((p) => ({ id: p, name: providerName(p), models: THIRD_PARTY_MODELS.filter((m) => m.provider === p).map((m) => ({ id: m.id, name: m.name })) })) } };
const LABEL = { "gpt-6-luna": "GPT-6 Luna", lumen: "VibhavGPT Lumen" };

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

// Opens the conversation on Lumen. `savesFail`: both background saves (the conversation's model and the default model) answer 500.
async function openOnLumen({ width = 1280, savesFail = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const sent = [];
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: LINEUP }));
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
    if (route.request().method() === "PATCH") return savesFail ? route.fulfill({ status: 500, json: { error: "down" } }) : route.fulfill({ json: { conversation: { id: CONVERSATION_ID } } });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, conversation: { ...body.conversation, model: "lumen" } } });
  });
  await page.route("**/api/profile/preferences", async (route) => {
    if (route.request().method() === "PATCH") return savesFail ? route.fulfill({ status: 500, json: { error: "down" } }) : route.fulfill({ json: {} });
    const response = await route.fetch();
    return route.fulfill({ json: { ...(await response.json()), preferredModel: null, lastUsedModel: "lumen" } });
  });
  // The chat stream answers as the server does now: the reply's modelKey is the model that answered, the one the request named.
  await page.route("**/api/chat/stream", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    sent.push(payload);
    const events = [
      ["status", { phase: "thinking" }],
      ["complete", { reply: `An answer from ${payload.model}.`, modelKey: payload.model, messageId: "m-reply", userMessageId: "m-user", conversationId: CONVERSATION_ID, sources: [], activitySummary: [] }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
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
async function checkedInPicker(page, width) {
  await openPicker(page, width);
  const checked = await page.locator(".model-modal__option[aria-checked=true] .model-row__name").allInnerTexts();
  await page.keyboard.press("Escape");
  await page.locator(".model-modal").waitFor({ state: "detached" });
  return checked;
}
async function chooseLuna(page, width) {
  await openPicker(page, width);
  await page.locator(".model-modal__option", { hasText: "GPT-6 Luna" }).click();
  await page.locator(".model-modal__done").click();
  await page.locator(".model-modal").waitFor({ state: "detached" });
  await page.waitForTimeout(300);
}
async function sendAndWait(page) {
  await page.locator(".composer__input").first().fill("Which moon is largest?");
  await page.locator('button[aria-label="Send message"]').first().click();
  await page.waitForFunction(() => document.body.innerText.includes("An answer from"), null, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

test("starting on Lumen, choosing GPT-6 Luna and sending: the request, the picker's check and the reply's label all agree", { skip }, async () => {
  const { context, page, sent } = await openOnLumen();
  assert.deepEqual(await checkedInPicker(page, 1280), ["Lumen"], "it starts on Lumen");
  await chooseLuna(page, 1280);
  await sendAndWait(page);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, "gpt-6-luna", "the request names the model clicked");
  assert.equal(sent[0].thinkingLevel, "medium", "and its thinking level as chosen when sent");
  assert.deepEqual(await checkedInPicker(page, 1280), ["GPT-6 Luna"], "the check is on GPT-6 Luna");
  // The thinking level is shown once, in the composer's own level control; the model button names only the model.
  assert.match(await page.locator(".model-trigger").first().innerText(), /^GPT-6 Luna$/);
  assert.match(await page.locator(".composer__level").first().innerText(), /Medium/, "the level as chosen, beside the composer");
  assert.equal((await page.locator(".turn__byline").last().innerText()).trim(), LABEL["gpt-6-luna"], "the reply is labelled with the model that answered");
  assert.equal(await page.locator(".turn__mark").last().getAttribute("data-brand"), "openai");
  await context.close();
});

test("the same when both background saves fail: the selection never moves back to Lumen after the message went", { skip }, async () => {
  const { context, page, sent } = await openOnLumen({ savesFail: true });
  await chooseLuna(page, 1280);
  // After both saves have failed: the selection is still GPT-6 Luna, and the failure is said (sending a message later clears the notice).
  assert.match(await page.locator("body").innerText(), /Your next message will use GPT-6 Luna\. We couldn't save it as your default model just now\./, "the failed save is said, not hidden");
  assert.deepEqual(await checkedInPicker(page, 1280), ["GPT-6 Luna"], "a failed save does not put the check back on Lumen");
  await sendAndWait(page);
  assert.equal(sent[0].model, "gpt-6-luna");
  assert.deepEqual(await checkedInPicker(page, 1280), ["GPT-6 Luna"]);
  assert.equal((await page.locator(".turn__byline").last().innerText()).trim(), LABEL["gpt-6-luna"]);
  await context.close();
});

test("on a phone (375px) too: the request, the check and the label agree", { skip }, async () => {
  const { context, page, sent } = await openOnLumen({ width: 375 });
  await chooseLuna(page, 375);
  await sendAndWait(page);
  assert.equal(sent[0].model, "gpt-6-luna");
  assert.equal((await page.locator(".turn__byline").last().innerText()).trim(), LABEL["gpt-6-luna"]);
  assert.deepEqual(await checkedInPicker(page, 375), ["GPT-6 Luna"]);
  await context.close();
});

test("the server: a chosen model is never answered by another tier; only Auto may move between tiers", async () => {
  const router = (await readFile(new URL("../src/chat/router.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(router, /if \(isAutoRequested && isInterceptableFallbackError\(err\) && !gateway && !NO_CROSS_TIER_FALLBACK\.has\(normalizeModelKey\(modelKey\)\) && !isThirdPartyModel\(modelKey\)\) \{/);
  assert.equal((router.match(/buildAlgorithmicFallbackPath\(/g) ?? []).length, 1, "the one cross-tier path is the guarded one");
});
