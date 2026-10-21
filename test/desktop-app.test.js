import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DESKTOP_APP_CLASS, isDesktopApp, markDesktopApp, visibleAppLinks, WINDOWS_DOWNLOAD_PATH } from "../frontend/src/desktop-app.js";

// Inside the Windows app the sidebar drops its own "Windows" download link,
// and <body> gets .is-desktop-app, which turns on a few playful touches
// (desktop.css). In a browser neither happens.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const LINKS = [
  { href: "/android", label: "Android" },
  { href: WINDOWS_DOWNLOAD_PATH, label: "Windows" },
  { href: "https://github.com/Shourya-Thoota/vibhavgpt", label: "Source code" },
];

test("the desktop app is recognised by its preload, and a browser is not", () => {
  assert.equal(isDesktopApp({}), false, "a browser: no desktopAPI, no desktop");
  assert.equal(isDesktopApp({ desktop: { isDesktop: true, platform: "win32" } }), true, "1.1.x exposes window.desktop");
  assert.equal(isDesktopApp({ desktopAPI: {} }), true, "1.2.0 and later also expose window.desktopAPI");
  assert.equal(isDesktopApp({ desktop: { isDesktop: false } }), false);
});

test("the Windows link shows on the web and is hidden in the desktop app", () => {
  assert.deepEqual(visibleAppLinks(LINKS, isDesktopApp({})).map((link) => link.label), ["Android", "Windows", "Source code"]);
  assert.deepEqual(visibleAppLinks(LINKS, isDesktopApp({ desktopAPI: {} })).map((link) => link.label), ["Android", "Source code"]);
  const sidebar = read("frontend/src/components/Sidebar.jsx");
  assert.match(sidebar, /\{ href: WINDOWS_DOWNLOAD_PATH, label: "Windows"/);
  assert.match(sidebar, /\{visibleAppLinks\(APP_LINKS\)\.map\(\(link\) =>/);
  assert.equal(WINDOWS_DOWNLOAD_PATH, "/vibhavgpt-windows");
});

test("the YouTube channel sits last in the Apps links and opens safely in a new tab", () => {
  const sidebar = read("frontend/src/components/Sidebar.jsx");
  assert.match(sidebar, /const YOUTUBE_CHANNEL_URL = "https:\/\/www\.youtube\.com\/@vibhavthoota";/);
  const links = sidebar.slice(sidebar.indexOf("const APP_LINKS = ["), sidebar.indexOf("];", sidebar.indexOf("const APP_LINKS = [")));
  assert.deepEqual([...links.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]), ["Android", "Windows", "Source code", "YouTube"]);
  assert.match(links, /\{ href: YOUTUBE_CHANNEL_URL, label: "YouTube", icon: <YoutubeIcon size=\{17\} strokeWidth=\{1\.9\} \/>, external: true \}/, "the same size and stroke as its neighbours");
  assert.match(sidebar, /\{\.\.\.\(link\.external \? \{ target: "_blank", rel: "noopener noreferrer" \} : \{\}\)\}/, "external links open in a new tab without an opener");
  assert.match(sidebar, /function YoutubeIcon\(\{ size = 24, strokeWidth = 2 \}\)[\s\S]*?stroke="currentColor"[\s\S]*?aria-hidden="true"/, "inherits the link colour and stays out of the accessible name");
  const youtube = { href: "https://www.youtube.com/@vibhavthoota", label: "YouTube" };
  assert.deepEqual(visibleAppLinks([...LINKS, youtube], isDesktopApp({ desktopAPI: {} })).map((link) => link.label), ["Android", "Source code", "YouTube"], "kept in the desktop app");
});

test("only the desktop app's <body> is marked, before the app renders", () => {
  const classes = new Set();
  const page = (extra) => ({ ...extra, document: { body: { classList: { add: (name) => classes.add(name) } } } });
  assert.equal(markDesktopApp(page({})), false);
  assert.equal(classes.size, 0, "the web is untouched");
  assert.equal(markDesktopApp(page({ desktop: { isDesktop: true } })), true);
  assert.deepEqual([...classes], [DESKTOP_APP_CLASS]);
  assert.equal(DESKTOP_APP_CLASS, "is-desktop-app");
  const main = read("frontend/src/main.jsx");
  assert.ok(main.indexOf("markDesktopApp();") > 0 && main.indexOf("markDesktopApp();") < main.indexOf("createRoot("), "marked before the first render");
});

test("the playful touches live only under .is-desktop-app, move only transform and opacity, and respect reduced motion", () => {
  const css = read("frontend/src/desktop.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const playful = css.slice(css.indexOf(".is-desktop-app {"));
  const media = playful.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/);
  assert.ok(media, "every hover and animation sits inside prefers-reduced-motion: no-preference");
  for (const [, selectors] of media[1].matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of selectors.split(",")) assert.match(selector.trim(), /^\.is-desktop-app\s/, selector.trim());
  }
  // What moves: the individual transform properties and opacity only.
  for (const [, name, body] of css.matchAll(/@keyframes (desktop-[\w-]+) \{([\s\S]*?\})\s*\}/g)) {
    for (const [, property] of body.matchAll(/([a-z-]+):/g)) assert.ok(["scale", "rotate", "translate", "opacity"].includes(property), `${name} animates ${property}`);
  }
  assert.match(css, /--desktop-spring: cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/);
  for (const piece of [".opening__planet:hover", ".sidebar__new:hover", ".sidebar .ui-icon-button:hover", ".sidebar__brand:hover img", ".sidebar__brand:hover::after", '.composer[data-send-pulse="odd"]', '.composer[data-send-pulse="even"]']) {
    assert.ok(media[1].includes(`.is-desktop-app ${piece}`), piece);
  }
  // No other stylesheet mentions the desktop class, so nothing leaks to the web.
  const sheets = readdirSync(new URL("../frontend/src/", import.meta.url)).filter((name) => name.endsWith(".css") && name !== "desktop.css");
  for (const sheet of sheets) assert.doesNotMatch(read(`frontend/src/${sheet}`), /is-desktop-app/, sheet);
  assert.doesNotMatch(css, /—/);
});

test("each send flips the composer's pulse so its pop restarts, and only real sends count", () => {
  const app = read("frontend/src/App.jsx");
  assert.equal(app.match(/data-send-pulse=\{sendPulse \? \(sendPulse % 2 \? "odd" : "even"\) : undefined\}/g)?.length, 2, "both composer layouts");
  const send = app.slice(app.indexOf("async function send(event) {"), app.indexOf("function startTurn("));
  assert.ok(send.indexOf("setSendPulse((count) => count + 1);") > send.indexOf("if (visionModelRequired)"), "counted only once the message will go");
});
