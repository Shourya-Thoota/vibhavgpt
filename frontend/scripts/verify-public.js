import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PUBLIC_PAGES, SITE_ORIGIN } from "../src/public-pages.js";

export async function verifyPublicBuild(dist) {
  const sitemap = await readFile(resolve(dist, "sitemap.xml"), "utf8");
  const robots = await readFile(resolve(dist, "robots.txt"), "utf8");
  assert.match(robots, /User-agent: \*[\s\S]*Allow: \//);
  assert.doesNotMatch(robots, /Disallow:\s*\//);
  assert.ok(robots.includes(`${SITE_ORIGIN}/sitemap.xml`));
  for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
    const file = ["/home", "/apps", "/sources", "/android", "/vibhavgpt-windows"].includes(path) ? `${path.slice(1)}/index.html` : `${path.slice(1)}.html`;
    const html = await readFile(resolve(dist, file), "utf8");
    const body = html.slice(html.indexOf("<body"));
    assert.equal((html.match(/<title>/g) ?? []).length, 1, `${path}: duplicate title`);
    assert.ok(html.includes(`<title>${page.title}</title>`), `${path}: title mismatch`);
    assert.ok(html.includes(`href="${SITE_ORIGIN}${path}"`), `${path}: canonical missing`);
    assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1, `${path}: duplicate canonical`);
    assert.equal((html.match(/name="description"/g) ?? []).length, 1, `${path}: description missing or duplicated`);
    const description = html.match(/name="description" content="([^"]*)"/)?.[1];
    assert.equal(description, page.description, `${path}: description mismatch`);
    assert.ok(description.length >= 150 && description.length <= 160, `${path}: description length`);
    assert.ok(description.endsWith("Made by Vibhav Thoota."), `${path}: creator attribution missing`);
    assert.match(html, /name="viewport"[^>]*width=device-width/);
    assert.doesNotMatch(html, /(?:noindex|nofollow)/i);
    assert.match(body, /<footer\b[^>]*>[\s\S]*?Made by Vibhav Thoota[\s\S]*?<\/footer>/, `${path}: visible creator footer missing`);
    assert.equal((body.match(/<h1(?:\s|>)/g) ?? []).length, 1, `${path}: expected one h1 in server HTML`);
    assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']http:\/\//i);
    for (const img of body.match(/<img\b[^>]*>/g) ?? []) assert.match(img, /\salt=/, `${path}: missing image alternative`);
    const dataTags = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g) ?? [];
    assert.equal(dataTags.length, 1, `${path}: expected one structured data graph`);
    const schema = JSON.parse(dataTags[0].replace(/^[^>]*>/, "").replace(/<\/script>$/, ""));
    const types = schema["@graph"].map(item => item["@type"]);
    assert.ok(types.includes("Organization") && types.includes("WebSite"));
    const organization = schema["@graph"].find(item => item["@type"] === "Organization");
    assert.equal(organization.founder?.name, "Vibhav Thoota", `${path}: founder missing`);
    assert.equal(organization.founder["@type"], "Person");
    assert.equal(organization.founder.jobTitle, "Founder");
    if (path !== "/home") {
      assert.ok(types.includes("BreadcrumbList"));
      assert.doesNotMatch(body, /aria-label="Breadcrumb"|public-breadcrumbs/, `${path}: visible breadcrumb`);
      assert.match(body, /Pansophy LLC/);
    }
    if (page.faq) {
      assert.ok(types.includes("FAQPage"));
      assert.match(body, /Questions and answers/);
      const content = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<[^>]*>/g, " ").replace(/&[^;]+;/g, " ");
      assert.ok(content.split(/\s+/).filter(Boolean).length >= 300, `${path}: insufficient public content`);
    }
    assert.ok(sitemap.includes(`<loc>${SITE_ORIGIN}${path}</loc>`));
  }
  console.log("Public build verification passed: metadata, readable HTML, headings, FAQs, schema and crawler discovery.");
}
