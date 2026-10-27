import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_PAGES, SITE_ORIGIN } from "../src/public-pages.js";
import { updateMetadata, detailsHtml, escapeHtml } from "./public-html.js";
import { verifyPublicBuild } from "./verify-public.js";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
// Reuse the actual public React views: content/prices cannot drift between
// crawler HTML and the interactive page. No network or account data is read.
const server = await createServer({ root, configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true } });
try {
  const { default: Legal } = await server.ssrLoadModule("/src/Legal.jsx");
  const { PublicPricing } = await server.ssrLoadModule("/src/App.jsx");
  for (const page of ["pricing", "terms", "privacy", "guarantee"]) {
    const file = resolve(dist, `${page}.html`);
    const component = page === "pricing" ? createElement(PublicPricing) : createElement(Legal, { page });
    const markup = renderToStaticMarkup(component);
    let html = await readFile(file, "utf8");
    html = html.replace('<div id="root"></div>', `<div id="root" data-prerendered>${markup}</div>`);
    if (!html.includes('data-prerendered')) throw new Error(`Missing prerender target: ${page}`);
    await writeFile(file, updateMetadata(html, `/${page}`));
  }
} finally { await server.close(); }

await mkdir(resolve(dist, "theme"), { recursive: true });
for (const [source, output] of [["src/theme/appearance-boot.js", "theme/appearance-boot.js"], ["src/theme/vibhav.css", "theme/vibhav.css"], ["src/page-scroll-boot.js", "theme/page-scroll-boot.js"], ["src/public-pages.css", "theme/public-pages.css"], ["src/apps-pages.css", "theme/apps-pages.css"]]) {
  await writeFile(resolve(dist, output), await readFile(resolve(root, source)));
}
for (const [path, filename] of [["/home", "home/index.html"], ["/account-deletion", "account-deletion.html"], ["/apps", "apps/index.html"], ["/sources", "sources/index.html"], ["/android", "android/index.html"], ["/vibhavgpt-windows", "vibhavgpt-windows/index.html"]]) {
  const file = resolve(dist, filename);
  let html = updateMetadata(await readFile(file, "utf8"), path);
  // Inject shared visible FAQs only into the standalone utility pages.
  if (path !== "/home") {
    const details = detailsHtml(path);
    html = html.replace("<!-- public-faq -->", details.faq);
  }
  if (path === "/android") {
    const release = JSON.parse(await readFile(resolve(root, "public/android/version.json"), "utf8"));
    const values = { version: `${release.versionName} (${release.versionCode})`, date: release.releaseDate, size: release.fileSize, requirements: release.androidRequirements, notes: release.releaseNotes, checksum: release.sha256 };
    for (const [id, value] of Object.entries(values)) html = html.replace(new RegExp(`(id="${id}">)[^<]*`), `$1${escapeHtml(value)}`);
  }
  if (path === "/apps") {
    // The one platform fact that can change: the Android requirement, from the
    // same release file the Android page reads. No version, size or checksum
    // appears on this page, so none can go stale.
    const release = JSON.parse(await readFile(resolve(root, "public/android/version.json"), "utf8"));
    html = html.replace(/(id="android-requirements">)[^<]*/, `$1${escapeHtml(release.androidRequirements)}`);
  }
  await writeFile(file, html);
}
await writeFile(resolve(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(PUBLIC_PAGES).map(path => `  <url><loc>${SITE_ORIGIN}${path}</loc></url>`).join("\n")}\n</urlset>\n`);
console.log(`Prerendered ${Object.keys(PUBLIC_PAGES).length} public pages with shared metadata.`);
await verifyPublicBuild(dist);
