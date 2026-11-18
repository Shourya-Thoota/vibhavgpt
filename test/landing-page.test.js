import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The public homepage (frontend/public/home/index.html) and the public Pricing
// page: what they promise, where their actions lead, and that the copy is plain.
// Rendering is covered in browser-redesign.test.js.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const home = read("frontend/public/home/index.html");
const body = home.slice(home.indexOf("<body"));
const script = home.slice(home.lastIndexOf("<script>"));
const text = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&rarr;|&middot;|&hellip;|&uarr;|&nbsp;|&#10003;/g, " ").replace(/\s+/g, " ");
const css = home.match(/<style>([\s\S]*?)<\/style>/)[1];
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("the homepage says what the product does, plainly, with truthful approved claims", () => {
  assert.match(home, /<h1 id="hero-title">AI chat, study tools and image creation\.<\/h1>/);
  assert.match(text, /Free to start\. We never train on your chats, sell your data, or show ads\./);
  // The copy is literal: it says what each part does, in the words a person would use.
  for (const line of ["Features", "Ask a question and read the answer in a conversation.", "Make flashcards and a quiz from an answer.", "Ask for a diagram and it appears in the reply.", "You can start on the free plan."]) assert.ok(text.includes(line), line);
  for (const gone of ["What you can do with VibhavGPT", "VibhavGPT does five things", "What VibhavGPT is", "A quick tour", "Scroll to watch", "Turn the answer into flashcards and a quiz", "Skip the tour", "Ask a question. Get a direct answer."]) assert.ok(!text.includes(gone), `removed: ${gone}`);
  // The Guarantee, in its approved wording, is a link to its own page; the plans live on the Pricing page. The homepage keeps neither the table nor the block.
  assert.match(text, /We never train on your chats, sell your data, or show ads\./);
  assert.doesNotMatch(text, /per month|Compare plans|Not available to purchase|Export everything, or delete your account/, "no plan prices or Guarantee block on the homepage");
  // What was on the homepage is on the pages that remain: the four promises on Pricing, the plans on Pricing, the diagrams line in the comparison.
  const app = read("frontend/src/App.jsx");
  assert.ok(app.includes("We never train on your chats. We never sell your data. We never show ads. Export everything or delete your account whenever you like."), "the four promises are on the Pricing page");
  assert.ok(app.includes("Max is not available to purchase yet."), "Max's availability is on the Pricing page");
  assert.match(read("frontend/src/plan-comparison.js"), /\{ label: "Diagrams in replies", values: \[true, true, true, true\] \}/, "the Free plan's diagrams line moved to the Pricing comparison");
  assert.doesNotMatch(text, /actual AI|AI cost|\$\d+ of|\$\d+ in (AI|usage)|launch date|coming soon/i, "no allowance dollars, launch dates or promises");
  // No invented proof, template slogans or vendor names.
  assert.doesNotMatch(text, /testimonial|trusted by|\d[\d,.]*\s?(k|m)?\+? users|unlock|supercharge|revolutioni|limitless|ultimate|future of|seamless|effortless|think out loud|your space to|built for the way|meet your|everything you need|think bigger|all[- ]in[- ]one|powerful|game[- ]chang|cutting[- ]edge|next[- ]level/i);
  for (const vendor of ["openai", "openrouter", "groq", "anthropic", "gemini", "deepseek", "qwen", "kimi", "grok", "mermaid"]) assert.doesNotMatch(text.toLowerCase(), new RegExp(`\\b${vendor}\\b`), vendor);
  assert.doesNotMatch(text, /—|–/, "no em or en dashes in page copy");
});

