import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PRODUCT_KNOWLEDGE } from "../frontend/src/product-knowledge.js";
import { TOKEN_QUOTAS } from "../frontend/src/token-quotas.js";
import { comparisonGroupsFor } from "../frontend/src/plan-comparison.js";
import { MONTHLY_CREDITS } from "../frontend/src/credits-policy.js";
import { PUBLIC_PAGES } from "../frontend/src/public-pages.js";
import {
  ORBIT_ACTIONS,
  ORBIT_BEST_FOR,
  ORBIT_COMPUTE,
  ORBIT_MODEL_IDS,
  ORBIT_SCROLL_PER_SLIDE,
  ORBIT_STICKY_TOP,
  orbitSlides,
  orbitTrackFactor,
  plansIncluding,
} from "../frontend/src/orbit-showcase-data.js";

// The model showcase on the homepage (frontend/src/components/ui/orbit-showcase.tsx and its data). This file reads source, data and
// build output; how it behaves in a browser is in browser-orbit-showcase.test.js.
const root = path.resolve(import.meta.dirname, "..");
const frontend = path.join(root, "frontend");
const read = (file) => fs.readFileSync(path.join(frontend, file), "utf8");
const dist = path.join(frontend, "dist");
const built = fs.existsSync(path.join(dist, "home/index.html"));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");

const COMPONENT = "src/components/ui/orbit-showcase.tsx";
const OWN_SOURCES = [COMPONENT, "src/orbit-showcase-data.js", "src/orbit-showcase-island.jsx", "src/orbit-showcase-fallback.jsx"];
const MODES = [null, "expiry", "carry"];

// ---- Content: only what the product already says -------------------------------------------------------

// Six slides: Nova and Nebula were retired on 2026-11-14, and Tecton (Build) and Prism (images) were added the same day.
test("seven slides, in the product's own order: Lumen, Vulcan, Zenith, Tecton, Study, Prism, Aura", () => {
  const slides = orbitSlides();
  assert.deepEqual(slides.map((s) => s.subtitle), ["Lumen", "Vulcan", "Zenith", "Tecton", "Study", "Prism", "Aura"]);
  assert.deepEqual(slides.map((s) => s.id), ORBIT_MODEL_IDS);
  // Every one of them is a model the product lists.
  assert.deepEqual([...PRODUCT_KNOWLEDGE.models.map(([name]) => name)].sort(), slides.map((s) => s.subtitle).sort());
});

test("what each model is for is the product's own sentence, word for word", () => {
  for (const slide of orbitSlides()) {
    const own = PRODUCT_KNOWLEDGE.models.find(([name]) => name === slide.subtitle)[1];
    assert.equal(slide.overview, `${own.charAt(0).toUpperCase()}${own.slice(1)}.`, `${slide.subtitle}: overview`);
  }
});

test("which plans include each model is read from the plan table, and agrees with what the product says", () => {
  // The product's own statements: Free includes Lumen and Study; Vulcan requires Pro, and Zenith requires Max.
  const free = PRODUCT_KNOWLEDGE.plans.find((plan) => plan.id === "free").details.join(" ");
  assert.match(free, /Free includes Lumen and Study/);
  assert.match(free, /Vulcan requires Pro, and Zenith requires Max/);
  const by = Object.fromEntries(orbitSlides().map((s) => [s.id, s.availability]));
  assert.deepEqual(by, {
    lumen: "Included in Free, Plus, Pro and Max",
    vesper: "Included in Pro and Max",
    // Slice 7: generated from the plan table, like every other line; Zenith is Max only.
    zenith: "Included in Max",
    tecton: "Included in Pro and Max",
    study: "Included in Free, Plus, Pro and Max",
    // Prism makes images, which every plan includes (counted by number, Free by the week).
    prism: "Included in Free, Plus, Pro and Max",
    // Aura is the second image model, on every plan, from the same image allowance.
    aura: "Included in Free, Plus, Pro and Max",
  });
  const max = PRODUCT_KNOWLEDGE.plans.find((plan) => plan.id === "max").features.join(" ");
  assert.match(max, /Zenith, the flagship model, is included only with Max/);
  for (const model of ORBIT_MODEL_IDS.filter((id) => id !== "prism" && id !== "aura")) {
    // Every plan the comparison table has (Max included), so a plan cannot be left out of the showcase by hand.
    const inTable = Object.keys(TOKEN_QUOTAS).filter((plan) => TOKEN_QUOTAS[plan][model].monthly > 0);
    assert.equal(plansIncluding(model).replace(/ and /g, ", ").split(", ").join(","), inTable.map((p) => p[0].toUpperCase() + p.slice(1)).join(","), `${model}: plans`);
  }
  assert.equal(plansIncluding("lumen"), "Free, Plus, Pro and Max");
  assert.equal(plansIncluding("vesper"), "Pro and Max");
});

