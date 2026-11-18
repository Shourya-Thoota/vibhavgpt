import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The supplied animation on the static homepage: the liquid-glass logo reveal. This file reads source and build output; the
// behaviour in real browsers is in browser-home-effects.test.js.
const root = path.resolve(import.meta.dirname, "..");
const frontend = path.join(root, "frontend");
const read = (file) => fs.readFileSync(path.join(frontend, file), "utf8");
const dist = path.join(frontend, "dist");
const built = fs.existsSync(path.join(dist, "home/index.html"));
const COMPONENTS = ["src/components/ui/liquid-glass-logo-reveal.tsx", "src/home-effects.tsx"];

test("the supplied components live in frontend/src/components/ui, not in the protected root src/components", () => {
  assert.ok(fs.existsSync(path.join(frontend, COMPONENTS[0])), `${COMPONENTS[0]} exists`);
  for (const name of ["liquid-glass-logo-reveal.tsx"]) {
    assert.equal(fs.existsSync(path.join(root, "src/components/ui", name)), false, `${name} is not in the root src/components`);
  }
  assert.ok(fs.existsSync(path.join(frontend, "src/lib/utils.ts")), "shadcn's cn helper is at @/lib/utils");
  assert.match(read("src/lib/utils.ts"), /export function cn\(\.\.\.inputs: ClassValue\[\]\)\s*\{\s*return twMerge\(clsx\(inputs\)\);/);
});

test("the glass reveal is the supplied engine, with the VibhavGPT logo in place of the 21st.dev mark", () => {
  const src = read("src/components/ui/liquid-glass-logo-reveal.tsx");
  for (const piece of ["#version 300 es", "uniform float uRimLine;", "const FRAG = `", "function frameAt(", "function spring(", "function timeToReach(", "function buildSdf(", "function edt1d(", "function fitToTexture(", "function startEngine(", '"webglcontextlost"', "new IntersectionObserver", "export function GlassIconReveal(", "export interface GlassIconRevealProps"]) {
    assert.ok(src.includes(piece), `keeps: ${piece}`);
  }
  // 6 for the tile and textures, 36 for the glass's shape and optics, 12 for its look and light, 3 colours.
  assert.equal((src.match(/uniform (float|vec2|vec3|sampler2D) u[A-Za-z]+;/g) ?? []).length, 57, "the shader's 57 uniforms, as supplied");
  // The 21st.dev mark and wrapper are replaced, not left behind.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/MARK_21ST|GlassReveal21st|M543\.595 247\.8/.test(code), false, "no trace of the 21st.dev mark or wrapper in the code");
  for (const line of src.split("\n").filter((l) => /21st/i.test(l))) assert.match(line, /^\s*(\/?\*|\/\/)/, `only the attribution comment mentions 21st.dev: ${line.trim()}`);
  // This file is written without semicolons, like the supplied source.
  assert.ok(src.includes('export const LOGO_VIBHAVGPT = "/brand/vibhavgpt-icon-512.png"'), "the logo is the repository's own mark");
  assert.ok(src.includes("export function GlassRevealVibhavGPT("));
  assert.equal(/label="VibhavGPT"[\s\S]*?originalColors/.test(src), true, "keeps the logo's own colours");
});

test("the logo is the VibhavGPT mark already in the repository, with transparency", () => {
  const file = path.join(frontend, "public/brand/vibhavgpt-icon-512.png");
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 512, "512 wide");
  assert.equal(png.readUInt32BE(20), 512, "512 tall");
  assert.equal(png[25], 6, "RGBA: the glass takes its shape from the alpha channel");
  assert.ok(png.length < 200_000, `${png.length} bytes: small enough to load for a hero effect`);
});

