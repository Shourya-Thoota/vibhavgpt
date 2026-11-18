import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The fluid background on the homepage: React Bits' SplashCursor, added as supplied and loaded lazily. This file reads source and
// build output; how it looks and behaves in a browser is in browser-splash-background.test.js.
const root = path.resolve(import.meta.dirname, "..");
const frontend = path.join(root, "frontend");
const read = (file) => fs.readFileSync(path.join(frontend, file), "utf8");
const dist = path.join(frontend, "dist");
const built = fs.existsSync(path.join(dist, "home/index.html"));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");

test("the component is the supplied one, in the folder the project's other components use, with its stylesheet beside it", () => {
  const src = read("src/components/ui/splash-cursor.jsx");
  assert.match(src, /^\/\/ SplashCursor, from React Bits \(https:\/\/reactbits\.dev\), JavaScript \+ CSS variant, added to the project as supplied\./);
  for (const piece of [
    "import './splash-cursor.css';",
    "const QUALITY = {", "const SHADERS = {", "const VERTEX = `#version 300 es", "function SplashCursor({", "export default SplashCursor;",
    "colors = ['#4f8cff', '#2dd4bf', '#ffd166'],", "rainbow = true,", "swirl = 3,", "trail = 1,", "quality = 'high',", "clickSplash = true,", "theme = 'dark',", "zIndex = 50,",
    "canvas.getContext('webgl2', {", "window.addEventListener('pointermove', onPointerMove, { passive: true });", "aria-hidden=\"true\"",
  ]) assert.ok(src.includes(piece), `keeps: ${piece}`);
  // All fourteen of the supplied fragment programs are there.
  for (const name of ["copy", "clear", "splat", "burst", "crown", "advection", "divergence", "curl", "vorticity", "pressure", "gradient", "prefilter", "blur", "display"]) assert.ok(new RegExp(`\\n  ${name}: \`uniform`).test(src), `the ${name} program`);
  const css = read("src/components/ui/splash-cursor.css").replace(/\r\n/g, "\n");
  assert.equal(css, `.splash-cursor {\n  position: fixed;\n  inset: 0;\n  pointer-events: none;\n}\n\n.splash-cursor[data-contained] {\n  position: absolute;\n}\n\n.splash-cursor__canvas {\n  display: block;\n  width: 100%;\n  height: 100%;\n}\n`);
  assert.doesNotMatch(stripComments(src), /https?:\/\/|fetch\(|XMLHttpRequest|localStorage|document\.cookie/, "it reaches nothing outside the page, and stores nothing");
});

test("the licence is on file with its notice, and so is the question it leaves open", () => {
  const licences = read("src/components/ui/LICENSES.md");
  assert.match(licences, /splash-cursor\.jsx/);
  assert.match(licences, /MIT \+ Commons Clause License Condition v1\.0\s+Copyright \(c\) 2026 David Haz/);
  assert.match(licences, /Permission is hereby granted, free of charge[\s\S]*as part of an application, website, or product/);
  assert.match(licences, /so long as you do not sell, sublicense, or redistribute the components themselves/);
  assert.match(licences, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(licences, /AGPL-3\.0-only[\s\S]*Commons Clause[\s\S]*Decide before the file is published/);
  // The earlier notices are kept.
  for (const kept of [/zanwei\/glass-icon-reveal/, /orbit-showcase\.tsx/, /GSAP 3\.15\.1/]) assert.match(licences, kept);
});

test("the homepage uses the example's own props, follows the sky, and starts nothing a reader did not allow", () => {
  const island = read("src/splash-cursor-island.jsx");
  assert.match(island, /<SplashCursor rainbow size=\{1\} force=\{1\} swirl=\{3\} trail=\{1\} clickSplash /, "the props of the supplied example");
  assert.match(island, /theme=\{theme\}/, "light ink on a dark sky, dark ink on a light one");
  assert.match(island, /attributeFilter: \["data-theme"\]/, "and it follows a change of sky");
  assert.match(island, /zIndex=\{0\}/, "inside the fixed mount layer, whose own z-index puts it behind the page");
  assert.match(island, /\(pointer: coarse\)"\)\.matches \? "medium" : "high"/, "a lighter simulation on a touch screen");
  assert.doesNotMatch(stripComments(island), /https?:\/\/|fetch\(/);

  const effects = read("src/home-effects.tsx");
  assert.match(effects, /import\("\.\/splash-cursor-island"\)/, "loaded with a dynamic import");
  assert.doesNotMatch(effects, /from "\.\/splash-cursor-island"|from "@\/components\/ui\/splash-cursor"/, "never imported statically by the logo's module");
  // Reduced motion: not started. The boot script already skips it for readers who save data.
  assert.match(effects, /if \(window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) \{\s*element\.dataset\.homeEffectState = "still";\s*return;/);
  assert.match(effects, /homeEffectState = "failed"/);
  assert.match(read("src/home-effects-boot.ts"), /saveData/);
  assert.doesNotMatch(stripComments(read("src/home-effects-boot.ts")), /splash/i, "the boot script's code knows nothing of it");
});

test("the homepage holds a fixed layer for it behind everything, that holds no space and takes no click", () => {
  const home = read("public/home/index.html");
  assert.ok(home.includes('<body>\n<div class="splash-bg" data-home-effect="splash-cursor" aria-hidden="true"></div>\n<a class="skip" href="#main">Skip to content</a>') || home.includes('<body>\r\n<div class="splash-bg" data-home-effect="splash-cursor" aria-hidden="true"></div>\r\n<a class="skip" href="#main">Skip to content</a>'), "the first thing in the body, hidden from assistive technology");
  assert.ok(home.includes(".splash-bg{position:fixed;inset:0;z-index:-1;pointer-events:none}"));
  assert.equal((home.match(/data-home-effect=/g) ?? []).length, 3);
  // The page wash is the body's ::before at z-index -1; the layer is later in the document, so it paints over the wash and under the content.
  const theme = read("src/theme/vibhav.css");
  assert.match(theme, /body::before \{\s*content: "";\s*position: fixed;\s*inset: 0;\s*z-index: -1;/);
  assert.match(theme, /:root:root:root body,[\s\S]*?background-color: transparent;/, "the body is transparent, so the layer shows through");
  // Nothing in the page's own styles gives the body a stacking context that would trap a negative z-index.
  const pageCss = home.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(pageCss.match(/body\{[^}]*\}/g).join(" "), /isolation|transform|filter|will-change|contain:|z-index/);
  // The static homepage still has its one h1 and its text in the source: the effect adds none and takes none away.
  assert.equal((home.match(/<h1\b/g) ?? []).length, 1);
});

test("built: the background is a chunk of its own that the page does not name, and no other chunk contains it", { skip: !built && "frontend/dist is not built" }, () => {
  const assets = fs.readdirSync(path.join(dist, "assets"));
  const withCanvas = assets.filter((f) => f.endsWith(".js") && fs.readFileSync(path.join(dist, "assets", f), "utf8").includes("splash-cursor__canvas"));
  assert.equal(withCanvas.length, 1, `one chunk (${withCanvas})`);
  assert.match(withCanvas[0], /^splash-cursor-island-/);
  assert.ok(assets.some((f) => /^splash-cursor-island-.*\.css$/.test(f)), "with its stylesheet, loaded with it");
  const size = fs.statSync(path.join(dist, "assets", withCanvas[0])).size;
  assert.ok(size < 40_000, `${Math.round(size / 1000)} kB`);
  const html = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
  assert.doesNotMatch(html, /assets\/splash-cursor-island|modulepreload/, "the page's HTML does not load or preload it, so it is not in the first load");
  const boot = assets.find((f) => f.startsWith("homeEffects-"));
  assert.doesNotMatch(fs.readFileSync(path.join(dist, "assets", boot), "utf8"), /splash|webgl2/);
  for (const page of ["pricing", "terms", "privacy", "guarantee"]) assert.doesNotMatch(fs.readFileSync(path.join(dist, `${page}.html`), "utf8"), /splash-cursor|splash-bg/, `${page}.html does not carry it`);
});