test("the label shown is the model picker's own intelligence label, so the two cannot disagree", async () => {
  // Slice 7: the composer's picker labels every model on one intelligence scale (model-marketplace.js); the retired dev picker's
  // compute levels are gone. The showcase reads the same table.
  const { HOUSE_INTELLIGENCE, INTELLIGENCE_LABELS } = await import("../frontend/src/model-marketplace.js");
  // Tecton and Prism are not picker rows: they are named for what they do.
  const KIND = { tecton: "Coding", prism: "Images", aura: "Images" };
  for (const [id, { level }] of Object.entries(ORBIT_COMPUTE)) assert.equal(level, KIND[id] ?? INTELLIGENCE_LABELS[HOUSE_INTELLIGENCE[id]], `${id}: the picker's label`);
  const slides = Object.fromEntries(orbitSlides().map((s) => [s.id, s]));
  assert.equal(slides.zenith.badge.label, "Best");
  assert.equal(slides.vesper.badge.label, "Advanced");
  assert.equal(slides.lumen.badge.label, "Fast");
  // Study is not one of the picker's compute tiers; its card says what it is for, never that it is low-cost (owner, 2026-11-15).
  assert.match(PRODUCT_KNOWLEDGE.thinkingEffort, /Study uses low-cost reasoning settings/);
  assert.equal(slides.study.badge.label, "Guided tutoring");
  assert.doesNotMatch(JSON.stringify(slides.study), /low-cost/i);
});

test("'Best for' is made only of words from each model's own description", () => {
  const words = (text) => text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? [];
  const skip = new Set(["a", "the", "of", "for", "and"]);
  for (const slide of orbitSlides()) {
    const own = new Set(words(PRODUCT_KNOWLEDGE.models.find(([name]) => name === slide.subtitle)[1]));
    for (const item of ORBIT_BEST_FOR[slide.id]) {
      for (const word of words(item).filter((w) => !skip.has(w))) {
        // Simple inflections of the same word ("tasks"/"task", "demanding"/"demanding") are the same word.
        const stem = word.replace(/s$/, "");
        assert.ok([...own].some((w) => w === word || w.replace(/s$/, "") === stem), `${slide.subtitle}: "${word}" in "${item}" is not in its description`);
      }
    }
    assert.deepEqual(slide.bestFor, [...ORBIT_BEST_FOR[slide.id]]);
  }
});

