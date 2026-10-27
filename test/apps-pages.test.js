import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PUBLIC_PAGES, pageStructuredData, SITE_ORIGIN } from "../frontend/src/public-pages.js";
import { SOURCE_REPO_URL } from "../frontend/src/source-repo.js";
import { detailsHtml, updateMetadata } from "../frontend/scripts/public-html.js";

// The Apps hub (/apps) and the refreshed Android and Windows pages.
//
// These read the source pages and run the project's own metadata and FAQ builders
// over them, the way the prerender step does. WHAT THIS DOES NOT PROVE: nothing here
// renders a page, follows a link, starts a download or checks a layout. The built
// output (npm run build --prefix frontend, which also runs verify-public.js), the
// served routes, the three pages' appearance at each size in both themes, contrast
// and the 44px targets were checked separately in a real browser (see the change notes).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hub = read("frontend/public/apps/index.html");
const android = read("frontend/public/android/index.html");
const windows = read("frontend/public/vibhavgpt-windows/index.html");
const css = read("frontend/src/apps-pages.css");

const APK = "https://github.com/Shourya-Thoota/vibhavgpt-releases/releases/latest/download/vibhavgpt-android.apk";
const EXE = "https://github.com/Shourya-Thoota/vibhavgpt-releases/releases/latest/download/VibhavGPT-Setup-x64.exe";
const attr = (tag, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
const anchors = (html) => [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({
  href: attr(attributes, "href"), download: attr(attributes, "download"), className: attr(attributes, "class"),
  text: inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
}));
const body = (html) => html.slice(html.indexOf("<body"));
const visibleWords = (html) => body(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ").split(/\s+/).filter(Boolean).length;

// --- Registry and metadata (the real builders) ---------------------------------

test("/apps is a registered public page with accurate, length-checked metadata and real FAQs", () => {
  const page = PUBLIC_PAGES["/apps"];
  assert.ok(page);
  assert.equal(page.title, "VibhavGPT Apps: Official Android and Windows Downloads");
  assert.ok(page.description.length >= 150 && page.description.length <= 160, `description is ${page.description.length} characters`);
  assert.ok(page.description.endsWith("Made by Vibhav Thoota."));
  assert.ok(page.faq.length >= 3);
  for (const [question, answer] of page.faq) assert.ok(question.endsWith("?") && answer.length > 120, question);
  assert.doesNotMatch(JSON.stringify(page), /[\u2013\u2014]/, "no en or em dashes in the copy");
  assert.doesNotMatch(JSON.stringify(page.faq), /\bios\b|iphone|macos|\bmac\b|linux|\d+\.\d+\.\d+|\bMB\b|rating|users? love/i, "no unsupported platforms, versions, sizes or claims");
});

test("the hub composes like the prerender step: one title, canonical, h1, schema graph, FAQ block and 300+ visible words", () => {
  let html = updateMetadata(hub, "/apps");
  html = html.replace("<!-- public-faq -->", detailsHtml("/apps").faq);
  assert.equal(html.match(/<title>/g).length, 1);
  assert.ok(html.includes(`<title>${PUBLIC_PAGES["/apps"].title}</title>`));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/apps">`));
  assert.equal(body(html).match(/<h1(\s|>)/g).length, 1);
  assert.match(body(html), /<h1>VibhavGPT apps<\/h1>/);
  const [graph] = [...html.matchAll(/<script id="vibhavgpt-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  const types = graph["@graph"].map((node) => node["@type"]);
  for (const type of ["Organization", "WebSite", "SoftwareApplication", "BreadcrumbList", "FAQPage"]) assert.ok(types.includes(type), type);
  assert.match(body(html), /Questions and answers/);
  assert.equal(body(html).match(/<h3>/g).length, PUBLIC_PAGES["/apps"].faq.length);
  assert.ok(visibleWords(html) >= 300, `${visibleWords(html)} visible words`);
  assert.match(body(html), /<footer\b[^>]*>[\s\S]*?Made by Vibhav Thoota[\s\S]*?<\/footer>/);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']http:\/\//i);
});

test("the structured data names Web, Android and Windows on every public page", () => {
  for (const path of ["/home", "/apps", "/android", "/vibhavgpt-windows", "/pricing"]) {
    const software = pageStructuredData(path)["@graph"].find((node) => node["@type"] === "SoftwareApplication");
    assert.equal(software.operatingSystem, "Web, Android, Windows", path);
  }
});

// --- The hub's content ---------------------------------------------------------

test("the hub offers both platforms, each with install steps first and the exact existing direct download second", () => {
  const links = anchors(body(hub));
  const byText = Object.fromEntries(links.map((link) => [link.text, link]));
  assert.equal(byText["See Android install steps"].href, "/android");
  assert.equal(byText["See Windows install steps"].href, "/vibhavgpt-windows");
  assert.equal(byText["Download the APK directly"].href, APK);
  assert.equal(byText["Download the APK directly"].download, "vibhavgpt-android.apk");
  assert.equal(byText["Download the installer directly"].href, EXE);
  assert.equal(byText["Download the installer directly"].download, "VibhavGPT-Setup-x64.exe");
  assert.equal(byText["Open workspace"].href, "/app");
  assert.equal(byText["Use VibhavGPT in your browser"].href, "/app");
  // The same two addresses the platform pages download from.
  assert.equal(anchors(android).find((link) => link.className === "download").href, APK);
  assert.equal(anchors(windows).find((link) => link.className === "download").href, EXE);
  // The destination of each button is explained, in words.
  assert.match(hub, /The steps page has the requirements and the file checksum\. The direct link starts the download at once\./);
  assert.match(hub, /The steps page explains the Windows security prompt and has the file checksum\./);
});

test("both platform cards are always in the page, and no script can hide or add one", () => {
  for (const platform of ["android", "windows"]) assert.match(hub, new RegExp(`<article class="platform rise" data-platform="${platform}"`));
  assert.equal(/<article[^>]*\bhidden\b/.test(hub), false, "neither card is hidden in the markup");
  const script = /<script>([\s\S]*?)<\/script>/.exec(body(hub))[1];
  assert.match(script, /setAttribute\("data-recommended", ""\)/, "the script only marks a card");
  assert.match(script, /if \(!card\) return;/, "an uncertain device emphasises neither");
  assert.doesNotMatch(script, /fetch|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|gtag|analytics|\.remove\(|\.hidden = true|display/i, "no network, storage, tracking or hiding");
  assert.equal([...script.matchAll(/platform = "(\w+)"/g)].map((match) => match[1]).sort().join(), "android,windows", "only the two real platforms are recognised");
});

test("the hub states no version, size, checksum, count or rating, and its requirements agree with the release sources", () => {
  const text = body(hub).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(text, /\b\d+\.\d+\.\d+\b|\b\d+(\.\d+)? ?MB\b|\b[0-9a-f]{64}\b|\bstars?\b|\brated\b|\bdownloads? (so far|total)\b|\d[\d,]* (users|people)\b/i);
  const release = JSON.parse(read("frontend/public/android/version.json"));
  assert.equal(/id="android-requirements">([^<]*)</.exec(hub)[1], release.androidRequirements, "the source default equals the release file; the build bakes it again");
  assert.match(windows, /<dt>Requires<\/dt><dd>Windows 10 or 11, x64<\/dd>/);
  assert.match(hub, /64-bit Windows 10 or 11/);
  assert.doesNotMatch(text, /\bios\b|iphone|macos|\bmac\b|linux|chromeos/i, "no unsupported platforms");
});

// --- The refreshed platform pages ----------------------------------------------

test("both platform pages keep their download links, attributes, ids, FAQ marker and checksum copy", () => {
  assert.equal(anchors(android).filter((link) => link.href === APK && link.download === "vibhavgpt-android.apk").length, 1);
  assert.equal(anchors(windows).filter((link) => link.href === EXE && link.download === "VibhavGPT-Setup-x64.exe").length, 1);
  for (const id of ["version", "date", "size", "requirements", "notes", "checksum", "download-meta", "requirement-note", "copy-checksum"]) {
    assert.ok(android.includes(`id="${id}"`), `android: #${id}`);
  }
  for (const id of ["checksum", "copy-checksum"]) assert.ok(windows.includes(`id="${id}"`), `windows: #${id}`);
  for (const page of [android, windows, hub]) assert.equal(page.split("<!-- public-faq -->").length - 1, 1);
  for (const page of [android, windows]) {
    assert.match(page, /navigator\.clipboard\.writeText\(text\)\.then\(function \(\) \{\s*button\.textContent = 'Copied';/, "checksum copy behaviour");
    assert.match(page, /<button class="copy" type="button" id="copy-checksum">Copy<\/button>/);
  }
  assert.match(android, /fetch\('\/android\/version\.json', \{ cache: 'no-store' \}\)/, "the page still reads the release file");
  assert.match(windows, /<span class="download-meta">Version [\d.]+, [\d.]+ MB<\/span>/);
  assert.match(windows, /<dt>Version<\/dt><dd>[\d.]+<\/dd>/);
});

test("version.json keeps its schema and its consumers", () => {
  const release = JSON.parse(read("frontend/public/android/version.json"));
  assert.deepEqual(Object.keys(release).sort(), ["androidRequirements", "downloadPage", "downloadUrl", "fileSize", "minimumSupportedVersionCode", "officialNote", "releaseDate", "releaseNotes", "sha256", "versionCode", "versionName"]);
  assert.equal(release.downloadUrl, APK);
  assert.equal(release.downloadPage, "https://vibhavgpt.com/android");
  assert.match(read("frontend/src/direct-distribution.js"), /fetch\("\/android\/version\.json"/);
  assert.match(read("frontend/src/App.jsx"), /directUpdate\.downloadPage \|\| "\/android"/);
  assert.match(read("frontend/scripts/prerender-public.js"), /public\/android\/version\.json/);
});

test("all three pages use the shared stylesheet, link back to all apps or across to the other platform, and keep the QR", () => {
  for (const [name, page] of [["hub", hub], ["android", android], ["windows", windows]]) {
    assert.match(page, /<link rel="stylesheet" href="\/theme\/apps-pages\.css">/, `${name}: shared stylesheet`);
    assert.equal(/<style[\s>]/.test(page), false, `${name}: no inline style block`);
  }
  assert.ok(anchors(android).some((link) => link.href === "/apps" && link.text === "All apps"));
  assert.ok(anchors(windows).some((link) => link.href === "/apps" && link.text === "All apps"));
  assert.ok(anchors(android).some((link) => link.href === "/vibhavgpt-windows" && link.text === "See Windows install steps"));
  assert.ok(anchors(windows).some((link) => link.href === "/android" && link.text === "See Android install steps"));
  assert.match(android, /<div class="scan__code" role="img" aria-label="QR code for vibhavgpt\.com\/android">\s*<svg[^>]*><path stroke="#04101f"/);
  assert.equal(windows.includes("scan__code"), false);
  assert.match(css, /\.scan__code \{[^}]*background: #f4f8fc;/, "the QR panel stays fixed dark-on-light");
});

test("install guidance stays per-source and never tells anyone to switch off protections globally", () => {
  for (const page of [android, windows, hub]) {
    const text = body(page).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /disable (windows )?(defender|smartscreen|antivirus|security|protection)|turn off (smartscreen|defender|antivirus|protection)|install apps from (any|all|unknown) sources/i, "no global-protection advice");
  }
  assert.match(android, /allow your browser or file manager to install apps from this source/);
  assert.match(windows, /select <strong>More info<\/strong>, then <strong>Run anyway<\/strong>/);
});

// --- Build registration (source text) -------------------------------------------

test("source: /apps is registered in the build, dev server, preview, crawler files and not in the app shell", () => {
  const prerender = read("frontend/scripts/prerender-public.js");
  assert.match(prerender, /\["\/apps", "apps\/index\.html"\]/);
  assert.match(prerender, /\["src\/apps-pages\.css", "theme\/apps-pages\.css"\]/, "the stylesheet is copied into dist/theme");
  assert.match(read("frontend/scripts/verify-public.js"), /\["\/home", "\/apps", "\/sources", "\/android", "\/vibhavgpt-windows"\]\.includes\(path\)/);
  const vite = read("frontend/vite.config.js");
  for (const piece of ['"/theme/apps-pages.css": "src/apps-pages.css"', '"/apps": "apps/index.html"', '"/apps/": "apps/index.html"', 'path.startsWith("/apps") ? "/apps"', '"/apps", "/apps/"']) assert.ok(vite.includes(piece), piece);
  assert.ok(read("frontend/public/llms.txt").includes("https://vibhavgpt.com/apps"));
  assert.ok(read("frontend/public/sitemap.xml").includes("<loc>https://vibhavgpt.com/apps</loc>"));
  assert.ok(existsSync(new URL("../frontend/src/apps-pages.css", import.meta.url)));
  const caddy = read("frontend/Caddyfile");
  assert.equal(caddy.includes("/apps"), false, "Caddy is unchanged: /apps is a static document found by its default try_files");
  assert.equal(caddy.slice(caddy.indexOf("@appShell path ")).split("\n")[0].split(" ").includes("/apps"), false, "and it is not an app-shell route");
});

// --- Motion, focus and tokens in the shared stylesheet (source text) --------------

test("css: motion is opacity and transform only, gated by reduced motion, with no transition: all", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(plain, /transition:\s*all/);
  const noPreference = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(plain)[1];
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(plain)[1];
  // Every animation declaration sits in one of the two motion blocks.
  const outside = plain.replace(noPreference, "").replace(reduce, "");
  assert.doesNotMatch(outside.replace(/@keyframes[\s\S]*?\}\s*\}/g, ""), /animation:/, "no animation outside the motion blocks");
  assert.match(noPreference, /animation: apps-rise/);
  assert.match(reduce, /animation: apps-fade/);
  assert.doesNotMatch(reduce, /transform|translate|scale/, "reduced motion keeps no movement");
  for (const [, name, frames] of plain.matchAll(/@keyframes (apps-[\w-]+) \{([\s\S]*?\})\s*\}/g)) {
    for (const [, property] of frames.matchAll(/([a-z-]+):/g)) assert.ok(["opacity", "transform"].includes(property), `${name} animates ${property}`);
  }
  assert.doesNotMatch(plain, /@keyframes[^{]*\{[^}]*(infinite)/, "no looping animation");
  assert.equal(/animation[^;]*infinite/.test(plain), false);
  assert.equal(/scroll-behavior|scroll-snap|view-transition/.test(plain), false, "no scroll hijacking, no view transitions in this build");
  // Content is never held back waiting on motion: the hidden state only exists as the animation's own `from`.
  assert.doesNotMatch(plain.replace(/@keyframes[\s\S]*?\}\s*\}/g, ""), /opacity:\s*0\b/);
});

test("css: visible focus, 44px controls, tokens only, and no horizontal-scroll trap", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(plain, /:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 3px;/);
  for (const selector of [".download, .button", ".direct", ".copy", ".nav-link", ".brand", ".footer a", ".web-link a"]) {
    const match = new RegExp(`(?:^|\\n)${selector.replaceAll(".", "\\.")} \\{[^}]*min-height: (\\d+)px`).exec(plain);
    assert.ok(match && Number(match[1]) >= 44, `${selector} is at least 44px tall`);
  }
  assert.match(plain, /\.footer a \{[^}]*min-width: 44px;/);
  assert.match(plain, /body \{[^}]*overflow-x: clip;/);
  assert.doesNotMatch(plain, /overflow-x:\s*hidden/);
  const hexes = [...plain.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase());
  assert.deepEqual(hexes, ["#f4f8fc"], "the only raw colour is the QR panel");
  assert.doesNotMatch(plain, /(?<![-\w])(rgb|rgba|hsl|oklch)\(/, "no raw colour functions");
  assert.doesNotMatch(plain, /font-family:\s*["']/, "no font names; type comes from the tokens");
  assert.doesNotMatch(plain, /!important|font-style:\s*italic|background-clip:\s*text|text-fill-color/, "no italics, gradient text or !important");
});

// --- The Sources page ---------------------------------------------------------------

const sources = read("frontend/public/sources/index.html");
const YOUTUBE = "https://www.youtube.com/@vibhavthoota";

test("/sources is a registered public page with accurate, length-checked metadata and real FAQs", () => {
  const page = PUBLIC_PAGES["/sources"];
  assert.ok(page);
  assert.equal(page.title, "VibhavGPT Sources: Public Source Code and YouTube Channel");
  assert.ok(page.description.length >= 150 && page.description.length <= 160, `description is ${page.description.length} characters`);
  assert.ok(page.description.endsWith("Made by Vibhav Thoota."));
  assert.ok(page.faq.length >= 3);
  for (const [question, answer] of page.faq) assert.ok(question.endsWith("?") && answer.length > 120, question);
  assert.doesNotMatch(JSON.stringify(page), /[–—]/, "no en or em dashes in the copy");
  // Only facts the project already states: the repository's license, its creator and operator, the support address.
  assert.doesNotMatch(JSON.stringify(page.faq), /\d+\.\d+\.\d+|\d[\d,]* (stars|subscribers|videos|views|users)|\b(award|ranked|popular|trusted by)\b/i, "no counts or boasts");
});

test("the Sources page composes like the prerender step: one title, canonical, h1, schema graph, FAQ block and 300+ visible words", () => {
  let html = updateMetadata(sources, "/sources");
  html = html.replace("<!-- public-faq -->", detailsHtml("/sources").faq);
  assert.equal(html.match(/<title>/g).length, 1);
  assert.ok(html.includes(`<title>${PUBLIC_PAGES["/sources"].title}</title>`));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE_ORIGIN}/sources">`));
  assert.equal(body(html).match(/<h1(\s|>)/g).length, 1);
  assert.match(body(html), /<h1>VibhavGPT sources<\/h1>/);
  const [graph] = [...html.matchAll(/<script id="vibhavgpt-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  const types = graph["@graph"].map((node) => node["@type"]);
  for (const type of ["Organization", "WebSite", "BreadcrumbList", "FAQPage"]) assert.ok(types.includes(type), type);
  assert.equal(body(html).match(/<h3>/g).length, PUBLIC_PAGES["/sources"].faq.length);
  assert.ok(visibleWords(html) >= 300, `${visibleWords(html)} visible words`);
  assert.match(body(html), /<footer\b[^>]*>[\s\S]*?Made by Vibhav Thoota[\s\S]*?<\/footer>/);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']http:\/\//i);
});

test("the Sources page has exactly two destinations: the existing repository and the existing channel, in safe new tabs", () => {
  const links = [...sources.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({
    href: attr(attributes, "href"), target: attr(attributes, "target"), rel: attr(attributes, "rel"), cls: attr(attributes, "class"),
    text: inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  }));
  const main = body(sources).slice(0, body(sources).indexOf("<footer"));
  const mainLinks = [...main.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({ href: attr(attributes, "href"), target: attr(attributes, "target"), rel: attr(attributes, "rel"), text: inner.replace(/\s+/g, " ").trim() }));
  const external = mainLinks.filter((link) => /^https?:/.test(link.href));
  assert.deepEqual(external.map((link) => [link.text, link.href]), [["View the source code", SOURCE_REPO_URL], ["Watch on YouTube", YOUTUBE]]);
  for (const link of external) { assert.equal(link.target, "_blank", link.href); assert.equal(link.rel, "noopener noreferrer", link.href); }
  assert.equal(SOURCE_REPO_URL, "https://github.com/Shourya-Thoota/vibhavgpt", "the repository address is the one the app already uses");
  assert.ok(links.some((link) => link.href === "/app" && link.text === "Open workspace"), "workspace navigation");
  assert.ok(mainLinks.some((link) => link.href === "/apps" && link.text === "See all apps"), "a way to the Apps page");
  const footerSource = links.filter((link) => link.text === "Source code");
  assert.equal(footerSource.length, 1);
  assert.equal(footerSource[0].href, SOURCE_REPO_URL, "the footer link is the same existing destination, not a second one");
  assert.equal(footerSource[0].rel, "noopener noreferrer");
  assert.equal(new Set(links.filter((link) => /github\.com/.test(link.href)).map((link) => link.href)).size, 1, "one GitHub address on the whole page");
});

test("the Sources page embeds nothing, tracks nothing, runs no script of its own, and does not name the private repository", () => {
  const text = body(sources);
  assert.doesNotMatch(text, /<iframe|<embed|<object|<video|<audio|<script\b|<form\b|<img[^>]*src="https?:/i, "no embeds, scripts, forms or remote images");
  assert.doesNotMatch(sources, /gtag|analytics|pixel|beacon|googletagmanager|fbq|utm_|ping=/i, "no trackers");
  assert.doesNotMatch(sources, /vibhavgpt-private/i, "the private repository is not exposed");
  assert.doesNotMatch(sources.replace(/<script id="vibhavgpt-structured-data"[\s\S]*?<\/script>/, ""), /openai|anthropic|google gemini|deepseek|mistral/i, "no provider names");
  assert.match(sources, /<link rel="stylesheet" href="\/theme\/apps-pages\.css">/);
  assert.equal(/<style[\s>]/.test(sources), false, "no inline style block");
  assert.equal(sources.split("<!-- public-faq -->").length - 1, 1);
  for (const [label, href] of [["Source code", SOURCE_REPO_URL], ["YouTube", YOUTUBE]]) assert.ok(sources.includes(href), `${label} destination present`);
  assert.equal(hub.includes("/sources"), false, "the Apps page is unchanged by this");
});

test("source: /sources is registered in the build, dev server, preview, crawler files and not in the app shell", () => {
  assert.match(read("frontend/scripts/prerender-public.js"), /\["\/sources", "sources\/index\.html"\]/);
  assert.match(read("frontend/scripts/verify-public.js"), /"\/sources"/);
  const vite = read("frontend/vite.config.js");
  for (const piece of ['"/sources": "sources/index.html"', '"/sources/": "sources/index.html"', '"/sources/index.html": "sources/index.html"', 'path.startsWith("/sources") ? "/sources"', '"/sources", "/sources/"']) assert.ok(vite.includes(piece), piece);
  assert.ok(read("frontend/public/llms.txt").includes("https://vibhavgpt.com/sources"));
  assert.ok(read("frontend/public/sitemap.xml").includes("<loc>https://vibhavgpt.com/sources</loc>"));
  const caddy = read("frontend/Caddyfile");
  assert.equal(caddy.includes("/sources"), false, "Caddy is unchanged: /sources is a static document found by its default try_files");
  assert.equal(caddy.slice(caddy.indexOf("@appShell path ")).split("\n")[0].split(" ").includes("/sources"), false, "and it is not an app-shell route");
  assert.match(read("frontend/src/components/Sidebar.jsx"), /const SOURCES_PATH = "\/sources";/, "the sidebar links to the registered path");
  assert.ok(Object.keys(PUBLIC_PAGES).includes("/sources"));
});

test("css: the device graphics use tokens only, and the new frames add no motion of their own", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const devices = plain.slice(plain.indexOf(".device {"), plain.indexOf("/* --- Apps page"));
  const section = plain.slice(plain.indexOf(".device {"), plain.indexOf(".hub-hero"));
  assert.ok(section.includes(".device--phone") && section.includes(".device--window") && section.includes(".device--video") && section.includes(".device__controls"));
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b|(?<![-\w])(rgb|rgba|hsl)\(/, "no raw colours in the device graphics");
  assert.doesNotMatch(section, /animation|transition/, "the frames carry no motion; the shared motion block owns it");
  assert.ok(devices.length > 0);
});
