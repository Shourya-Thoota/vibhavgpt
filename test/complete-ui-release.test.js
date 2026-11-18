import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SETTINGS_SECTIONS, settingsPath, settingsRoute } from "../frontend/src/settings-routes.js";
import { PUBLIC_PAGES } from "../frontend/src/public-pages.js";

test("complete UI release: shared public navigation definition across all routes", () => {
  // Public pages must include /home, /pricing, /apps, /guarantee, /terms, /privacy
  const required = ["/home", "/pricing", "/apps", "/guarantee", "/terms", "/privacy"];
  for (const route of required) {
    assert.ok(PUBLIC_PAGES[route], `PUBLIC_PAGES must define ${route}`);
    assert.ok(PUBLIC_PAGES[route].title, `${route} must have a title`);
    assert.ok(PUBLIC_PAGES[route].description, `${route} must have a description`);
  }
});

test("complete UI release: public HTML pages have unified floating capsule navigation", () => {
  const homeHtml = fs.readFileSync(path.resolve("frontend/public/home/index.html"), "utf8");
  const appsHtml = fs.readFileSync(path.resolve("frontend/public/apps/index.html"), "utf8");

  for (const [name, html] of [["home", homeHtml], ["apps", appsHtml]]) {
    // 1. Navigation contains Brand logo, Pricing, Apps, Guarantee
    assert.match(html, /href="\/pricing"/, `${name}: Pricing link present in nav`);
    assert.match(html, /href="\/apps"/, `${name}: Apps link present in nav`);
    assert.match(html, /href="\/guarantee"/, `${name}: Guarantee link present in nav`);

    // 2. Features must NOT be in the navigation header
    const navMatch = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
    assert.ok(navMatch, `${name} must contain a <nav> element`);
    assert.doesNotMatch(navMatch[1], /href="#features"/, `${name}: Features removed from nav capsule`);
    assert.doesNotMatch(navMatch[1], /href="\/features"/, `${name}: Features removed from nav capsule`);

    // 3. Standalone "Get app" button must NOT be in the header
    assert.doesNotMatch(navMatch[1], /Get app/i, `${name}: Redundant Get app button absent from nav`);
  }
});

test("complete UI release: homepage scroll-driven showcase stage structure", () => {
  const homeHtml = fs.readFileSync(path.resolve("frontend/public/home/index.html"), "utf8");
  assert.match(homeHtml, /class="showcase"/, "Showcase container present");
  assert.match(homeHtml, /class="presenter"/, "Sticky presenter stage present");
  assert.match(homeHtml, /data-i="0"/, "Slide 0 present");
  assert.match(homeHtml, /slide__badge/, "Feature badge pills present");
  assert.match(homeHtml, /scroll/, "Scroll-driven progress logic present");
});

