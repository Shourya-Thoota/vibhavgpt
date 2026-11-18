// Captures the built site for design review, with production's routes and a
// synthetic API. Nothing here reaches the network or a real account.
//
//   node scripts/design-capture.mjs <outDir> [--only=name1,name2] [--contrast]
//
// Serves frontend/dist the way the Caddyfile does (/ and /home are the static
// homepage, /pricing and the legal pages are prerendered, everything else is
// the app), and answers /api with fixed fixtures for a fictitious account.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { auditContrast } from "./contrast-audit.mjs";

const dist = path.resolve("frontend/dist");
const outDir = path.resolve(process.argv[2] ?? "design-shots");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
// --contrast also measures every visible run of text in each state against
// WCAG AA (scripts/contrast-audit.mjs) and writes contrast.json beside the shots.
const contrast = process.argv.includes("--contrast");
const contrastReport = {};
// Imported (by design-walkthrough.mjs) for its fixtures, it captures nothing.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) fs.mkdirSync(outDir, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg" };
const STATIC_DIRS = { "/": "home/index.html", "/home": "home/index.html", "/apps": "apps/index.html", "/sources": "sources/index.html", "/android": "android/index.html", "/vibhavgpt-windows": "vibhavgpt-windows/index.html" };
const ENTRY = { "/pricing": "pricing.html", "/terms": "terms.html", "/privacy": "privacy.html", "/guarantee": "guarantee.html", "/account-deletion": "account-deletion.html" };

