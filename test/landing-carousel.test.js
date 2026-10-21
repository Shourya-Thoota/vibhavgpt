import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The landing page's hero is a four-planet carousel: What It Is (over
// Earth), the VibhavGPT Guarantee (a gold world), Image (Venus) and Study
// (Mars). The planets beside the button, their labels and the arrow keys
// move it one step either way, wrapping round. The navbar shows the official
// mark beside a sans wordmark, and /pricing sits in the same night sky.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const home = read("frontend/public/home/index.html");
const slides = JSON.parse(home.match(/<script type="application\/json" id="carousel-slides">([\s\S]*?)<\/script>/)[1]);

test("the four slides, in order, with their badges, titles and copy", () => {
  assert.deepEqual(slides.order, ["earth", "guarantee", "venus", "mars"]);
  assert.deepEqual(slides.slides.earth, { label: "WHAT IT IS", badge: "WORKSPACE", title: "ALL-IN-ONE AI", lede: "Private AI chat, image creation, and interactive study tools." });
  assert.deepEqual(slides.slides.guarantee, { label: "GUARANTEE", badge: "PRIVACY", title: "OUR GUARANTEE", lede: "No training on your chats, no data selling, and no ads. Complete privacy by design." });
  assert.deepEqual(slides.slides.venus, { label: "IMAGE", badge: "VISUALS", title: "IMAGE CREATION", lede: "Turn descriptions, ideas, and study notes into visual art." });
  assert.deepEqual(slides.slides.mars, { label: "STUDY", badge: "LEARNING", title: "STUDY TOOLS", lede: "3D flippable flashcards and instant-feedback quizzes with score tracking." });
  for (const slide of Object.values(slides.slides)) assert.ok(slide.title.split(/\s+/).length <= 2, `short, punchy title: ${slide.title}`);
  for (const slide of Object.values(slides.slides)) for (const text of Object.values(slide)) assert.doesNotMatch(text, /—|–/, "no em or en dashes in page copy");
  assert.doesNotMatch(home, /PRIVATE AI</, "the old slide is gone");
});

test("the page opens on What It Is over Earth, before any script runs", () => {
  assert.match(home, /<div class="atmosphere is-active" data-planet="earth">/);
  assert.match(home, /<div class="col eyebrow"><span class="ent-mask"><span class="ent-line">WORKSPACE<\/span><\/span><\/div>/);
  assert.match(home, /<h1 class="col title" aria-live="polite"><span class="ent-mask"><span class="ent-line">ALL-IN-ONE AI<\/span><\/span><\/h1>/);
  assert.match(home, /<p class="col lede">Private AI chat, image creation, and interactive study tools\.<\/p>/);
  assert.match(home, /<button class="planet planet-l" type="button" data-slot="l" aria-label="Show STUDY">.*?<img data-planet="mars" class="is-shown"/, "Study waits on the left");
  assert.match(home, /<button class="planet planet-r" type="button" data-slot="r" aria-label="Show GUARANTEE">.*?<img data-planet="guarantee" class="is-shown" src="\/planets\/guarantee\.svg"/, "the Guarantee waits on the right");
  assert.match(home, /<a href="\/signup">GET STARTED<\/a><span class="label label-l">STUDY<\/span><span class="label label-r">GUARANTEE<\/span>/);
  assert.match(home, /<div class="atmosphere" data-planet="guarantee"><div class="orb"><img src="\/planets\/guarantee\.svg" alt=""><\/div><\/div>/);
  const planet = read("frontend/public/planets/guarantee.svg");
  assert.match(planet, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 800 800"/);
  assert.doesNotMatch(planet, /<script|on\w+=/i, "a plain picture");
});

// A small stand-in for the DOM: just what the carousel script touches.
function makeElement(extra = {}) {
  const classes = new Set(extra.classes ?? []);
  const listeners = {};
  return Object.assign({
    dataset: { ...(extra.dataset ?? {}) },
    attributes: {},
    textContent: extra.textContent ?? "",
    style: {},
    children: [],
    clientWidth: 1000,
    classList: {
      add: (name) => classes.add(name), remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name),
      toggle: (name, force) => { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; },
    },
    has: (name) => classes.has(name),
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); },
    emit: (type, event = {}) => (listeners[type] ?? []).forEach((handler) => handler({ preventDefault() {}, stopPropagation() {}, ...event })),
    append(child) { this.children.push(child); },
    contains: () => false,
    decode: () => Promise.resolve(),
  }, extra.props ?? {});
}

