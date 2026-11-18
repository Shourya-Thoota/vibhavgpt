// The first download stays free of code most visits never run (2026-11-17): KaTeX loads when a reply holds math (math-loader.js),
// Sentry ships only what the app calls, and the model marks are sized for the 20px they are shown at. Behaviour is unchanged; these
// pin the structure that keeps it light, and the built output when frontend/dist exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadMath, needsMath } from "../frontend/src/math-loader.js";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("needsMath: an unescaped $ (a formula after normalizing) needs the plugins; escaped currency and plain text do not", () => {
  for (const text of ["$x^2$", "Energy is $E = mc^2$.", "$$\\int_0^1 x\\,dx$$", "a\n$y$"]) assert.equal(needsMath(text), true, text);
  for (const text of ["", null, undefined, "No math here.", "It costs \\$5 and \\$10.", "`code` only"]) assert.equal(needsMath(text), false, String(text));
});

test("loadMath: one load shared by every caller; a failed load is tried again next time", async () => {
  let calls = 0;
  const failing = () => { calls += 1; return Promise.reject(new Error("offline")); };
  await assert.rejects(loadMath(failing), /offline/);
  await assert.rejects(loadMath(failing), /offline/);
  assert.equal(calls, 2, "a failure is not cached");
  const module = { remarkMath: () => {}, rehypeKatex: () => {} };
  let loads = 0;
  const importer = () => { loads += 1; return new Promise((resolve) => setTimeout(() => resolve(module), 5)); };
  const [a, b] = await Promise.all([loadMath(importer), loadMath(importer)]);
  assert.equal(loads, 1, "concurrent callers share the one load");
  assert.equal(a, b);
  assert.equal(a.rehypeKatex, module.rehypeKatex);
  assert.equal(await loadMath(() => { throw new Error("not called"); }), a, "once loaded, it is reused");
});

test("KaTeX and the math plugins are imported only by math-render.js, which App loads on demand", () => {
  const app = read("frontend/src/App.jsx");
  assert.doesNotMatch(app, /^import .*(remark-math|rehype-katex|katex)/m, "no static import in App.jsx");
  assert.match(read("frontend/src/math-loader.js"), /import\("\.\/math-render\.js"\)/, "loaded with a dynamic import");
  const render = read("frontend/src/math-render.js");
  for (const spec of ["remark-math", "rehype-katex", "katex/dist/katex.min.css"]) assert.ok(render.includes(`"${spec}"`), spec);
  // Every other source file leaves KaTeX alone, so nothing pulls it back into the first download.
  const others = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/math-(render|loader)\.js$/.test(entry.name) && /^import .*(remark-math|rehype-katex|["']katex)/m.test(fs.readFileSync(full, "utf8"))) others.push(full); } };
  walk(path.resolve("frontend/src"));
  assert.deepEqual(others, []);
  // The reply renderer keeps the same plugin options once they are loaded.
  assert.match(app, /\[math\.remarkMath, \{ singleDollarTextMath: true \}\]/);
  assert.match(app, /rehypePlugins=\{math \? \[math\.rehypeKatex\] : \[\]\}/);
});

test("Sentry: named imports of what the app calls, never the whole namespace (that kept replay and feedback in the bundle)", () => {
  const sentry = read("frontend/src/sentry.js");
  assert.doesNotMatch(sentry, /import \* as/);
  assert.match(sentry, /import \{ captureMessage, ErrorBoundary, init \} from "@sentry\/react";/);
  // The default export still offers every member the app uses.
  const used = new Set();
  for (const file of ["frontend/src/App.jsx", "frontend/src/main.jsx"]) for (const [, name] of read(file).matchAll(/\bSentry\.([A-Za-z]+)/g)) used.add(name);
  assert.deepEqual([...used].sort(), ["ErrorBoundary", "captureMessage"]);
});

test("the model marks are 128px PNGs with transparency, sized for the 20px they are shown at", () => {
  for (const name of ["gemini", "openai", "zai"]) {
    const file = path.resolve(`frontend/public/brand/providers/${name}.png`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.toString("ascii", 1, 4), "PNG", name);
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [128, 128], `${name}: 128x128`);
    assert.equal(bytes[25], 6, `${name}: RGBA, so its transparency is kept`);
    assert.ok(bytes.length < 32 * 1024, `${name}: ${bytes.length} bytes`);
  }
  assert.match(read("scripts/build-gemini-mark.mjs"), /const OUTPUT_SIZE = 128;[\s\S]*\.resize\(OUTPUT_SIZE, OUTPUT_SIZE/, "the generator writes the same size");
});

const dist = path.resolve("frontend/dist");
test("the built app's first download has no KaTeX and no session-replay code", { skip: fs.existsSync(path.join(dist, "index.html")) ? false : "frontend/dist is not built" }, () => {
  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(initial.length > 0);
  assert.ok(!initial.some((file) => /math-render|katex/i.test(file)), `initial: ${initial.join(", ")}`);
  for (const file of initial) {
    const code = fs.readFileSync(path.join(dist, "assets", file), "utf8");
    assert.doesNotMatch(code, /rrweb|replayIntegration|feedbackIntegration/, `${file}: no replay or feedback code`);
    assert.doesNotMatch(code, /renderToString\(|KaTeX parse error/, `${file}: no KaTeX engine`);
  }
  assert.ok(fs.readdirSync(path.join(dist, "assets")).some((file) => /^math-render-.*\.js$/.test(file)), "the math chunk is built");
});