export const CONVERSATION_ID = "5b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";
export const STUDY_ID = "6c2d3e4f-5061-4b72-8c83-ad9e8f7a6b51";
const PROJECT_ID = "8e4f5061-7283-4d94-aea5-cfb0ab9c8d73";
const CONVERSATIONS = [
  { id: CONVERSATION_ID, title: "Orbital resonance, explained", model: "lumen", mode: "chat", groupId: PROJECT_ID, updatedAt: "2026-10-30T15:00:00.000Z" },
  { id: STUDY_ID, title: "Jupiter's moons: cards and quiz", model: "study", mode: "study", updatedAt: "2026-10-29T15:00:00.000Z" },
  { id: "7d3e4f50-6172-4c83-9d94-beaf9a8b7c62", title: "Trip budget table", model: "lumen", mode: "chat", updatedAt: "2026-10-28T15:00:00.000Z" },
  { id: "9f506172-8394-4ea5-bfb6-d0c1bcad9e84", title: "Essay outline: tides", model: "lumen", mode: "chat", updatedAt: "2026-10-20T15:00:00.000Z" },
  { id: "a0617283-94a5-4fb6-80c7-e1d2cdbeaf95", title: "Flowchart: how a bill becomes law", model: "lumen", mode: "chat", updatedAt: "2026-10-12T15:00:00.000Z" },
];
// Image results for layout review only: the site's own existing images,
// served from /public, standing in for a gallery. No generation is called.
const IMAGES = [
  { id: "img-1", name: "Earth from orbit", prompt: "Earth from low orbit at dawn", previewUrl: "/planets/earth.webp", downloadUrl: "/planets/earth.webp", meta: { aspectRatio: "square", style: "photo" }, createdAt: "2026-10-30T10:00:00.000Z" },
  { id: "img-2", name: "Mars at noon", prompt: "Mars in full sunlight", previewUrl: "/planets/mars.webp", downloadUrl: "/planets/mars.webp", meta: { aspectRatio: "square" }, createdAt: "2026-10-29T10:00:00.000Z" },
  { id: "img-3", name: "VibhavGPT mark", prompt: "The VibhavGPT logo on a light ground", previewUrl: "/brand/vibhavgpt-logo.png", downloadUrl: "/brand/vibhavgpt-logo.png", meta: { aspectRatio: "landscape" }, createdAt: "2026-10-28T10:00:00.000Z" },
  { id: "img-4", name: "Venus in haze", prompt: "Venus wrapped in cloud", previewUrl: "/planets/venus.webp", downloadUrl: "/planets/venus.webp", meta: { aspectRatio: "square" }, createdAt: "2026-10-27T10:00:00.000Z" },
];
const GROUPS = [{ id: PROJECT_ID, kind: "project", mode: "chat", parentId: null, name: "Astronomy course", instructions: "Explain with worked numbers.", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" }];
const FENCE = "```";
const STUDY_HISTORY = [
  { id: "s1", role: "user", content: "Make flashcards and a short quiz from my notes on Jupiter's moons, then draw why Io has volcanoes.", createdAt: "2026-10-29T14:58:00.000Z" },
  { id: "s2", role: "assistant", model: "study", content: [
    "Here are three cards, a two-question quiz and the flowchart.",
    "",
    FENCE + "flashcards",
    JSON.stringify({ title: "Jupiter's moons", cards: [{ front: "Io", back: "Innermost of the three large moons. Tidal flexing drives its volcanoes." }, { front: "Europa", back: "Likely hides an ocean under its ice." }, { front: "Ganymede", back: "The largest moon in the solar system." }] }),
    FENCE,
    "",
    FENCE + "quiz",
    JSON.stringify({ title: "Jupiter's moons", questions: [{ question: "Which moon is heated most by tidal flexing?", options: ["Io", "Europa", "Ganymede", "Callisto"], answer: 0, explanation: "The resonance keeps Io's orbit oval, so Jupiter flexes it." }, { question: "Which moon is the largest in the solar system?", options: ["Titan", "Ganymede", "Io"], answer: 1, explanation: "Ganymede is larger than the planet Mercury." }] }),
    FENCE,
    "",
    FENCE + "mermaid",
    "flowchart TD",
    "  A[Laplace resonance] --> B[Oval orbit]",
    "  B --> C[Tidal flexing]",
    "  C --> D[Volcanoes on Io]",
    FENCE,
  ].join("\n"), createdAt: "2026-10-29T14:58:20.000Z" },
];
const HISTORY = [
  { id: "m1", role: "user", content: "Why do Jupiter's moons Io, Europa and Ganymede line up in a 1:2:4 pattern?", createdAt: "2026-10-30T14:58:00.000Z" },
  { id: "m2", role: "assistant", model: "lumen", content: [
    "That pattern is called a **Laplace resonance**. For every orbit Ganymede completes, Europa completes two and Io completes four.",
    "",
    "### Why it holds",
    "1. Each moon tugs on its neighbours at the same points in every cycle, so the pulls add up instead of cancelling.",
    "2. Those repeated pulls keep the orbits slightly oval, which also heats Io from the inside.",
    "",
    "| Moon | Orbital period | Ratio |",
    "| --- | --- | --- |",
    "| Io | 1.77 days | 1 |",
    "| Europa | 3.55 days | 2 |",
    "| Ganymede | 7.15 days | 4 |",
    "",
    "```python",
    "periods = {\"Io\": 1.769, \"Europa\": 3.551, \"Ganymede\": 7.155}",
    "print({moon: round(p / periods['Io'], 2) for moon, p in periods.items()})",
    "```",
  ].join("\n"), createdAt: "2026-10-30T14:58:20.000Z" },
  { id: "m3", role: "user", content: "Does the resonance change over time?", createdAt: "2026-10-30T14:59:00.000Z" },
  { id: "m4", role: "assistant", model: "lumen", content: "Slowly. Tides between Jupiter and Io move energy outward, and the resonance passes that change on to Europa and Ganymede, which is why the three stay locked together.\n\nOver millions of years the ratio holds while each orbit drifts a little.", createdAt: "2026-10-30T14:59:20.000Z" },
];

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
function api(req, res, url, state) {
  const p = url.pathname;
  // The social sign-in providers set up (Slice 8): Google, as production has today, unless a test or capture says otherwise.
  if (p === "/api/sign-in-options") return json(res, 200, { socialProviders: state.socialProviders ?? ["google"] });
  if (p === "/api/me") return state.signedIn ? json(res, 200, { user: { id: "usr_design_sample", name: "Avery Sample", email: "avery@example.com", surveyCompleted: !state.onboarding } }) : json(res, 401, { error: "Sign in is required." });
  if (p === "/api/usage") {
    // The server's own shape: per-model allowances (limits), the tokens counted in the month and in the rolling window, and the
    // moment the rolling window next frees tokens. Plus-plan caps from the product data; the usage is made up for the screen.
    const release = new Date(Date.now() + (2 * 60 + 10) * 60_000).toISOString();
    return json(res, 200, {
      tier: "plus",
      limits: { lumen: { monthly: 8_000_000, rolling: 800_000 }, nova: { monthly: 8_000_000, rolling: 800_000 }, study: { monthly: 4_000_000, rolling: 400_000 }, nebula: { monthly: 1_500_000, rolling: 150_000 }, vesper: { monthly: 300_000, rolling: 30_000 } },
      tokenBreakdown: { lumen: { total: 120000 }, nova: { total: 340000 }, study: { total: 80000 } },
      rollingTokenBreakdown: { lumen: { total: 12000 }, nova: { total: 96000 } },
      reservedTokenBreakdown: {}, rollingReservedTokenBreakdown: {},
      nextMonthlyTokenReleaseAt: {}, nextRollingTokenReleaseAt: { nova: release },
      periodStart: "2026-11-01T00:00:00.000Z", periodEndsAt: "2026-12-01T00:00:00.000Z", rollingWindowHours: 5, periodType: "calendar-month",
      imageGenerationsThisPeriod: 4, imageLimit: 25, documentGenerationsThisPeriod: 2, documentLimit: 20, imagePeriodEndsAt: "2026-11-15T00:00:00.000Z",
      creditBalance: 0,
    });
  }
  if (p.startsWith("/api/profile")) return json(res, 200, { preferredModel: "lumen", lastUsedModel: "lumen", thinkingEffort: "low", responseStyle: "balanced", customInstructions: "", memoryEnabled: true });
  if (p === "/api/chat/conversations") return json(res, 200, { conversations: state.emptyLibrary ? [] : CONVERSATIONS });
  if (p === "/api/chat/groups") return json(res, 200, { groups: state.emptyLibrary ? [] : GROUPS });
  if (p.startsWith(`/api/chat/conversations/${STUDY_ID}`)) return json(res, 200, { conversation: CONVERSATIONS[1], history: STUDY_HISTORY, hasMore: false, nextCursor: null });
  if (p.startsWith("/api/generation/images")) return json(res, 200, { images: state.images ? IMAGES : [], nextCursor: null });
  if (p === "/api/generation/image-folders") return json(res, 200, { folders: [] });
  if (p.startsWith(`/api/chat/conversations/${CONVERSATION_ID}`)) return json(res, 200, { conversation: CONVERSATIONS[0], history: HISTORY, hasMore: false, nextCursor: null });
  if (p === "/api/billing/subscription") return json(res, 200, { subscription: { tier: "plus", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-11-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: false });
  if (p === "/api/billing/credit-purchases") return json(res, 200, { purchases: [] });
  if (p === "/api/memory" || p.startsWith("/api/memory/")) return json(res, 200, { facts: [], memories: [] });
  if (p === "/api/uploads/limits") return json(res, 200, { maxSizeBytes: 20971520, allowedMimeTypes: ["image/png", "image/jpeg"] });
  if (p.startsWith("/api/security")) return json(res, 200, { twoFactorEnabled: false, passkeys: [], sessions: [] });
  return json(res, 404, { error: "Not available in the design fixture." });
}

export function serve(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return api(req, res, url, state);
    let rel = STATIC_DIRS[url.pathname.replace(/\/$/, "") || "/"] ?? ENTRY[url.pathname] ?? url.pathname.slice(1);
    let file = path.join(dist, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

const VIEWPORTS = { mobile: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 } };
// name, path, viewport, theme, options
export const SHOTS = [
  ["home", "/", "desktop", "light"], ["home", "/", "tablet", "light"], ["home", "/", "mobile", "light"],
  ["home-dark", "/", "desktop", "dark"], ["home-dark", "/", "mobile", "dark"],
  ["home-reduced", "/", "desktop", "light", { reducedMotion: true, fullPage: true }],
  ["home-full", "/", "desktop", "light", { fullPage: true }],
  ["home-full", "/", "mobile", "light", { fullPage: true }],
  ["pricing", "/pricing", "desktop", "light", { fullPage: true }], ["pricing", "/pricing", "mobile", "light"],
  ["pricing-dark", "/pricing", "desktop", "dark"],
  ["auth-signup", "/signup", "desktop", "light"], ["auth-signup", "/signup", "mobile", "light"], ["auth-signin-dark", "/app", "desktop", "dark"],
  ["workspace-chat", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "light", { signedIn: true }],
  ["workspace-chat-dark", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "dark", { signedIn: true }],
  ["workspace-chat", `/app/chat?conversation=${CONVERSATION_ID}`, "mobile", "light", { signedIn: true }],
  ["workspace-empty", "/app/chat", "desktop", "light", { signedIn: true, emptyLibrary: true }],
  ["workspace-study", "/app/study", "desktop", "light", { signedIn: true }],
  ["settings", "/app/settings/account", "desktop", "light", { signedIn: true }],
  ["settings-dark", "/app/settings/appearance", "desktop", "dark", { signedIn: true }],
  ["usage", "/app/usage", "desktop", "light", { signedIn: true }],
  ["billing", "/app/billing", "desktop", "light", { signedIn: true, fullPage: true }],
  ["legal-terms", "/terms", "desktop", "light"], ["apps", "/apps", "desktop", "light"],
  ["study-widgets", `/app/study?conversation=${STUDY_ID}`, "desktop", "light", { signedIn: true, fullPage: true }],
  ["study-widgets", `/app/study?conversation=${STUDY_ID}`, "mobile", "light", { signedIn: true, scrollThread: "top" }],
  ["image-workspace", "/app/image", "desktop", "light", { signedIn: true }],
  ["image-workspace", "/app/image", "mobile", "light", { signedIn: true }],
  ["image-results", "/app/image", "desktop", "light", { signedIn: true, images: true }],
  ["onboarding", "/app", "desktop", "light", { signedIn: true, onboarding: true }],
  ["onboarding", "/app", "mobile", "light", { signedIn: true, onboarding: true }],
  ["onboarding-question", "/app", "desktop", "light", { signedIn: true, onboarding: true, click: ".survey .btn--primary" }],
  ["onboarding-question", "/app", "mobile", "dark", { signedIn: true, onboarding: true, click: ".survey .btn--primary" }],
  ["onboarding-role", "/app", "desktop", "light", { signedIn: true, onboarding: true, click: ".survey .btn--primary", repeat: 2 }],
  ["onboarding-role", "/app", "mobile", "light", { signedIn: true, onboarding: true, click: ".survey .btn--primary", repeat: 2 }],
  ["onboarding-expertise", "/app", "desktop", "dark", { signedIn: true, onboarding: true, click: ".survey .btn--primary", repeat: 3 }],
  ["onboarding-expertise", "/app", "mobile", "light", { signedIn: true, onboarding: true, click: ".survey .btn--primary", repeat: 3 }],
  ["sheet-mobile", `/app/chat?conversation=${CONVERSATION_ID}`, "mobile", "light", { signedIn: true, click: ".composer__row button:first-child" }],
  ["menu-account", "/app/chat", "desktop", "light", { signedIn: true, click: ".sidebar .account" }],
  ["image-results", "/app/image", "mobile", "light", { signedIn: true, images: true }],
  ["image-inspector", "/app/image", "desktop", "light", { signedIn: true, images: true, click: ".studio-tile__open" }],
  ["writing-tools", "/app/study", "desktop", "light", { signedIn: true, emptyLibrary: true, click: ".study-starters__tool" }],
  ["settings-appearance", "/app/settings/appearance", "desktop", "light", { signedIn: true }],
  ["settings-security", "/app/settings/security", "desktop", "light", { signedIn: true }],
  ["settings-delete", "/app/settings/delete-account", "desktop", "light", { signedIn: true }],
  ["settings", "/app/settings/account", "mobile", "light", { signedIn: true }],
  ["memory", "/app/memory", "desktop", "light", { signedIn: true }],
  ["composer-glass", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "light", { signedIn: true, scrollThread: 230 }],
  ["composer-glass-dark", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "dark", { signedIn: true, scrollThread: 230 }],
  ["model-menu", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "light", { signedIn: true, click: ".composer__model .ui-select__trigger" }],
  ["auth-signup", "/signup", "tablet", "light"], ["auth-signin", "/app", "mobile", "dark"],
  ["legal-privacy", "/privacy", "mobile", "light"], ["guarantee", "/guarantee", "desktop", "light"],
  ["sources", "/sources", "desktop", "light"], ["android", "/android", "desktop", "light"], ["windows", "/vibhavgpt-windows", "desktop", "light"],
  ["account-deletion", "/account-deletion", "desktop", "light"], ["apps", "/apps", "mobile", "light"],
  ["solid-surfaces", `/app/chat?conversation=${CONVERSATION_ID}`, "desktop", "light", { signedIn: true, solid: true, scrollThread: 230 }],
];

// The installed Chrome or Edge, as the browser test suites use (no download needed).
export function systemBrowser() {
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [process.env.BROWSER_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", path.join(local, "Google", "Chrome", "Application", "chrome.exe"), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}
if (isMain) {
  const browser = await chromium.launch({ headless: true, executablePath: systemBrowser() });
  const state = { signedIn: false, emptyLibrary: false, images: false, onboarding: false };
  const server = serve(state);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, route, viewport, theme, options = {}] of SHOTS) {
      const file = `${name}-${viewport}.png`;
      if (only && !only.includes(name)) continue;
      state.signedIn = Boolean(options.signedIn);
      state.emptyLibrary = Boolean(options.emptyLibrary);
      state.images = Boolean(options.images);
      state.onboarding = Boolean(options.onboarding);
      const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1, reducedMotion: options.reducedMotion ? "reduce" : "no-preference", colorScheme: theme });
      await context.addInitScript(([sky, solid]) => { try { localStorage.setItem("vibhavgpt-theme", sky); localStorage.setItem("vibhavgpt-theme-chosen", "1"); if (solid) localStorage.setItem("vibhavgpt-effects", "solid"); } catch {} }, [theme, Boolean(options.solid)]);
      const page = await context.newPage();
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(1600);
      // `repeat` presses the same control again, to step through a flow.
      for (let press = 0; options.click && press < (options.repeat ?? 1); press += 1) { await page.locator(options.click).first().click().catch((error) => console.log(`  (${file}: ${error.message.split("\n")[0]})`)); await page.waitForTimeout(500); }
      if (options.scrollThread) {
        // A number scrolls the thread that far up from its end, so earlier
        // messages pass under the composer; "top" goes to the beginning.
        await page.evaluate((offset) => { const scroller = document.querySelector(".chat__scroll"); if (scroller) scroller.scrollTop = typeof offset === "number" ? scroller.scrollHeight - scroller.clientHeight - offset : 0; }, options.scrollThread);
        await page.waitForTimeout(400);
      }
      await page.screenshot({ path: path.join(outDir, file), fullPage: Boolean(options.fullPage) });
      console.log(`captured ${file}`);
      if (contrast) {
        const failures = await page.evaluate(auditContrast);
        contrastReport[file] = failures;
        for (const f of failures) console.log(`  contrast ${f.ratio}:1 (needs ${f.need}) ${f.ink} on ${f.ground}, ${f.size}px/${f.weight}: "${f.text}" ${f.selector}`);
      }
      await context.close();
    }
    if (contrast) fs.writeFileSync(path.join(outDir, "contrast.json"), `${JSON.stringify(contrastReport, null, 2)}\n`);
  } finally {
    await browser.close();
    server.close();
  }
}
