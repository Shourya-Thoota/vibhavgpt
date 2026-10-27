import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDesktopApp, visibleAppLinks, WINDOWS_DOWNLOAD_PATH } from "../frontend/src/desktop-app.js";
import { SOURCE_REPO_URL } from "../frontend/src/source-repo.js";

// The Resources section of the web sidebar: where the old Apps section sat, above the
// history, with three plain links (Apps, Sources, Merch Store). Most of these tests
// render the real Sidebar to markup (react-dom/server) and read the anchors'
// attributes; a few read source text, and say so.
//
// WHAT THIS DOES NOT PROVE: rendered markup is not a click, a new tab, or a layout.
// Nothing here opens the store, checks spacing, focus rings or touch targets on a
// phone, or shows how the Windows app or the Android app handle the links. Those
// need a real browser and the real apps (see the manual checks in the change notes).
const STORE = "https://store.vibhavgpt.com";
const BROWSER_ORDER = ["Apps", "Sources", "Merch Store"];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadSidebar() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import Sidebar from "./components/Sidebar.jsx";
        const noop = () => {};
        export const render = (props) => renderToStaticMarkup(<Sidebar api={async () => ({ conversations: [], groups: [] })} user={{ name: "Ada Learner", email: "ada@example.com" }}
          appearance={{}} rail={false} sidebarOpen={false} setSidebarOpen={noop} setCollapsed={noop} brand={<span>VibhavGPT</span>} tierKey="free" tierLabel="Free"
          page="chat" go={noop} newChat={noop} newChatInGroup={noop} openConversation={noop} onOpenImageSession={noop} onOpenWritingTools={noop} onSignOut={noop} {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  const dir = mkdtempSync(join(tmpdir(), "sidebar-resources-"));
  try {
    const file = join(dir, "sidebar.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file).render;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const render = await loadSidebar();

// The Resources section's anchors, as plain objects: attributes, visible label text, and whether the icon is hidden from assistive tech.
function resources(html) {
  const nav = /<nav class="sidebar__nav sidebar__apps" aria-label="Resources">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? null;
  if (!nav) return null;
  const anchors = [...nav.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => {
    const attribute = (name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
    return {
      href: attribute("href"), className: attribute("class"), target: attribute("target"), rel: attribute("rel"),
      title: attribute("title"), ariaLabel: attribute("aria-label"), railLabel: attribute("data-rail-label"),
      label: /<span>([^<]*)<\/span>/.exec(inner)?.[1] ?? null,
      iconHidden: /<svg[^>]*aria-hidden="true"/.test(inner),
      visibleText: inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim(),
    };
  });
  return { nav, heading: /<span class="sidebar__apps-label">([^<]*)<\/span>/.exec(nav)?.[1] ?? null, anchors, labels: anchors.map((anchor) => anchor.label ?? anchor.ariaLabel) };
}
const merch = (group) => group.anchors.find((anchor) => anchor.href === STORE);

// Sets a browser-like global for one render and restores it, so the Electron checks never leak.
async function withGlobals(values, work) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { return await work(); } finally {
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test("the Resources section sits where Apps did, headed Resources, with Apps, Sources and Merch Store in that order", () => {
  const html = render({ variant: "chat", rail: false });
  const group = resources(html);
  assert.equal(group.heading, "Resources", "the section heading");
  assert.deepEqual(group.labels, BROWSER_ORDER);
  const at = (needle) => { const index = html.indexOf(needle); assert.ok(index >= 0, needle); return index; };
  assert.ok(at('href="/app/billing"') < at('aria-label="Resources"') && at('aria-label="Resources"') < at('class="conversation-history'), "after the Chat/Memory/Plan nav and above the history");
  assert.equal(html.split('aria-label="Resources"').length - 1, 1, "one Resources navigation");
});

test("the five old entries are gone: no Android, Windows, Source code or YouTube link in the sidebar", () => {
  const html = render({ variant: "chat", rail: false });
  for (const gone of ['href="/android"', 'href="/vibhavgpt-windows"', SOURCE_REPO_URL, "youtube.com", ">Source code<", ">YouTube<", ">Android<", ">Windows<"]) {
    assert.equal(html.includes(gone), false, `no ${gone}`);
  }
  assert.equal(resources(html).anchors.length, 3, "five links became three");
});

test("Apps and Sources are plain internal links in the same class as before, with no new-tab rules", () => {
  const group = resources(render({ variant: "chat", rail: false }));
  for (const [href, label] of [["/apps", "Apps"], ["/sources", "Sources"]]) {
    const anchor = group.anchors.find((candidate) => candidate.href === href);
    assert.ok(anchor, `${label} link`);
    assert.equal(anchor.label, label);
    assert.equal(anchor.className, "sidebar__link", "the same class the old Apps links had");
    assert.equal(anchor.target, undefined, `${label} opens in the same tab, like the download pages did`);
    assert.equal(anchor.rel, undefined);
    assert.equal(anchor.ariaLabel, undefined, "the visible text is the name");
    assert.equal(anchor.iconHidden, true);
  }
});

test("the expanded Merch Store link is a labelled, safe new-tab link with a hidden icon and an explicit name", () => {
  const html = render({ variant: "chat", rail: false });
  const link = merch(resources(html));
  assert.equal(link.href, "https://store.vibhavgpt.com");
  assert.equal(link.label, "Merch Store", "the visible label");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer", "no opener, no referrer");
  assert.equal(link.className, "sidebar__link", "the same class as its siblings");
  assert.equal(link.iconHidden, true, "the icon stays out of the accessible name");
  assert.equal(link.ariaLabel, "Merch Store", "an explicit accessible name");
  assert.equal(link.title, undefined, "no native tooltip: the rail has its own, for hover and focus");
  assert.equal(html.split(STORE).length - 1, 1, "the address appears once in the whole sidebar");
});

test("the collapsed rail names every Resources link explicitly, with no heading and no visible label", () => {
  const group = resources(render({ variant: "chat", rail: true }));
  assert.equal(group.heading, null, "no heading in the rail");
  assert.equal(group.anchors.length, 3);
  for (const anchor of group.anchors) {
    assert.ok(anchor.ariaLabel, `${anchor.href}: an explicit accessible name`);
    assert.equal(anchor.railLabel, anchor.ariaLabel, `${anchor.href}: the tooltip text is the same name`);
    assert.equal(anchor.title, undefined, `${anchor.href}: no native title doubling the tooltip`);
    assert.equal(anchor.label, null, `${anchor.href}: no label span`);
    assert.equal(anchor.visibleText, "", `${anchor.href}: nothing visible but the icon`);
    assert.equal(anchor.iconHidden, true);
  }
  assert.deepEqual(group.labels, BROWSER_ORDER, "the same order, named explicitly");
  assert.equal(merch(group).target, "_blank");
  assert.equal(merch(group).rel, "noopener noreferrer");
});

test("the mobile drawer shows the same Resources section, labelled", () => {
  // The drawer is this same Sidebar, with the rail always off and the drawer open.
  const html = render({ variant: "chat", rail: false, sidebarOpen: true });
  assert.match(html, /^<aside class="sidebar" data-open="true" data-variant="chat"/);
  const group = resources(html);
  assert.equal(group.heading, "Resources");
  assert.deepEqual(group.labels, BROWSER_ORDER);
  assert.equal(merch(group).ariaLabel, "Merch Store");
  assert.equal(merch(group).target, "_blank");
  assert.equal(html.split("sidebar__apps").length - 1, 2, "one section: its class and its heading, not a mobile copy beside a desktop copy");
});

test("Study and Image keep their previous placement: no Resources section, no store link, no chat-only additions", () => {
  // The old Apps section was Chat-only, and so is this one. Study and Image stay as they were:
  // Study has New session, Writing Tools and its history; Image has its history alone.
  for (const variant of ["study", "image"]) {
    const html = render({ variant });
    assert.equal(resources(html), null, `${variant}: no Resources section`);
    assert.equal(html.includes(STORE), false, `${variant}: no store address`);
    assert.equal(html.includes('href="/apps"') || html.includes('href="/sources"'), false, `${variant}: no Apps or Sources link`);
  }
  assert.match(render({ variant: "study" }), /New study session/);
  assert.match(render({ variant: "study" }), /Writing Tools/);
  assert.equal(render({ variant: "image" }).includes("sidebar__new"), false, "Image still has no New button of its own");
});

test("a browser on Windows is not the desktop app: every link shows", async () => {
  const windowsBrowser = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };
  const electronAgent = { platform: "Win32", userAgent: `${windowsBrowser.userAgent} Electron/33.0.0` };
  assert.equal(isDesktopApp({ navigator: windowsBrowser }), false, "Windows alone is not the desktop app");
  assert.equal(isDesktopApp({ navigator: electronAgent }), false, "nor is a user agent: only the app's own preload counts");
  assert.equal(isDesktopApp({ desktop: { isDesktop: false } }), false);
  for (const navigator of [windowsBrowser, electronAgent]) {
    const labels = await withGlobals({ navigator }, () => resources(render({ variant: "chat" })).labels);
    assert.deepEqual(labels, BROWSER_ORDER);
  }
});

test("inside the Electron desktop app Apps and Merch Store are hidden, expanded and in the rail, and Sources stays", async () => {
  for (const preload of [{ desktopAPI: {} }, { desktop: { isDesktop: true, platform: "win32" } }]) {
    for (const rail of [false, true]) {
      const group = await withGlobals(preload, () => resources(render({ variant: "chat", rail })));
      const where = `${Object.keys(preload)[0]} preload, rail ${rail}`;
      assert.deepEqual(group.labels, ["Sources"], where);
      assert.equal(group.anchors.some((anchor) => anchor.href === STORE), false, `${where}: no store link`);
      assert.equal(group.anchors.some((anchor) => anchor.href === "/apps"), false, `${where}: no Apps link`);
      assert.equal(group.anchors.some((anchor) => anchor.href === WINDOWS_DOWNLOAD_PATH), false, `${where}: no Windows download link`);
      assert.equal(group.anchors[0].target, undefined, `${where}: Sources is an internal page`);
    }
  }
  assert.equal(render({ variant: "chat" }).includes(STORE), true, "and a browser render afterwards is unaffected");
});

test("visibleAppLinks drops webOnly links only in the desktop app, and never changes the list it is given", () => {
  const list = Object.freeze([
    Object.freeze({ href: "/apps", label: "Apps", webOnly: true }),
    Object.freeze({ href: "/sources", label: "Sources" }),
    Object.freeze({ href: STORE, label: "Merch Store", external: true, webOnly: true }),
    Object.freeze({ href: WINDOWS_DOWNLOAD_PATH, label: "Windows" }),
    Object.freeze({ href: "https://example.com/kept", label: "Kept", webOnly: false }),
  ]);
  const before = JSON.stringify(list);
  assert.deepEqual(visibleAppLinks(list, true).map((link) => link.label), ["Sources", "Kept"], "desktop app");
  assert.deepEqual(visibleAppLinks(list, false).map((link) => link.label), ["Apps", "Sources", "Merch Store", "Windows", "Kept"], "browser");
  assert.equal(JSON.stringify(list), before, "the input list is untouched");
  assert.equal(list.length, 5);
  assert.deepEqual(visibleAppLinks([], true), []);
});

// Source-text checks (not rendering): the fixed addresses, the entries, and the documented meaning of webOnly.
test("source: the addresses are fixed in code, Apps and the store are flagged webOnly, and webOnly is documented as desktop-app-only", () => {
  const sidebar = read("frontend/src/components/Sidebar.jsx");
  assert.match(sidebar, /const MERCH_STORE_URL = "https:\/\/store\.vibhavgpt\.com";/);
  assert.match(sidebar, /const APPS_HUB_PATH = "\/apps";/);
  assert.match(sidebar, /const SOURCES_PATH = "\/sources";/);
  const entries = sidebar.slice(sidebar.indexOf("const RESOURCE_LINKS = ["), sidebar.indexOf("];", sidebar.indexOf("const RESOURCE_LINKS = [")));
  assert.deepEqual([...entries.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]), BROWSER_ORDER);
  assert.match(entries, /\{ href: APPS_HUB_PATH, label: "Apps", icon: <LayoutGrid size=\{17\} strokeWidth=\{1\.9\} \/>, webOnly: true \}/);
  assert.match(entries, /\{ href: SOURCES_PATH, label: "Sources", icon: <Code size=\{17\} strokeWidth=\{1\.9\} \/> \}/, "Sources is not webOnly: it stays in the desktop app");
  assert.match(entries, /\{ href: MERCH_STORE_URL, label: "Merch Store", icon: <ShoppingBag size=\{17\} strokeWidth=\{1\.9\} \/>, external: true, webOnly: true/);
  assert.doesNotMatch(sidebar, /fetch\([^)]*store\.vibhavgpt|store\.vibhavgpt[^"']*\?utm|sendBeacon|analytics/i, "no requests to the store and no tracking");
  assert.doesNotMatch(sidebar, /youtube\.com|github\.com|SOURCE_REPO_URL/i, "the repository and channel addresses live on the Sources page, not here");
  const desktop = read("frontend/src/desktop-app.js");
  assert.match(desktop, /webOnly[\s\S]{0,400}Electron desktop app[\s\S]{0,400}not[\s\S]{0,200}Android/i, "webOnly's meaning is documented, including that it says nothing about Android");
  assert.doesNotMatch(desktop, /navigator|userAgent|platform\s*===/, "desktop detection is not broadened");
});
