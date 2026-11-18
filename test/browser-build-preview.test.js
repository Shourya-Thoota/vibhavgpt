// Build's live Preview and message order (owner report, 2026-11-15), in a real browser against the built app. A small server in front of the
// shared fixture serves one Build conversation (the person's prompt, Tecton's reply) and its saved project. Checks: the prompt sits above
// the project card; Preview bundles the files in the browser and runs them in a sandboxed iframe (allow-scripts only, never
// allow-same-origin); a plain page and a React project both really run; code inside cannot read the app or reach the network, and both
// attempts are reported under the preview. Needs `npm run build` in frontend/ first.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import { serve, systemBrowser } from "../scripts/design-capture.mjs";
import * as esbuild from "esbuild";
import { PREVIEW_RUNTIME_MARKER, PreviewError, buildPreviewDocument } from "../frontend/src/build-preview.js";
import { extractBuildArtifact } from "../src/build/artifacts.js";

// Production's own Content-Security-Policy, from the Caddyfile, sent with every page here: the preview must work under it (a first
// version bundled in the page with WebAssembly, which this policy blocks; tests without the header did not catch that).
const PRODUCTION_CSP = fs.readFileSync(new URL("../frontend/Caddyfile", import.meta.url), "utf8").match(/Content-Security-Policy "([^"]+)"/)[1];

const executablePath = systemBrowser();
const built = fs.existsSync(new URL("../frontend/dist/index.html", import.meta.url)) && fs.existsSync(new URL("../frontend/dist/preview/runtime.js", import.meta.url));
const previewRequests = [];
const skip = !executablePath ? "no system browser" : !built ? "frontend not built" : false;
const CONVERSATION = "8e4f5a61-7283-4d94-8ea5-cfb0a1b2c3d5";
const PROJECT = "proj-preview-test";

const PROJECTS = {
  web: { kind: "web", entry: "index.html", files: {
    "index.html": '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="title">Timer</h1><p id="count">0</p><script type="module" src="app.js"></script></body></html>',
    "style.css": "h1 { color: rgb(200, 30, 30); }",
    "app.js": 'import { start } from "./lib/count.js"; start(document.getElementById("count")); try { parent.document.title = "pwned"; } catch (e) { console.error("parent blocked: " + e.name); } fetch("https://example.com/steal").catch(() => console.error("network blocked"));',
    "lib/count.js": "export function start(el) { el.textContent = 'Ready: ' + (2 + 3); }",
  } },
  react: { kind: "react", entry: "src/main.jsx", files: {
    "package.json": '{"name":"counter","dependencies":{"react":"^19","react-dom":"^19"}}',
    "src/main.jsx": 'import { createRoot } from "react-dom/client"; import App from "./App"; createRoot(document.getElementById("root")).render(<App />);',
    "src/App.jsx": 'import { useState } from "react"; export default function App() { const [n, setN] = useState(0); return <button id="b" onClick={() => setN(n + 1)}>Clicked {n}</button>; }',
  } },
  // Create React App's layout (live test, 2026-11-15, previewed blank): a page template with no script tag, JSX in .js files, and the
  // legacy ReactDOM.render, which React 19 no longer has.
  cra: { kind: "react", entry: "src/index.js", files: {
    "package.json": '{"name":"momentum","dependencies":{"react":"^18.2.0","react-dom":"^18.2.0","react-scripts":"5.0.1"}}',
    "public/index.html": '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Momentum</title></head><body><div id="root"></div></body></html>',
    "src/index.js": "import React from 'react';\nimport ReactDOM from 'react-dom';\nimport App from './App';\nimport './styles.css';\nReactDOM.render(<React.StrictMode><App /></React.StrictMode>, document.getElementById('root'));",
    // It keeps its count in localStorage, as generated apps often do: the sandbox refuses real storage, so the preview's stand-in is used.
    "src/App.js": "import React, { useState } from 'react';\nexport default function App() { const [done, setDone] = useState(Number(localStorage.getItem('done')) || 0); const add = () => { localStorage.setItem('done', String(done + 1)); setDone(done + 1); }; return <main><h1>Momentum</h1><button id=\"habit\" onClick={add}>Done {done}</button><p id=\"saved\">{localStorage.getItem('done') ?? 'none'}</p></main>; }",
    "src/styles.css": "h1 { color: rgb(20, 120, 60); }",
  } },
  // A 3D model: a 10 x 10 x 2 box as an ASCII STL, drawn by the sandboxed WebGL viewer.
  model: { kind: "model", entry: "plate.stl", files: {
    "plate.stl": (() => {
      const c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 2], [10, 0, 2], [10, 10, 2], [0, 10, 2]];
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
      return ["solid plate", ...f.flatMap((t) => ["facet normal 0 0 0", "outer loop", ...t.map((i) => `vertex ${c[i].join(" ")}`), "endloop", "endfacet"]), "endsolid plate"].join("\n");
    })(),
    "README.md": "A 10 x 10 x 2 mm plate.",
  } },
  // The 3D helper: Tecton describes a plate in model.json and the server generates the STL (the real extraction, as on the API).
  spec: (() => {
    const plate = { format: "vibhavgpt-model/1", name: "Dinner plate", units: "mm", parts: [{ type: "revolve", profile: [[0, 0], [50, 0], [60, 10], [60, 12], [57, 12], [48, 3], [0, 3]] }] };
    const out = extractBuildArtifact(["A plate.", '<<<PROJECT kind="model" entry="model.json">>>', '<<<FILE path="model.json">>>', JSON.stringify(plate), "<<<END FILE>>>"].join("\n"));
    return { kind: out.kind, entry: out.entry, files: Object.fromEntries(out.files.map((f) => [f.path, f.content])) };
  })(),
};
let current = "web";

