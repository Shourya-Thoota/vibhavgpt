import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SOCIAL_LINKS, socialLinkName } from "../frontend/src/social-links.js";
import { FOOTER_ICONS, FOOTER_LINKS, FOOTER_SOCIAL, GITHUB, THREADS, siteFooterHtml, siteFooterInner } from "../frontend/src/site-footer.js";
import { STATIC_PUBLIC_PAGES, expectedPage } from "../scripts/sync-site-footer.mjs";

// The owner's profile links, exactly as given, in one footer on every public page (Slice 6: one footer component, plus Threads and
// GitHub). Nothing else is guessed or added.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

test("the owner's original four are unchanged, verbatim", () => {
  assert.deepEqual(SOCIAL_LINKS.map((link) => [link.label, link.href]), [
    ["Instagram", "https://www.instagram.com/vibhavgpt.ai/"],
    ["X", "https://x.com/VibhavGPT"],
    ["Bluesky", "https://bsky.app/profile/vibhavgpt.bsky.social"],
    ["Reddit", "https://www.reddit.com/user/Cool-Issue-2311/"],
  ]);
  for (const link of SOCIAL_LINKS) assert.equal(socialLinkName(link), `VibhavGPT on ${link.label} (opens in a new tab)`);
});

test("the footer's social row: YouTube, Instagram, X, Bluesky, Reddit unchanged, then Threads and GitHub exactly as the owner gave them", () => {
  assert.deepEqual(FOOTER_SOCIAL.map((link) => [link.label, link.href, link.handle]), [
    ["YouTube", "https://www.youtube.com/@vibhavthoota", "@vibhavthoota"],
    ["Instagram", "https://www.instagram.com/vibhavgpt.ai/", "@vibhavgpt.ai"],
    ["X", "https://x.com/VibhavGPT", "@VibhavGPT"],
    ["Bluesky", "https://bsky.app/profile/vibhavgpt.bsky.social", "@vibhavgpt.bsky.social"],
    ["Reddit", "https://www.reddit.com/user/Cool-Issue-2311/", "u/Cool-Issue-2311"],
    ["Threads", "https://www.threads.net/@vibhavgpt.ai", "@vibhavgpt.ai"],
    ["GitHub", "https://github.com/Shourya-Thoota", "@Shourya-Thoota"],
  ]);
  assert.equal(THREADS.handle, "@vibhavgpt.ai");
  assert.equal(GITHUB.handle, "@Shourya-Thoota");
  assert.deepEqual(FOOTER_LINKS.map((link) => link.label), ["The VibhavGPT Guarantee", "Privacy Policy", "Terms of Service", "Account deletion", "Source code"]);
});

test("one footer: every static public page carries exactly the shared markup, once, and loads its stylesheet", async () => {
  for (const rel of STATIC_PUBLIC_PAGES) {
    const html = read(`frontend/public/${rel}`);
    assert.equal(await expectedPage(html), html, `${rel}: in sync (node scripts/sync-site-footer.mjs)`);
    assert.equal(html.split(siteFooterHtml()).length - 1, 1, `${rel}: the footer once`);
    assert.equal((html.match(/<footer\b/g) ?? []).length, 1, `${rel}: no second footer`);
    assert.match(html, /<link rel="stylesheet" href="\/theme\/site-footer\.css" \/>/);
  }
  // The React pages render the same markup through <SiteFooter />.
  assert.match(read("frontend/src/components/SiteFooter.jsx"), /dangerouslySetInnerHTML=\{\{ __html: siteFooterInner\(\) \}\}/);
  assert.equal((read("frontend/src/Legal.jsx").match(/<SiteFooter \/>/g) ?? []).length, 2, "the Guarantee and both legal documents");
  assert.match(read("frontend/src/App.jsx"), /\{publicPreview && <SiteFooter \/>\}/, "the pricing page");
  assert.match(read("frontend/scripts/prerender-public.js"), /\["src\/site-footer\.css", "theme\/site-footer\.css"\]/);
});

test("each link opens a new tab safely when external, and its accessible name contains its visible word", () => {
  const html = siteFooterInner();
  const anchors = [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)];
  for (const [, attributes, inner] of anchors) {
    const text = inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    const href = attributes.match(/href="([^"]+)"/)[1];
    if (/^https?:/.test(href)) {
      assert.match(attributes, /target="_blank"/);
      assert.match(attributes, /rel="noopener noreferrer"/);
      assert.match(attributes, /aria-label="[^"]*\(opens in a new tab\)"/);
    }
    const label = attributes.match(/aria-label="([^"]+)"/)?.[1] ?? text;
    assert.ok(label.includes(text), `"${label}" contains the visible "${text}"`);
  }
  // One icon style: outline glyphs at the same stroke, decorative.
  const icons = [...html.matchAll(/<svg [^>]*>/g)].map((m) => m[0]);
  assert.equal(icons.length, FOOTER_SOCIAL.length);
  for (const icon of icons) {
    assert.match(icon, /fill="none" stroke="currentColor" stroke-width="1\.75"/);
    assert.match(icon, /aria-hidden="true"/);
  }
});

