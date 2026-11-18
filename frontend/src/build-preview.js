// Build's live preview (owner request, 2026-11-15): turns a saved project's files into one HTML document that runs in a sandboxed iframe.
//
// Isolation (what the preview can and cannot do):
// - The iframe is sandboxed with allow-scripts only, never allow-same-origin: the document has an opaque origin, so it cannot read this
//   page, its cookies or its storage, cannot navigate the app, open windows or submit forms.
// - The document carries its own Content-Security-Policy (PREVIEW_CSP): no network at all (connect, scripts, styles, images, fonts and
//   frames only from inside the document), no <base>, no form targets. It combines with the app's policy; the stricter rule wins.
// - Only the project's own files are bundled (real bundling, by esbuild on the API, which reads the files but never runs them). Imports resolve to the project's files;
//   React comes from the preview runtime built from this app's own packages (scripts/build-preview-runtime.mjs). Anything else is refused
//   with a plain message, never fetched.
// - It runs only when the person opens Preview, and stops when they close it. Only the browser's sandboxed iframe runs the code.

import { ModelError, isModelPath, modelPreviewParts } from "./model3d.js";

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// The packages the preview runtime provides (window.__vgModules). Kept in step with scripts/build-preview-runtime.mjs.
export const RUNTIME_PACKAGES = Object.freeze(["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);

export class PreviewError extends Error {}

// Where the React runtime goes in a document bundled on the server: the browser puts the runtime there (it is served by the app, not the
// API). A comment inside the script, so a document missing its runtime is still valid.
export const PREVIEW_RUNTIME_MARKER = "/*__vg_preview_runtime__*/";

/** Puts the preview runtime into a document bundled on the server, kept from closing its <script>. */
export function withPreviewRuntime(html, runtime) {
  return String(html).replace(PREVIEW_RUNTIME_MARKER, () => String(runtime).replace(/<\/script/gi, "<\\/script"));
}

const LOADERS = { js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", tsx: "tsx", css: "css", json: "json", svg: "dataurl", txt: "text", md: "text" };
const extension = (path) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

// "a/b/../c.js" -> "a/c.js"; paths never climb above the project.
export function normalizePath(path) {
  const out = [];
  for (const part of String(path).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) throw new PreviewError(`"${path}" points outside the project.`); out.pop(); } else out.push(part);
  }
  return out.join("/");
}
const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// An import or src in the project, resolved to one of its files: exact, then with a script extension, then as a folder's index.
export function resolveProjectPath(files, specifier, fromDir = "") {
  const base = specifier.startsWith("/") ? specifier.slice(1) : `${fromDir ? `${fromDir}/` : ""}${specifier}`;
  const wanted = normalizePath(base);
  if (files.has(wanted)) return wanted;
  for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "css", "json"]) if (files.has(`${wanted}.${ext}`)) return `${wanted}.${ext}`;
  for (const ext of ["js", "jsx", "ts", "tsx"]) if (files.has(`${wanted}/index.${ext}`)) return `${wanted}/index.${ext}`;
  return null;
}

const isLocal = (ref) => ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.trim());
// Inline code must not end the <script> or <style> it is placed in.
const safeInline = (code, tag) => String(code).replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** An esbuild plugin that reads only the project's files and the preview runtime. */
function projectPlugin(files, { jsxInJs = false } = {}) {
  // React projects often write JSX in .js files (Create React App does); there .js is read as JSX, a superset of it.
  const loaderFor = (path) => (jsxInJs && /^(?:js|mjs|cjs)$/.test(extension(path)) ? "jsx" : LOADERS[extension(path)] ?? "text");
  return {
    name: "vg-project",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: normalizePath(args.path), namespace: "project" };
        if (RUNTIME_PACKAGES.includes(args.path)) return { path: args.path, namespace: "runtime" };
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          // Relative to the importing file's place in the project (esbuild makes resolveDir absolute, so it is not used).
          const resolved = resolveProjectPath(files, args.path, args.namespace === "project" ? dirOf(args.importer) : "");
          if (!resolved) return { errors: [{ text: `"${args.path}" is not one of the project's files.` }] };
          return { path: resolved, namespace: "project" };
        }
        return { errors: [{ text: `The preview can't load the package "${args.path}": it runs only the project's own files and React. Download the ZIP to run it with its packages.` }] };
      });
      build.onLoad({ filter: /.*/, namespace: "runtime" }, (args) => ({
        contents: `module.exports = window.__vgModules[${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "project" }, (args) => {
        const contents = files.get(args.path);
        if (contents === undefined) return { errors: [{ text: `"${args.path}" is not one of the project's files.` }] };
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}

/** Bundles one entry file of the project: { js, css }. */
async function bundle(esbuild, files, entryPath, { usesReact }) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    outdir: "out",
    jsx: "automatic",
    jsxImportSource: "react",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    plugins: [projectPlugin(files, { jsxInJs: usesReact })],
  }).catch((error) => {
    const message = error?.errors?.[0]?.text ?? error?.message ?? "The project could not be bundled.";
    const where = error?.errors?.[0]?.location;
    throw new PreviewError(where ? `${where.file}:${where.line}: ${message}` : message);
  });
  const out = { js: "", css: "", usesReact };
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".css")) out.css += file.text;
    else out.js += file.text;
  }
  out.usesReact = usesReact || /window\.__vgModules/.test(out.js);
  return out;
}

