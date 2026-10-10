import { PUBLIC_PAGES, SITE_ORIGIN, BRAND_IMAGE, pageStructuredData } from "../src/public-pages.js";

export const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function metadataHtml(path) {
  const page = PUBLIC_PAGES[path];
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const url = `${SITE_ORIGIN}${path}`;
  return `<title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="index, follow, max-image-preview:large">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="VibhavGPT">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${url}">
    <meta property="og:image" content="${BRAND_IMAGE}">
    <meta property="og:image:alt" content="VibhavGPT brand icon">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <script id="vibhavgpt-structured-data" type="application/ld+json">${JSON.stringify(pageStructuredData(path)).replaceAll("<", "\\u003c")}</script>`;
}

export function updateMetadata(html, path) {
  // Change head tags only, including on the protected static homepage.
  const headEnd = html.indexOf("</head>");
  let head = html.slice(0, headEnd);
  head = head.replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*(?:name=["'](?:description|robots|twitter:[^"']*)["']|property=["']og:[^"']*["'])[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, "")
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  // Removing old tags must not leave whitespace-only lines. Keep every
  // style block byte-for-byte intact, especially the protected homepage.
  head = head.split(/(<style\b[^>]*>[\s\S]*?<\/style>)/gi)
    .map((part, index) => index % 2 ? part : part.replace(/^[\t ]+\r?$/gm, "").replace(/\n{3,}/g, "\n\n"))
    .join("");
  return `${head}${metadataHtml(path)}\n${html.slice(headEnd)}`;
}

export function detailsHtml(path) {
  const page = PUBLIC_PAGES[path];
  const faq = `<section class="public-faq" aria-labelledby="public-faq-title"><h2 id="public-faq-title">Questions and answers</h2>${page.faq.map(([q, a]) => `<div><h3>${escapeHtml(q)}</h3><p>${escapeHtml(a)}</p></div>`).join("")}<p class="public-operator">VibhavGPT is operated by Pansophy LLC. <a href="mailto:support@pansophy.com">Contact support</a>.</p></section>`;
  return { faq };
}
