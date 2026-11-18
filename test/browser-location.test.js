import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, firefox } from "@playwright/test";
import { serve } from "../scripts/design-capture.mjs";

// Settings > Location, in the built app, in three engines: off by default and asking for nothing on its own, a city chosen from the
// search and saved by its id, a device-position request that the person declined (the message, nothing sent), Update, Remove, and a
// phone layout. The browser's geolocation is replaced by a stub, so no real permission prompt appears and each call is counted.
function browserPath() {
  const local = process.env.LOCALAPPDATA ?? "";
  return [process.env.BROWSER_PATH, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe")].find((candidate) => candidate && fs.existsSync(candidate));
}
const ENGINES = [
  ["Chromium", () => chromium.launch({ headless: true, executablePath: browserPath() })],
  ["WebKit", () => webkit.launch({ headless: true })],
  ["Firefox", () => firefox.launch({ headless: true })],
];
const built = fs.existsSync(path.resolve("frontend/dist/index.html"));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const OFF = { mode: "off" };
const AUSTIN = { mode: "city", city: "Austin", region: "Texas", country: "United States", timezone: "America/Chicago", placeId: 4726206 };
const AUSTIN_PLACE = { id: 4726206, city: "Austin", region: "Texas", country: "United States", timezone: "America/Chicago" };

for (const [engine, launch] of ENGINES) describe(`Settings > Location in ${engine}`, { concurrency: false, timeout: 300000, skip: !built && "frontend/dist is not built" }, () => {
  let server; let base; let browser; let launchError = null;
  before(async () => {
    server = serve({ signedIn: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await launch().catch((error) => { launchError = error; return null; });
  });
  after(async () => { await browser?.close(); server?.close(); });
  const skip = (t) => { if (!browser) { t.skip(`${engine} is not installed: ${launchError?.message.split("\n")[0]}`); return true; } return false; };

  // `location` is the saved setting the stub server returns; `searchPlaces` answers city searches; the stub geolocation always reports
  // "permission denied" (code 1) unless `position` is given.
  async function open({ viewport = { width: 1440, height: 900 }, location = OFF, searchPlaces = [AUSTIN_PLACE] } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {}
      window.__geo = { calls: 0 };
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition(success, failure) { window.__geo.calls += 1; setTimeout(() => failure?.({ code: 1, message: "User denied Geolocation" }), 10); },
        watchPosition() { window.__geo.calls += 1; return 0; },
        clearWatch() {},
      } });
    });
    const page = await context.newPage();
    const state = { current: structuredClone(location), puts: [], deletes: [], searches: [], resolves: [], problems: [] };
    page.on("pageerror", (error) => state.problems.push(`pageerror: ${error.message.slice(0, 140)}`));
    await page.route("**/api/me", (r) => json(r, { user: { id: "usr_design_sample", name: "Avery Sample", email: "avery@example.com", surveyCompleted: true } }));
    await page.route((url) => url.pathname === "/api/me/location", async (route) => {
      const method = route.request().method();
      if (method === "GET") return json(route, { location: state.current });
      if (method === "PUT") {
        const body = route.request().postDataJSON(); state.puts.push(body);
        const place = searchPlaces.find((p) => p.id === body.placeId);
        state.current = place ? { mode: "city", city: place.city, region: place.region, country: place.country, timezone: place.timezone, placeId: place.id } : state.current;
        return json(route, { location: state.current });
      }
      if (method === "DELETE") { state.deletes.push(true); state.current = OFF; return json(route, { location: OFF }); }
      return json(route, { error: "unexpected" }, 405);
    });
    await page.route((url) => url.pathname === "/api/me/location/search", (route) => { state.searches.push(route.request().postDataJSON()); return json(route, { places: searchPlaces }); });
    await page.route((url) => url.pathname === "/api/me/location/resolve", (route) => { state.resolves.push(true); return json(route, { location: AUSTIN }); });
    await page.goto(`${base}/app/settings/location`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Your location" }).or(page.getByText("Your location").first()).waitFor();
    return { context, page, state };
  }

  test("off by default: says so, asks for nothing on its own, and the device position is only asked for by its button", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open();
    await page.getByText("Off.", { exact: false }).first().waitFor();
    assert.equal(await page.getByText("VibhavGPT does not know where you are.").count(), 1);
    assert.equal(await page.evaluate(() => window.__geo.calls), 0, "the browser was not asked for a position on load");
    assert.equal(await page.getByPlaceholder("Enter a city, for example Austin, Texas").count(), 1, "the city search is offered");
    assert.deepEqual(state.searches, [], "nothing was searched");
    await page.getByRole("button", { name: "Use device location" }).click();
    await page.getByRole("alert").filter({ hasText: "Permission to use your location was declined" }).waitFor();
    assert.equal(await page.evaluate(() => window.__geo.calls), 1, "the browser was asked once, because the button was pressed");
    assert.deepEqual(state.resolves, [], "no position was sent after the refusal");
    assert.deepEqual(state.puts, [], "nothing was saved");
    await context.close();
  });

  test("a city is found by typing, chosen from the list, and saved by its id", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open();
    await page.getByPlaceholder("Enter a city, for example Austin, Texas").fill("Aus");
    const list = page.getByRole("list", { name: "Matching cities" });
    await list.waitFor();
    assert.deepEqual(state.searches.at(-1), { q: "Aus" }, "the search sends the text to this app's own server");
    await list.getByRole("button", { name: "Austin, Texas, United States" }).click();
    await page.getByText("Location saved.").waitFor();
    assert.deepEqual(state.puts, [{ mode: "city", placeId: AUSTIN_PLACE.id }], "saved by place id, not by coordinates");
    assert.equal(await page.locator(".location__current strong").textContent(), "Austin, Texas, United States");
    assert.equal(await page.evaluate(() => window.__geo.calls), 0, "choosing a city does not ask for the device position");
    await context.close();
  });

  test("a search with no match says so and saves nothing", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open({ searchPlaces: [] });
    await page.getByPlaceholder("Enter a city, for example Austin, Texas").fill("Zzzqx");
    await page.getByText("No city matches that.").waitFor();
    assert.deepEqual(state.puts, []);
    await context.close();
  });

  test("when the saved location is on, Update opens the chooser and Remove turns it off", async (t) => {
    if (skip(t)) return;
    const { context, page, state } = await open({ location: AUSTIN });
    const current = page.locator(".location__current");
    await current.waitFor();
    assert.equal(await current.locator("strong").textContent(), "Austin, Texas, United States");
    assert.equal(await page.getByPlaceholder("Enter a city, for example Austin, Texas").count(), 0, "the chooser is hidden while a location is set");
    await page.getByRole("button", { name: "Update" }).click();
    await page.getByPlaceholder("Enter a city, for example Austin, Texas").waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByText("Location removed.").waitFor();
    assert.equal(state.deletes.length, 1, "one removal request was sent");
    await page.getByText("VibhavGPT does not know where you are.").waitFor();
    assert.equal(await page.locator(".location__current").count(), 0, "the location is no longer shown");
    await context.close();
  });

  test("on a phone the location controls fit the screen with touch-sized targets and no sideways scroll", async (t) => {
    if (skip(t)) return;
    const { context, page } = await open({ viewport: { width: 390, height: 844 }, location: AUSTIN });
    await page.getByRole("button", { name: "Update" }).waitFor();
    await page.getByRole("button", { name: "Update" }).click();
    const input = await page.getByPlaceholder("Enter a city, for example Austin, Texas").boundingBox();
    assert.ok(input.height >= 40, `the search field is ${Math.round(input.height)}px tall`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(overflow, 0, "no sideways scroll");
    const buttons = await page.getByRole("button", { name: /Use device location|Cancel/ }).evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right })));
    for (const b of buttons) assert.ok(b.right <= 390.5, "each button is on screen");
    await context.close();
  });
});