test("every call to action leads to an existing destination", () => {
  const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("data:"));
  // The shared footer's profile links and support address (site-footer.js; test/social-links.test.js checks them).
  const social = new Set(["https://www.youtube.com/@vibhavthoota", "https://www.instagram.com/vibhavgpt.ai/", "https://x.com/VibhavGPT", "https://bsky.app/profile/vibhavgpt.bsky.social", "https://www.reddit.com/user/Cool-Issue-2311/", "https://www.threads.net/@vibhavgpt.ai", "https://github.com/Shourya-Thoota", "mailto:support@pansophy.com"]);
  for (const href of hrefs) assert.ok(social.has(href) || /^(\/(signup|app|app\/chat|app\/study|home|pricing|apps|guarantee|privacy|terms|account-deletion)|#(main|showcase)|https:\/\/github\.com\/Shourya-Thoota\/vibhavgpt)$/.test(href), `unexpected link ${href}`);
  for (const id of ["showcase", "main"]) assert.match(body, new RegExp(`id="${id}"`), `anchor #${id} exists`);
  for (const id of ["plans", "features", "privacy"]) assert.doesNotMatch(body, new RegExp(`id="${id}"|href="#${id}"`), `no leftover #${id}`);
  assert.match(body, /<a href="\/pricing">Pricing<\/a>/, "the nav's Pricing opens the Pricing page");
  assert.match(body, /<a class="btn btn-primary" href="\/signup" id="nav-enroll">Get started<\/a>/);
  assert.doesNotMatch(home, /tour|SCENES|skip-tour/i, "the scroll tour is gone");
});

test("planetary identity is one horizon: no starfield, orbs or planet images", () => {
  assert.doesNotMatch(home, /class="stars"|planets\/(earth|venus|mars)\.webp|planets\/guarantee\.svg/);
  assert.doesNotMatch(home, /class="horizon"/);
});

test("glass is the shared material on floating controls only, with a rim lens kept beneath the labels", () => {
  const filtered = [...cssNoComments.matchAll(/([^{}]+)\{[^{}]*backdrop-filter[^{}]*\}/g)].map((match) => match[1].trim()).sort();
  assert.deepEqual(filtered, [".lg::before", "html.lens .lg-m::before"], "the backdrop lives on a pseudo-layer under the content");
  const glassUsers = [...body.matchAll(/class="([^"]*\blg\b[^"]*)"/g)].map((match) => match[1].split(" ")[0]).sort();
  assert.deepEqual(glassUsers, ["nav", "sheet"], "the navigation bar and its menu sheet");
  assert.match(css, /\.lg::before\{content:"";position:absolute;inset:0;z-index:-1;/, "behind the labels, never over them");
  assert.match(home, /<filter id="lg-lens"[\s\S]*<feDisplacementMap in="SourceGraphic" in2="map"/);
  assert.match(script, /navigator\.userAgentData\?\.brands\?\.some\(\(brand\) => \/Chromium\/\.test\(brand\.brand\)\)\) document\.documentElement\.classList\.add\("lens"\)/, "progressive enhancement");
  const theme = read("frontend/src/theme/vibhav.css");
  for (const token of ["--lg-tint-s", "--lg-tint-m", "--lg-tint-l", "--lg-filter-s", "--lg-filter-m", "--lg-filter-l", "--lg-rim", "--lg-shadow"]) assert.ok(theme.includes(`${token}:`), token);
  assert.match(theme, /@media \(prefers-reduced-transparency: reduce\) \{[^}]*--lg-filter-m: none;/);
  assert.match(theme, /@media \(prefers-contrast: more\) \{[^}]*--lg-filter-m: none;/);
  assert.match(theme, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{[^}]*--lg-filter-m: none;/);
  assert.match(theme, /:root\[data-effects="solid"\][^{]*\{[^}]*--lg-filter-m: none;/, "the explicit Solid setting");
});

test("navigation keeps the signed-in swap, a keyboard-safe mobile menu and the creator credit", () => {
  assert.match(home, /<a class="brand" href="\/home"><img src="\/brand\/vibhavgpt-icon-64\.png"/);
  assert.match(home, /fetch\(`\$\{apiBase\}\/api\/me`, \{ credentials: "include", cache: "no-store" \}\)/);
  assert.match(home, /if \(enroll\) \{ enroll\.textContent = "Open workspace"; enroll\.href = "\/app"; \}/);
  assert.match(home, /<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-sheet" aria-label="Open menu">/);
  assert.match(home, /event\.key === "Escape" && sheet\.hasAttribute\("data-open"\)\) setOpen\(false\)/, "Escape closes the menu and returns focus");
  assert.match(home, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(home, /<footer class="site-footer">[\s\S]*<a href="https:\/\/github\.com\/Shourya-Thoota\/vibhavgpt" target="_blank" rel="noopener noreferrer" aria-label="Source code \(opens in a new tab\)">Source code<\/a>[\s\S]*Made by Vibhav Thoota/);
  assert.match(home, /<script src="\/theme\/appearance-boot\.js"><\/script>/, "the saved appearance applies before first paint");
});

test("the public Pricing page has no sky decoration and keeps the plans unchanged", () => {
  const app = read("frontend/src/App.jsx");
  const pricing = app.slice(app.indexOf("export function PublicPricing"), app.indexOf("function Billing("));
  assert.match(pricing, /<div className="pricing-page">/);
  assert.match(pricing, /<Billing tier="visitor" publicPreview \/>/, "the plans themselves are unchanged");
  assert.doesNotMatch(pricing, /planets\/|cosmos|stars|orbit/);
  const sheet = read("frontend/src/pricing.css");
  assert.doesNotMatch(sheet, /pricing-cosmos/);
  assert.doesNotMatch(sheet.slice(sheet.indexOf("The public /pricing page (PublicPricing)")), /#[0-9a-f]{3,8}\b/i, "theme tokens only");
});