let browser;
let server;
let base;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true, executablePath });
  const fixture = serve({ signedIn: true });
  const delegate = fixture.listeners("request")[0];
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const project = PROJECTS[current];
    if (url.pathname === `/api/chat/conversations/${CONVERSATION}`) {
      return json(res, 200, { conversation: { id: CONVERSATION, title: "Timer build", model: "tecton", mode: "build" }, history: [
        { id: "u1", role: "user", content: "Build me a small timer page", createdAt: "2026-11-15T10:00:00.000Z" },
        { id: "a1", role: "assistant", content: "I made a small timer page.", model: "tecton", createdAt: "2026-11-15T10:00:09.000Z" },
      ], hasMore: false, nextCursor: null });
    }
    if (url.pathname === `/api/build/conversations/${CONVERSATION}/project`) {
      const files = Object.entries(project.files).map(([p, content]) => ({ path: p, bytes: Buffer.byteLength(content), type: "text/plain" }));
      return json(res, 200, { project: { id: PROJECT, title: "Timer build", kind: project.kind, current: { revision: 1, kind: project.kind, entry: project.entry, files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) }, revisions: [{ revision: 1, files: files.length }] } });
    }
    if (url.pathname === `/api/build/projects/${PROJECT}/revisions/1/file`) {
      const content = project.files[url.searchParams.get("path")];
      if (content === undefined) return json(res, 404, { error: "Not found." });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(content);
    }
    if (url.pathname === "/api/chat/replies") return json(res, 200, { replies: [] });
    // The API's preview route: the same bundling the server does (esbuild, the project's files only), the runtime left for the browser.
    if (url.pathname === `/api/build/projects/${PROJECT}/revisions/1/preview`) {
      previewRequests.push(url.pathname);
      const files = Object.entries(project.files).map(([path, content]) => ({ path, content }));
      return buildPreviewDocument({ kind: project.kind, entry: project.entry, files }, { esbuild, loadRuntime: async () => PREVIEW_RUNTIME_MARKER })
        .then((html) => json(res, 200, { revision: 1, html, runtime: html.includes(PREVIEW_RUNTIME_MARKER) }))
        .catch((error) => json(res, error instanceof PreviewError ? 422 : 500, { error: error.message }));
    }
    // Every page carries production's policy.
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => {
      const headers = rest.find((value) => value && typeof value === "object") ?? {};
      const type = String(res.getHeader("content-type") ?? headers["Content-Type"] ?? headers["content-type"] ?? "");
      if (/text\/html/.test(type)) res.setHeader("Content-Security-Policy", PRODUCTION_CSP);
      return writeHead(status, ...rest);
    };
    return delegate(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

async function openBuild(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route("**/api/billing/subscription", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ subscription: { tier: "pro", status: "active", billingSource: "stripe", currentPeriodEndsAt: "2026-12-15T00:00:00.000Z", cancelAtPeriodEnd: false }, maxAvailable: true }) }));
  await page.route("**/api/usage", async (route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...(await response.json()), tier: "pro" } }); });
  await page.goto(`${base}/app/build?conversation=${CONVERSATION}`, { waitUntil: "networkidle" });
  await page.locator(".build-project").waitFor({ timeout: 20000 });
  return { context, page };
}

test("the person's prompt is above the project card, and the card follows the reply", { skip }, async () => {
  current = "web";
  const { context, page } = await openBuild(1280);
  const top = (selector) => page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().top);
  const prompt = await page.getByText("Build me a small timer page").evaluate((el) => el.getBoundingClientRect().top);
  const reply = await page.getByText("I made a small timer page.").evaluate((el) => el.getBoundingClientRect().top);
  const card = await top(".build-project");
  assert.ok(prompt < reply && reply < card, `prompt (${prompt}) above reply (${reply}) above card (${card})`);
  assert.equal(await page.getByText(/Live preview isn.t available yet/).count(), 0, "the placeholder is gone");
  await context.close();
});