// Reports errors and console errors from inside the preview to the card, by message (the card checks the message comes from its iframe).
const REPORTER = `(()=>{const send=(m)=>{try{parent.postMessage({vgPreview:"error",message:String(m).slice(0,500)},"*")}catch{}};addEventListener("error",(e)=>send(e.message||"Script error"));addEventListener("unhandledrejection",(e)=>send(e.reason&&e.reason.message||e.reason||"Unhandled promise rejection"));addEventListener("securitypolicyviolation",(e)=>send("Blocked by the preview sandbox: "+e.violatedDirective+(e.blockedURI?" ("+e.blockedURI+")":"")));const ce=console.error;console.error=(...a)=>{send(a.join(" "));ce.apply(console,a)};})();`;

// The sandbox has an opaque origin, so the browser refuses it localStorage and sessionStorage (reading them throws), and apps that save
// their state there would crash in the preview though their code is fine. Each gets an in-memory stand-in, only when the real one is
// refused: it lives while the preview is open, is gone on Reload, and cannot reach the app's own storage. Isolation is unchanged.
const STORAGE = `(()=>{const mk=()=>{const m=new Map();return Object.freeze({get length(){return m.size},key:(i)=>[...m.keys()][i]??null,getItem:(k)=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:(k)=>{m.delete(String(k))},clear:()=>{m.clear()}})};for(const name of ["localStorage","sessionStorage"]){try{window[name].getItem("x")}catch{try{Object.defineProperty(window,name,{value:mk(),configurable:true})}catch{}}}})();`;

function shell({ head = "", body = "", runtime = "", scripts = [], styles = [] }) {
  return [
    "<!doctype html>",
    "<html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<script>${REPORTER}</script>`,
    `<script>${STORAGE}</script>`,
    ...styles.map((css) => `<style>${safeInline(css, "style")}</style>`),
    head,
    "</head><body>",
    body,
    runtime ? `<script>${safeInline(runtime, "script")}</script>` : "",
    ...scripts.map((js) => `<script>${safeInline(js, "script")}</script>`),
    "</body></html>",
  ].join("\n");
}

/**
 * The preview document for a project: { kind, entry, files: [{ path, content }] }.
 * `esbuild` is esbuild's API (esbuild-wasm in the browser); `loadRuntime()` returns the preview runtime's source when React is needed.
 */
// Where a project's script entry usually is, when its own entry is not a file of it (Vite, Create React App and plain layouts).
const ENTRY_CANDIDATES = ["src/main.jsx", "src/main.tsx", "src/main.js", "src/main.ts", "src/index.jsx", "src/index.tsx", "src/index.js", "src/index.ts", "main.jsx", "index.jsx", "main.js", "index.js"];
const scriptEntry = (files, entry) => {
  const own = entry && !/\.html?$/i.test(entry) ? resolveProjectPath(files, entry) : null;
  return own && /\.(?:m?jsx?|tsx?)$/i.test(own) ? own : ENTRY_CANDIDATES.find((path) => files.has(path)) ?? null;
};

