// The sidebar's "Your chats" heading (owner report, 2026-11-15: rows crowded or overlapped it while scrolling). In a real browser against
// the built app with a long history: only the list under the heading scrolls; at the top, middle and bottom of the list the heading stays
// where it is and no visible row reaches into it; a keyboard-focused row is scrolled fully into view below it. Needs `npm run build`.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url));
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath });
  server = serve({ signedIn: true, emptyLibrary: true, images: false, onboarding: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

const HISTORY = Array.from({ length: 60 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `Conversation number ${i + 1} about a long topic`,
  model: "lumen", mode: "chat", groupId: null, temporary: false,
  createdAt: new Date(Date.UTC(2026, 10, 14, 12, 0) - i * 3_600_000).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 10, 14, 12, 0) - i * 3_600_000).toISOString(),
}));

for (const [width, scheme] of [[1280, "dark"], [1280, "light"], [768, "dark"]]) {
  test(`${width}px ${scheme}: rows never pass under or through "Your chats", at the top, middle and bottom of a long list`, { skip }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 760 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.route("**/api/chat/conversations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: HISTORY }) }));
    await page.goto(`${base}/app/chat`, { waitUntil: "networkidle" });
    if (width < 1000) {
      const open = page.getByRole("button", { name: "Open navigation" });
      if (await open.isVisible()) await open.click();
    }
    const heading = page.locator('.library__section[data-section="recent"] > .library__head');
    const rows = page.locator('.library__section[data-section="recent"] .library__rows');
    await rows.locator(".conversation-item").nth(59).waitFor({ state: "attached" });
    const headingBox = await heading.boundingBox();
    assert.ok(headingBox, "the heading is shown");
    assert.match(await heading.innerText(), /Your chats/);
    for (const where of ["top", "middle", "bottom"]) {
      await rows.evaluate((el, w) => { el.scrollTop = w === "top" ? 0 : w === "middle" ? (el.scrollHeight - el.clientHeight) / 2 : el.scrollHeight; }, where);
      await page.waitForTimeout(80);
      const now = await heading.boundingBox();
      assert.ok(Math.abs(now.y - headingBox.y) < 0.5, `${where}: the heading does not move`);
      const listTop = (await rows.boundingBox()).y;
      assert.ok(listTop >= now.y + now.height - 0.5, `${where}: the list starts below the heading`);
      const overlapping = await rows.evaluate((el, headingBottom) => [...el.querySelectorAll(".conversation-item")].filter((row) => {
        const r = row.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const visibleTop = Math.max(r.top, box.top);
        return r.bottom > box.top && visibleTop < headingBottom - 0.5;
      }).length, now.y + now.height);
      assert.equal(overlapping, 0, `${where}: no visible row reaches into the heading`);
    }
    // Keyboard: focusing a row far down scrolls it fully into view, below the heading.
    await rows.evaluate((el) => { el.scrollTop = 0; });
    await rows.locator(".conversation-item__open").nth(40).focus();
    await page.waitForTimeout(80);
    const focused = await rows.locator(".conversation-item__open").nth(40).boundingBox();
    const list = await rows.boundingBox();
    assert.ok(focused.y >= list.y - 0.5 && focused.y + focused.height <= list.y + list.height + 0.5, "the focused row is fully visible");
    // The heading has a background of its own (not transparent), and only the rows scroll.
    assert.equal(await page.locator('.library__section[data-section="recent"]').evaluate((el) => getComputedStyle(el).overflowY), "hidden");
    assert.equal(await rows.evaluate((el) => getComputedStyle(el).overflowY), "auto");
    await context.close();
  });
}