test("each footer link is a 44px target, and the footer is tokens only", () => {
  const css = read("frontend/src/site-footer.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [".site-footer__links a", ".site-footer__social a", ".site-footer__mark", ".site-footer__support"]) {
    assert.match(css, new RegExp(`${selector.replaceAll(".", "\\.")} \\{[^}]*min-height: var\\(--hit-min\\)`), `${selector} is a 44px target`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i, "no raw colours");
  // Settings and Usage show this same footer (its 44px targets are the ones checked above); there is no second in-app footer.
  const app = read("frontend/src/App.jsx");
  assert.equal(app.match(/<SiteFooter className="site-footer--in-app" \/>/g)?.length, 2, "Settings and Usage render the shared footer");
  assert.doesNotMatch(app, /SettingsFooter|settings__footer|<SocialLinks\b/, "the old in-app footer is gone");
});

test("no other profile link is added: every social address in the site is one the owner gave", () => {
  const allowed = new Set(FOOTER_SOCIAL.map((link) => link.href));
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!["node_modules", "dist", "fonts", "brand", "home/artwork", "home/models"].includes(entry.name)) walk(rel); continue; }
      if (!/\.(html|js|jsx)$/.test(entry.name)) continue;
      for (const match of read(rel).matchAll(/https?:\/\/(?:www\.)?(?:instagram\.com|x\.com|twitter\.com|bsky\.app|reddit\.com|facebook\.com|linkedin\.com|tiktok\.com|threads\.net|mastodon\.[a-z]+)[^"'`\s<)]*/g)) found.add(match[0]);
    }
  };
  walk("frontend/src"); walk("frontend/public");
  for (const href of found) assert.ok(allowed.has(href), `unexpected social address: ${href}`);
  assert.equal(found.size, 5, "the four profiles and Threads");
});

test("the Sources page's Social section is the generated one: the YouTube channel, the owner's four profiles, Threads and GitHub, and nothing else", async () => {
  const { SOURCES_SOCIAL, YOUTUBE_CHANNEL, sourcesSocialHtml } = await import("../frontend/src/social-links.js");
  const page = read("frontend/public/sources/index.html");
  assert.ok(page.includes(sourcesSocialHtml("    ")), "the page carries exactly the generated section");
  assert.equal(page.split('aria-labelledby="social-title"').length - 1, 1, "once");
  assert.deepEqual(SOURCES_SOCIAL.map((link) => link.href), [YOUTUBE_CHANNEL.href, ...SOCIAL_LINKS.map((link) => link.href), THREADS.href, GITHUB.href]);
  // One source: the footer's social row is exactly this list, with the same icons, so the two cannot drift apart.
  assert.deepEqual(FOOTER_SOCIAL.map((link) => link.href), SOURCES_SOCIAL.map((link) => link.href));
  for (const link of SOURCES_SOCIAL) assert.equal(link.icon, FOOTER_ICONS[link.id], `${link.label}: the same glyph as the footer`);
  assert.equal(YOUTUBE_CHANNEL.href, "https://www.youtube.com/@vibhavthoota", "the existing YouTube destination is kept, unchanged");
  const section = sourcesSocialHtml();
  const rows = [...section.matchAll(/<a class="src-row src-row--social" href="([^"]+)" target="_blank" rel="noopener noreferrer">/g)];
  assert.equal(rows.length, 7, "seven destinations");
  for (const handle of ["@vibhavgpt.ai", "@Shourya-Thoota"]) assert.ok(section.includes(`<span>${handle}</span>`), `shows ${handle}`);
  for (const link of SOURCES_SOCIAL) {
    assert.match(section, new RegExp(`<strong>${link.label}</strong>`), `${link.label} is named`);
    assert.ok(link.icon.startsWith("<svg") && link.icon.includes('aria-hidden="true"'), `${link.label} has a decorative platform icon`);
  }
  assert.equal((section.match(/\(opens in a new tab\)/g) ?? []).length, 7);
  for (const link of SOURCES_SOCIAL) assert.ok(decodeURIComponent(link.href).toLowerCase().includes(link.handle.replace(/^[@u/]+/, "").toLowerCase()), `${link.label}: ${link.handle} comes from ${link.href}`);
  assert.doesNotMatch(section, /<script|<iframe|utm_|ping=/i, "no embeds or tracking");
  const { PUBLIC_PAGES } = await import("../frontend/src/public-pages.js");
  const copy = JSON.stringify(PUBLIC_PAGES["/sources"]);
  assert.doesNotMatch(copy, /Two places outside/i);
  for (const platform of ["GitHub", "YouTube", "Instagram", "X", "Bluesky", "Reddit", "Threads"]) assert.ok(copy.includes(platform), `the page copy names ${platform}`);
  // Nothing claims a smaller list than the page shows.
  assert.doesNotMatch(copy, /Bluesky and Reddit/, "the old five-network list is gone from the copy");
});
