import { SITE_ORIGIN, BRAND_IMAGE, PUBLIC_PAGES, publicPagePath, pageStructuredData } from "./public-pages.js";
const DEFAULT_DESCRIPTION = "VibhavGPT brings AI chat, image creation, and study tools together in one workspace.";

function setMeta(attribute, key, value) {
  let element = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!value) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.content = value;
}

export function applyPageMetadata(pathname) {
  const path = publicPagePath(pathname);
  const page = PUBLIC_PAGES[path] ?? {};
  const title = page.title ?? "VibhavGPT Workspace: AI Chat, Image Creation and Study";
  const description = page.description ?? DEFAULT_DESCRIPTION;
  const canonical = PUBLIC_PAGES[path] ? `${SITE_ORIGIN}${path}` : null;

  document.title = title;
  setMeta("name", "description", description);
  setMeta("property", "og:type", "website");
  setMeta("property", "og:site_name", "VibhavGPT");
  setMeta("property", "og:title", title);
  setMeta("property", "og:description", description);
  setMeta("property", "og:url", canonical);
  setMeta("property", "og:image", BRAND_IMAGE);
  setMeta("property", "og:image:alt", "VibhavGPT brand icon");
  setMeta("name", "twitter:card", "summary");
  setMeta("name", "twitter:title", title);
  setMeta("name", "twitter:description", description);

  let canonicalLink = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) canonicalLink?.remove();
  else {
    if (!canonicalLink) {
      canonicalLink = document.createElement("link");
      canonicalLink.rel = "canonical";
      document.head.append(canonicalLink);
    }
    canonicalLink.href = canonical;
  }

  let structuredData = document.head.querySelector("script#vibhavgpt-structured-data, script[type=\"application/ld+json\"]");
  if (!structuredData) {
    structuredData = document.createElement("script");
    structuredData.id = "vibhavgpt-structured-data";
    structuredData.type = "application/ld+json";
    document.head.append(structuredData);
  }
  structuredData.textContent = JSON.stringify(pageStructuredData(path));
}
