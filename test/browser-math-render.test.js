// Math in a reply still renders with KaTeX now that KaTeX loads on demand (math-loader.js, 2026-11-17): a $…$ formula, a \[…\]
// formula and plain currency, in the built app against a reply the conversation API returns (page.route). As before this change,
// normalizeTexDelimiters turns \[…\] into an inline $…$, so both are inline KaTeX.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const REPLY = "Mass and energy are linked by $E = mc^2$, and the area under the curve is \\[\\int_0^1 x^2\\,dx = \\frac{1}{3}\\]\n\nThe book costs $5 and the pen $2.";

let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, emptyLibrary: false, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

test("a reply with math renders KaTeX for both delimiters, and plain dollar amounts stay text", { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const scripts = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await page.route(`**/api/chat/conversations/${CONVERSATION_ID}*`, (route) => route.fulfill({ json: {
    conversation: { id: CONVERSATION_ID, title: "Math", model: "lumen", mode: "chat", updatedAt: "2026-11-17T12:00:00.000Z" },
    history: [
      { id: "u1", role: "user", content: "Show me a formula.", createdAt: "2026-11-17T11:59:00.000Z" },
      { id: "a1", role: "assistant", model: "lumen", content: REPLY, createdAt: "2026-11-17T12:00:00.000Z" },
    ],
    hasMore: false, nextCursor: null,
  } }));
  await page.goto(`${base}/app/chat?conversation=${CONVERSATION_ID}`, { waitUntil: "networkidle" });
  const reply = page.locator(".prose").filter({ hasText: "Mass and energy" }).first();
  await reply.waitFor();
  await reply.locator(".katex").first().waitFor({ timeout: 10_000 });
  assert.equal(await reply.locator(".katex").count(), 2, "both formulas");
  const annotations = await reply.locator(".katex-mathml annotation").allTextContents();
  assert.match(annotations[0], /E = mc\^2/);
  assert.match(annotations[1], /\\int_0\^1 x\^2/);
  const text = await reply.innerText();
  assert.match(text, /costs \$5 and the pen \$2/, "currency is not parsed as math");
  // KaTeX's stylesheet came with it: the formula is laid out by KaTeX's own fonts.
  assert.match(await reply.locator(".katex").first().evaluate((el) => getComputedStyle(el).fontFamily), /KaTeX_Main/);
  assert.ok(scripts.some((p) => /\/assets\/math-render-.*\.js$/.test(p)), "the math chunk was loaded on demand");
  await context.close();
});