test("complete UI release: mode tabs have distinct styling for Chat|Image (notch) and Chat|Study (off-white segmented control)", () => {
  const mobileCss = fs.readFileSync(path.resolve("frontend/src/mobile.css"), "utf8");
  const chatRefCss = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");

  // Chat | Study: one white rounded surface holding two segments, with a sliding selected thumb.
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*--seg-surface:\s*var\(--surface-2\)/s, "the study switcher's track is the Chat | Image notch's own track, never a paper or white block");
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*border-radius:\s*var\(--r-pill/s, "study control is a rounded container");
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*border:\s*1px solid var\(--seg-line\)/s, "study control's border reads --seg-line (transparent: like the notch, it has no outline of its own)");
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*box-shadow:\s*var\(--seg-shadow\)/s, "study control has a subtle shadow");
  assert.match(mobileCss, /\.mode-tabs--study::before\s*\{[^}]*translateX\(calc\(var\(--tab-index/s, "study selected thumb slides on --tab-index");
  assert.doesNotMatch(mobileCss, /\.mode-tabs--study::before\s*\{[^}]*display:\s*none/s, "study thumb is no longer suppressed");
  assert.match(mobileCss, /\.mode-tabs--study\s+\.mode-tabs__tab\[aria-selected="true"\]\s*\{[^}]*font-weight:\s*650/s, "active study tab keeps font-weight 650");
  // Placement only: no stylesheet may turn the control back into bare text.
  assert.doesNotMatch(chatRefCss, /\.start-below\s+\.mode-tabs[^{]*\{[^}]*background:\s*transparent/s, "chat-reference.css must not make the study control transparent");
  assert.match(chatRefCss, /\.workspace\s+\.start-below__tabs\s*\{[^}]*justify-content:\s*center/s, "study control stays centred under the composer");

  // Chat | Image: restored notch design with sliding thumb container
  assert.match(mobileCss, /\.mode-tabs--notch[\s\S]*?display:\s*grid/, "mobile.css mode-tabs--notch has grid container");
  assert.match(mobileCss, /\.mode-tabs--notch::before[\s\S]*?translateX/, "mobile.css mode-tabs--notch has sliding thumb");
  assert.match(chatRefCss, /\.workspace\s+\.mode-tabs--notch::before[\s\S]*?translateX/, "chat-ref mode-tabs--notch has sliding thumb");
});

test("complete UI release: redundant get-app promotions removed from chat/workspace", () => {
  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");
  const chatRefCss = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");

  // Standalone <a className="get-app" href="/apps"> removed from top bar
  assert.doesNotMatch(appJsx, /<a\s+className="get-app"/, "App.jsx does not render .get-app");
  assert.match(chatRefCss, /\.workspace\s+\.get-app\s*\{\s*display:\s*none\s*!important;\s*\}/, "CSS suppresses .get-app");
});

test("complete UI release: Settings canonical sections and search coverage", () => {
  // Canonical sections
  const expectedSlugs = ["general", "appearance", "profile", "personalization", "location", "security", "usage", "billing", "data-controls"];
  for (const slug of expectedSlugs) {
    assert.ok(SETTINGS_SECTIONS.some((s) => s.slug === slug), `SETTINGS_SECTIONS must define canonical slug ${slug}`);
  }

  // Canonical groups: Personal, Security & Access, Billing & Usage
  const canonicalSections = SETTINGS_SECTIONS.filter((s) => !s.legacy);
  const groups = new Set(canonicalSections.map((s) => s.group));
  assert.deepEqual([...groups].sort(), ["Billing & Usage", "Personal", "Security & Access"]);

  // Legacy aliases
  const legacySlugs = ["account", "replies", "personality", "memory", "your-data", "delete-account"];
  for (const slug of legacySlugs) {
    assert.ok(SETTINGS_SECTIONS.some((s) => s.slug === slug && s.legacy), `SETTINGS_SECTIONS must define legacy slug ${slug}`);
  }

  // Routing verification
  for (const slug of [...expectedSlugs, ...legacySlugs]) {
    const route = settingsRoute(settingsPath(slug));
    assert.equal(route.page, "settings");
    assert.equal(route.section, slug);
  }
});

test("complete UI release: Settings sidebar structure with Back button, Search and thin separators", () => {
  const settingsCss = fs.readFileSync(path.resolve("frontend/src/settings.css"), "utf8");
  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");

  // Sidebar back button
  assert.match(settingsCss, /\.settings-back-btn/, "settings.css defines .settings-back-btn");
  assert.match(appJsx, /className="settings-back-btn"/, "App.jsx renders .settings-back-btn");

  // Search input and results
  assert.match(settingsCss, /\.settings-search__input/, "settings.css defines .settings-search__input");
  assert.match(settingsCss, /\.settings-search__results/, "settings.css defines .settings-search__results");
  assert.match(appJsx, /className="settings-search__input"/, "App.jsx renders search input");

  // Mobile section picker
  assert.match(settingsCss, /\.settings-mobile-picker/, "settings.css defines .settings-mobile-picker");
  assert.match(appJsx, /className="settings-mobile-picker"/, "App.jsx renders mobile picker");

  // Row hairline separators
  assert.match(settingsCss, /\.settings-row\s*\+\s*\.settings-row\s*\{\s*border-top:/, "settings.css has thin row separators");
});

test("complete UI release: Pricing and Guarantee policy preservation", () => {
  const guaranteeHtml = fs.readFileSync(path.resolve("frontend/dist/guarantee.html"), "utf8");
  const pricingCss = fs.readFileSync(path.resolve("frontend/src/pricing.css"), "utf8");

  // Guarantee is privacy commitments, not money-back
  assert.match(guaranteeHtml, /VibhavGPT Guarantee/i, "Guarantee title present");
  assert.doesNotMatch(guaranteeHtml, /money[- ]back/i, "Guarantee does not offer money-back");

  // Pricing background is transparent for unified gradient
  assert.match(pricingCss, /\.pricing-page\s*\{[^}]*background:\s*transparent;/, "Pricing page background is transparent");
});

test("complete UI release: Unified projects across Chat and Study with Learning and Work types", () => {
  const library = fs.readFileSync(path.resolve("frontend/src/components/ConversationLibrary.jsx"), "utf8");
  const groupsJs = fs.readFileSync(path.resolve("src/chat/groups.js"), "utf8");
  const migration = fs.readFileSync(path.resolve("drizzle/0042_flatten_folders_into_projects.sql"), "utf8");

  // User-facing terminology: Projects with Learning and Work choices
  assert.match(library, /<span>Projects<\/span>/, "Projects heading present");
  assert.match(library, /<span>New project<\/span>/, "New project button present");
  assert.match(library, /Learning project/, "Learning project option in create modal");
  assert.match(library, /Work project/, "Work project option in create modal");
  assert.match(library, /For studying, explanations, and practice/, "Learning project copy present");
  assert.match(library, /For projects, research, and everyday tasks/, "Work project copy present");

  // Folders UI removed from Library
  assert.doesNotMatch(library, /<span>Folders<\/span>/, "Folders heading removed");
  assert.doesNotMatch(library, /<span>New folder<\/span>/, "New folder button removed");
  assert.doesNotMatch(library, /Folder name/, "Folder name label removed");

  // Client-side flattening and cross-mode compatibility
  assert.match(library, /folderParentMap/, "Client-side folder flattening in library");
  assert.match(groupsJs, /Use a \$\{kind === "project" \? "project" : "folder"\} name/, "Groups validation uses project for project kinds");
  assert.match(groupsJs, /notebookType/, "groups.js returns and normalizes notebookType");

  // Migration flattens folder items into projects without deleting groups
  assert.match(migration, /UPDATE conversations\s+SET group_id = conversation_groups\.parent_id/i, "Folder items flattened into projects");
  assert.match(migration, /UPDATE conversations\s+SET group_id = NULL/i, "Loose folder items flattened to NULL");
});

test("complete UI release: Auth screen simplified, promises and standalone legal footer removed", () => {
  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");
  const signinCss = fs.readFileSync(path.resolve("frontend/src/signin.css"), "utf8");

  // Redundant content below sign-in form removed
  assert.doesNotMatch(appJsx, /How we treat your account/, "How we treat your account heading removed");
  assert.doesNotMatch(appJsx, /<AccountFacts/, "AccountFacts component removed");
  assert.doesNotMatch(appJsx, /<p className="auth__legal">/, "Standalone auth__legal footer removed");
  assert.doesNotMatch(signinCss, /\.auth--signin\s+\.auth__facts/, "auth__facts styles removed from signin.css");
  assert.doesNotMatch(signinCss, /\.auth--signin\s+\.auth__legal/, "auth__legal styles removed from signin.css");

  // Essential elements preserved
  assert.match(appJsx, /className="auth__switchline"/, "auth__switchline preserved");
  assert.match(appJsx, /New to VibhavGPT\?/, "New to VibhavGPT switch preserved");
  assert.match(appJsx, /className="auth__consent"/, "Signup consent wording preserved");
  assert.match(appJsx, /After you create your account, we\u2019ll ask your month and year of birth and for you to accept our/, "Terms/Privacy consent line preserved in signup (reworded for the eligibility screen, #145)");
});

test("priority corrections: Library authenticated preview delivery and document excerpt display", () => {
  const apiJs = fs.readFileSync(path.resolve("frontend/src/api.js"), "utf8");
  const libraryJsx = fs.readFileSync(path.resolve("frontend/src/components/Library.jsx"), "utf8");
  const libraryCss = fs.readFileSync(path.resolve("frontend/src/components/Library.css"), "utf8");

  // 1. isPrivateFileUrl includes library
  assert.match(apiJs, /library/, "api.js recognizes library endpoints as private file URLs");

  // 2. Library uses PrivateImage for authenticated blob loading
  assert.match(libraryJsx, /<PrivateImage\b/, "Library.jsx renders PrivateImage");
  assert.match(libraryJsx, /saveFile/, "Library.jsx uses saveFile for direct download");
  assert.match(libraryJsx, /fetchPrivateFile/, "Library.jsx uses fetchPrivateFile for credentialed blob fetching");

  // 3. Document excerpts and badges
  assert.match(libraryJsx, /docBadge/, "Library.jsx calculates format badges");
  assert.match(libraryJsx, /previewText/, "Library.jsx renders preview text excerpts");
  assert.match(libraryJsx, /No longer stored/, "Missing files show honest unavailable state");

  // 4. CSS defines containment and responsive sizing
  assert.match(libraryCss, /\.lib-page__img/, "Library.css defines .lib-page__img");
  assert.match(libraryCss, /\.lib-page__missing/, "Library.css defines .lib-page__missing");
  assert.match(libraryCss, /\.lib-page__doc-badge/, "Library.css defines .lib-page__doc-badge");
  assert.match(libraryCss, /\.lib-page__excerpt/, "Library.css defines .lib-page__excerpt");
});

test("priority corrections: Location end-to-end helper copy, attribution and responsive fit", () => {
  const locJsx = fs.readFileSync(path.resolve("frontend/src/components/LocationSettings.jsx"), "utf8");
  const locCss = fs.readFileSync(path.resolve("frontend/src/components/SavedAvatars.css"), "utf8");

  // 1. Condensed copy
  assert.match(locJsx, /Helps answers with local weather, time and places/);
  assert.match(locJsx, /never exact coordinates/);
  assert.match(locJsx, /Used once to look up your nearest city, then discarded/);

  // 2. GeoNames CC BY 4.0 attribution
  assert.match(locJsx, /Place data from <a className="link" href="https:\/\/www\.geonames\.org\/"/);
  assert.match(locJsx, /CC BY 4\.0/);

  // 3. Responsive containment at small viewports
  assert.match(locCss, /\.location-settings\s*\{[^}]*max-width:\s*100%/);
  assert.match(locCss, /\.location-settings\s*\{[^}]*overflow-wrap:\s*break-word/);
});

test("priority corrections: Shared geometric heading style and application-wide gradient canvas", () => {
  const vibhavCss = fs.readFileSync(path.resolve("frontend/src/theme/vibhav.css"), "utf8");
  const stylesCss = fs.readFileSync(path.resolve("frontend/src/styles.css"), "utf8");
  const chatRefCss = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");
  const settingsCss = fs.readFileSync(path.resolve("frontend/src/settings.css"), "utf8");

  // 1. Heading typography tokens: Google Sans, 550 weight, -0.015em tracking
  assert.match(vibhavCss, /--font-display:\s*"Google Sans"/, "vibhav.css sets --font-display to Google Sans");
  assert.match(vibhavCss, /--display-weight:\s*550/, "vibhav.css sets --display-weight to 550");
  assert.match(vibhavCss, /--display-tracking:\s*-0\.015em/, "vibhav.css sets --display-tracking to -0.015em");

  // 2. Page title line height and 6px subtitle gap
  assert.match(stylesCss, /\.page__title\s*\{[^}]*line-height:\s*1\.2;/, "styles.css page__title line-height is 1.2");
  assert.match(stylesCss, /\.page__lede\s*\{[^}]*margin-top:\s*6px;/, "styles.css page__lede margin-top is 6px");
  assert.match(settingsCss, /\.settings-section__head\s+p\s*\{[^}]*margin:\s*var\(--space-2xs\)\s+0\s+0;/, "settings.css head p margin is the small spacing token (Slice 6: spacing from the scale)");

  // 3. Application-wide gradient canvas
  assert.match(chatRefCss, /:root:root:root\s+\.workspace\[data-page="chat"\]\s*\{\s*background-color:\s*transparent;\s*\}/, "chat workspace is transparent so gradient shines through");
  assert.match(chatRefCss, /\.workspace\s+\.sidebar\s*\{[^}]*backdrop-filter:\s*blur\(20px\)/, "sidebar is translucent with backdrop-filter blur");
  assert.match(settingsCss, /\.settings-group__panel\s*\{[^}]*backdrop-filter:\s*blur\(12px\)/, "settings panels are translucent with backdrop-filter blur");
});
