import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PREVIEW_CSP, PreviewError, buildPreviewDocument, normalizePath, resolveProjectPath } from "../frontend/src/build-preview.js";

// Build's live preview document (owner request 2026-11-15). The browser uses esbuild-wasm; these tests use the same esbuild API natively.
const frontendRequire = createRequire(new URL("../frontend/package.json", import.meta.url));
const esbuild = await import(pathToFileURL(frontendRequire.resolve("esbuild")).href);
const RUNTIME = "/* runtime */window.__vgModules={};";
const deps = { esbuild, loadRuntime: async () => RUNTIME };

test("the preview document carries its own no-network policy and reports errors to the card", async () => {
  const html = await buildPreviewDocument({ kind: "web", entry: "index.html", files: [{ path: "index.html", content: "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>" }] }, deps);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`));
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(PREVIEW_CSP.includes(rule), rule);
  assert.doesNotMatch(PREVIEW_CSP, /https?:|'self'|\*/, "no network source of any kind");
  assert.match(html, /vgPreview:"error"/);
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.ok(!html.includes(RUNTIME), "plain pages get no React runtime");
});

test("a web project's local scripts and stylesheets are bundled, with their relative imports", async () => {
  const html = await buildPreviewDocument({ kind: "web", entry: "index.html", files: [
    { path: "index.html", content: '<html><head><link rel="stylesheet" href="css/site.css"><base href="https://evil.example/"></head><body><p id="out"></p><script type="module" src="js/app.js"></script></body></html>' },
    { path: "css/site.css", content: '@import "./base.css"; p { color: red; }' },
    { path: "css/base.css", content: "body { margin: 0; }" },
    { path: "js/app.js", content: 'import { greet } from "./lib/greet.js"; document.getElementById("out").textContent = greet("preview");' },
    { path: "js/lib/greet.js", content: "export const greet = (name) => `Hello, ${name}`;" },
  ] }, deps);
  assert.match(html, /body\s*\{\s*margin:\s*0;?\s*\}/, "the stylesheet's @import is bundled");
  assert.match(html, /Hello, \$\{name\}|Hello, "\s*\+|`Hello, \$\{/, "the imported module is in the bundle");
  assert.doesNotMatch(html, /src="js\/app\.js"|href="css\/site\.css"/, "nothing is left to fetch");
  assert.doesNotMatch(html, /<base\b/, "a page's own <base> is dropped");
});