test("licence notices are kept", () => {
  const licences = read("src/components/ui/LICENSES.md");
  assert.match(licences, /zanwei\/glass-icon-reveal/);
  assert.match(licences, /MIT License\s+Copyright \(c\) 2026 Zanwei Guo/);
  assert.match(licences, /Permission is hereby granted, free of charge[\s\S]*THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(licences, /came with no licence text, so none is reproduced here/, "says plainly that the grid shipped without one");
  const glass = read("src/components/ui/liquid-glass-logo-reveal.tsx");
  assert.ok(glass.includes("Shader and spring timeline ported from zanwei/glass-icon-reveal (MIT):"));
  assert.ok(glass.includes("https://github.com/zanwei/glass-icon-reveal"));
  assert.ok(glass.includes("The MIT licence for the upstream shader and timeline is in ./LICENSES.md."));
});

test("Tailwind is scoped: utilities only, outside any layer, and exactly the classes the components use", () => {
  const css = read("src/home-effects.css");
  assert.match(css, /@import "tailwindcss\/utilities\.css" source\(none\);/, "utilities only, no scan of the source");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /preflight|tailwindcss\/theme\.css|@import "tailwindcss"|@layer/, "no reset, no default palette, no cascade layer");
  assert.match(css, /--spacing: 0\.25rem;/, "without a spacing scale inset-0 and top-0 are silently not generated");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--color-muted/, "the site's own --color-muted is never redefined");

  const listed = new Set(css.match(/@source inline\("\{([^}]+)\}"\)/)[1].split(","));
  const used = new Set();
  for (const file of COMPONENTS) {
    const src = read(file);
    for (const m of src.matchAll(/className=\{?"([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const call of src.matchAll(/\bcn\(([\s\S]*?)\)\s*[,}]/g)) for (const s of call[1].matchAll(/"([^"]+)"/g)) s[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  assert.deepEqual([...used].sort(), [...listed].sort(), "every class a component uses is listed in home-effects.css, and nothing else is");
});

test("the homepage: the glass logo leads the hero, then the model showcase, then one plain section of five features and the call to action, then the footer", () => {
  const home = fs.readFileSync(path.join(frontend, "public/home/index.html"), "utf8");
  assert.equal((home.match(/<div [^>]*data-home-effect="logo-reveal"/g) ?? []).length, 1);
  // Three effects, each its own lazy island: the logo, the model showcase below the hero (orbit-showcase.test.js) and the fluid
  // background behind everything (splash-background.test.js).
  assert.equal((home.match(/data-home-effect=/g) ?? []).length, 3, "the logo, the model showcase and the background are the only effects");
  assert.equal((home.match(/<div [^>]*data-home-effect="splash-cursor"/g) ?? []).length, 1);
  assert.equal((home.match(/<div [^>]*data-home-effect="orbit-showcase"/g) ?? []).length, 1);
  assert.equal((home.match(/<!-- home-effects -->/g) ?? []).length, 1, "the build injects the boot script here");
  assert.doesNotMatch(home, /home-effects-boot|homeEffects/, "the source names no hashed file");

  // The order: hero, models, features (which end in the call to action), footer. Nothing else.
  const at = (re) => { const m = home.match(re); assert.ok(m, `${re} is on the page`); return m.index; };
  const order = [at(/<section class="hero"/), at(/<section class="orbits"/), at(/<section class="showcase"/), at(/<footer class="site-footer"/)];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "hero, models, features, footer");
  assert.equal((home.match(/<section\b/g) ?? []).length, 3, "three sections: the hero, the models and the features");

  // The pinned scroll tour and the curved row are gone, with their markup, styles, script and sample content.
  assert.doesNotMatch(home, /tour|tilted-grid|fx__|tgh-t-|data-cap|demo-quiz|class="win"|class="horizon"|SCENES|tour-live|fx-off/i, "no trace of the tour or the curved row");
  assert.doesNotMatch(home, /class="(after|features|feature|plans|promises|more)\b|id="(plans|features|privacy|plans-title|features-title)"|href="#(plans|features)"|Compare plans|One place for the work|Read the Guarantee/, "nor of the older sections");

  // The nav's links: Features is removed from the header; Pricing, Apps, Guarantee are present in order.
  const nav = home.match(/<nav class="nav-links"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(nav, /Features/, "Features is removed from the public navigation");
  assert.match(nav, /<a href="\/pricing">Pricing<\/a><a href="\/apps">Apps<\/a><a href="\/guarantee">Guarantee<\/a>/, "Pricing, Apps, Guarantee in order");

  // The hero: the one h1, what it does, the primary action and a secondary one, and the logo beside them.
  const hero = home.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  assert.equal((hero.match(/<h1\b/g) ?? []).length, 1);
  assert.match(hero, /<a class="btn btn-primary" href="\/signup"[^>]*>Get started free<\/a>/);
  assert.match(hero, /<a class="btn btn-quiet" href="#showcase"[^>]*>Explore features<\/a>/);
  assert.match(hero, /<div class="hero__mark" data-home-effect="logo-reveal"><img src="\/brand\/vibhavgpt-icon-512\.png" width="512" height="512" alt="VibhavGPT" decoding="async"><\/div>/, "without script the logo stays a still image");
  assert.match(hero, /We never train on your chats, sell your data, or show ads\./, "the Guarantee's wording is unchanged");

  // The features: a heading, the five features as real text with their pictures, the call to action.
  const showcase = home.match(/<section class="showcase"[\s\S]*?<\/section>/)[0];
  assert.match(showcase, /<h2 id="showcase-title">Features<\/h2>/);
  const slides = [...showcase.matchAll(/<article class="slide" id="slide-([a-z]+)"[^>]*>[\s\S]*?<h3><a href="([^"]+)">([^<]+)<\/a><\/h3><p>([^<]+)<\/p>/g)].map((m) => ({ id: m[1], href: m[2], name: m[3], text: m[4] }));
  assert.deepEqual(slides.map((i) => i.name), ["Chat", "Image creation", "Study", "Diagrams", "The VibhavGPT Guarantee"], "the five features, as text");
  assert.deepEqual(slides.map((i) => i.href), ["/app/chat", "/pricing", "/app/study", "/app/chat", "/guarantee"], "each links to a real page");
  assert.match(slides[1].text, /Included with Plus and Pro\./, "image creation is not offered to the free plan");
  assert.equal(slides[4].text, "We never train on your chats, sell your data, or show ads.", "the Guarantee's promise is unchanged");
  for (const slide of slides) {
    for (const theme of ["dark", "light"]) assert.match(showcase, new RegExp(`<img class="slide__art slide__art--${theme}" src="/home/artwork/${slide.id}-${theme}\\.webp" width="1280" height="720" alt="[^"]+" loading="lazy" decoding="async">`), `${slide.name}: a sized, lazy ${theme} picture`);
  }
  assert.match(home, /:root\[data-theme="light"\] \.slide__art--dark,:root:not\(\[data-theme="light"\]\) \.slide__art--light\{display:none\}/, "the other theme's picture is hidden, so it is never fetched");
  assert.match(home, /html\.save-data \.slide__art\{display:none\}/, "readers who save data get no pictures");
  assert.ok(showcase.indexOf('class="presenter__slides"') < showcase.indexOf('class="cta"'), "the features, then the call to action");
  assert.match(showcase, /<div class="cta"><p>You can start on the free plan\.<\/p><a class="btn btn-primary" href="\/signup">Get started free<\/a><\/div>/);
  assert.match(home, /id="main"/);
  assert.match(home, /id="showcase"/);
  assert.match(home, /\.hero__mark\{[^}]*height:clamp\(260px,38vw,600px\)/, "the logo stage has a fixed height, so nothing shifts when it loads");
  assert.match(home, /\.hero__mark\{[^}]*mask-image:radial-gradient/, "the glass canvas fades into the page wash instead of ending in an edge");
});

test("one wash behind every page: shared tokens in both themes, one static fixed layer, and shells that let it through", () => {
  const theme = read("src/theme/vibhav.css");
  for (const token of ["--page-wash", "--page-wash-calm", "--wash-stage", "--wash-fade"]) {
    assert.equal((theme.match(new RegExp(`^\\s*${token}:`, "gm")) ?? []).length, 2, `${token} is defined once per theme`);
  }
  // A single static layer: fixed, behind the page, no animation, no blur, no canvas.
  const layer = theme.match(/body::before \{([^}]*)\}/)[1];
  assert.match(layer, /position: fixed/);
  assert.match(layer, /z-index: -1/);
  assert.match(layer, /pointer-events: none/);
  assert.doesNotMatch(layer, /animation|filter|blur/);
  assert.match(theme, /body:has\(\.workspace\)::before \{ background: var\(--page-wash-calm\); \}/, "Chat and Study get the calm wash");
  for (const shell of ["body", ".workspace", ".legal", ".boot", ".auth", ".survey", ".pricing-page"]) assert.ok(theme.includes(`:root:root:root ${shell}`), `${shell} lets the wash through`);
  // The accent as text has its own token (lighter at night, deeper by day), so links, tags and letters keep
  // 4.5:1 over the wash and on their own tint. The accent itself, used for fills, is unchanged.
  assert.equal((theme.match(/^\s*--color-accent-text:/gm) ?? []).length, 2, "--color-accent-text is defined once per theme");
  for (const [file, rule] of [["src/styles.css", /\.btn--quiet \{[^}]*color: var\(--color-accent-text\)/], ["src/styles.css", /\.link \{\s*color: var\(--color-accent-text\)/], ["src/styles.css", /\.tag--plus \{[^}]*color: var\(--color-accent-text\)/], ["src/pricing.css", /\.pricing__guarantee a \{[^}]*color: var\(--color-accent-text\)/], ["src/study-widgets.css", /\.quiz__letter \{[^}]*color: var\(--color-accent-text\)/]]) assert.match(read(file), rule, `${file}: accent text uses the text token (${rule})`);
  const home = fs.readFileSync(path.join(frontend, "public/home/index.html"), "utf8");
  assert.match(home, /\/theme\/vibhav\.css/, "the homepage takes the same tokens as the app");
  assert.doesNotMatch(home, /\nbody\{[^}]*background:var\(--color-paper\)/, "the homepage body no longer paints a flat colour over the wash");
  // The glass canvas takes its colour from the theme token, not from the body (which is transparent now).
  const effects = read("src/home-effects.tsx");
  assert.match(effects, /background-color:var\(--wash-stage\)/, "the glass takes the theme's stage colour, resolved by the browser");
  assert.doesNotMatch(effects, /document\.body\)\.backgroundColor/);
});

test("the build injects the tiny boot script, and the animations load without the app bundle", { skip: !built && "frontend/dist is not built" }, () => {
  const home = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
  assert.ok(!home.includes("<!-- home-effects -->"), "the marker is replaced");
  const boot = home.match(/<script type="module" crossorigin src="\/(assets\/homeEffects-[A-Za-z0-9_-]+\.js)"><\/script>/);
  assert.ok(boot, "the boot script is injected into the built homepage");
  const bootSource = fs.readFileSync(path.join(dist, boot[1]), "utf8");
  assert.ok(bootSource.length < 3000, `the boot script is ${bootSource.length} bytes`);
  assert.ok(bootSource.includes("data-home-effect") && bootSource.includes("IntersectionObserver") && bootSource.includes("700px 0px"), "it loads each effect when it nears the viewport");
  assert.ok(bootSource.includes("saveData"), "and respects a reader who saves data");
  assert.equal(fs.existsSync(path.join(dist, ".vite")), false, "the build manifest is not served");

  // Nothing the homepage loads for the animations may pull in the app itself.
  const effects = bootSource.match(/assets\/(home-effects-[A-Za-z0-9_-]+\.js)/)[1];
  const chunks = fs.readFileSync(path.join(dist, "assets", effects), "utf8");
  assert.doesNotMatch(bootSource + chunks, /main-[A-Za-z0-9_-]+\.js/, "no import of the 1.3 MB app bundle");
  const css = fs.readdirSync(path.join(dist, "assets")).find((f) => /^home-effects-.*\.css$/.test(f));
  const sheet = fs.readFileSync(path.join(dist, "assets", css), "utf8");
  assert.ok(sheet.length < 2500, `the stylesheet is ${sheet.length} bytes`);
  assert.doesNotMatch(sheet, /box-sizing|\bhtml\{|:where\(|\bbutton\{/, "no reset: nothing on the page changes");
  const generated = [...sheet.matchAll(/(?:^|\})\.([a-z0-9-]+)\{/g)].map((m) => m[1]).sort();
  assert.deepEqual(generated, ["absolute", "block", "cursor-pointer", "h-full", "inset-0", "isolate", "m-auto", "overflow-hidden", "relative", "select-none", "w-full"], "exactly the utilities the logo uses");
  assert.doesNotMatch(sheet.replace(/@layer properties\{[^]*?\}\}\}/, ""), /@layer/, "unlayered, so they beat the page's own img rule");
  assert.equal(fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".webp")).length, 0, "no artwork ships: the logo is the only animation");
  const page = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
  assert.doesNotMatch(page, /src="art:|<img class="art/, "no placeholder or card image is left in the built page");
  assert.doesNotMatch(fs.readFileSync(path.join(frontend, "scripts/prerender-public.js"), "utf8"), /art:|artwork\[/, "and the build no longer resolves them");
});
