// Before/after captures for the Slice 6 de-slop pass: the built site with production's routes and the synthetic API from
// design-capture.mjs. Error, limit and connector states are answered by page.route, so nothing reaches the network.
//
//   node scripts/slice6-capture.mjs <outDir> [--only=name1,name2]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser, CONVERSATION_ID } from "./design-capture.mjs";
import { defaultConnectors, sampleSkills } from "../test/support/extensions-fixture.js";

const outDir = path.resolve(process.argv[2] ?? "slice6-shots");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORTS = { desktop: { width: 1280, height: 860 }, mobile: { width: 375, height: 812 }, narrow: { width: 320, height: 720 } };
const CHAT = `/app/chat?conversation=${CONVERSATION_ID}`;
const sse = (events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const streamError = (data) => async (route) => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: sse([["status", { phase: "thinking" }], ["error", data]]) });
// The same directory the Extensions browser tests use: some connected, one needing permissions, one needing setup.
const CONNECTORS = { connectors: defaultConnectors() };
const send = async (page) => {
  await page.locator(".composer__input").first().fill("Why do tides happen twice a day?");
  await page.locator(".composer__send").first().click();
  await page.waitForTimeout(900);
};

// name, path, viewports, options. `act` runs after load; `routes` answers API calls; `element` captures one element.
const SHOTS = [
  ["menu-plus", CHAT, ["desktop", "mobile"], { act: (p) => p.locator('.composer button[aria-label="Add to message"]').first().click() }],
  ["menu-model", CHAT, ["desktop"], { act: (p) => p.locator(".composer__model .ui-select__trigger").first().click() }],
  // Phones have no dropdown here: the "+" opens the add sheet (the model and thinking pickers live in it).
  ["sheet-add", CHAT, ["mobile"], { act: (p) => p.locator('button[aria-label="Add to message"]').first().click() }],
  ["menu-chat-options", CHAT, ["desktop"], { act: async (p) => { await p.locator(".conversation-item").first().hover(); await p.locator(".conversation-item__actions").first().click({ force: true }); } }],
  ["menu-account", "/app/chat", ["desktop"], { act: (p) => p.locator(".sidebar .account").first().click() }],
  ["settings-account", "/app/settings/account", ["desktop", "mobile"], { fullPage: true }],
  ["settings-appearance", "/app/settings/appearance", ["desktop", "mobile"], { fullPage: true }],
  ["settings-personalization", "/app/settings/personalization", ["desktop"], { fullPage: true }],
  ["study-empty", "/app/study", ["desktop", "mobile"], {}],
  ["chat-empty", "/app/chat", ["desktop"], { emptyLibrary: true }],
  ["temp-notice", "/app/chat", ["desktop", "mobile"], { emptyLibrary: true, act: (p) => p.locator('button[aria-label="Temporary chat"]').first().click() }],
  ["banner-high-demand", CHAT, ["desktop", "mobile"], { routes: { "**/api/chat/stream": streamError({ error: "Nova is in high demand right now, so this reply didn't start and nothing was used. Please try again in a minute.", code: "high_demand", retryable: true, status: 503 }) }, act: send }],
  ["banner-couldnt-start", CHAT, ["desktop"], { routes: { "**/api/chat/stream": streamError({ error: "We couldn't start this reply just now, and nothing was used. Please try again in a moment.", code: "capacity_unavailable", retryable: true, status: 503 }) }, act: send }],
  ["new-project", "/app/chat", ["desktop", "mobile", "narrow"], { act: async (p) => { if ((p.viewportSize()?.width ?? 1280) < 760) await p.getByRole("button", { name: "Open navigation" }).click(); await p.getByRole("button", { name: "New project" }).first().click(); } }],
  ["extensions", "/app/extensions", ["desktop", "mobile"], { fullPage: true, routes: { "**/api/connectors": (r) => r.fulfill({ json: CONNECTORS }), "**/api/skills**": (r) => r.fulfill({ json: { skills: sampleSkills() } }) } }],
  ["menu-skill", "/app/extensions", ["desktop"], { routes: { "**/api/connectors": (r) => r.fulfill({ json: CONNECTORS }), "**/api/skills**": (r) => r.fulfill({ json: { skills: sampleSkills() } }) }, act: async (p) => { await p.getByRole("tab", { name: "Skills" }).click(); await p.waitForTimeout(400); await p.getByRole("button", { name: /More actions for / }).first().click(); } }],
  ["showcase", "/", ["desktop", "mobile"], { element: "#models" }],
  ["guarantee", "/guarantee", ["desktop", "mobile"], { fullPage: true }],
  ["privacy", "/privacy", ["desktop"], { fullPage: true }],
  ["account-deletion", "/account-deletion", ["desktop", "mobile"], { fullPage: true }],
  ["sources", "/sources", ["desktop"], { fullPage: true }],
  ["footer", "/guarantee", ["desktop", "mobile", "narrow"], { element: "footer" }],
  ["footer-home", "/", ["desktop", "mobile"], { element: "footer" }],
  ["terms", "/terms", ["desktop"], {}],
  ["apps", "/apps", ["desktop", "mobile"], {}],
  ["android", "/android", ["desktop"], {}],
];

const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
const state = { signedIn: false, emptyLibrary: false, images: false, onboarding: false };
const server = serve(state);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, route, viewports, options] of SHOTS) {
    if (only && !only.includes(name)) continue;
    for (const viewport of viewports) {
      const file = `${name}-${viewport}.png`;
      state.signedIn = route.startsWith("/app");
      state.emptyLibrary = Boolean(options.emptyLibrary);
      const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
      await context.addInitScript(() => { try { localStorage.setItem("vibhavgpt-theme", "light"); localStorage.setItem("vibhavgpt-theme-chosen", "1"); } catch {} });
      const page = await context.newPage();
      for (const [pattern, handler] of Object.entries(options.routes ?? {})) await page.route(pattern, handler);
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(1400);
      if (options.act) {
        try { await options.act(page); } catch (error) { console.log(`  (${file}: ${String(error.message).split("\n")[0]})`); }
        await page.waitForTimeout(700);
      }
      if (options.element) {
        const target = page.locator(options.element).first();
        if (await target.count()) {
          await target.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(400);
          await target.screenshot({ path: path.join(outDir, file) });
        } else console.log(`  (${file}: ${options.element} not found)`);
      } else {
        await page.screenshot({ path: path.join(outDir, file), fullPage: Boolean(options.fullPage) });
      }
      console.log(`captured ${file}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