test("the allowance wording is the pricing page's, for every credits mode", () => {
  for (const mode of MODES) {
    const group = comparisonGroupsFor(mode).find((g) => g.title === "Monthly allowance");
    for (const slide of orbitSlides(mode)) {
      if (slide.id === "prism" || slide.id === "aura") {
        // The image models' allowance is images (one, shared), the same numbers in every credits mode.
        assert.match(slide.allowance, /^Free: 2 images a week\. Plus 100, Pro 400 and Max 1,500 images a month\.$/);
        continue;
      }
      if (mode) {
        // Credits: the plan figures come from the same table the pricing page prints.
        const row = group.rows.find((r) => r.label === "AI credits per month");
        assert.match(slide.allowance, /^Uses your plan's AI credits: /);
        assert.equal(new RegExp(`Plus ${row.values[1]}`).test(slide.allowance), TOKEN_QUOTAS.plus[slide.id].monthly > 0, `${slide.id}: Plus credits are named only where Plus includes it (Vulcan is Pro and Max)`);
        assert.equal(new RegExp(`Pro ${row.values[2]}`).test(slide.allowance), TOKEN_QUOTAS.pro[slide.id].monthly > 0, `${slide.id}: Pro credits are named only where Pro includes it (Zenith is Max only)`);
        assert.match(slide.allowance, new RegExp(`Max ${row.values[3]}`), `${slide.id}: Max includes every model`);
        assert.equal(/Free \d/.test(slide.allowance), TOKEN_QUOTAS.free[slide.id].monthly > 0, `${slide.id}: Free credits are named only where Free includes it`);
        assert.match(slide.allowance, /allocated weekly\.$/);
        assert.equal(row.values[0], String(MONTHLY_CREDITS.free));
      } else {
        // No credits mode: the existing allowance wording, with no mention of credits.
        assert.doesNotMatch(slide.allowance, /AI credits/);
        if (TOKEN_QUOTAS.free[slide.id].monthly > 0) assert.match(slide.allowance, /Up to 15 AI requests in any 24 hours and \$0\.25 each UTC calendar month/);
      }
      assert.ok(slide.allowance.length > 20, `${slide.id}: ${mode}: has an allowance line`);
    }
  }
  // Under credits no figure of the superseded token tables survives on any slide.
  for (const slide of orbitSlides("carry")) assert.doesNotMatch(JSON.stringify(slide), /\btokens?\b|5-hour|24 hours|\$0\.25|15 AI requests/i, `${slide.id}: no old allowance wording under credits`);
});

test("nothing invented: no rating, count, review, person, ranking or statistic, and every number comes from the product's own tables", () => {
  const FABRICATED = /\brat(?:ing|ed|ings)\b|★|\bstars?\b|\blikes?\b|\breviews?\b|\bchef\b|\bkitchen\b|most loved|#\s?\d|\d+(?:\.\d)?\s*\/\s*5|\bcustomers?\b|\btrusted by\b|\bloved by\b|\bmillions?\b|\bthousands?\b/i;
  for (const mode of MODES) {
    const known = JSON.stringify([PRODUCT_KNOWLEDGE, comparisonGroupsFor(mode), TOKEN_QUOTAS, MONTHLY_CREDITS]);
    const knownNumbers = new Set(known.match(/\d+(?:\.\d+)?/g));
    for (const slide of orbitSlides(mode)) {
      const text = [slide.title, slide.subtitle, slide.eyebrow, slide.label, slide.alt, slide.badge.label, slide.availability, slide.overview, slide.allowance, ...slide.bestFor].join(" | ");
      assert.doesNotMatch(text, FABRICATED, `${slide.id}: ${mode}: nothing made up`);
      for (const number of text.match(/\d+(?:\.\d+)?/g) ?? []) assert.ok(knownNumbers.has(number), `${slide.id}: ${mode}: the number ${number} is not in the product's own tables`);
    }
  }
});

test("no underlying AI vendor, upstream model ID or routing detail anywhere in the section", () => {
  const VENDOR = /openrouter|openai|anthropic|gemini|claude|groq|composio|deepseek|qwen|moonshot|kimi|mistral|llama|\bgrok\b|\bglm\b|minimax|cohere|\bgoogle\b(?! sans)|fireworks|together\.ai|azure|bedrock|vertex|\bgpt-\d|\bo[134]-(?:mini|preview)|\b[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*\d[a-z0-9.-]*\b|provider|upstream|\brouting\b/i;
  for (const mode of MODES) for (const slide of orbitSlides(mode)) assert.doesNotMatch(JSON.stringify(slide), VENDOR, `${slide.id}: ${mode}`);
  for (const file of OWN_SOURCES) assert.doesNotMatch(stripComments(read(file)), VENDOR, `${file}`);
  const home = read("public/home/index.html");
  const section = home.slice(home.indexOf('<section class="orbits"'), home.indexOf('<section class="showcase"'));
  assert.doesNotMatch(section, VENDOR, "the homepage section");
  for (const model of ORBIT_MODEL_IDS) assert.doesNotMatch(read(`public/home/models/${model}.svg`), VENDOR, `${model}.svg`);
});

test("the two actions are real: Try it goes where the page's sign-up goes, See plans goes to pricing", () => {
  assert.deepEqual(ORBIT_ACTIONS.map(({ label, href }) => ({ label, href })), [
    { label: "Try it", href: "/signup" },
    { label: "See plans", href: "/pricing" },
  ]);
  const home = read("public/home/index.html");
  assert.ok(home.includes('<a class="btn btn-primary" href="/signup" id="hero-start">'), "the hero's own sign-up link is /signup");
  assert.ok(PUBLIC_PAGES["/pricing"], "/pricing is a real public page");
});

test("accents are distinct per slide and never used as a text colour", () => {
  const accents = orbitSlides().map((s) => s.accent.toLowerCase());
  assert.equal(new Set(accents).size, ORBIT_MODEL_IDS.length, "a different accent per slide");
  for (const accent of accents) assert.match(accent, /^#[0-9a-f]{6}$/);
  const hue = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const max = Math.max(r, g, b); const d = max - Math.min(r, g, b); if (!d) return 0; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  const hues = accents.map(hue).sort((a, b) => a - b);
  for (let i = 1; i < hues.length; i++) assert.ok(hues[i] - hues[i - 1] >= 15, `neighbouring accents differ in hue by at least 15 degrees (${hues.map(Math.round)})`);
  // The accent paints the arc and the badge dot only. Words are in the theme's ink, so they are as readable as the rest of the page.
  const code = stripComments(read(COMPONENT));
  assert.doesNotMatch(code, /--osh-accent|color:\s*\$\{|color: (?:s|slide)\.accent/, "no style rule or inline style sets a text colour from the accent");
  assert.equal((code.match(/\.accent/g) ?? []).length, 1, "the accent is read once, for the arc");
  assert.match(code, /background: s\.badge\.dot/, "and the badge dot is a background, not a text colour");
});

// ---- The artwork ----------------------------------------------------------------------------------------

test("original local SVG orbs, one per slide, in the lit-sphere construction of the site's planets", () => {
  const seenBodies = new Set();
  for (const slide of orbitSlides()) {
    assert.equal(slide.image, `/home/models/${slide.id}.svg`);
    const file = path.join(frontend, "public", slide.image);
    assert.ok(fs.existsSync(file), `${slide.image} exists`);
    const svg = fs.readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(svg) < 8000, `${slide.id}.svg is small (${Buffer.byteLength(svg)} bytes)`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 800 800" width="800" height="800">/);
    assert.match(svg, /<\/svg>\s*$/);
    // Transparent: no background rectangle, only the halo and the sphere.
    assert.doesNotMatch(svg, /<rect[^>]*width="800"[^>]*height="800"|<rect[^>]*height="800"[^>]*width="800"/, "no full-canvas background");
    // Not flat discs: a lit body, a night veil, a rim and a pale halo, as in public/planets/guarantee.svg.
    for (const part of ["halo", "body", "night", "rim"]) assert.match(svg, new RegExp(`id="[a-z]{2}-${part}"`), `${slide.id}: has a ${part} gradient`);
    assert.ok((svg.match(/<radialGradient/g) ?? []).length >= 4);
    // Self-contained and inert.
    assert.doesNotMatch(svg, /<image\b|<script\b|<foreignObject|xlink:href|\shref=|url\((?!#)|@import|data:|https?:\/\/(?!www\.w3\.org)/i, `${slide.id}.svg refers to nothing outside itself`);
    // Every url(#id) it uses is defined in it.
    const ids = new Set([...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(ref[1]), `${slide.id}.svg: ${ref[1]} is defined`);
    seenBodies.add(svg.match(/id="[a-z]{2}-body"[\s\S]*?<stop offset="0.6" stop-color="(#[0-9a-f]{6})"/)[1]);
  }
  assert.equal(seenBodies.size, ORBIT_MODEL_IDS.length, "each orb has its own colour");
  // Study carries a book; Vulcan a ring.
  assert.match(read("public/home/models/study.svg"), /id="st-page"/);
  assert.match(read("public/home/models/vesper.svg"), /id="ve-ring"/);
});

test("every orb has its own useful alternative text, and the picture is never described as something it is not", () => {
  const alts = orbitSlides().map((s) => s.alt);
  assert.equal(new Set(alts).size, ORBIT_MODEL_IDS.length);
  for (const slide of orbitSlides()) {
    assert.ok(slide.alt.length >= 40 && slide.alt.length <= 140, `${slide.id}: alt is a sentence, not a filename (${slide.alt.length})`);
    assert.match(slide.alt, new RegExp(slide.subtitle), `${slide.id}: alt names the model`);
    assert.doesNotMatch(slide.alt, /\bimage of\b|\bpicture of\b|\.svg\b|\bicon\b/i);
  }
});

test("no stock photo, no external image, no embedded font or image in the section's code", () => {
  for (const file of OWN_SOURCES) {
    const code = stripComments(read(file));
    // The one URL in the section's code is this site's own API host, built from the page's own hostname (the same fallback the page's script uses).
    assert.doesNotMatch(code.replace("`https://api.${location.hostname.replace(/^www\\./, \"\")}`", ""), /https?:\/\//, `${file}: no external URL`);
    assert.doesNotMatch(code, /data:(?:font|image)|base64|FONT_DATA|@font-face|\.woff2?/i, `${file}: nothing embedded`);
  }
  const home = read("public/home/index.html");
  const section = home.slice(home.indexOf('<section class="orbits"'), home.indexOf('<section class="showcase"'));
  assert.doesNotMatch(section, /https?:\/\/|\.(?:jpe?g|png)\b|unsplash|pexels|stock/i);
});

// ---- The component --------------------------------------------------------------------------------------

test("it never loops by default, and the page's scroll is never captured: no wheel listener unless looping", () => {
  const src = read(COMPONENT);
  assert.match(src, /loop = false,/, "the component's default is not to loop");
  assert.match(read("src/orbit-showcase-island.jsx"), /loop=\{false\}/, "and the homepage says so too");
  // The only wheel listener is the looping one, and it is added only when looping.
  assert.equal((src.match(/addEventListener\("wheel"/g) ?? []).length, 1);
  assert.match(src, /if \(loop\) window\.addEventListener\("wheel"/);
  // Keys: only the two arrow keys are taken; Page Down, Space, End, Tab and Up/Down keep their meaning.
  assert.equal((src.match(/preventDefault\(\)/g) ?? []).length, 2);
  assert.match(src, /e\.key === "ArrowRight"[^}]*preventDefault[\s\S]*e\.key === "ArrowLeft"[^}]*preventDefault/);
  // The stage sticks by CSS; it does not pin with a scroll-blocking spacer or take over the scroller.
  assert.doesNotMatch(stripComments(src), /\bpin\s*:|pinSpacing|ScrollSmoother|scrollerProxy|document\.body\.style|documentElement\.style/);
  assert.match(src, /position:sticky/);
});

test("reduced motion: no scroll-driven pinning, no timelines, no transitions", () => {
  const src = read(COMPONENT);
  assert.match(src, /const REDUCED = "\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /const pinned = scrollDriven && !reduced/);
  assert.match(src, /const steps = pinned \? scrollSteps\(n, loop\) : 0/, "no scroll stretches, so the track is one stage tall");
  assert.match(src, /from === -1 \|\| from === to \|\| reducedRef\.current/, "slides swap without a timeline");
  assert.match(src, /@media \(prefers-reduced-motion:reduce\)\{\.osh-track,\.osh-dot,\.osh-dot i,\.osh-th \.osh-btn,\.osh-th img\{transition:none\}\}/);
});

test("colours come from the page's theme tokens (the four named, then this site's own), the stage is transparent, and the font is the site's own", () => {
  const css = read(COMPONENT).match(/const CSS =([\s\S]*?)\nconst HIDE_1/)[1];
  for (const token of ["--color-foreground", "--color-background", "--color-primary", "--color-muted-foreground"]) assert.ok(css.includes(`var(${token},`), `${token} is read first`);
  // The tokens that exist in this repository (src/theme/vibhav.css) are the fallbacks, so both skies work.
  const theme = read("src/theme/vibhav.css");
  for (const token of ["--color-ink", "--color-paper", "--color-accent", "--color-muted", "--color-rule", "--color-focus"]) {
    assert.ok(css.includes(`var(${token},`), `${token} is the fallback`);
    assert.ok(theme.includes(`${token}:`), `${token} exists in the theme`);
  }
  assert.match(css, /\.osh-root\{[^}]*position:sticky;/);
  assert.doesNotMatch(css.match(/\.osh-root\{[^}]*\}/)[0], /background:/, "no stage background: the page's own wash shows through, so dark stays consistent");
  assert.doesNotMatch(css, /(?<![\w-])color:\s*#[0-9a-fA-F]{3,8}/, "no fixed text colour");
  // The font is already self-hosted (public/fonts/v1/fonts.css): variable 100 to 900, so the thin and heavy lines are real weights.
  const fonts = fs.readFileSync(path.join(frontend, "public/fonts/v1/fonts.css"), "utf8");
  assert.match(fonts, /font-family: 'Hanken Grotesk';[\s\S]*?font-weight: 100 900;/);
  assert.match(css, /font-family:var\(--font-body,system-ui\),system-ui,sans-serif/, "the design system's body face");
  assert.doesNotMatch(css, /Hanken Grotesk/, "no font outside the design system");
  assert.match(css, /\.osh-t1\{font-weight:200/);
  assert.match(css, /\.osh-t2\{font-weight:800/);
});

test("nothing food-related is left, and the file says what was adapted", () => {
  for (const file of OWN_SOURCES) assert.doesNotMatch(stripComments(read(file)), /\bdish(?:es)?\b|ingredient|\bchef\b|\brating\b|kitchen|recipe|Order food|Play video|\bdsh-|\blikes?\b/i, file);
  const src = read(COMPONENT);
  assert.match(src, /Adapted from the supplied "Dish Orbit Carousel"/);
  assert.match(src, /The licence for GSAP is in \.\/LICENSES\.md\./);
  assert.match(src, /It never loops by default \(loop = false\)/);
});

test("it renders safely without a window: nothing at import time or during render touches the DOM", () => {
  const code = stripComments(read(COMPONENT));
  const before = code.slice(0, code.indexOf("export function OrbitShowcase"));
  // At module level only a guarded registration; window is read in effects, handlers and the reduced-motion store.
  assert.match(code, /if \(typeof window !== "undefined"\) gsap\.registerPlugin\(ScrollTrigger\)/);
  const bare = before.replace(/if \(typeof window !== "undefined"\)[^\n]*/, "").replace(/function subscribeReduced[\s\S]*?\n\}\n/, "").replace(/function usePrefersReducedMotion[\s\S]*?\n\}\n/, "");
  assert.doesNotMatch(bare, /\b(?:window|document|navigator|localStorage|matchMedia)\b/);
  // The reduced-motion hook has a server answer.
  assert.match(code, /useSyncExternalStore\(subscribeReduced, \(\) => window\.matchMedia\(REDUCED\)\.matches, \(\) => false\)/);
});

// ---- Loading and the page -------------------------------------------------------------------------------

test("GSAP is installed at an exact version, and is loaded only by the section's own chunk", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies.gsap, "3.15.1", "pinned exactly");
  const effects = read("src/home-effects.tsx");
  assert.match(effects, /import\("\.\/orbit-showcase-island"\)/, "loaded with a dynamic import");
  assert.doesNotMatch(effects, /from "\.\/orbit-showcase-island"|from "@\/components\/ui\/orbit-showcase"|from "gsap/, "never imported statically by the logo's module");
  assert.match(effects, /homeEffectState = "failed"/, "a failed load releases the reserved space");
  const boot = read("src/home-effects-boot.ts");
  assert.doesNotMatch(boot, /gsap|orbit/, "the boot script, the only script the page names, knows nothing of it");
  assert.match(read("src/orbit-showcase-island.jsx"), /import \{ OrbitShowcase \} from "@\/components\/ui\/orbit-showcase"/);
});

test("the GSAP licence is on file: what it says, and the question it leaves open", () => {
  const licences = read("src/components/ui/LICENSES.md");
  assert.match(licences, /orbit-showcase\.tsx/);
  assert.match(licences, /GSAP 3\.15\.1/);
  assert.match(licences, /Standard 'no charge' license/);
  assert.ok(licences.includes("https://gsap.com/standard-license"));
  assert.match(licences, /commercial/);
  assert.match(licences, /visual animation/);
  assert.match(licences, /AGPL-3\.0-only/);
  assert.match(licences, /decision for the owner/);
  // The existing notices are kept.
  assert.match(licences, /zanwei\/glass-icon-reveal/);
});

test("the homepage section sits below the hero and above the features, with a heading and a place for the stage", () => {
  const home = read("public/home/index.html");
  const at = (re) => { const m = home.match(re); assert.ok(m, `${re} is on the page`); return m.index; };
  const order = [at(/<section class="hero"/), at(/<section class="orbits" id="models"/), at(/<section class="showcase" id="showcase"/), at(/<footer class="site-footer"/)];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const section = home.match(/<section class="orbits"[\s\S]*?<\/section>/)[0];
  assert.match(section, /<h2 id="models-title">Models<\/h2>/);
  assert.equal((section.match(/<h[1-6]\b/g) ?? []).length, 1, "one heading in the source; the five tiers' headings are written at build time");
  assert.match(section, /<div class="orbits__stage" data-home-effect="orbit-showcase" style="--orbit-track:5\.2"><!-- orbit-showcase --><\/div>/);
  assert.equal((home.match(/<!-- orbit-showcase -->/g) ?? []).length, 1, "the build writes the plain list here");
  // The reserved length is the component's own track length, for however many slides there are (four since 2026-11-14), to the
  // precision the page writes it.
  assert.ok(Math.abs(Number(home.match(/--orbit-track:([\d.]+)/)[1]) - orbitTrackFactor(ORBIT_MODEL_IDS.length)) < 1e-9, "the page reserves the component's track length");
  assert.equal(orbitTrackFactor(6), 1 + 5 * ORBIT_SCROLL_PER_SLIDE);
  assert.equal(ORBIT_STICKY_TOP, 72);
  // Before the stage loads the box has its exact final height and clips the list, so nothing below it moves; the box is released
  // when the stage is live, still, or failed. Under reduced motion the stage is one stage tall.
  const pre = ':not([data-home-effect-state="live"]):not([data-home-effect-state="failed"]):not([data-home-effect-state="still"])';
  assert.ok(home.includes(`html.presenting:not(.save-data) .orbits__stage${pre}{height:calc((100svh - 72px) * var(--orbit-track,4.5));overflow:hidden}`));
  assert.ok(home.includes(`@media (prefers-reduced-motion:reduce){html:not(.save-data) .orbits__stage${pre}{height:calc(100svh - 72px);overflow:hidden}}`));
  assert.doesNotMatch(home, /\.orbits__stage[^{]*\{min-height/, "a height, not a minimum: the list is taller than a stage on a phone");
});

test("the hero, the five features and the Guarantee are as they were", () => {
  const home = read("public/home/index.html");
  const hero = home.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<h1 id="hero-title">AI chat, study tools and image creation\.<\/h1>/);
  assert.match(hero, /<a class="btn btn-quiet" href="#showcase" id="hero-explore">Explore features<\/a>/);
  const showcase = home.match(/<section class="showcase"[\s\S]*?<\/section>/)[0];
  assert.equal((showcase.match(/<article class="slide"/g) ?? []).length, 5);
  assert.match(showcase, /<article class="slide" id="slide-guarantee" data-i="4">/);
  assert.match(showcase, /<h3><a href="\/guarantee">The VibhavGPT Guarantee<\/a><\/h3><p>We never train on your chats, sell your data, or show ads\.<\/p>/);
});

// ---- The built page -------------------------------------------------------------------------------------

test("built: the home HTML already holds the six models as real text, and still has exactly one h1", { skip: !built && "frontend/dist is not built" }, () => {
  const html = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<!-- orbit-showcase -->/g) ?? []).length, 0, "the marker is replaced");
  const stage = html.match(/<div class="orbits__stage"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/)[1];
  const headings = [...stage.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["VibhavGPT Lumen", "VibhavGPT Vulcan", "VibhavGPT Zenith", "VibhavGPT Tecton", "VibhavGPT Study", "VibhavGPT Prism"]);
  const mode = ["expiry", "carry"].includes(process.env.VITE_CREDITS_PUBLIC_COPY) ? process.env.VITE_CREDITS_PUBLIC_COPY : null;
  const text = stage.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  for (const slide of orbitSlides(mode)) {
    assert.ok(text.includes(slide.overview), `${slide.subtitle}: overview is in the static HTML`);
    assert.ok(text.includes(slide.availability), `${slide.subtitle}: availability is in the static HTML`);
    assert.ok(text.includes(slide.allowance), `${slide.subtitle}: allowance wording matches this build's credits mode`);
  }
  for (const slide of orbitSlides()) assert.ok(stage.includes(`alt="${slide.alt}"`), `${slide.id}: the picture has its alternative text`);
  assert.match(stage, /<a class="btn btn-primary" href="\/signup">Try it<\/a><a class="btn btn-quiet" href="\/pricing">See plans<\/a>/);
  for (const img of stage.match(/<img\b[^>]*>/g)) assert.match(img, /\salt="[^"]{20,}"/);
});

test("built: GSAP is in one lazy chunk, and neither the page's first script nor the logo's module contains it", { skip: !built && "frontend/dist is not built" }, () => {
  const assets = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js"));
  const withGsap = assets.filter((f) => /ScrollTrigger/.test(fs.readFileSync(path.join(dist, "assets", f), "utf8")));
  assert.equal(withGsap.length, 1, `exactly one chunk contains GSAP (${withGsap})`);
  assert.match(withGsap[0], /^orbit-showcase-island-/);
  const html = fs.readFileSync(path.join(dist, "home/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.every((src) => !src.includes("orbit-showcase")), "the page does not name the chunk");
  assert.ok(!html.includes('rel="modulepreload"') || !/orbit-showcase/.test(html), "it is not preloaded either");
  const boot = assets.find((f) => f.startsWith("homeEffects-"));
  assert.ok(boot && !/gsap|ScrollTrigger/.test(fs.readFileSync(path.join(dist, "assets", boot), "utf8")), "the boot script has none of it");
  const size = fs.statSync(path.join(dist, "assets", withGsap[0])).size;
  assert.ok(size < 200_000, `the chunk is ${Math.round(size / 1000)} kB`);
});

test("built: the orbs are copied into the site, and the sitemap and the other pages are unaffected", { skip: !built && "frontend/dist is not built" }, () => {
  for (const id of ORBIT_MODEL_IDS) assert.ok(fs.existsSync(path.join(dist, "home/models", `${id}.svg`)), `${id}.svg is served`);
  const sitemap = fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8");
  assert.doesNotMatch(sitemap, /models/, "no new page was added");
  for (const page of ["pricing", "terms", "privacy", "guarantee"]) assert.doesNotMatch(fs.readFileSync(path.join(dist, `${page}.html`), "utf8"), /orbit-showcase|osh-/, `${page}.html does not carry it`);
});
