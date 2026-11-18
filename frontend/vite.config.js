import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { updateMetadata, detailsHtml } from "./scripts/public-html.js";

// One source for what every HTML entry needs in its <head> before first
// paint, so the four entries cannot drift apart:
// - the appearance boot script (sky and universe, set before paint);
// - the self-hosted @font-face rules, inlined so text never waits on an
//   extra stylesheet request (the same file serves the static pages);
// - no font preloads: text is set in the platform's system face.
// Files are read per transform, so editing them hot-reloads in dev.
function appearanceHead() {
  const read = (path) => readFileSync(resolve(import.meta.dirname, path), "utf8");
  return {
    name: "vibhav-appearance-head",
    transformIndexHtml(html, context) {
      const name = context.filename?.replaceAll("\\", "/").split("/").pop().replace(/\.html$/, "");
      return { html: ["pricing", "terms", "privacy", "guarantee"].includes(name) ? updateMetadata(html, `/${name}`) : html, tags: [
        { tag: "script", children: read("src/theme/appearance-boot.js"), injectTo: "head" },
        { tag: "script", children: read("src/page-scroll-boot.js"), injectTo: "head" },
        { tag: "style", children: read("public/fonts/v1/fonts.css"), injectTo: "head" },
      ] };
    },
    configureServer(server) {
      // Standalone pages and their theme sources work in dev as in dist.
      const assets = { "/theme/appearance-boot.js": "src/theme/appearance-boot.js", "/theme/vibhav.css": "src/theme/vibhav.css", "/theme/page-scroll-boot.js": "src/page-scroll-boot.js", "/theme/public-pages.css": "src/public-pages.css", "/theme/apps-pages.css": "src/apps-pages.css" };
      const pages = { "/account-deletion": "account-deletion.html", "/account-deletion.html": "account-deletion.html", "/apps": "apps/index.html", "/apps/": "apps/index.html", "/apps/index.html": "apps/index.html", "/sources": "sources/index.html", "/sources/": "sources/index.html", "/sources/index.html": "sources/index.html", "/android": "android/index.html", "/android/": "android/index.html", "/android/index.html": "android/index.html", "/vibhavgpt-windows": "vibhavgpt-windows/index.html", "/vibhavgpt-windows/": "vibhavgpt-windows/index.html", "/vibhavgpt-windows/index.html": "vibhavgpt-windows/index.html" };
      server.middlewares.use((req, res, next) => {
        const path = req.url.split("?")[0];
        if (assets[path]) {
          res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
          res.end(read(assets[path]));
        } else if (pages[path]) {
          const canonical = path.startsWith("/sources") ? "/sources" : path.startsWith("/apps") ? "/apps" : path.startsWith("/android") ? "/android" : path.startsWith("/vibhavgpt-windows") ? "/vibhavgpt-windows" : "/account-deletion";
          const details = detailsHtml(canonical);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(updateMetadata(read(`public/${pages[path]}`), canonical).replace("<!-- public-faq -->", details.faq));
        } else next();
      });
    },
    configurePreviewServer(server) {
      // Match Caddy's directory-index routes during built-site verification.
      server.middlewares.use((req, res, next) => {
        const [path, query] = req.url.split("?");
        if (["/home", "/home/", "/apps", "/apps/", "/sources", "/sources/", "/android", "/android/", "/vibhavgpt-windows", "/vibhavgpt-windows/"].includes(path) || (path === "/" && !query)) {
          const directory = path === "/" ? "home" : path.replaceAll("/", "");
          req.url = `/${directory}/index.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // Tailwind handles only CSS that opts in with its directives (home-effects.css,
  // for the two homepage components); every other stylesheet passes through as is.
  plugins: [react(), tailwindcss(), appearanceHead()],
  // "@/" is shadcn's alias for src/. The pattern needs the slash so it cannot
  // match scoped packages such as "@capacitor/app" or "@sentry/react".
  resolve: { alias: [{ find: /^@\//, replacement: `${resolve(import.meta.dirname, "src")}/` }] },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
  build: {
    // The static homepage cannot import the animations' script by name: its
    // file name carries a content hash. The manifest lets the post-build step
    // (scripts/prerender-public.js) find it, and removes the manifest after.
    manifest: true,
    rollupOptions: {
      input: {
        homeEffects: resolve(import.meta.dirname, "src/home-effects-boot.ts"),
        app: resolve(import.meta.dirname, "index.html"),
        pricing: resolve(import.meta.dirname, "pricing.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        guarantee: resolve(import.meta.dirname, "guarantee.html"),
      },
    },
  },
});
