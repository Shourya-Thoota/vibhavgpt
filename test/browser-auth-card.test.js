import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The sign-in page: one centred card on a still backdrop, in the order the page was designed in, with every way in kept
// (email and password, Google, an email code, passkeys, two-step codes, forgot password, create account) and the four promises
// about the account kept word for word. Served from frontend/dist with the design fixtures; the bot check shows its real
// "not configured" error state there, because the fixture has no Turnstile key.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const PROMISES = ["No ads.", "We don't sell your data.", "We don't train AI models on your chats.", "Export your data or delete your account from Settings."];

for (const [engine, launch] of ENGINES) describe(`The sign-in card in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function open({ route = "/app", width = 1366, height = 768, theme = "light", reducedMotion = "no-preference" } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    page.on("console", (message) => { if (message.type() === "error" && !/401|403|404|Failed to load resource|interactive-widget|turnstile|Turnstile/i.test(message.text())) problems.push(`console: ${message.text().slice(0, 140)}`); });
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.locator(".auth__card").waitFor();
    await page.waitForTimeout(700);
    return { context, page, problems };
  }

  test("one centred card, no side panel, with the parts in order: logo, heading, line, Google, OR, the toggle, the fields, the button", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open();
    assert.equal(await page.locator(".auth__sky, .auth__horizon, .auth__quote").count(), 0, "no grey side panel and no sky");
    const m = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width }; };
      return { card: r(".auth__card"), logo: r(".auth__logo"), h1: r(".auth__title"), line: r(".auth__subtitle"), google: r(".auth__google"), divider: r(".auth__divider"), method: r(".auth__method"), email: r("#auth-email"), password: r("#auth-password"), submit: r(".auth__submit"), vw: innerWidth,
        heading: document.querySelector(".auth__title").textContent.trim(), subtitle: document.querySelector(".auth__subtitle").textContent.trim(), dividerText: document.querySelector(".auth__divider").textContent.trim(), h1s: document.querySelectorAll("h1").length,
        toggle: [...document.querySelectorAll(".auth__method [role=radio]")].map((e) => e.textContent.trim()), forgot: r(".auth__forgot"), passwordLabel: r('label[for="auth-password"]'), submitText: document.querySelector(".auth__submit").textContent.trim(), submitArrow: !!document.querySelector(".auth__submit svg") };
    });
    assert.ok(Math.abs((m.card.left + m.card.right) / 2 - m.vw / 2) <= 2, "the card is centred");
    assert.ok(m.card.w <= 420 && m.card.w >= 300, `a single narrow card (${Math.round(m.card.w)}px)`);
    assert.equal(m.heading, "Welcome back"); assert.equal(m.h1s, 1);
    assert.ok(m.subtitle.length > 10 && m.subtitle.length < 80, "one short line");
    assert.equal(m.dividerText.toLowerCase(), "or");
    assert.deepEqual(m.toggle, ["Password", "Email code"]);
    const order = [m.logo, m.h1, m.line, m.google, m.divider, m.method, m.email, m.password, m.submit].map((x) => x.top);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "logo, heading, line, Google, OR, toggle, email, password, button, top to bottom");
    assert.ok(m.forgot.left > m.passwordLabel.right && Math.abs(m.forgot.top - m.passwordLabel.top) < 8 && m.forgot.right <= m.card.right, "Forgot password? is beside the Password label, on its right");
    assert.match(m.submitText, /^Sign in$/); assert.equal(m.submitArrow, true, "with a small arrow");
    assert.ok(m.logo.top >= m.card.top && m.submit.bottom <= m.card.bottom, "the logo and the button are in the card");
    assert.equal(await page.locator(".auth canvas").count(), 0, "no canvas");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("the whole card fits a 1366 by 768 screen without scrolling to reach the primary button, in both themes", async (t) => {
    if (skip(t)) return;
    for (const [route, label] of [["/app", "sign in"], ["/signup", "create account"]]) for (const theme of ["light", "dark"]) {
      const { context, page } = await open({ route, theme });
      const m = await page.evaluate(() => ({ bottom: document.querySelector(".auth__submit").getBoundingClientRect().bottom, h: innerHeight }));
      assert.ok(m.bottom <= m.h - 8, `${label}, ${theme}: the primary button ends at ${Math.round(m.bottom)}px of ${m.h}`);
      await context.close();
    }
  });

  test("the backdrop is still: blurred areas of the selected accent and a few dots, with no animation", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const { context, page } = await open({ theme });
      const read = () => page.evaluate(() => ({ blobs: [...document.querySelectorAll(".auth__blob")].map((e) => { const s = getComputedStyle(e); return { filter: s.filter, anim: s.animationName, bg: s.backgroundColor }; }), dots: getComputedStyle(document.querySelector(".auth__dots")).backgroundImage, hidden: document.querySelector(".auth__backdrop").getAttribute("aria-hidden") }));
      const channels = (value) => value.match(/[\d.]+/g).map(Number);
      await page.evaluate(() => document.documentElement.setAttribute("data-accent", "cerulean"));
      const blue = await read();
      assert.equal(blue.blobs.length, 3);
      for (const blob of blue.blobs) { assert.match(blob.filter, /blur\(/, `${theme}: blurred`); assert.equal(blob.anim, "none", `${theme}: not animated`); }
      await page.evaluate(() => document.documentElement.setAttribute("data-accent", "ember"));
      const copper = await read();
      // The blobs are the accent: cerulean leans to blue, copper leans to red, and they are not the same colour.
      const [br, , bb] = channels(blue.blobs[0].bg); const [cr, , cb] = channels(copper.blobs[0].bg);
      assert.ok(bb > br, `${theme}: cerulean leans blue (${blue.blobs[0].bg})`);
      assert.ok(cr > cb, `${theme}: ember leans red (${copper.blobs[0].bg})`);
      assert.notEqual(blue.blobs[0].bg, copper.blobs[0].bg, `${theme}: the backdrop follows the accent`);
      const m = copper;
      assert.ok((m.dots.match(/radial-gradient/g) ?? []).length >= 5, "a few small dots");
      assert.equal(m.hidden, "true", "decoration is hidden from assistive technology");
      await context.close();
    }
  });

  test("Password / Email code: the toggle swaps the fields, the code is requested from the page's own email field, and the code step follows", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open();
    assert.equal(await page.locator("#auth-password").count(), 1);
    await page.getByRole("radio", { name: "Email code" }).click();
    assert.equal(await page.locator("#auth-password").count(), 0, "no password field in Email code mode");
    assert.equal(await page.locator(".auth .turnstile").count(), 0, "and no bot check: asking for a code needs none");
    assert.equal(await page.locator(".auth__submit").textContent(), "Email me a code");
    assert.equal(await page.locator(".auth__submit").isDisabled(), true, "disabled until there is an email address");
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.locator("#auth-email").fill("Ada@Example.com");
    const request = page.waitForRequest((r) => /send-verification-otp/.test(r.url()));
    await page.locator(".auth__submit").click();
    const sent = JSON.parse((await request).postData());
    assert.deepEqual(sent, { email: "ada@example.com", type: "sign-in" }, "the request is the same one the old dialog sent");
    await page.locator("#auth-title", { hasText: "Your code is on the way." }).waitFor();
    const code = await page.evaluate(() => { const i = document.querySelector(".auth input.input--code"); return { autocomplete: i.getAttribute("autocomplete"), mode: i.getAttribute("inputmode"), size: parseFloat(getComputedStyle(i).fontSize) }; });
    assert.equal(code.autocomplete, "one-time-code"); assert.equal(code.mode, "numeric");
    assert.equal(await page.locator(".auth__back").textContent(), "Use a different method");
    await page.locator(".auth__back").click();
    await page.locator("#auth-email").waitFor();
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("Create account is one line under the card, and Sign in comes back; forgot password still opens its dialog", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open();
    const link = page.locator(".auth__switchline .auth__switchlink");
    assert.equal(await link.textContent(), "Create account");
    assert.ok((await link.boundingBox()).y > (await page.locator(".auth__card").boundingBox()).y + (await page.locator(".auth__card").boundingBox()).height - 2, "under the card");
    assert.ok((await link.boundingBox()).height >= 36, "a real target");
    await link.click();
    await page.locator("#auth-title", { hasText: "Create your account" }).waitFor();
    assert.equal(await page.locator("#auth-name").getAttribute("autocomplete"), "name");
    assert.equal(await page.locator("#auth-password").getAttribute("autocomplete"), "new-password");
    // The age question moved to the eligibility screen after sign-up (#145): a neutral month-and-year question for every way of signing
    // up. The form no longer has a box that names the cutoff, and says what comes next.
    assert.equal(await page.locator('.auth input[type="checkbox"]').count(), 0, "no age box that names the cutoff");
    assert.match(await page.locator(".auth__consent").innerText(), /month and year of birth[\s\S]*Terms of Service[\s\S]*Privacy Policy/);
    assert.equal(await page.locator(".auth__forgot").count(), 0, "no Forgot password? when creating an account");
    assert.equal(await page.locator(".auth__method").count(), 0, "and no toggle");
    assert.equal(await page.locator(".auth__submit").textContent(), "Create account");
    await page.locator(".auth__switchline .auth__switchlink").click();
    await page.locator("#auth-title", { hasText: "Welcome back" }).waitFor();
    await page.locator(".auth__forgot").click();
    await page.getByRole("dialog").getByText("Reset your password").waitFor();
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("labels, autocomplete, focus and the error state", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open();
    assert.equal(await page.getByLabel("Email", { exact: true }).getAttribute("autocomplete"), "username webauthn", "a password manager finds the username");
    assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("autocomplete"), "current-password webauthn");
    assert.equal(await page.getByLabel("Email", { exact: true }).getAttribute("type"), "email");
    assert.equal(await page.getByRole("button", { name: "Show password" }).count(), 1, "the eye button is named");
    // A visible focus state on the field, the button and the link, reached by keyboard.
    for (const selector of ["#auth-email", ".auth__submit", ".auth__switchlink"]) {
      await page.locator(selector).focus();
      await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1.5, shadow: s.boxShadow !== "none", border: s.borderColor }; });
      assert.ok(ring.outline || ring.shadow, `${selector} shows where focus is`);
    }
    // The error state: the bot check's own error is announced and can be retried.
    const alert = page.locator(".auth__captcha-error");
    await alert.waitFor();
    assert.equal(await alert.getAttribute("role"), "alert");
    assert.match(await alert.textContent(), /Bot protection|bot check/i);
    assert.equal(await alert.getByRole("button", { name: "Try the bot check again" }).isEnabled(), true);
    await context.close();
  });

  test("the content below the sign-in card is simplified: promises and standalone footer removed, switchline positioned neatly", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open({ width: 1920, height: 1080 });
    // Promises and "How we treat your account" are removed
    assert.equal(await page.locator(".auth__facts").count(), 0, "How we treat your account section removed");
    assert.equal(await page.locator(".auth__legal").count(), 0, "Standalone Terms / Privacy footer removed");
    // Switchline is present and positioned neatly under the card
    const switchline = page.locator(".auth__switchline");
    assert.equal(await switchline.count(), 1, "switchline is present");
    assert.match(await switchline.textContent(), /New to VibhavGPT\?\s*Create account/);
    const card = await page.locator(".auth__card").boundingBox();
    const switchBox = await switchline.boundingBox();
    assert.ok(switchBox.y >= card.y + card.height, "switchline sits under the card");
    assert.ok(switchBox.y <= card.y + card.height + 40, "switchline sits neatly near the card");
    // No other sign-in provider is offered
    const text = await page.locator(".auth").innerText();
    assert.doesNotMatch(text, /GitHub|Apple|Microsoft|Facebook|Twitter|Discord/i, "only the sign-in methods that exist");
    assert.equal(await page.getByRole("button", { name: /Continue with Google/ }).count(), 1);
    // Navigation check: clicking Create account switches to signup
    await page.locator(".auth__switchlink").click();
    assert.match(await page.locator(".auth__switchline").textContent(), /Already have an account\?\s*Sign in/);
    // And switching back
    await page.locator(".auth__switchlink").click();
    assert.match(await page.locator(".auth__switchline").textContent(), /New to VibhavGPT\?\s*Create account/);
    await context.close();
  });

  test("a phone: one column, every input at least 16px, the button on screen, and the same in dark", async (t) => {
    if (skip(t)) return;
    for (const theme of ["light", "dark"]) {
      const { context, page } = await open({ width: 390, height: 844, theme });
      const m = await page.evaluate(() => ({ inputs: [...document.querySelectorAll(".auth .input")].map((i) => parseFloat(getComputedStyle(i).fontSize)), overflow: document.documentElement.scrollWidth - innerWidth, submit: document.querySelector(".auth__submit").getBoundingClientRect(), card: document.querySelector(".auth__card").getBoundingClientRect(), h: innerHeight, targets: [...document.querySelectorAll(".auth .btn, .auth__switchlink")].map((e) => e.getBoundingClientRect().height) }));
      assert.ok(m.inputs.length >= 2 && m.inputs.every((s) => s >= 16), `${theme}: inputs are ${m.inputs.join(", ")}px`);
      assert.equal(m.overflow, 0, `${theme}: no sideways scroll`);
      assert.ok(m.card.left >= 8 && m.card.right <= 390 - 8, `${theme}: the card fits`);
      assert.ok(m.submit.bottom <= m.h, `${theme}: the button is on screen`);
      assert.ok(m.targets.every((h) => h >= 40), `${theme}: every button is a touch target`);
      await context.close();
    }
  });

  test("reduced motion: the card appears without moving, and the page still works", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open({ reducedMotion: "reduce" });
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".auth__card")).animationName);
    assert.equal(anim, "auth-fade", "a fade, not a rise");
    await page.getByRole("radio", { name: "Email code" }).click();
    assert.equal(await page.locator("#auth-password").count(), 0);
    assert.deepEqual(problems, []);
    await context.close();
  });
});
