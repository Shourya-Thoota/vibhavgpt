// Shortcuts in a real browser against the built app (2026-11-17): the keyboard handler and its help dialog at desktop and phone
// widths, and the three launch addresses (the manifest's, the jump list's and Android's) signed in and signed out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "../scripts/design-capture.mjs";

const skip = fs.existsSync(path.resolve("frontend/dist/index.html")) ? false : "frontend/dist is not built";
const LAUNCH = [["/app/chat", "chat"], ["/app/image", "image"], ["/app/build", "build"]];

let browser;
const servers = {};
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  for (const signedIn of [true, false]) {
    const server = serve({ signedIn, emptyLibrary: false, images: false, onboarding: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers[signedIn ? "in" : "out"] = { server, base: `http://127.0.0.1:${server.address().port}` };
  }
});
test.after(async () => { await browser?.close(); for (const { server } of Object.values(servers)) server.close(); });

async function open(width, url, signedIn = true) {
  const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await page.goto(`${servers[signedIn ? "in" : "out"].base}${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  return { context, page };
}
// Keys go to the page itself, not a field: the shortcuts wait while the person types.
const leaveFields = (page) => page.evaluate(() => document.activeElement?.blur?.());
const pathname = (page) => page.evaluate(() => location.pathname + location.search);

test("1280px: Ctrl+/ lists the shortcuts and Esc closes it; Ctrl+K, Ctrl+B, Ctrl+, and Ctrl+N each do their job", { skip }, async () => {
  const { context, page } = await open(1280, `/app/chat?conversation=${CONVERSATION_ID}`);
  await leaveFields(page);
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await dialog.waitFor();
  assert.deepEqual(await dialog.locator(".shortcuts-list__row dt").allTextContents(), ["New chat", "Search chats", "Show or hide the sidebar", "Open Settings", "Keyboard shortcuts", "Close the dialog or picker on top"]);
  assert.deepEqual(await dialog.locator('.shortcuts-list__row[data-action="settings"] kbd').allTextContents(), ["Ctrl", ","]);
  // Another shortcut does nothing behind the open dialog.
  await page.keyboard.press("Control+b");
  assert.equal(await page.locator(".workspace").getAttribute("data-collapsed"), "false");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  await page.keyboard.press("Control+k");
  await page.locator(".chat-search").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".chat-search").waitFor({ state: "detached" });

  await leaveFields(page);
  await page.keyboard.press("Control+b");
  assert.equal(await page.locator(".workspace").getAttribute("data-collapsed"), "true", "the sidebar folds to its rail");
  await page.keyboard.press("Control+b");
  assert.equal(await page.locator(".workspace").getAttribute("data-collapsed"), "false");

  await page.keyboard.press("Control+,");
  await page.waitForFunction(() => location.pathname.startsWith("/app/settings/"));
  assert.match(await pathname(page), /^\/app\/settings\/profile$/);

  await page.goBack();
  await page.waitForFunction(() => location.search.includes("conversation="));
  await leaveFields(page);
  await page.keyboard.press("Control+n");
  await page.waitForFunction(() => location.pathname === "/app/chat" && !location.search);
  assert.equal(await pathname(page), "/app/chat", "a new chat, with no conversation open");
  await context.close();
});

test("1280px: while typing in the composer the shortcuts wait (Ctrl+K still opens search)", { skip }, async () => {
  const { context, page } = await open(1280, `/app/chat?conversation=${CONVERSATION_ID}`);
  const composer = page.locator(".composer textarea").first();
  await composer.click();
  await composer.fill("draft");
  for (const combo of ["Control+n", "Control+b", "Control+,", "Control+/"]) await page.keyboard.press(combo);
  assert.equal(await pathname(page), `/app/chat?conversation=${CONVERSATION_ID}`);
  assert.equal(await page.locator(".workspace").getAttribute("data-collapsed"), "false");
  assert.equal(await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count(), 0);
  assert.equal(await composer.inputValue(), "draft", "the text is untouched");
  await page.keyboard.press("Control+k");
  await page.locator(".chat-search").waitFor();
  await context.close();
});

test("375px: Ctrl+B opens and closes the navigation drawer, and the shortcuts dialog fits the screen", { skip }, async () => {
  const { context, page } = await open(375, `/app/chat?conversation=${CONVERSATION_ID}`);
  await leaveFields(page);
  const scrim = page.locator(".scrim-mobile");
  assert.equal(await scrim.getAttribute("data-open"), null);
  await page.keyboard.press("Control+b");
  await page.waitForFunction(() => document.querySelector(".scrim-mobile")?.dataset.open === "true");
  await page.keyboard.press("Control+b");
  await page.waitForFunction(() => !document.querySelector(".scrim-mobile")?.dataset.open);
  await leaveFields(page);
  await page.keyboard.press("Control+/");
  const box = await page.getByRole("dialog", { name: "Keyboard shortcuts" }).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375.5, `inside the screen (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor({ state: "detached" });
  await context.close();
});

for (const width of [1280, 375]) {
  test(`${width}px: each launch address opens its workspace signed in, and the sign-in screen (keeping the address) signed out`, { skip }, async () => {
    for (const [address, mode] of LAUNCH) {
      const signedIn = await open(width, address, true);
      assert.equal(await signedIn.page.locator(".workspace__main").getAttribute("data-product-mode"), mode, `${address} signed in`);
      assert.equal(await pathname(signedIn.page), address, "a fresh session: no conversation open");
      await signedIn.context.close();
      const signedOut = await open(width, address, false);
      await signedOut.page.locator(".auth").waitFor();
      assert.equal(await signedOut.page.locator(".workspace__main").count(), 0, `${address} signed out shows no workspace`);
      assert.equal(await pathname(signedOut.page), address, "the address is kept for after sign-in");
      await signedOut.context.close();
    }
  });
}

test("the served manifest carries the three shortcuts, and their icons load", { skip }, async () => {
  const { base } = servers.in;
  const manifest = await (await fetch(`${base}/brand/manifest.webmanifest`)).json();
  assert.deepEqual(manifest.shortcuts.map((s) => s.url), LAUNCH.map(([address]) => address));
  for (const shortcut of manifest.shortcuts) {
    const response = await fetch(`${base}${shortcut.icons[0].src}`);
    assert.equal(response.status, 200, shortcut.icons[0].src);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
  }
});
