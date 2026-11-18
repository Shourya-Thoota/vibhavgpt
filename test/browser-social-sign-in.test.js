// Slice 8 in a real browser against the built app: the sign-in page shows one button per provider the server reports as set up, in the
// order Google, GitHub, Microsoft, Discord, as 44px targets in both skies; none (and no "or" divider) when none are set up; and a
// failed social sign-in comes back in words that name the provider. Emulated Chromium, not a real device.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const state = { signedIn: false, socialProviders: ["google"] };
let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open({ width = 1280, sky = "light", providers, query = "" }) {
  state.socialProviders = providers;
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: sky, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((s) => { localStorage.setItem("vibhavgpt-theme", s); localStorage.setItem("vibhavgpt-theme-chosen", "1"); }, sky);
  const page = await context.newPage();
  await page.goto(`${base}/app${query}`, { waitUntil: "networkidle" });
  await page.locator(".auth__card").waitFor();
  return { context, page };
}
const buttons = (page) => page.locator(".auth__social .auth__provider").evaluateAll((els) => els.map((el) => ({ id: el.dataset.provider, text: el.textContent.trim(), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width, svg: Boolean(el.querySelector("svg")) })));

test("one button per configured provider, in order, 44px, with its mark, in both skies at 375 and 1280px", { skip }, async () => {
  for (const sky of ["light", "dark"]) for (const width of [1280, 375]) {
    const { context, page } = await open({ width, sky, providers: ["discord", "google", "microsoft", "github"] });
    const shown = await buttons(page);
    assert.deepEqual(shown.map((b) => b.id), ["google", "github", "microsoft", "discord"], `${sky} ${width}: the page's order, whatever order the server lists`);
    assert.deepEqual(shown.map((b) => b.text), ["Continue with Google", "Continue with GitHub", "Continue with Microsoft", "Continue with Discord"]);
    for (const b of shown) {
      assert.ok(b.h >= 43.5, `${sky} ${width} ${b.id}: a 44px target (${b.h})`);
      assert.ok(b.svg, `${b.id}: has its mark`);
    }
    assert.equal(new Set(shown.map((b) => Math.round(b.w))).size, 1, "all the same width");
    assert.equal(await page.locator(".auth__divider").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await context.close();
  }
});

test("only what the server reports: partial sets show only those, and none means no buttons and no divider", { skip }, async () => {
  for (const [providers, expected] of [[["github"], ["github"]], [["google", "discord"], ["google", "discord"]], [[], []], [["railway", "evil"], []]]) {
    const { context, page } = await open({ providers });
    assert.deepEqual((await buttons(page)).map((b) => b.id), expected, JSON.stringify(providers));
    assert.equal(await page.locator(".auth__divider").count(), expected.length ? 1 : 0);
    await context.close();
  }
});

test("pressing a provider starts that provider's sign-in, back to the workspace", { skip }, async () => {
  const { context, page } = await open({ providers: ["google", "github"] });
  let body = null;
  await page.route("**/api/auth/sign-in/social", async (route) => { body = route.request().postDataJSON(); await route.fulfill({ json: { url: `${base}/app?started=1` } }); });
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.waitForURL(/started=1/);
  assert.equal(body.provider, "github");
  assert.match(body.callbackURL, /\/app$/);
  assert.match(body.errorCallbackURL, /\/app$/);
  await context.close();
});

test("a social sign-in that comes back with an error says what happened, naming the provider that was used", { skip }, async () => {
  for (const [code, provider, words] of [
    ["email_not_verified", "github", /GitHub hasn't verified your email address/],
    ["account_not_linked", "microsoft", /account with this email already exists.*Microsoft hasn't confirmed/],
    ["access_denied", "discord", /Discord sign-in was cancelled/],
    ["something_else", "google", /Google sign-in didn't finish/],
  ]) {
    state.socialProviders = ["google", "github", "microsoft", "discord"];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript((p) => { sessionStorage.setItem("vibhavgpt-social-provider", p); }, provider);
    const page = await context.newPage();
    await page.goto(`${base}/app?error=${code}`, { waitUntil: "networkidle" });
    await page.locator(".auth__card").waitFor();
    assert.match(await page.locator(".auth__card").innerText(), words, code);
    assert.equal(new URL(page.url()).search, "", "the error is cleared from the address");
    await context.close();
  }
});
