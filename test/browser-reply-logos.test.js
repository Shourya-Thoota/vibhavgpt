// The mark beside the model name above each assistant reply is the maker's: OpenAI's for GPT-6 replies, Z.AI's for GLM replies, and
// VibhavGPT's for the house tiers (Lumen, Nova, Nebula, Vulcan, Zenith) and Study. The makers' marks are the official files, bundled
// locally (frontend/public/brand/providers), and drawn in white in the dark sky. Real browser against the built app.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
// One reply per model, in this order, each labelled by its own model.
const REPLIES = [
  ["gpt-6-luna", "GPT-6 Luna", "openai"], ["gpt-6.1-terra", "GPT-6.1 Terra", "openai"], ["gpt-6-sol", "GPT-6 Sol", "openai"], ["gpt-6.1-sol", "GPT-6.1 Sol", "openai"], ["gpt-6-astra", "GPT-6 Astra", "openai"],
  ["glm-5.3", "GLM 5.3", "zai"], ["glm-5.3-flash", "GLM 5.3 Flash", "zai"],
  ["lumen", "VibhavGPT Lumen", "vibhavgpt"], ["nova", "VibhavGPT Nova", "vibhavgpt"], ["nebula", "VibhavGPT Nebula", "vibhavgpt"], ["vesper", "VibhavGPT Vulcan", "vibhavgpt"], ["zenith", "VibhavGPT Zenith", "vibhavgpt"],
];
const SRC = { openai: "/brand/providers/openai.png", zai: "/brand/providers/zai.png", vibhavgpt: "/brand/vibhavgpt-icon-64.png" };

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function openWithReplies(sky) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: sky, reducedMotion: "reduce" });
  await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); }, sky);
  const page = await context.newPage();
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const history = body.history ?? [];
    const user = history.find((m) => m.role === "user");
    const assistant = history.find((m) => m.role === "assistant");
    const turns = REPLIES.flatMap(([model], i) => [
      { ...user, id: `u-${i}`, content: `Question ${i + 1}` },
      { ...assistant, id: `a-${i}`, content: `Answer ${i + 1}.`, model },
    ]);
    return route.fulfill({ json: { ...body, history: turns } });
  });
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { context, page };
}

const bylines = (page) => page.evaluate(() => [...document.querySelectorAll(".turn__byline")].map((b) => {
  const mark = b.querySelector(".turn__mark");
  const img = mark?.querySelector("img");
  return { label: b.textContent.trim(), brand: mark?.dataset.brand ?? null, src: img?.getAttribute("src") ?? null, loaded: Boolean(img?.complete && img.naturalWidth > 0), filter: img ? getComputedStyle(img).filter : null };
}));

for (const sky of ["light", "dark"]) {
  test(`${sky}: each reply's header shows its maker's mark: OpenAI for GPT-6, Z.AI for GLM, VibhavGPT for the house tiers`, { skip }, async () => {
    const { context, page } = await openWithReplies(sky);
    const rows = await bylines(page);
    assert.deepEqual(rows.map((r) => [r.label, r.brand]), REPLIES.map(([, label, brand]) => [label, brand]));
    for (const [i, [, label, brand]] of REPLIES.entries()) {
      assert.equal(rows[i].src, SRC[brand], `${label}: the ${brand} mark`);
      assert.ok(rows[i].loaded, `${label}: the mark loaded`);
      // The makers' marks are black on transparent: drawn in white in the dark sky, as they are in the light sky otherwise.
      if (brand !== "vibhavgpt") assert.equal(rows[i].filter, sky === "dark" ? "invert(1)" : "none", `${label}: legible in the ${sky} sky`);
      else assert.equal(rows[i].filter, "none");
    }
    await context.close();
  });
}

test("Study replies keep the VibhavGPT mark, and the official marks are served locally (200)", { skip }, async () => {
  for (const file of ["openai.png", "zai.png"]) {
    const response = await fetch(`${base}/brand/providers/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${base}/app/study`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const marks = await page.evaluate(() => [...document.querySelectorAll(".turn__mark")].map((m) => m.dataset.brand));
  assert.ok(marks.every((brand) => brand === "vibhavgpt"), `Study: ${marks}`);
  await context.close();
});
