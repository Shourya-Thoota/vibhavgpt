// Build's live preview (owner request, 2026-11-15) runs a project's code in a sandboxed iframe with no network access, so a React project
// cannot fetch React from anywhere. This builds the packages the preview provides, from this app's own node_modules, into one script the
// preview inlines: public/preview/runtime.js. A project that imports one of these gets it; any other package is reported as unavailable.
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

export const PREVIEW_PACKAGES = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];

const entry = [
  `import * as React from "react";`,
  `import * as ReactDOM from "react-dom";`,
  `import * as ReactDOMClient from "react-dom/client";`,
  `import * as JSXRuntime from "react/jsx-runtime";`,
  // React 19 removed ReactDOM.render, which much generated code (Create React App style) still calls: here it mounts with createRoot.
  `const roots = new WeakMap();`,
  `const legacyDOM = Object.freeze({ ...ReactDOM,`,
  `  render(element, container, callback) { let root = roots.get(container); if (!root) { root = ReactDOMClient.createRoot(container); roots.set(container, root); } root.render(element); if (typeof callback === "function") queueMicrotask(callback); },`,
  `  hydrate(element, container, callback) { return legacyDOM.render(element, container, callback); },`,
  `  unmountComponentAtNode(container) { const root = roots.get(container); if (!root) return false; root.unmount(); roots.delete(container); return true; } });`,
  `window.__vgModules = Object.freeze({ "react": React, "react-dom": legacyDOM, "react-dom/client": ReactDOMClient, "react/jsx-runtime": JSXRuntime });`,
].join("\n");

const outdir = new URL("../public/preview/", import.meta.url);
await mkdir(outdir, { recursive: true });
await build({
  stdin: { contents: entry, resolveDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "js" },
  bundle: true,
  format: "iife",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: new URL("runtime.js", outdir).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  logLevel: "warning",
});
console.log("Preview runtime built: public/preview/runtime.js");
