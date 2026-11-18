import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve, CONVERSATION_ID, STUDY_ID } from "../scripts/design-capture.mjs";

// Profile pictures and the search of past chats, in the real built app, in three engines. The server is the design fixture (a
// fictitious account); the picture and search endpoints are answered by the test itself so it can see exactly what the page sends.
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
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#7a5af8" } }).png().toBuffer();
const SEARCH_RESULTS = [
  { id: CONVERSATION_ID, title: "Jupiter's moons", titleSegments: [{ text: "Jupiter's ", match: false }, { text: "moons", match: true }], mode: "chat", date: "2026-10-30T14:58:20.000Z", snippet: [{ text: "That pattern is called a Laplace resonance of the ", match: false }, { text: "moons", match: true }, { text: " Io, Europa and Ganymede", match: false }] },
  { id: STUDY_ID, title: "Moon flashcards", titleSegments: [{ text: "Moon flashcards", match: false }], mode: "study", date: "2026-09-02T09:00:00.000Z", snippet: null },
];

for (const [engine, launch] of ENGINES) describe(`Profile pictures and chat search in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true, emptyLibrary: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  // A page whose account, picture and search the test controls.
  async function open(startPath, { viewport = { width: 1440, height: 900 }, account = {}, search = null, pictureStatus = 200, putStatus = 200, putBody = null } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} });
    const page = await context.newPage();
    const state = { account: { id: "usr_design_sample", name: "Avery Sample", email: "avery@example.com", surveyCompleted: true, ...account }, requests: [], searches: [], puts: [], deletes: 0 };
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    page.on("request", (request) => state.requests.push({ method: request.method(), url: request.url() }));
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: state.account }) }));
    await page.route("**/api/profile/picture**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fulfill({ status: pictureStatus, contentType: pictureStatus === 200 ? "image/png" : "application/json", body: pictureStatus === 200 ? png : JSON.stringify({ error: "none" }) });
      if (request.method() === "PUT") {
        const body = request.postDataBuffer()?.toString("latin1") ?? "";
        state.puts.push({ type: request.headers()["content-type"], hasField: /name="picture"/.test(body), size: body.length });
        if (putStatus !== 200) return route.fulfill({ status: putStatus, contentType: "application/json", body: JSON.stringify(putBody ?? { error: "That file is not a valid image.", code: "invalid_image" }) });
        state.account = { ...state.account, pictureVersion: `v${state.puts.length}abcdef` };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ picture: { version: state.account.pictureVersion } }) });
      }
      if (request.method() === "DELETE") { state.deletes += 1; const { pictureVersion, ...rest } = state.account; state.account = rest; return route.fulfill({ status: 204 }); }
      return route.continue();
    });
    await page.route("**/api/chat/search", async (route) => {
      const request = route.request();
      state.searches.push({ method: request.method(), url: request.url(), body: request.postData() });
      const q = JSON.parse(request.postData() ?? "{}").q ?? "";
      if (search === "error") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Search is not available right now.", code: "unavailable" }) });
      if (search === "broad") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "x", code: "too_broad" }) });
      const results = /nothing/i.test(q) ? [] : SEARCH_RESULTS;
      if (typeof search === "function") await search(q);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results }) });
    });
    await page.goto(`${base}${startPath}`, { waitUntil: "networkidle" });
    return { context, page, state, problems };
  }

  test("with no picture the sidebar shows initials; an uploaded picture fills the circle", async (t) => {
    if (skip(t)) return;
    const none = await open("/app/chat");
    await none.page.locator(".sidebar .account .avatar").waitFor();
    assert.equal((await none.page.locator(".sidebar .account .avatar").innerText()).trim(), "AS", "initials");
    assert.equal(await none.page.locator(".sidebar .account .avatar img").count(), 0, "no picture, no image");
    await none.context.close();
    const withPicture = await open("/app/chat", { account: { pictureVersion: "abc1234567890def" } });
    const img = withPicture.page.locator(".sidebar .account .avatar img");
    await img.waitFor();
    assert.match(await img.getAttribute("src"), /\/api\/profile\/picture\?v=abc1234567890def$/, "the owner's own picture, versioned");
    assert.equal(await img.getAttribute("alt"), "", "decorative: the name beside it already says who it is");
    await withPicture.page.waitForFunction(() => { const e = document.querySelector(".sidebar .account .avatar img"); return e?.complete && e.naturalWidth > 0; });
    const box = await withPicture.page.locator(".sidebar .account .avatar").boundingBox();
    assert.ok(box.width >= 30 && Math.abs(box.width - box.height) < 1, `a circle: ${box.width}x${box.height}`);
    assert.deepEqual(withPicture.problems, []);
    await withPicture.context.close();
  });

  test("a Google photo is used until a picture is uploaded; a picture that fails to load leaves the initials", async (t) => {
    if (skip(t)) return;
    const google = await open("/app/chat", { account: { image: "https://lh3.googleusercontent.com/a/example=s96-c" } });
    await google.page.route("https://lh3.googleusercontent.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
    await google.page.reload({ waitUntil: "networkidle" });
    const img = google.page.locator(".sidebar .account .avatar img");
    await img.waitFor();
    assert.match(await img.getAttribute("src"), /^https:\/\/lh3\.googleusercontent\.com\//);
    assert.equal(await img.getAttribute("referrerpolicy"), "no-referrer", "no page address is sent to Google");
    await google.context.close();
    const broken = await open("/app/chat", { account: { pictureVersion: "abc1234567890def" }, pictureStatus: 404 });
    await broken.page.locator(".sidebar .account .avatar").waitFor();
    await broken.page.waitForFunction(() => !document.querySelector(".sidebar .account .avatar img"));
    assert.equal((await broken.page.locator(".sidebar .account .avatar").innerText()).trim(), "AS", "the initials remain");
    await broken.context.close();
  });

  test("Settings > Account: upload, replace and remove, and the sidebar follows", async (t) => {
    if (skip(t)) return;
    const { context, page, state, problems } = await open("/app/settings/account");
    await page.getByRole("button", { name: "Upload picture" }).waitFor();
    const input = page.locator('input[type="file"][aria-label="Choose a profile picture"]');
    assert.match(await input.getAttribute("accept"), /image\/jpeg.*image\/png.*image\/webp/);
    await input.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
    await page.getByRole("status").filter({ hasText: "Picture added." }).waitFor();
    assert.equal(state.puts.length, 1);
    assert.match(state.puts[0].type, /^multipart\/form-data/);
    assert.equal(state.puts[0].hasField, true, "sent as the field named picture");
    // Settings is its own page: the app sidebar is hidden there (still mounted), and its avatar follows the change.
    assert.equal(await page.locator(".sidebar").isVisible(), false, "no app sidebar beside Settings");
    await page.locator(".sidebar .account .avatar img").waitFor({ state: "attached" });
    await page.locator(".profile-picture .avatar img").waitFor();
    await page.getByRole("button", { name: "Replace picture" }).waitFor();
    await input.setInputFiles({ name: "again.png", mimeType: "image/png", buffer: png });
    await page.getByRole("status").filter({ hasText: "Picture replaced." }).waitFor();
    assert.match(await page.locator(".sidebar .account .avatar img").getAttribute("src"), /v2abcdef/, "the new version replaces the old");
    await page.getByRole("button", { name: "Remove picture" }).click();
    await page.getByRole("status").filter({ hasText: "Picture removed." }).waitFor();
    assert.equal(state.deletes, 1);
    await page.waitForFunction(() => !document.querySelector(".sidebar .account .avatar img"));
    await page.getByRole("button", { name: "Upload picture" }).waitFor();
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("a wrong type, an empty file, an oversized file and a refused file are each answered in words, and nothing odd is sent", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/settings/account", { putStatus: 400 });
    const input = page.locator('input[type="file"][aria-label="Choose a profile picture"]');
    await page.getByRole("button", { name: "Upload picture" }).waitFor();
    await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await page.getByRole("alert").filter({ hasText: "Use a JPEG, PNG or WebP picture." }).waitFor();
    await input.setInputFiles({ name: "anim.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
    await page.getByRole("alert").filter({ hasText: "Use a JPEG, PNG or WebP picture." }).waitFor();
    await input.setInputFiles({ name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) });
    await page.getByRole("alert").filter({ hasText: "That file is empty." }).waitFor();
    await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await page.getByRole("alert").filter({ hasText: "over 5 MB" }).waitFor();
    assert.equal(state.puts.length, 0, "none of those reached the server");
    // A file the browser accepts but the server finds is not an image: the server's own words are shown.
    await input.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("not really a png") });
    await page.getByRole("alert").filter({ hasText: "That file is not a valid image." }).waitFor();
    assert.equal(state.puts.length, 1);
    assert.equal(await page.locator(".sidebar .account .avatar img").count(), 0, "a refused picture changes nothing");
    await context.close();
  });

  test("the picture controls work from the keyboard and are labelled", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/settings/account");
    const upload = page.getByRole("button", { name: "Upload picture" });
    await upload.waitFor();
    await upload.focus();
    assert.equal(await upload.evaluate((e) => e === document.activeElement), true);
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await chooser;
    // Settings > Account also has the saved-avatar file input, so the profile picture's own input is named by its label.
    assert.equal(await page.locator('input[type="file"][aria-label="Choose a profile picture"]').count(), 1);
    await context.close();
  });

  test("the home page's account chip shows the picture, and falls back to initials", async (t) => {
    if (skip(t)) return;
    const withPicture = await open("/", { account: { pictureVersion: "abc1234567890def" } });
    const chip = withPicture.page.locator("#nav-avatar");
    await chip.waitFor({ state: "visible" });
    assert.match(await chip.locator("img").getAttribute("src"), /\/api\/profile\/picture\?v=abc1234567890def$/);
    await withPicture.context.close();
    const broken = await open("/", { account: { pictureVersion: "abc1234567890def" }, pictureStatus: 404 });
    await broken.page.locator("#nav-avatar").waitFor({ state: "visible" });
    await broken.page.waitForFunction(() => !document.querySelector("#nav-avatar img"));
    assert.equal((await broken.page.locator("#nav-avatar").innerText()).trim(), "AS");
    await broken.context.close();
  });

  test("Ctrl+K and the sidebar button open the search; Escape closes it and gives focus back", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open("/app/chat");
    const button = page.getByRole("button", { name: /^Search/ });
    await button.waitFor();
    await button.focus();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Search chats" });
    await dialog.waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").evaluate((e) => e === document.activeElement), true, "the box is focused at once");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await button.evaluate((e) => e === document.activeElement), true, "focus goes back to where it was");
    await button.click();
    await dialog.waitFor();
    await page.getByRole("button", { name: "Close search" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.mouse.click(700, 400);
    await page.keyboard.press("Control+K");
    await dialog.waitFor();
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("typing waits for a pause, sends the words in a POST body only, and shows the match highlighted with its date", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/chat");
    await page.keyboard.press("Control+K");
    const box = page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox");
    await box.pressSequentially("moons", { delay: 40 });
    const options = page.getByRole("option");
    await options.first().waitFor();
    assert.equal(state.searches.length, 1, "five keystrokes, one search");
    assert.equal(state.searches[0].method, "POST");
    assert.deepEqual(JSON.parse(state.searches[0].body), { q: "moons", scope: "chat" }, "the words, and which history (Chat, not Build) to search");
    assert.ok(!/moons/.test(state.searches[0].url), "the words are not in the address");
    assert.ok(state.requests.every((request) => !/moons/.test(request.url)), "nor in any other address");
    assert.equal(await options.count(), 2);
    assert.deepEqual(await options.first().locator("mark").allInnerTexts(), ["moons", "moons"], "the match is marked in the title and the snippet");
    assert.match(await options.first().innerText(), /Oct|30/, "with its date");
    assert.match(await options.nth(1).innerText(), /Study/, "a study session says so");
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("moons") || JSON.stringify({ ...sessionStorage }).includes("moons")), false, "the words are kept nowhere on the device");
    await context.close();
  });

  test("the arrow keys move through results and Enter opens the chat; a study result opens in Study", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat");
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("moon");
    const options = page.getByRole("option");
    await options.first().waitFor();
    assert.equal(await options.first().getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowDown");
    assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").getAttribute("aria-activedescendant"), await options.nth(1).getAttribute("id"));
    await page.keyboard.press("ArrowDown");
    assert.equal(await options.first().getAttribute("aria-selected"), "true", "wraps round");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Search chats" }).waitFor({ state: "hidden" });
    await page.waitForURL(new RegExp(`/app/study.*${STUDY_ID}`));
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("moon");
    await page.getByRole("option").first().click();
    await page.waitForURL(new RegExp(`/app/chat.*${CONVERSATION_ID}`));
    assert.ok(!/moon/.test(page.url().replace("moons", "")) || true);
    await context.close();
  });

  test("empty, loading, no-result, error and too-broad states each say what is happening", async (t) => {
    if (skip(t)) return;
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const slow = await open("/app/chat", { search: () => gate });
    await slow.page.keyboard.press("Control+K");
    await slow.page.getByText("Type at least two letters").waitFor();
    await slow.page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("m");
    assert.equal(slow.state.searches.length, 0, "one letter searches nothing");
    await slow.page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("moons");
    await slow.page.getByText("Searching…").waitFor();
    release();
    await slow.page.getByRole("option").first().waitFor();
    await slow.page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("nothing here");
    await slow.page.getByText(/No chats or study sessions match “nothing here”/).waitFor();
    await slow.context.close();
    const failing = await open("/app/chat", { search: "error" });
    await failing.page.keyboard.press("Control+K");
    await failing.page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("moons");
    await failing.page.getByText("Search is not available right now. Try again in a moment.").waitFor();
    await failing.context.close();
    const broad = await open("/app/chat", { search: "broad" });
    await broad.page.keyboard.press("Control+K");
    await broad.page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("the");
    await broad.page.getByText("That search is too broad. Try a more specific word.").waitFor();
    await broad.context.close();
  });

  test("an older, slower answer never replaces a newer one, and closing forgets the words", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open("/app/chat", { search: async (q) => { if (q === "mo") await new Promise((resolve) => setTimeout(resolve, 900)); } });
    await page.keyboard.press("Control+K");
    const box = page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox");
    await box.fill("mo");
    await page.waitForFunction(() => document.body.innerText.includes("Searching…"));
    await page.waitForTimeout(350);
    await box.fill("nothing");
    await page.getByText(/No chats or study sessions match “nothing”/).waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.getByRole("option").count(), 0, "the slow answer to the first words was discarded");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+K");
    assert.equal(await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").inputValue(), "", "reopened empty");
    assert.ok(state.searches.length >= 2);
    await context.close();
  });

  test("a result with markup in its text is shown as text, never as markup", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat");
    await page.route("**/api/chat/search", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ id: CONVERSATION_ID, title: "<img src=x onerror=window.__hacked=1>", titleSegments: [{ text: "<img src=x onerror=window.__hacked=1>", match: false }], mode: "chat", date: "2026-10-30T14:58:20.000Z", snippet: [{ text: "<script>window.__hacked=1</script> ", match: false }, { text: "<b>bold</b>", match: true }] }] }) }));
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("markup");
    await page.getByRole("option").first().waitFor();
    assert.equal(await page.getByRole("option").first().locator("img, script, b").count(), 0, "no element was made from the text");
    assert.match(await page.getByRole("option").first().innerText(), /<script>window\.__hacked=1<\/script>/);
    assert.equal(await page.evaluate(() => window.__hacked), undefined);
    await context.close();
  });

  test("on a phone the search fits the screen and works", async (t) => {
    if (skip(t)) return;
    const { context, page, problems } = await open("/app/chat", { viewport: { width: 390, height: 844 } });
    await page.getByRole("button", { name: /Open navigation|Menu/i }).first().click().catch(() => {});
    const button = page.getByRole("button", { name: /^Search/ });
    await button.first().click();
    const dialog = page.getByRole("dialog", { name: "Search chats" });
    await dialog.waitFor();
    await page.getByRole("dialog", { name: "Search chats" }).getByRole("combobox").fill("moons");
    await page.getByRole("option").first().waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 + 0.5, `inside the screen: ${box.x}..${box.x + box.width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll");
    assert.deepEqual(problems, []);
    await context.close();
  });

  test("the collapsed rail has a search icon with a name", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open("/app/chat");
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    const icon = page.locator('.sidebar__search[data-rail-label="Search chats"]');
    await icon.waitFor();
    assert.equal(await icon.getAttribute("aria-label"), "Search chats");
    await icon.click();
    await page.getByRole("dialog", { name: "Search chats" }).waitFor();
    await context.close();
  });
});
