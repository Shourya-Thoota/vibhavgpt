import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PUBLIC_PAGES, SITE_ORIGIN, publicPagePath, pageStructuredData, DELETION_PLAN_NOTICE } from "../frontend/src/public-pages.js";
import { updateMetadata, detailsHtml } from "../frontend/scripts/public-html.js";
import { resetPageScroll } from "../frontend/src/page-scroll.js";

test("public URLs and legal aliases share a canonical, title and description", () => {
  for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
    assert.ok(page.title.length >= 50 && page.title.length <= 60, path);
    assert.ok(page.description.length >= 150 && page.description.length <= 160, path);
    assert.ok(page.description.endsWith("Made by Vibhav Thoota."), path);
    assert.doesNotMatch(page.description, /\u2014/, path);
    for (const url of [path, `${path}/`, `${path}.html`, `${path}/index.html`]) assert.equal(publicPagePath(url), path);
  }
  assert.equal(publicPagePath("/"), "/home");
  assert.equal(publicPagePath("/terms-of-service"), "/terms");
  assert.equal(publicPagePath("/privacy-policy/"), "/privacy");
  assert.equal(publicPagePath("/app/study"), "/app/study");
});

test("head updates remove duplicate SEO tags and never alter visible homepage content or styles", () => {
  const home = readFileSync(new URL("../frontend/public/home/index.html", import.meta.url), "utf8");
  const html = updateMetadata(updateMetadata(home, "/home"), "/home");
  assert.equal(html.slice(html.indexOf("<body")), home.slice(home.indexOf("<body")));
  assert.deepEqual(html.match(/<style\b[^>]*>[\s\S]*?<\/style>/g), home.match(/<style\b[^>]*>[\s\S]*?<\/style>/g));
  for (const pattern of [/<title>/g, /name="description"/g, /rel="canonical"/g, /type="application\/ld\+json"/g]) assert.equal(html.match(pattern)?.length, 1);
  assert.match(html, /name="robots" content="index, follow/);
  assert.doesNotMatch(html, /noindex|nofollow/i);
});

test("structured data names the operator, website, matching breadcrumbs and visible FAQs", () => {
  for (const [path, page] of Object.entries(PUBLIC_PAGES)) {
    const data = pageStructuredData(path);
    assert.equal(data["@context"], "https://schema.org");
    const get = (type) => data["@graph"].find(item => item["@type"] === type);
    assert.equal(get("Organization").name, "Pansophy LLC");
    const founder = get("Organization").founder;
    assert.deepEqual(founder, { "@type": "Person", "@id": `${SITE_ORIGIN}/#founder`, name: "Vibhav Thoota", jobTitle: "Founder" });
    assert.equal(get("WebSite").creator["@id"], founder["@id"]);
    assert.equal(get("SoftwareApplication").creator["@id"], founder["@id"]);
    assert.equal(get("WebSite").publisher["@id"], get("Organization")["@id"]);
    if (path !== "/home") {
      assert.deepEqual(get("BreadcrumbList").itemListElement.map(item => item.position), [1, 2]);
      assert.equal(get("BreadcrumbList").itemListElement[1].item, `${SITE_ORIGIN}${path}`);
    }
    if (page.faq) {
      assert.deepEqual(get("FAQPage").mainEntity.map(q => [q.name, q.acceptedAnswer.text]), page.faq);
      const { faq } = detailsHtml(path);
      assert.equal((faq.match(/<h3>/g) ?? []).length, page.faq.length);
      for (const [q] of page.faq) assert.ok(faq.includes(q));
    }
  }
});

test("deletion confirmation and static page include the cancellation responsibility notice", () => {
  assert.equal(DELETION_PLAN_NOTICE, "Cancel your plan before deleting your account. Deletion is blocked while a web plan is active. Pansophy LLC is not responsible for subscriptions that were not canceled.");
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /title="Delete your account\?"[\s\S]*?description=\{`[^`]*\$\{DELETION_PLAN_NOTICE\}/);
  const page = readFileSync(new URL("../frontend/public/account-deletion.html", import.meta.url), "utf8");
  assert.ok(page.includes(DELETION_PLAN_NOTICE));
  assert.ok(PUBLIC_PAGES["/account-deletion"].faq.some(([, answer]) => answer === `${DELETION_PLAN_NOTICE} Open Plan and billing and choose Cancel plan. Once it is canceled, you can delete your account.`));
});

test("the static deletion page never claims deletion cancels a plan", () => {
  const page = readFileSync(new URL("../frontend/public/account-deletion.html", import.meta.url), "utf8");
  for (const claim of ["was canceled", "is canceled first", "was cancelled", "is cancelled first"]) assert.ok(!page.includes(claim), claim);
  assert.ok(page.includes("Your conversations, projects, memory, files and images are gone from VibhavGPT, and you have been signed out.</p>"));
  assert.ok(page.includes("Sign in if asked, then type DELETE to confirm. If you have an active plan, cancel it in Plan and billing first; deletion is blocked until you do. Your account and everything in it is then removed straight away."));
});

