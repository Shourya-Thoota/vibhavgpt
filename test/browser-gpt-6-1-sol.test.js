// GPT-6 Sol was replaced by GPT-6.1 Sol (2026-11-15) and now opens as GPT-6.2 Sol (2026-11-17), in a real browser against the built app. A Max account opens a conversation
// last used with GPT-6 Sol, with "none" remembered as its thinking level: the chat moves to GPT-6.2 Sol and says so, the level becomes Low
// (OpenAI's migration guidance; GPT-6.2 Sol has no "none"), the old reply keeps the name GPT-6 Sol, and the next message names GPT-6.2 Sol
// and Low. Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";
import { HOUSE_MODELS, THIRD_PARTY_MODELS, providerName } from "../frontend/src/model-marketplace.js";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const LINEUP = {
  models: [], groups: [], userPlan: "max",
  lineup: {
    house: HOUSE_MODELS.map((m) => ({ id: m.id, name: m.name, house: true })),
    providers: ["glm", "gpt-6"].map((provider) => ({ id: provider, name: providerName(provider), models: THIRD_PARTY_MODELS.filter((m) => m.provider === provider).map((m) => ({ id: m.id, name: m.name })) })),
  },
};

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

for (const width of [1280, 375]) {
  test(`${width}px: a GPT-6 Sol conversation opens on GPT-6.2 Sol with a notice, Low for a remembered none, and the old reply keeps its name`, { skip }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(() => { localStorage.setItem("vibhavgpt-marketplace-thinking", JSON.stringify({ "gpt-6-sol": "none" })); });
    const page = await context.newPage();
    const sent = [];
    await page.route("**/api/models/catalog", (route) => route.fulfill({ json: LINEUP }));
    await page.route("**/api/billing/subscription", (route) => route.fulfill({ json: { subscription: { tier: "max", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true } }));
    await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "max" } }); });
    await page.route((url) => url.pathname === `/api/chat/conversations/${CONVERSATION_ID}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      route.fulfill({ response, json: { ...body, conversation: { ...body.conversation, model: "gpt-6-sol" }, history: [
        { id: "u1", role: "user", content: "Plan my week", createdAt: "2026-11-14T10:00:00.000Z" },
        { id: "a1", role: "assistant", content: "Here is a plan for your week.", model: "gpt-6-sol", createdAt: "2026-11-14T10:00:05.000Z" },
      ], hasMore: false, nextCursor: null } });
    });
    await page.route("**/api/chat/stream", (route) => { sent.push(route.request().postDataJSON()); route.fulfill({ status: 503, json: { error: "Stubbed: nothing is sent to a model." } }); });
    await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });

    await page.getByText("GPT-6 Sol is now GPT-6.2 Sol.").waitFor({ timeout: 15000 });
    assert.match(await page.locator(".ui-banner", { hasText: "GPT-6 Sol is now GPT-6.2 Sol." }).innerText(), /Your next message uses GPT-6\.2 Sol\. Earlier replies keep the name of the model that wrote them\./);
    assert.match(await page.locator(".turn__byline").last().innerText(), /^GPT-6 Sol$/, "the old reply keeps the name of the model that wrote it");
    if (width >= 500) {
      assert.match(await page.locator(".model-trigger").first().innerText(), /^GPT-6\.2 Sol$/, "the selection moved to the replacement; no effort on the button");
      assert.match(await page.locator(".composer__level").first().innerText(), /Low/, "a remembered none becomes Low");
    }
    const box = page.locator("textarea").first();
    await box.fill("Next step?");
    await box.press("Enter");
    for (let i = 0; i < 50 && !sent.length; i += 1) await page.waitForTimeout(100);
    assert.equal(sent[0]?.model, "gpt-6.2-sol", "the next message is sent to GPT-6.2 Sol");
    assert.equal(sent[0]?.thinkingLevel, "low", "with Low, never the unsupported none");
    await context.close();
  });
}
