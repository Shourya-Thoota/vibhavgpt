import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// The newer features in the real built app, in three engines: the homepage presentation, the two mode controls and the draft that
// travels between them, the Library, the absence of a per-chat memory switch, the image watermark setting, and the accent that follows the account. The
// server is the design fixture (a fictitious account); each test answers the endpoints it is about so it can see what the page sends.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe")].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ITEMS = Array.from({ length: 5 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`, name: i === 1 ? "report.pdf" : `image-${i + 1}.png`, kind: i === 1 ? "document" : "image",
  mimeType: i === 1 ? "application/pdf" : "image/png", sizeBytes: 120000 + i, createdAt: `2026-10-0${5 - i}T12:00:00.000Z`, prompt: i === 1 ? null : `a picture number ${i + 1}`,
  available: true, conversation: { id: "5b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40", title: "Jupiter's moons", mode: "chat" },
  previewUrl: i === 1 ? null : `/api/library/00000000-0000-4000-8000-00000000000${i + 1}/preview`, downloadUrl: `/api/library/00000000-0000-4000-8000-00000000000${i + 1}/download`,
}));
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

for (const [engine, launch] of ENGINES) describe(`New features in ${engine}`, { concurrency: false, timeout: 400000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true, emptyLibrary: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  async function open(route, { viewport = { width: 1440, height: 900 }, reducedMotion = "no-preference", theme = "light", account = {}, javaScriptEnabled = true, setup } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion, javaScriptEnabled });
    await context.addInitScript((sky) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} }, theme);
    const page = await context.newPage();
    const state = { requests: [], account: { id: "usr_design_sample", name: "Avery Sample", email: "avery@example.com", surveyCompleted: true, ...account }, problems: [] };
    page.on("pageerror", (error) => state.problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    page.on("request", (request) => state.requests.push({ method: request.method(), url: request.url().replace(base, ""), body: request.postData() }));
    await page.route("**/api/me", (r) => json(r, { user: state.account }));
    await setup?.(page, state);
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    return { context, page, state };
  }
  const tabs = (page, label) => page.getByRole("tablist", { name: label }).getByRole("tab").allTextContents();

  // --- Homepage presentation ---------------------------------------------------------------------------------------------------

  // The presenter is a slide show of five static slides (autoplay every 6 seconds, pause, dots, arrow keys, off-screen and hidden-tab holds,
  // reduced motion). Its tests, with fake time at four widths, are in browser-presenter.test.js.

  test("without script the five features are cards; with reduced motion they are the same slides, not playing, with dots and no Pause", async (t) => {
    if (skip(t)) return;
    const noScript = await open("/", { javaScriptEnabled: false });
    assert.equal(await noScript.page.locator(".slide").count(), 5);
    assert.equal(await noScript.page.locator(".presenter__bar").isVisible(), false, "no controls for cards");
    const all = await noScript.page.locator(".slide").evaluateAll((els) => els.every((e) => { const r = e.getBoundingClientRect(); const style = getComputedStyle(e); return r.width > 100 && style.visibility === "visible" && style.opacity === "1"; }));
    assert.equal(all, true, "all five are shown");
    for (const link of await noScript.page.locator(".slide__copy h3 a").all()) { const { height, width } = await link.boundingBox(); assert.ok(height >= 44 - 0.01 && width >= 44 - 0.01, `44px targets (${(await link.textContent()).trim()} is ${width}x${height}px)`); }
    await noScript.context.close();
    const reduced = await open("/", { reducedMotion: "reduce" });
    await reduced.page.evaluate(() => document.querySelector("#presenter").scrollIntoView({ block: "center", behavior: "instant" }));
    await reduced.page.waitForFunction(() => document.querySelector("#presenter")?.hasAttribute("data-ready"));
    assert.equal(await reduced.page.locator(".presenter__toggle").isVisible(), false, "nothing to pause when nothing plays");
    assert.equal(await reduced.page.locator(".presenter__dot").count(), 5);
    assert.equal(await reduced.page.locator(".slide[data-on]").count(), 1, "one slide at a time");
    await reduced.context.close();
  });

  test("only the current theme's artwork is fetched, and following the theme swaps it", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/", { theme: "light", reducedMotion: "reduce" });
    await page.evaluate(() => document.querySelector("#presenter").scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForFunction(() => [...document.querySelectorAll(".slide__art")].filter((img) => getComputedStyle(img).display !== "none").every((img) => img.complete && img.naturalWidth > 0));
    const art = () => state.requests.filter((r) => r.url.startsWith("/home/artwork/"));
    assert.ok(art().length >= 5 && art().every((r) => r.url.endsWith("-light.webp")), `only light pictures: ${art().map((r) => r.url).join(", ")}`);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForFunction(() => [...document.querySelectorAll(".slide__art--dark")].every((img) => img.complete && img.naturalWidth > 0 && getComputedStyle(img).display !== "none"));
    assert.ok(art().some((r) => r.url.endsWith("-dark.webp")), "the dark pictures are fetched once they are needed");
    await context.close();
  });

  test("the presentation reserves its space: nothing shifts as pictures load", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/", { reducedMotion: "reduce" });
    const sizes = await page.locator(".slide__art:visible").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { ratio: r.width / r.height, w: e.getAttribute("width"), h: e.getAttribute("height") }; }));
    for (const s of sizes) { assert.equal(`${s.w}x${s.h}`, "1280x720", "dimensions are in the markup"); assert.ok(Math.abs(s.ratio - 16 / 9) < 0.02, `16:9 before and after loading (${s.ratio.toFixed(2)})`); }
    await context.close();
  });

  // --- Mode controls ---------------------------------------------------------------------------------------------------------------

  test("Chat | Image at the top, Chat | Study under the composer; switching never reloads, and the draft goes with it", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat");
    await page.locator(".opening__title").waitFor();
    assert.deepEqual(await tabs(page, "Workspace"), ["Chat", "Image"], "top: no Study");
    assert.deepEqual(await tabs(page, "Chat or Study"), ["Chat", "Study"], "under the composer: no Image");
    await page.evaluate(() => { window.__marker = "same-document"; });
    await page.locator(".composer__input").fill("a half-written question");
    await page.getByRole("tablist", { name: "Chat or Study" }).getByRole("tab", { name: "Study" }).click();
    await page.waitForURL(/\/app\/study/);
    assert.equal(await page.evaluate(() => window.__marker), "same-document", "no document reload");
    await page.locator(".composer__input").waitFor();
    assert.equal(await page.locator(".composer__input").inputValue(), "a half-written question", "the draft came along");
    await page.getByRole("tablist", { name: "Chat or Study" }).getByRole("tab", { name: "Chat" }).click();
    await page.waitForURL(/\/app\/chat/);
    assert.equal(await page.locator(".composer__input").inputValue(), "a half-written question", "and back again");
    await page.getByRole("tablist", { name: "Workspace" }).getByRole("tab", { name: "Image" }).click();
    await page.waitForURL(/\/app\/image/);
    assert.equal(await page.evaluate(() => window.__marker), "same-document", "Image is client-side too");
    await page.goBack();
    await page.waitForURL(/\/app\/chat/);
    await page.goForward();
    await page.waitForURL(/\/app\/image/);
    await page.reload({ waitUntil: "networkidle" });
    assert.match(page.url(), /\/app\/image/, "a direct URL and a refresh both land on Image");
    await context.close();
  });

  test("a new chat does not inherit another conversation's draft", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat");
    await page.locator(".composer__input").fill("leftover words");
    await page.getByRole("button", { name: /^New chat/ }).first().click();
    await page.locator(".opening__title").waitFor();
    assert.equal(await page.locator(".composer__input").inputValue(), "", "New chat starts empty");
    await context.close();
  });

  test("on a phone, Study is reachable too", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat", { viewport: { width: 390, height: 844 } });
    await page.locator(".opening__title").waitFor();
    assert.deepEqual(await tabs(page, "Chat or Study"), ["Chat", "Study"]);
    await page.getByRole("tablist", { name: "Chat or Study" }).getByRole("tab", { name: "Study" }).click();
    await page.waitForURL(/\/app\/study/);
    await context.close();
  });

  // --- Library -----------------------------------------------------------------------------------------------------------------------

  const libraryRoutes = (deleted = []) => async (page, state) => {
    state.libraryCalls = [];
    await page.route("**/api/library/**/preview", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
    // One handler for the whole Library API, matched by a predicate rather than a glob, so the list, the item and the preview
    // addresses are each answered here and never fall through to the shared design fixture (which answers 404).
    await page.route((url) => url.pathname.startsWith("/api/library"), async (r) => {
      const request = r.request(); const url = new URL(request.url());
      if (/\/api\/library\/[^/]+$/.test(url.pathname) && request.method() === "DELETE") { deleted.push(url.pathname.split("/").pop()); return r.fulfill({ status: 204 }); }
      if (url.pathname !== "/api/library") return r.continue();
      state.libraryCalls.push(Object.fromEntries(url.searchParams));
      const type = url.searchParams.get("type"); const q = url.searchParams.get("q"); const cursor = url.searchParams.get("cursor");
      let list = ITEMS.filter((item) => type === "images" ? item.kind === "image" : type === "documents" ? item.kind === "document" : true);
      if (q) list = list.filter((item) => `${item.name} ${item.prompt ?? ""}`.includes(q));
      if (state.libraryMode === "empty") list = [];
      if (state.libraryMode === "error") return json(r, { error: "no" }, 500);
      const page1 = cursor ? list.slice(3) : list.slice(0, 3);
      return json(r, { items: page1, nextCursor: !cursor && list.length > 3 ? "next-page" : null });
    });
  };

  test("the Library: sidebar entry, list, filters, search, load more, preview and download addresses", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/library", { setup: libraryRoutes() });
    await page.getByRole("heading", { name: "Library" }).waitFor();
    const link = page.locator(".sidebar").getByRole("link", { name: "Library" });
    assert.equal(await link.getAttribute("aria-current"), "page", "the sidebar marks it as the current page");
    assert.equal(await page.locator(".lib-page__card").count(), 3, "the first page");
    await page.getByRole("button", { name: "Show more" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".lib-page__card").length === 5);
    assert.equal(state.libraryCalls.at(-1).cursor, "next-page");
    assert.equal(await page.getByRole("button", { name: "Show more" }).count(), 0, "no more to load");
    const imageCard = page.locator(".lib-page__card[data-kind=image]").first();
    assert.match(await imageCard.locator("img").getAttribute("src"), /\/api\/library\/[0-9a-f-]{36}\/preview$/);
    assert.match(await imageCard.getByRole("link", { name: /^Download/ }).getAttribute("href"), /\/api\/library\/[0-9a-f-]{36}\/download$/);
    await page.getByRole("button", { name: "Documents" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".lib-page__card").length === 1);
    assert.equal(state.libraryCalls.at(-1).type, "documents");
    await page.getByRole("button", { name: "All" }).click();
    await page.getByRole("searchbox", { name: "Search the Library" }).fill("number 3");
    await page.waitForFunction(() => document.querySelectorAll(".lib-page__card").length === 1);
    assert.equal(state.libraryCalls.at(-1).q, "number 3");
    await page.getByRole("searchbox").fill("zzz nothing");
    await page.getByText("Nothing matches that.").waitFor();
    await context.close();
  });

  test("the Library: preview opens, 'Open chat' goes to the source conversation, and Back works", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/library", { setup: libraryRoutes() });
    await page.locator(".lib-page__card").first().waitFor();
    await page.locator(".lib-page__card[data-kind=image] .lib-page__thumb").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.ok(await dialog.locator("img").evaluate((e) => e.complete));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".lib-page__card").first().getByRole("button", { name: /^Open the chat/ }).click();
    await page.waitForURL(/\/app\/chat.*5b1c2d3e/);
    await page.goBack();
    await page.waitForURL(/\/app\/library/);
    await context.close();
  });

  test("the Library: delete asks first, says what it removes, and only a confirmed delete sends the request", async (t) => {
    if (skip(t)) return;
    const deleted = [];
    const { context, page } = await open("/app/library", { setup: libraryRoutes(deleted) });
    await page.locator(".lib-page__card").first().waitFor();
    await page.locator(".lib-page__card").first().getByRole("button", { name: /^Delete/ }).click();
    const dialog = page.getByRole("dialog", { name: "Delete this file?" });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /from your Library and from the chat it came from/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(deleted, [], "cancel sends nothing");
    assert.equal(await page.locator(".lib-page__card").count(), 3);
    await page.locator(".lib-page__card").first().getByRole("button", { name: /^Delete/ }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".lib-page__card").length === 2);
    assert.deepEqual(deleted, [ITEMS[0].id]);
    await context.close();
  });

  test("the Library: empty and error states, and Try again", async (t) => {
    if (skip(t)) return;
    const empty = await open("/app/library", { setup: async (page, state) => { await libraryRoutes()(page, state); state.libraryMode = "empty"; } });
    await empty.page.getByText(/Nothing here yet/).waitFor();
    await empty.context.close();
    const failing = await open("/app/library", { setup: async (page, state) => { await libraryRoutes()(page, state); state.libraryMode = "error"; } });
    await failing.page.getByRole("alert").getByText("The Library could not be loaded.").waitFor();
    failing.state.libraryMode = "ok";
    await failing.page.getByRole("button", { name: "Try again" }).click();
    await failing.page.locator(".lib-page__card").first().waitFor();
    await failing.context.close();
  });

  test("the Library fits a phone without sideways scrolling and keeps 44px targets", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/library", { viewport: { width: 390, height: 844 }, setup: libraryRoutes() });
    await page.locator(".lib-page__card").first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const control of await page.locator(".lib-page__action, .lib-page__filter").all()) assert.ok((await control.boundingBox()).height >= 43, "a thumb-sized target");
    await context.close();
  });

  // --- No per-chat memory switch -----------------------------------------------------------------------------------------------------
  // The + menu used to carry a "Use memory" switch (a truncated label and an unclear on/off). It is gone. Memory itself is not:
  // it is controlled in Settings and on the Memory page (browser-extensions-directory.test.js checks both are still there).

  const chatStub = async (page, state) => {
    await page.route("**/api/chat/stream", (route) => {
      state.streamBodies = [...(state.streamBodies ?? []), JSON.parse(route.request().postData() ?? "{}")];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: complete\ndata: {\"conversationId\":\"5b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40\",\"reply\":\"ok\"}\n\n" });
    });
  };

  test("the + menu has no memory switch, and a message sends no memory choice", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/chat", { setup: chatStub });
    await page.locator(".composer__input").waitFor();
    await page.getByRole("button", { name: "Add to message" }).click();
    const menu = page.locator(".ui-menu__panel");
    await menu.waitFor();
    assert.deepEqual(await menu.locator("[role^=menuitem] .ui-menu__name").allTextContents(), ["Photos", "Files", "Response mode"]);
    assert.equal(await page.getByRole("menuitemcheckbox").count(), 0, "no switch in the menu at all");
    assert.equal(await menu.getByText(/memory/i).count(), 0, "and nothing in it mentions memory");
    await page.keyboard.press("Escape");
    await page.locator(".composer__input").fill("question one");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    assert.ok(state.streamBodies?.length >= 1, "the message was sent");
    assert.equal("useMemory" in state.streamBodies[0], false, "and carries no per-chat memory choice");
    await context.close();
  });

  // --- Media settings and accent ---------------------------------------------------------------------------------------------------

  const preferenceRoutes = (initial) => async (page, state) => {
    state.prefs = { accent: null, ...initial }; state.patches = [];
    await page.route("**/api/me/preferences", async (r) => {
      if (r.request().method() === "PATCH") {
        const body = JSON.parse(r.request().postData());
        state.patches.push(body);
        state.prefs = { ...state.prefs, ...body, ...("imageWatermark" in body ? { imageWatermark: { enabled: body.imageWatermark, locked: false } } : {}) };
      }
      return json(r, { preferences: state.prefs });
    });
  };

  // The watermark policy (owner decision, 2026-11-16, superseding #70): Settings > Media shows it; the server enforces it.
  test("Settings > Media: on the Free plan the watermark is shown on and locked", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/settings/media", { setup: preferenceRoutes({ imageWatermark: { enabled: true, locked: true } }) });
    const group = page.getByRole("radiogroup", { name: "Watermark" });
    await group.waitFor();
    assert.equal(await group.getByRole("radio", { name: "On" }).getAttribute("aria-checked"), "true");
    assert.equal(await group.getByRole("radio", { name: "Off" }).isDisabled(), true, "it cannot be switched off");
    await page.getByText("Images on the Free plan always carry the mark.").waitFor();
    assert.equal(state.patches.length, 0);
    await context.close();
  });

  test("Settings > Media: on a paid plan the watermark is off until turned on, and the choice is saved to the account", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/settings/media", { setup: preferenceRoutes({ imageWatermark: { enabled: false, locked: false } }) });
    const group = page.getByRole("radiogroup", { name: "Watermark" });
    await group.waitFor();
    assert.equal(await group.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"), "true", "off by default");
    await group.getByRole("radio", { name: "On" }).click();
    await page.waitForFunction(() => document.querySelector('[role="radiogroup"][aria-label="Watermark"] [role="radio"][aria-checked="true"]')?.textContent?.trim() === "On");
    assert.deepEqual(state.patches.at(-1), { imageWatermark: true });
    await context.close();
  });

  test("the accent follows the account: shown when it loads, saved when changed, and the page colours follow", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/settings/appearance", { account: { accent: "ember" }, setup: preferenceRoutes({}) });
    await page.getByRole("group", { name: "Accent colour" }).waitFor();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-accent") === "ember");
    const wash = (accent) => page.evaluate((id) => { document.documentElement.setAttribute("data-accent", id); return getComputedStyle(document.body, "::before").backgroundImage; }, accent);
    const ember = await wash("ember"); const pine = await wash("pine");
    assert.notEqual(ember, pine, "the page background follows the accent");
    await page.getByRole("group", { name: "Accent colour" }).getByRole("button", { name: /Pine/ }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-accent") === "pine");
    assert.deepEqual(state.patches.at(-1), { accent: "pine" }, "saved to the account");
    assert.equal(await page.evaluate(() => localStorage.getItem("vibhavgpt-accent")), "pine", "and kept on this device for the first paint");
    assert.deepEqual(state.problems, []);
    await context.close();
  });
});
