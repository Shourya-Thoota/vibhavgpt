// The one public-site footer (Slice 6). Every public page shows exactly this markup: the React pages (Guarantee, Terms, Privacy,
// Pricing) render it through <SiteFooter />, and the static pages carry the same string between <!-- site-footer:start --> and
// <!-- site-footer:end -->, written by scripts/sync-site-footer.mjs. test/site-footer.test.js checks every copy is identical.
//
// A grid: the brand and operator block, one column of links, the social row, the attribution line. Styles: site-footer.css.

import { SOCIAL_ICONS_OUTLINE, SOURCES_SOCIAL } from "./social-links.js";

export const FOOTER_LINKS = Object.freeze([
  Object.freeze({ label: "The VibhavGPT Guarantee", href: "/guarantee" }),
  Object.freeze({ label: "Privacy Policy", href: "/privacy" }),
  Object.freeze({ label: "Terms of Service", href: "/terms" }),
  // Kept beyond the four the brief lists: app stores expect the deletion page to be reachable from every page.
  Object.freeze({ label: "Account deletion", href: "/account-deletion" }),
  Object.freeze({ label: "Source code", href: "https://github.com/Shourya-Thoota/vibhavgpt", external: true }),
]);

// Every profile and its icon come from social-links.js, the one list the Sources page reads too, so the two cannot drift apart.
export { THREADS, GITHUB } from "./social-links.js";
export const FOOTER_SOCIAL = Object.freeze(SOURCES_SOCIAL.map(({ id, label, href, handle }) => Object.freeze({ id, label, href, handle })));
export const FOOTER_ICONS = SOCIAL_ICONS_OUTLINE;


const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
const newTab = (label) => `${label} (opens in a new tab)`;

/** The footer's inner markup (no wrapper), identical everywhere it appears. */
export function siteFooterInner() {
  const links = FOOTER_LINKS.map((link) => `<li><a href="${link.href}"${link.external ? ` ${EXTERNAL} aria-label="${escape(newTab(link.label))}"` : ""}>${escape(link.label)}</a></li>`).join("");
  const social = FOOTER_SOCIAL.map((link) => `<li><a href="${link.href}" ${EXTERNAL} aria-label="${escape(newTab(`VibhavGPT on ${link.label}, ${link.handle}`))}">${FOOTER_ICONS[link.id]}<span>${escape(link.label)}</span></a></li>`).join("");
  return [
    `<div class="site-footer__brand"><a class="site-footer__mark" href="/home"><img src="/brand/vibhavgpt-icon-64.png" alt="" width="24" height="24" /><span>VibhavGPT</span></a><p>Operated by Pansophy LLC.</p><a class="site-footer__support" href="mailto:support@pansophy.com">support@pansophy.com</a></div>`,
    `<nav class="site-footer__links" aria-label="Site"><ul>${links}</ul></nav>`,
    `<nav class="site-footer__social" aria-label="VibhavGPT on social media"><ul>${social}</ul></nav>`,
    `<p class="site-footer__credit">Made by Vibhav Thoota</p>`,
  ].join("");
}

/** The whole footer element, as the static pages carry it. */
export function siteFooterHtml() {
  return `<footer class="site-footer">${siteFooterInner()}</footer>`;
}