function runCarousel() {
  const planets = ["earth", "guarantee", "venus", "mars"];
  const atmospheres = planets.map((planet) => makeElement({ dataset: { planet }, classes: planet === "earth" ? ["is-active"] : [] }));
  const slotImages = { l: planets.map((planet) => makeElement({ dataset: { planet } })), r: planets.map((planet) => makeElement({ dataset: { planet } })) };
  const slots = ["l", "r"].map((slot) => makeElement({ dataset: { slot }, props: { querySelectorAll: () => slotImages[slot] } }));
  const titleLine = makeElement();
  const titleBox = makeElement({ props: { querySelector: () => titleLine } });
  const nodes = {
    ".eyebrow .ent-line": makeElement(), "h1 .ent-line": titleLine, ".lede": makeElement(),
    ".label-l": makeElement({ classes: ["label", "label-l"] }), ".label-r": makeElement({ classes: ["label", "label-r"] }),
    ".scroll": makeElement(), ".navrow": makeElement(), ".links": makeElement(), ".burger": makeElement(), ".stars": makeElement(), "h1.title": titleBox,
  };
  const documentListeners = {};
  const document = {
    images: [...slotImages.l, ...slotImages.r],
    fonts: { ready: Promise.resolve() },
    documentElement: makeElement(),
    getElementById: (id) => (id === "carousel-slides" ? { textContent: JSON.stringify(slides) } : null),
    querySelector: (selector) => nodes[selector] ?? null,
    querySelectorAll: (selector) => ({ ".planet": slots, ".atmosphere": atmospheres, ".label": [nodes[".label-l"], nodes[".label-r"]] }[selector] ?? []),
    createElement: () => makeElement(),
    createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ width: 800 }) }),
    addEventListener: (type, handler) => { (documentListeners[type] ??= []).push(handler); },
  };
  const script = [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((code) => code.includes("carousel-slides"));
  assert.ok(script, "the carousel script");
  vm.runInNewContext(script, {
    document, matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ fontSize: "80px" }),
    addEventListener() {}, requestAnimationFrame: (run) => run(), setTimeout: (run) => run(), Promise, JSON, Math, parseFloat, String,
  });
  const state = () => ({
    active: atmospheres.find((element) => element.has("is-active"))?.dataset.planet,
    badge: nodes[".eyebrow .ent-line"].textContent,
    title: titleLine.textContent,
    left: nodes[".label-l"].textContent,
    right: nodes[".label-r"].textContent,
    leftPlanet: slotImages.l.find((image) => image.has("is-shown"))?.dataset.planet,
    rightPlanet: slotImages.r.find((image) => image.has("is-shown"))?.dataset.planet,
  });
  const key = (name) => (documentListeners.keydown ?? []).forEach((handler) => handler({ key: name, target: { tagName: "BODY" }, preventDefault() {} }));
  return { state, slots, nodes, key, lede: nodes[".lede"] };
}

test("the carousel opens on Earth and cycles 1, 2, 3, 4 and back to 1 either way", () => {
  const { state, slots, nodes, key, lede } = runCarousel();
  assert.deepEqual(state(), { active: "earth", badge: "WORKSPACE", title: "ALL-IN-ONE AI", left: "STUDY", right: "GUARANTEE", leftPlanet: "mars", rightPlanet: "guarantee" });
  const right = slots.find((slot) => slot.dataset.slot === "r");
  const left = slots.find((slot) => slot.dataset.slot === "l");
  right.emit("click");
  assert.deepEqual(state(), { active: "guarantee", badge: "PRIVACY", title: "OUR GUARANTEE", left: "WHAT IT IS", right: "IMAGE", leftPlanet: "earth", rightPlanet: "venus" }, "slide 2 is the VibhavGPT Guarantee");
  assert.match(lede.textContent, /^No training on your chats/);
  right.emit("click");
  assert.equal(state().title, "IMAGE CREATION");
  nodes[".label-r"].emit("click");
  assert.equal(state().title, "STUDY TOOLS", "the labels move it too");
  key("ArrowRight");
  assert.equal(state().active, "earth", "and it wraps from Study back to What It Is");
  left.emit("click");
  assert.equal(state().active, "mars", "backwards wraps too");
  key("ArrowLeft");
  nodes[".label-l"].emit("click");
  assert.equal(state().active, "guarantee");
  assert.equal(right.attributes["aria-label"], "Show IMAGE", "the planets say where they lead");
});

