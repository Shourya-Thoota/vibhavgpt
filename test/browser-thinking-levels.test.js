// One thinking control (owner request, 2026-11-16), in a real browser against the built app: whichever reasoning-capable model is chosen
// (a house model, GPT-6, Gemini 4, GLM), the composer's control offers exactly Low, Medium and High, and the choice is what is sent.
// The server maps it to each model's own level (test/thinking-levels.test.js). Nothing reaches a model: the stream is stubbed.
// Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
const lineup = (plan) => ({ models: [], groups: [], userPlan: plan, lineup: { house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })), providers: ["glm", "gpt-6", "gemini-4"].map((p) => ({ id: p, name: providerName(p), models: THIRD_PARTY_MODELS.filter((m) => m.provider === p).map((m) => ({ id: m.id, name: m.name })) })) } });

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(model, plan) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const sent = [];
  await page.route("**/api/models/catalog", (route) => route.fulfill({ json: lineup(plan) }));
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: { subscription: { tier: plan, status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true } }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: plan } }); });
  await page.route("**/api/profile/preferences", async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: JSON.parse(route.request().postData() || "{}") });
    return route.fulfill({ json: { responseStyle: "balanced", customInstructions: "", thinkingEffort: "xhigh", lastUsedModel: model, preferredModel: null } });
  });
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { conversation: { id: CONVERSATION_ID } } });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ json: { ...body, conversation: { ...body.conversation, model } } });
  });
  await page.route("**/api/chat/stream", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    sent.push(payload);
    const events = [["complete", { reply: "Done.", modelKey: payload.model, messageId: "m-reply", userMessageId: "m-user", conversationId: CONVERSATION_ID, sources: [], activitySummary: [] }]]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: events });
  });
  await context.addInitScript(() => { localStorage.setItem("vibhavgpt-marketplace-thinking", JSON.stringify({ "gpt-6.2-sol": "max", "gemini-4-hydrogen": "xhigh" })); });
  await page.goto(`${base}${CHAT}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  return { context, page, sent };
}

async function options(page) {
  const control = page.locator(".composer__level").first();
  await control.locator("button").first().click();
  const list = page.getByRole("listbox", { name: "Thinking level for your next response" });
  await list.locator("[role=option]").first().waitFor();
  // Each option's label (its description is a separate line); read as text, so the list's opening animation does not matter.
  const labels = (await list.locator("[role=option] .ui-option__label").allTextContents()).map((t) => t.trim());
  return { list, labels };
}

for (const [model, plan, field] of [["vesper", "pro", "thinkingEffort"], ["gpt-6.2-sol", "max", "thinkingLevel"], ["gemini-4-hydrogen", "max", "thinkingLevel"], ["glm-5.3", "max", "thinkingLevel"]]) {
  test(`${model}: the control offers exactly Low, Medium and High, and the choice is sent as is`, { skip }, async () => {
    const { context, page, sent } = await open(model, plan);
    // An older stored level beyond High (Extra High, Max) shows as High.
    if (field === "thinkingLevel" && model !== "glm-5.3") assert.match(await page.locator(".composer__level").first().innerText(), /High/, "an older stored level (Max, Extra high) reads as High");
    const { list, labels } = await options(page);
    assert.deepEqual(labels, ["Low", "Medium", "High"], `${model}: the three levels only`);
    await list.locator("[role=option]", { hasText: "High" }).first().click();
    await page.waitForTimeout(200);
    await page.locator(".composer__input").first().fill("Think about this.");
    await page.locator('button[aria-label="Send message"]').first().click();
    for (let i = 0; i < 50 && !sent.length; i += 1) await page.waitForTimeout(100);
    assert.equal(sent[0]?.model, model);
    assert.equal(sent[0]?.[field], "high", `${model}: High is sent as high; the server maps it to the model's highest level`);
    await context.close();
  });
}

test("a house model's older stored Extra High reads as High in the one control", { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/api/profile/preferences", (route) => route.fulfill({ json: { responseStyle: "balanced", customInstructions: "", thinkingEffort: "xhigh", lastUsedModel: "vesper", preferredModel: null } }));
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: { subscription: { tier: "pro", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true } }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "pro" } }); });
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => { const response = await route.fetch(); const body = await response.json(); return route.fulfill({ json: { ...body, conversation: { ...body.conversation, model: "vesper" } } }); });
  await page.goto(`${base}${CHAT}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  assert.match(await page.locator(".model-trigger").first().innerText(), /Vulcan/);
  assert.equal((await page.locator(".composer__level").first().innerText()).trim(), "High");
  await context.close();
});
