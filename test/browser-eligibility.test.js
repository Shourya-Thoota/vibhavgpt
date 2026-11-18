// The eligibility screen (components/EligibilityGate.jsx; legal audit, 2026-11-16) in a real browser against the built app: an account
// that has not answered is asked its month and year of birth and to accept the Terms and Privacy Policy, by keyboard as well as pointer;
// under 16 it is blocked with sign-out and deletion; an account that has answered sees the workspace. At 1280 and 375px. The sign-up
// form no longer hints at the cutoff. Needs `npm run build` in frontend/ first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
let browser; let server; let base;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  server = serve({ signedIn: true, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(width, initial) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const state = { agreements: initial, posts: [] };
  await page.route("**/api/me/agreements", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData());
      state.posts.push(body);
      const under = body.birthYear > 2010;
      state.agreements = under ? { ...state.agreements, blocked: true, required: false } : { ...state.agreements, required: false, ageChecked: true, accepted: true };
      return route.fulfill({ status: under ? 403 : 200, contentType: "application/json", body: JSON.stringify(under ? { error: "VibhavGPT is only for people 16 and older.", code: "age_blocked", agreements: state.agreements } : { agreements: state.agreements }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agreements: state.agreements }) });
  });
  await page.goto(`${base}/app`, { waitUntil: "networkidle" });
  return { context, page, state };
}
const ASK = { required: true, blocked: false, ageChecked: false, accepted: false, termsVersion: "2026-11-16", privacyVersion: "2026-11-16", minimumAge: 16 };

for (const width of [1280, 375]) {
  test(`${width}px: a new account answers by keyboard, accepts, and reaches the workspace; the answer is sent, not the cutoff`, { skip }, async () => {
    const { context, page, state } = await open(width, ASK);
    const dialog = page.getByRole("dialog", { name: "Before you continue" });
    await dialog.waitFor();
    const question = [await dialog.getByRole("heading").innerText(), await dialog.locator("legend").innerText(), await dialog.locator(".eligibility__hint").innerText()].join(" ");
    assert.doesNotMatch(question, /16|sixteen|at least/i, "the question does not name the cutoff");
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("alert").filter({ hasText: "Choose the month and year you were born." }).waitFor();
    await dialog.getByRole("combobox", { name: "Month" }).focus();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    await dialog.getByRole("combobox", { name: "Month" }).selectOption("3");
    await dialog.getByRole("combobox", { name: "Year" }).selectOption("1995");
    await dialog.getByRole("checkbox", { name: /I agree to the Terms of Service and Privacy Policy/ }).check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(state.posts.at(-1), { birthMonth: 3, birthYear: 1995, acceptTerms: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "nothing overflows");
    await context.close();
  });
}

test("under 16: the account is blocked, with sign out and a way to delete it", { skip }, async () => {
  const { context, page } = await open(1280, ASK);
  const dialog = page.getByRole("dialog", { name: "Before you continue" });
  await dialog.getByRole("combobox", { name: "Month" }).selectOption("6");
  await dialog.getByRole("combobox", { name: "Year" }).selectOption("2013");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "VibhavGPT is for people 16 and older" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Sign out" }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Delete this account" }).getAttribute("href"), "/account-deletion");
  assert.equal(await page.locator("textarea").count(), 0, "no workspace behind it");
  await context.close();
});

test("an account that has answered sees the workspace; one asked only to accept new Terms is not asked its age again", { skip }, async () => {
  const done = await open(1280, { ...ASK, required: false, ageChecked: true, accepted: true });
  await done.page.locator("textarea").first().waitFor();
  assert.equal(await done.page.getByRole("dialog", { name: "Before you continue" }).count(), 0);
  await done.context.close();
  const again = await open(1280, { ...ASK, required: true, ageChecked: true, accepted: false });
  const dialog = again.page.getByRole("dialog", { name: "Before you continue" });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("combobox").count(), 0, "no age question the second time");
  await again.context.close();
});

test("the sign-up form no longer hints at the age cutoff; it says what comes next", { skip }, async () => {
  const source = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");
  assert.doesNotMatch(source, /I confirm I am at least 16 years old/);
  assert.match(source, /After you create your account, we’ll ask your month and year of birth/);
});