test("a React project is bundled with JSX, and React comes from the preview runtime, not the network", async () => {
  const html = await buildPreviewDocument({ kind: "react", entry: "src/main.jsx", files: [
    { path: "package.json", content: '{"dependencies":{"react":"^19"}}' },
    { path: "src/main.jsx", content: 'import { createRoot } from "react-dom/client"; import App from "./App"; createRoot(document.getElementById("root")).render(<App />);' },
    { path: "src/App.jsx", content: 'import { useState } from "react"; import "./App.css"; export default function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>Clicked {n}</button>; }' },
    { path: "src/App.css", content: "button { padding: 8px; }" },
  ] }, deps);
  assert.ok(html.includes(RUNTIME), "the runtime is inlined");
  assert.match(html, /window\.__vgModules\["react-dom\/client"\]/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /padding:\s*8px/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test("anything outside the project is refused with a plain reason, never fetched", async () => {
  await assert.rejects(buildPreviewDocument({ kind: "react", entry: "src/main.jsx", files: [{ path: "src/main.jsx", content: 'import { motion } from "framer-motion"; console.log(motion);' }] }, deps),
    (error) => error instanceof PreviewError && /can't load the package "framer-motion"/.test(error.message));
  await assert.rejects(buildPreviewDocument({ kind: "web", entry: "index.html", files: [{ path: "index.html", content: '<script src="missing.js"></script>' }] }, deps),
    (error) => error instanceof PreviewError && /"missing\.js", which is not one of the project's files/.test(error.message));
  assert.throws(() => normalizePath("../../etc/passwd"), PreviewError);
  assert.equal(resolveProjectPath(new Map([["a/b.js", ""]]), "./b", "a"), "a/b.js");
});

test("inline code cannot close the script it is placed in", async () => {
  const html = await buildPreviewDocument({ kind: "web", entry: "index.html", files: [
    { path: "index.html", content: '<body><script src="x.js"></script></body>' },
    { path: "x.js", content: 'document.body.append("</script><img src=x onerror=alert(1)>");' },
  ] }, deps);
  const scriptBodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scriptBodies.some((body) => body.includes("<\\/script>")), "the closing tag inside the code is escaped");
});

// Live test, 2026-11-15: a Create React App layout (public/index.html with no script tag; src/index.js calling ReactDOM.render) previewed blank.
test("a Create React App layout: the page template gets its entry script, as CRA's tooling would add it", async () => {
  const html = await buildPreviewDocument({ kind: "react", entry: "src/index.js", files: [
    { path: "package.json", content: '{"dependencies":{"react":"^18.2.0","react-dom":"^18.2.0","react-scripts":"5.0.1"}}' },
    { path: "public/index.html", content: '<!DOCTYPE html><html><head><title>Momentum</title></head><body><div id="root"></div></body></html>' },
    { path: "src/index.js", content: "import React from 'react';\nimport ReactDOM from 'react-dom';\nimport App from './App';\nimport './styles.css';\nReactDOM.render(<React.StrictMode><App /></React.StrictMode>, document.getElementById('root'));" },
    { path: "src/App.js", content: "export default function App() { return <h1>Momentum</h1>; }" },
    { path: "src/styles.css", content: "h1 { color: rebeccapurple; }" },
  ] }, deps);
  assert.match(html, /<title>Momentum<\/title>/, "the page's own head is kept");
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /window\.__vgModules\["react-dom"\]/, "the entry is bundled, with react-dom from the runtime");
  assert.match(html, /rebeccapurple/, "its stylesheet import is bundled");
});

test("JSX in a .js file is read as JSX in a React project only", async () => {
  const files = [{ path: "src/index.js", content: "const el = <p>hi</p>; console.log(el);" }];
  await buildPreviewDocument({ kind: "react", entry: "src/index.js", files }, deps);
  await assert.rejects(buildPreviewDocument({ kind: "web", entry: "src/index.js", files }, deps), PreviewError);
});

test("a page with its own inline script is left as it is, not given a second entry", async () => {
  const html = await buildPreviewDocument({ kind: "web", entry: "index.html", files: [
    { path: "index.html", content: '<html><body><p id="x"></p><script>document.getElementById("x").textContent = "inline";</script></body></html>' },
    { path: "index.js", content: 'document.body.dataset.second = "yes";' },
  ] }, deps);
  assert.doesNotMatch(html, /dataset\.second/);
});

test("the preview runtime gives react-dom the legacy render, on top of createRoot", () => {
  const source = fs.readFileSync(new URL("../frontend/scripts/build-preview-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /render\(element, container, callback\)/);
  assert.match(source, /ReactDOMClient\.createRoot\(container\)/);
  assert.match(source, /unmountComponentAtNode/);
  assert.match(source, /"react-dom": legacyDOM/);
});

test("the preview page gives storage an in-memory stand-in, only where the sandbox refuses the real one", async () => {
  const html = await buildPreviewDocument({ kind: "web", entry: "index.html", files: [{ path: "index.html", content: "<p>x</p>" }] }, deps);
  assert.match(html, /for\(const name of \["localStorage","sessionStorage"\]\)\{try\{window\[name\]\.getItem\("x"\)\}catch\{/);
  assert.ok(html.indexOf('"localStorage","sessionStorage"') < html.indexOf("<p>x</p>"), "installed before the project's own code");
});
