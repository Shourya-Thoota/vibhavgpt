import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiPath, apiRequest, fetchPrivateFile, isPrivateFileUrl } from "../frontend/src/api.js";

test("private resource resolution rejects outside origins and non-API paths", () => {
  assert.equal(apiPath("/api/uploads/a/preview", "https://api.vibhavgpt.com"), "/api/uploads/a/preview");
  assert.equal(apiPath("https://api.vibhavgpt.com/api/uploads/a/download", "https://api.vibhavgpt.com"), "/api/uploads/a/download");
  for (const url of ["https://evil.example/api/uploads/a/download", "//evil.example/api/uploads/a/download", "/account", "/api/../account"]) {
    assert.throws(() => apiPath(url, "https://api.vibhavgpt.com"));
  }
});

test("JSON, multipart and protected bytes keep credentials, errors never become image blobs", async (t) => {
  const previousLocation = globalThis.location;
  globalThis.location = { origin: "https://vibhavgpt.com" };
  t.after(() => { if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response("pixels", { headers: { "Content-Type": "image/png" } });
  });
  const form = new FormData(); form.append("files", new Blob(["notes"]), "notes.txt");
  await apiRequest("/api/uploads", { method: "POST", body: form });
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers.has("Content-Type"), false);
  assert.equal(calls[0].options.body, form);
  await apiRequest("/api/chat/stream", { method: "POST", body: JSON.stringify({ message: "hello" }) });
  assert.equal(calls[1].options.headers.get("Content-Type"), "application/json");
  assert.equal((await fetchPrivateFile("/api/uploads/a/preview")).type, "image/png");
  assert.equal(calls[2].options.credentials, "include");
  assert.equal(isPrivateFileUrl("/api/uploads/a/preview"), true);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Sign in is required." }), { status: 401 });
  await assert.rejects(fetchPrivateFile("/api/uploads/a/preview"), { message: "Sign in is required.", status: 401 });
});

// --- Lazy chat images ---------------------------------------------------------

async function loadPrivateMedia() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: { contents: `export { startPrivateFile, NEAR_VIEW_MARGIN } from "./components/PrivateMedia.jsx";`, resolveDir: fileURLToPath(new URL("../frontend/src/", import.meta.url)), loader: "jsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", logLevel: "silent",
    loader: { ".css": "empty" }, external: ["mermaid"],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  const dir = mkdtempSync(join(tmpdir(), "private-media-"));
  try {
    const file = join(dir, "private-media.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { startPrivateFile, NEAR_VIEW_MARGIN } = await loadPrivateMedia();

function fakeObserver() {
  const made = [];
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.observed = []; this.disconnected = false; made.push(this); }
    observe(node) { this.observed.push(node); }
    disconnect() { this.disconnected = true; }
    fire(isIntersecting) { this.callback([{ isIntersecting }]); }
  }
  return { Observer, made };
}

const deps = (loads) => ({
  load: async (path) => { loads.push(path); return new Blob(["pixels"], { type: "image/png" }); },
  createUrl: () => "blob:fixture",
  revokeUrl: () => {},
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a lazy image downloads only once the observer reports it near view", async () => {
  const { Observer, made } = fakeObserver();
  const loads = [];
  const results = [];
  const node = {};
  const root = {};
  const stop = startPrivateFile("/api/uploads/a/preview", (result) => results.push(result), { lazy: true, node, root, Observer, ...deps(loads) });
  await settle();
  assert.equal(loads.length, 0, "nothing fetched on mount");
  assert.deepEqual(made[0].observed, [node]);
  assert.deepEqual(made[0].options, { root, rootMargin: NEAR_VIEW_MARGIN }, "watched against its own scroller, with a margin");
  made[0].fire(false);
  await settle();
  assert.equal(loads.length, 0, "still far away");
  made[0].fire(true);
  await settle();
  assert.deepEqual(loads, ["/api/uploads/a/preview"], "fetched once it comes near");
  assert.equal(made[0].disconnected, true, "the watch ends once it has fired");
  assert.equal(results.at(-1).url, "blob:fixture");
  stop();
});

test("without IntersectionObserver, or when not lazy, the file downloads at once", async () => {
  const loads = [];
  startPrivateFile("/api/uploads/b/preview", () => {}, { lazy: true, node: {}, Observer: undefined, ...deps(loads) });
  const { Observer, made } = fakeObserver();
  startPrivateFile("/api/uploads/c/preview", () => {}, { Observer, ...deps(loads) });
  await settle();
  assert.deepEqual(loads, ["/api/uploads/b/preview", "/api/uploads/c/preview"]);
  assert.equal(made.length, 0, "a non-lazy image is never watched");
});

test("unmounting before it comes near stops the watch and fetches nothing", async () => {
  const { Observer, made } = fakeObserver();
  const loads = [];
  const stop = startPrivateFile("/api/uploads/d/preview", () => {}, { lazy: true, node: {}, Observer, ...deps(loads) });
  stop();
  assert.equal(made[0].disconnected, true);
  await settle();
  assert.equal(loads.length, 0);
});

test("chat images are lazy; the hook and the Image page keep their behaviour", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const media = readFileSync(new URL("../frontend/src/components/PrivateMedia.jsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  assert.match(app, /<PrivateImage lazy loading="lazy" src=\{message\.attachment\.previewUrl \?\? message\.attachment\.downloadUrl\}/);
  assert.match(media, /export function PrivateImage\(\{ src, alt, lazy = false, \.\.\.props \}\)/, "lazy is opt-in");
  assert.match(media, /usePrivateFile\(privatePath, \{ lazy, nodeRef: holderRef \}\)/);
  assert.match(media, /<span ref=\{holderRef\} className="private-media-status"/, "the placeholder is what is watched");
  assert.doesNotMatch(workspace, /<PrivateImage lazy/, "the Image page is unchanged");
});