test("long titles fit on one line on wide screens and wrap on phones", () => {
  assert.match(home, /h1\.title \.ent-line\{white-space:nowrap\}/);
  assert.match(home, /@media\(max-width:579px\),\(max-height:620px\)\{h1\.title\{font-size:calc\(46 \* var\(--u\)\);line-height:1\.08\}h1\.title \.ent-line\{white-space:normal;text-wrap:balance\}\}/);
  assert.match(home, /function fitTitle\(\)\{titleLine\.style\.fontSize='';if\(narrow\.matches\)return;/);
  assert.match(home, /addEventListener\('resize',fitTitle\);document\.fonts\?\.ready\.then\(fitTitle\);/);
});

test("titles and ledes sit in a narrow centred column instead of stretching across the screen", () => {
  assert.match(home, /h1\.title\{max-width:680px;margin:0 auto;text-wrap:balance;text-align:center;text-indent:0;font-size:clamp\(2\.2rem,5vw,3\.4rem\);letter-spacing:-0\.02em;line-height:1\.15\}/);
  assert.match(home, /p\.lede\{max-width:540px;margin:14px auto 0;font-size:clamp\(0\.95rem,1\.4vw,1\.05rem\);line-height:1\.5;opacity:0\.85;--settle:0\.85\}/);
  assert.match(home, /@keyframes ent-rise\{[^}]*\}to\{opacity:var\(--settle,1\);/, "the lede's entrance settles at its softer opacity");
  assert.match(home, /@media\(max-width:579px\),\(max-height:620px\)\{h1\.title\{margin-top:calc\(15 \* var\(--u\)\)\}\}/, "phones keep the gap under the badge");
  const css = home.slice(0, home.indexOf("</style>"));
  assert.ok(css.lastIndexOf("h1.title{max-width:680px") > css.lastIndexOf("{h1.title{font-size:calc(46 * var(--u))"), "the constraints win over the older sizes");
});

test("the navbar shows the official mark beside a sans wordmark", () => {
  assert.match(home, /<a class="logo" href="\/home"><img src="\/brand\/vibhavgpt-icon-64\.png" srcset="\/brand\/vibhavgpt-icon-64\.png 1x, \/brand\/vibhavgpt-icon-192\.png 3x" width="30" height="30" alt=""><span>Vibhav<i>GPT<\/i><\/span><\/a>/);
  assert.match(home, /\.logo\{display:inline-flex;align-items:center;gap:calc\(10 \* var\(--u\)\);font-family:var\(--font-body\);font-weight:650;/, "the app's sans, not the display serif");
});

test("the public Pricing page sits in the night sky, with readable plans", () => {
  const app = read("frontend/src/App.jsx");
  const pricing = app.slice(app.indexOf("export function PublicPricing("), app.indexOf("function Billing("));
  assert.match(pricing, /<div className="pricing-cosmos">\s*<div className="pricing-cosmos__sky" aria-hidden="true">/);
  for (const planet of ["earth", "venus", "mars"]) assert.match(pricing, new RegExp(`pricing-cosmos__planet--${planet}" src="/planets/${planet}\\.webp" alt=""`));
  assert.match(pricing, /<Billing tier="visitor" publicPreview \/>/, "the plans themselves are unchanged");
  const css = read("frontend/src/pricing.css");
  assert.match(css, /\.pricing-cosmos__sky \{ position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; \}/, "behind everything, taking no clicks");
  assert.match(css, /\.pricing-cosmos \.plans\.rate-card \{\s*background: color-mix\(in srgb, var\(--color-paper-2\) 95%, transparent\);\s*backdrop-filter: blur\(10px\);/);
  assert.match(css, /\.pricing-cosmos \.compare__scroll \{[^}]*background: color-mix\(in srgb, var\(--color-paper-2\) 94%, transparent\);/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.pricing-cosmos__planet--earth \{ animation:/, "motion only when wanted");
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.pricing-cosmos__planet--earth \{ width: 200px;/, "smaller on phones");
  assert.doesNotMatch(css.slice(css.indexOf("The public /pricing page")), /#[0-9a-f]{3,8}\b/i, "theme tokens only");
});