for (const width of [1280, 375]) {
  test(`${width}px: Preview runs a web project in a sandbox that cannot reach the app or the network`, { skip }, async () => {
    current = "web";
    const { context, page } = await openBuild(width);
    const policy = await page.evaluate(async () => { try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return "allowed"; } catch (error) { return error.name; } });
    assert.equal(policy, "CompileError", "the page runs under production's policy, which blocks WebAssembly");
    await page.getByRole("tab", { name: "Preview" }).click();
    const frame = page.locator("iframe.build-preview__frame");
    await frame.waitFor({ timeout: 60000 });
    assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "scripts only: never allow-same-origin");
    const inside = page.frameLocator("iframe.build-preview__frame");
    await inside.getByText("Ready: 5").waitFor({ timeout: 15000 });
    assert.equal(await inside.locator("h1").evaluate((el) => getComputedStyle(el).color), "rgb(200, 30, 30)", "the linked stylesheet applies");
    const log = page.getByRole("log", { name: "Errors from the preview" });
    await log.getByText(/parent blocked: SecurityError/).waitFor({ timeout: 15000 });
    await log.getByText(/network blocked|Blocked by the preview sandbox: connect-src/).first().waitFor({ timeout: 15000 });
    assert.notEqual(await page.title(), "pwned", "the app page was not touched");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    fs.mkdirSync(path.resolve("test-results"), { recursive: true });
    await page.screenshot({ path: path.resolve(`test-results/build-preview-web-${width}.png`) });
    await context.close();
  });
}

test("Preview runs a React project with its JSX bundled, and it responds to clicks", { skip }, async () => {
  current = "react";
  const { context, page } = await openBuild(1280);
  await page.getByRole("tab", { name: "Preview" }).click();
  const inside = page.frameLocator("iframe.build-preview__frame");
  const button = inside.locator("#b");
  await button.waitFor({ timeout: 60000 });
  await button.click();
  await button.click();
  assert.equal(await button.innerText(), "Clicked 2");
  await page.screenshot({ path: path.resolve("test-results/build-preview-react-1280.png") });
  await context.close();
});

test("Preview runs a Create React App project: template page, JSX in .js, and ReactDOM.render on React 19", { skip }, async () => {
  current = "cra";
  const { context, page } = await openBuild(1280);
  await page.getByRole("tab", { name: "Preview" }).click();
  const inside = page.frameLocator("iframe.build-preview__frame");
  const button = inside.locator("#habit");
  await button.waitFor({ timeout: 60000 });
  assert.equal(await inside.locator("h1").evaluate((el) => getComputedStyle(el).color), "rgb(20, 120, 60)", "its imported stylesheet applies");
  await button.click();
  assert.equal(await button.innerText(), "Done 1");
  assert.equal(await inside.locator("#saved").innerText(), "1", "localStorage works inside the preview (in memory)");
  assert.equal(await page.evaluate(() => localStorage.getItem("done")), null, "and never touches the app's own storage");
  assert.equal(await page.getByRole("log", { name: "Errors from the preview" }).count(), 0, "no errors reported");
  await page.screenshot({ path: path.resolve("test-results/build-preview-cra-1280.png") });
  await context.close();
});

test("Preview shows a 3D model in the sandbox: drawn with WebGL, turned by dragging, with its size", { skip }, async () => {
  current = "model";
  const { context, page } = await openBuild(1280);
  await page.getByText(/Model saved\. Open Preview to turn it in 3D here/).waitFor();
  await page.getByRole("tab", { name: "Preview" }).click();
  const frame = page.locator("iframe.build-preview__frame");
  await frame.waitFor({ timeout: 30000 });
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
  const inside = page.frameLocator("iframe.build-preview__frame");
  await inside.getByText(/plate\.stl: 12 triangles · 10 × 10 × 2/).waitFor({ timeout: 15000 });
  assert.equal(await inside.locator("body").getAttribute("data-drawn"), "12", "WebGL drew all 12 triangles");
  const canvas = inside.locator("#view");
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  // The drag reaches the sandboxed frame's canvas; the frame may need a moment to settle first, so the drag is tried for up to 3 seconds.
  let turned = false;
  for (let attempt = 0; attempt < 6 && !turned; attempt += 1) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    turned = !before.equals(await canvas.screenshot());
    if (!turned) await page.waitForTimeout(500);
  }
  assert.ok(turned, "dragging turns the model");
  assert.equal(await page.getByRole("log", { name: "Errors from the preview" }).count(), 0, "no errors reported");
  await page.getByText(/Showing version 1 in 3D, in a sandbox/).waitFor();
  await page.screenshot({ path: path.resolve("test-results/build-preview-model-1280.png") });
  await context.close();
});

test("Preview draws a model the server generated from Tecton's JSON description", { skip }, async () => {
  current = "spec";
  assert.equal(PROJECTS.spec.entry, "model.stl");
  const { context, page } = await openBuild(1280);
  await page.getByRole("tab", { name: "Preview" }).click();
  const inside = page.frameLocator("iframe.build-preview__frame");
  await inside.getByText(/model\.stl: \d+ triangles · 120 × 120 × 12/).waitFor({ timeout: 30000 });
  const drawn = Number(await inside.locator("body").getAttribute("data-drawn"));
  assert.ok(drawn > 100, `WebGL drew the generated plate (${drawn} triangles)`);
  assert.equal(await page.getByRole("log", { name: "Errors from the preview" }).count(), 0);
  await page.screenshot({ path: path.resolve("test-results/build-preview-spec-1280.png") });
  await context.close();
});