export async function buildPreviewDocument(project, { esbuild, loadRuntime }) {
  const files = new Map(project.files.map((file) => [normalizePath(file.path), String(file.content ?? "")]));

  // A 3D model: drawn by a small WebGL viewer in the same sandbox, from its own file (no bundling, no React, no network).
  if (project.kind === "model") {
    const modelPath = isModelPath(project.entry) && files.has(normalizePath(project.entry)) ? normalizePath(project.entry) : [...files.keys()].find(isModelPath);
    if (!modelPath) throw new PreviewError("The project has no .stl or .obj model to show.");
    try {
      const parts = modelPreviewParts(files.get(modelPath), modelPath);
      return shell({ body: parts.body, scripts: [parts.script], styles: [parts.styles] });
    } catch (error) {
      if (error instanceof ModelError) throw new PreviewError(error.message);
      throw error;
    }
  }
  const htmlPath = files.has(normalizePath(project.entry)) && /\.html?$/i.test(project.entry) ? normalizePath(project.entry)
    : files.has("index.html") ? "index.html"
    : [...files.keys()].find((path) => /\.html?$/i.test(path)) ?? null;

  if (!htmlPath) {
    // A React (or script-only) project with no page: mount its entry script into a root element.
    const entryPath = scriptEntry(files, project.entry);
    if (!entryPath) throw new PreviewError("The project has no page (index.html) or entry script to preview.");
    const out = await bundle(esbuild, files, entryPath, { usesReact: project.kind === "react" });
    return shell({ body: '<div id="root"></div>', runtime: out.usesReact ? await loadRuntime() : "", scripts: [out.js], styles: out.css ? [out.css] : [] });
  }

  let html = files.get(htmlPath);
  const htmlDir = dirOf(htmlPath);
  const styles = [];
  const scripts = [];
  let usesReact = project.kind === "react";

  // Local stylesheets become inline styles (their own @imports bundled).
  for (const match of [...html.matchAll(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi)]) {
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!isLocal(href)) continue;
    const path = resolveProjectPath(files, href, htmlDir);
    if (!path) throw new PreviewError(`The page links "${href}", which is not one of the project's files.`);
    const out = await bundle(esbuild, files, path, { usesReact: false });
    styles.push(out.css);
    html = html.replace(match[0], "");
  }
  // Local scripts are bundled (their imports resolved inside the project) and run in page order at the end of the body.
  for (const match of [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)]) {
    const src = match[1];
    if (!isLocal(src)) continue;
    const path = resolveProjectPath(files, src, htmlDir);
    if (!path) throw new PreviewError(`The page loads "${src}", which is not one of the project's files.`);
    const out = await bundle(esbuild, files, path, { usesReact });
    usesReact = usesReact || out.usesReact;
    if (out.css) styles.push(out.css);
    scripts.push(out.js);
    html = html.replace(match[0], "");
  }
  // Inline module scripts with imports are bundled too; plain inline scripts stay where they are.
  for (const match of [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)]) {
    if (!/\bimport\b/.test(match[1])) continue;
    const entry = `__inline_${scripts.length}.jsx`;
    const withInline = new Map(files).set(entry, match[1]);
    const out = await bundle(esbuild, withInline, entry, { usesReact });
    usesReact = usesReact || out.usesReact;
    scripts.push(out.js);
    html = html.replace(match[0], "");
  }

  // A page that loads none of the project's scripts, in a project that has a script entry: the page is a template its tooling fills in
  // (Create React App's public/index.html has no script tag). The entry is bundled and run after the page, as that tooling does.
  if (!scripts.length && !/<script\b[^>]*>\s*\S/i.test(html)) {
    const entryPath = scriptEntry(files, project.entry);
    if (entryPath) {
      const out = await bundle(esbuild, files, entryPath, { usesReact });
      usesReact = usesReact || out.usesReact;
      if (out.css) styles.push(out.css);
      scripts.push(out.js);
    }
  }

  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>|<head\b[\s\S]*?<\/head>/gi, "");
  // A page's own <base> or CSP meta is dropped: the preview's policy is the one that applies.
  const cleanHead = head.replace(/<base\b[^>]*>/gi, "").replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
  return shell({ head: cleanHead, body, runtime: usesReact ? await loadRuntime() : "", scripts, styles });
}