test("Settings links to Plan and billing when deletion is refused for an active plan", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const settings = app.slice(app.indexOf("function Settings("), app.indexOf("function SettingsFooter("));
  const body = (name) => settings.slice(settings.indexOf(`function ${name}(`), settings.indexOf("\n  }\n", settings.indexOf(`function ${name}(`)));

  // The refusal is kept in the dialog's own error, never the page banner.
  const deleteAccount = body("deleteAccount");
  assert.match(deleteAccount, /setDeleteError\(err\.message\)/);
  assert.match(deleteAccount, /setDeleteErrorCode\(err\.code \?\? ""\)/);
  assert.doesNotMatch(deleteAccount, /setError\(/, "deleting never writes the page-level error");
  assert.match(settings, /\{deleteError && \(\s*<p className="note note--error" role="alert">\s*\{deleteError\}/);

  // Opening and closing the dialog clear both errors.
  for (const name of ["openDeleteDialog", "closeDeleteDialog"]) {
    const fn = body(name);
    assert.match(fn, /setError\(""\)/, `${name} clears the page error`);
    assert.match(fn, /setDeleteError\(""\)/, `${name} clears the dialog error`);
    assert.match(fn, /setDeleteErrorCode\(""\)/, name);
  }
  assert.match(settings, /onClick=\{openDeleteDialog\}/);
  assert.match(settings, /onClose=\{closeDeleteDialog\}/);
  assert.match(settings, /onClick=\{closeDeleteDialog\}>Keep my account</);
  assert.doesNotMatch(settings, /setDeleteOpen\(false\)(?![\s\S]{0,80}setError)/, "every close goes through closeDeleteDialog");

  // The link closes the dialog and moves in-app: no full page load.
  assert.match(settings, /deleteErrorCode === "active-subscription" && \([\s\S]*?<a href="\/app\/billing" onClick=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\); closeDeleteDialog\(\); onOpenBilling\(\);[\s\S]*?>Plan and billing<\/a>/);
  assert.match(app, /onOpenBilling=\{\(\) => go\("billing"\)\}/);
  assert.match(app, /const go = \(next[\s\S]*?window\.history\.pushState\(null, "", path\)/, "go() navigates with pushState, not a reload");

  // The notice shows once: the section hides its copy while the dialog, which repeats it, is open.
  assert.match(settings, /\{!deleteOpen && <p className="settings-notice">\{DELETION_PLAN_NOTICE\}<\/p>\}/);
});

test("standalone deletion uses the shared pre-paint theme and Daybreak honors saved preferences", () => {
  const page = readFileSync(new URL("../frontend/public/account-deletion.html", import.meta.url), "utf8");
  assert.match(page, /src="\/theme\/appearance-boot\.js"/);
  assert.match(page, /href="\/theme\/vibhav\.css"/);
  assert.doesNotMatch(page, /color-scheme:\s*dark\s*;|--paper:\s*#/);
  const boot = readFileSync(new URL("../frontend/src/theme/appearance-boot.js", import.meta.url), "utf8");
  for (const [saved, chosen, systemLight, expected] of [["light", "1", false, "light"], ["dark", "1", true, "dark"], ["system", "1", true, "light"], ["system", null, true, "dark"], [null, null, true, "dark"]]) {
    const attributes = {};
    runInNewContext(boot, { document: { documentElement: { setAttribute: (k, v) => { attributes[k] = v; } } }, localStorage: { getItem: k => ({ "vibhavgpt-theme": saved, "vibhavgpt-theme-chosen": chosen, "vibhavgpt-accent": "pine" })[k] }, window: { matchMedia: () => ({ matches: systemLight }), addEventListener: () => {} } });
    assert.equal(attributes["data-theme"], expected);
    assert.equal(attributes["data-accent"], "pine");
  }
});

test("theme re-syncs on a cached page return or another tab's theme change", () => {
  const events = {}; const attributes = {}; let saved = "dark";
  runInNewContext(readFileSync(new URL("../frontend/src/theme/appearance-boot.js", import.meta.url), "utf8"), { document: { documentElement: { setAttribute: (key, value) => { attributes[key] = value; } } }, localStorage: { getItem: key => key === "vibhavgpt-theme" ? saved : null }, window: { addEventListener: (name, fn) => { events[name] = fn; } } });
  assert.equal(attributes["data-theme"], "dark");
  saved = "light"; events.pageshow({ persisted: true });
  assert.equal(attributes["data-theme"], "light");
  saved = "dark"; events.storage({ key: "vibhavgpt-theme" });
  assert.equal(attributes["data-theme"], "dark");
});

test("page load disables automatic restoration and pageshow resets old positions including bfcache", () => {
  const events = {}; const frames = []; const calls = []; const history = { scrollRestoration: "auto" };
  runInNewContext(readFileSync(new URL("../frontend/src/page-scroll-boot.js", import.meta.url), "utf8"), { history, window: { addEventListener: (name, fn) => { events[name] = fn; }, scrollTo: options => calls.push(options) }, requestAnimationFrame: fn => frames.push(fn) });
  assert.equal(history.scrollRestoration, "manual");
  events.pageshow({ persisted: true }); frames.shift()();
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.top === 0 && c.left === 0 && c.behavior === "instant"));
});

test("route reset clears both the window and workspace scroll positions", () => {
  const priorWindow = globalThis.window; const priorDocument = globalThis.document;
  const nodes = [{ scrollTop: 2000, scrollLeft: 10 }, { scrollTop: 3000, scrollLeft: 20 }];
  let called = false;
  try {
    globalThis.window = { scrollTo: options => { called = options.top === 0; } };
    globalThis.document = { scrollingElement: nodes[0], querySelector: () => nodes[1] };
    resetPageScroll(); assert.ok(called);
    assert.ok(nodes.every(n => n.scrollTop === 0 && n.scrollLeft === 0));
  } finally { globalThis.window = priorWindow; globalThis.document = priorDocument; }
});

test("crawler discovery permits search and AI engines and lists every canonical public page", () => {
  const read = file => readFileSync(new URL(`../frontend/public/${file}`, import.meta.url), "utf8");
  assert.match(read("robots.txt"), /User-agent: \*[\s\S]*Allow: \//);
  assert.match(read("llms.txt").split("## Public pages")[0], /Vibhav Thoota is the creator and founder of VibhavGPT\./);
  assert.doesNotMatch(read("robots.txt"), /Disallow:\s*\//);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/vibhavgpt.com\/sitemap.xml/);
  for (const path of Object.keys(PUBLIC_PAGES)) {
    assert.ok(read("sitemap.xml").includes(`<loc>${SITE_ORIGIN}${path}</loc>`));
    assert.ok(read("llms.txt").includes(`${SITE_ORIGIN}${path}`));
  }
});

test("creator credit is visible in public footers and shared Settings and usage views", () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const file of ["home/index.html", "android/index.html", "vibhavgpt-windows/index.html", "account-deletion.html"]) {
    const html = read(`frontend/public/${file}`);
    assert.match(html, /<footer\b[^>]*>[\s\S]*?Made by Vibhav Thoota[\s\S]*?<\/footer>/);
    assert.match(html, /name="description" content="[^"]*Made by Vibhav Thoota\./);
  }
  const app = read("frontend/src/App.jsx");
  for (const [start, end] of [["function Settings(", "function SettingsFooter("], ["function UsageDashboard(", "export function PublicPricing("]]) {
    const section = app.slice(app.indexOf(start), end ? app.indexOf(end) : undefined);
    assert.match(section, /<SettingsFooter onLegal=\{onLegal\} \/>/);
  }
  const sharedFooter = app.slice(app.indexOf("function SettingsFooter("), app.indexOf("function SettingsIndex("));
  assert.match(sharedFooter, /<footer[^>]*>[\s\S]*Made by Vibhav Thoota[\s\S]*<\/footer>/);
  for (const label of ["Terms of Service", "Privacy Policy", "The VibhavGPT Guarantee"]) assert.ok(sharedFooter.includes(label));
  assert.match(app.slice(app.indexOf("function Billing(")), /<footer[^>]*>Made by Vibhav Thoota<\/footer>/);
  const legal = read("frontend/src/Legal.jsx");
  assert.equal((legal.match(/<footer[^>]*>Made by Vibhav Thoota<\/footer>/g) ?? []).length, 2);
});

test("the frontend server publishes prerendered public documents from the frontend build", () => {
  const caddy = readFileSync(new URL("../frontend/Caddyfile", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(caddy.includes("root * dist"), "the site is served from the frontend build");
  // A bare / gets the static homepage; every other public page is a real
  // file in the build, found as {path}.html or {path}/index.html.
  const home = caddy.slice(caddy.indexOf("handle @homeRoot {"), caddy.indexOf("@appShell"));
  assert.ok(home.includes("rewrite * /home/index.html"), "a bare / serves the static homepage");
  const fallback = caddy.slice(caddy.lastIndexOf("\thandle {"), caddy.indexOf("handle_errors 404"));
  assert.ok(fallback.includes("try_files {path} {path}.html {path}/index.html\n"), "public pages resolve to their prerendered files");
  const appShell = caddy.slice(caddy.indexOf("@appShell path ") + "@appShell path ".length).split("\n")[0].split(" ");
  for (const path of Object.keys(PUBLIC_PAGES).filter((path) => path !== "/")) {
    assert.ok(!appShell.includes(path), `${path} is served as its own document, not the app shell`);
  }
});
