import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FIXES_ROOT = path.resolve(".");

test("Track 1: Public navigation is compact on desktop and menu sheet is strictly hidden", () => {
  const publicPagesCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/public-pages.css"), "utf8");
  const homeHtml = fs.readFileSync(path.join(FIXES_ROOT, "frontend/public/home/index.html"), "utf8");
  const publicNavJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/PublicNav.jsx"), "utf8");

  // 1. Desktop hides public sheet, div.sheet, #site-sheet, and menu-toggle with !important
  assert.match(
    publicPagesCss,
    /@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?\.public-sheet[\s\S]*?display:\s*none\s*!important/i,
    "Desktop media query strictly hides .public-sheet with !important"
  );
  assert.match(
    publicPagesCss,
    /@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?#site-sheet[\s\S]*?display:\s*none\s*!important/i,
    "Desktop media query strictly hides #site-sheet with !important"
  );
  assert.match(
    publicPagesCss,
    /@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?\.menu-toggle[\s\S]*?display:\s*none\s*!important/i,
    "Desktop media query hides .menu-toggle with !important"
  );

  // 2. Hidden attribute has !important display: none
  assert.match(
    publicPagesCss,
    /\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important/i,
    "[hidden] rule uses display: none !important to prevent class specificity override"
  );

  // 3. Home HTML initializes site-sheet with hidden attribute
  assert.match(homeHtml, /<div class="sheet[^"]*"\s+id="site-sheet"[^>]*hidden/, "site-sheet has hidden attribute in home/index.html");

  // 4. Resize listener to close sheet when resizing to desktop (>= 768px)
  assert.match(homeHtml, /window\.innerWidth\s*>=\s*768/, "home/index.html has resize listener closing sheet at 768px");
  assert.match(publicNavJsx, /window\.innerWidth\s*>=\s*768/, "PublicNav.jsx has resize listener closing sheet at 768px");

  // 5. Escape and outside click listeners in PublicNav.jsx
  assert.match(publicNavJsx, /e\.key\s*===\s*["']Escape["']/, "PublicNav handles Escape keydown");
  assert.match(publicNavJsx, /aria-controls=["']site-sheet["']/, "Menu toggle has aria-controls='site-sheet'");
});

test("Track 2: Chat controls consolidated in composer only (no floating duplicate header)", () => {
  const appJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/App.jsx"), "utf8");

  // 1. No floating top selector container or ChatHeader in chat DOM
  assert.doesNotMatch(appJsx, /<div className=\"chat-top-selector-container\">/, "No floating chat-top-selector-container");
  assert.doesNotMatch(appJsx, /<ChatHeader\b/, "No ChatHeader rendered above greeting in App.jsx");

  // 2. Exactly one model selector in the composer: the trigger that opens the centered model picker (2026-11-14), not a dropdown.
  assert.equal((appJsx.match(/<ModelTrigger /g) || []).length, 1, "Exactly one model trigger in App.jsx");
  assert.doesNotMatch(appJsx, /className=\"composer__model\"/, "the old dropdown selector is gone");

  // 3. Exactly one effort selector in composer, gated by effortApplies
  const effortSelectMatches = appJsx.match(/className=\"composer__effort\"/g) || [];
  assert.equal(effortSelectMatches.length, 1, "Exactly one composer__effort selector in App.jsx");
  assert.match(appJsx, /\{effortApplies && \(\s*<Select[^>]*className=\"composer__effort\"/, "composer__effort is gated by effortApplies");
});

test("Track 3: no cyan/blue cloud background; the light sky is plain white and the dark ground stays warm charcoal", () => {
  const cosmosCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/cosmos.css"), "utf8");
  const vibhavCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/theme/vibhav.css"), "utf8");

  // 1. cosmos.css no longer uses sky-blue for its sky gradients
  assert.doesNotMatch(
    cosmosCss,
    /color-mix\(in srgb, var\(--color-sky-blue\) 20%, transparent\)/,
    "cosmos.css does not use var(--color-sky-blue) 20% cloud gradient"
  );

  // 2. The light sky is plain white (owner decision, 2026-11-14): no peach, amber or rose undertones.
  for (const warm of ["#fdede2", "#fbf2e3", "#f8e8ea", "#fbf9f5"]) {
    assert.doesNotMatch(cosmosCss, new RegExp(warm), `cosmos.css has no ${warm}`);
    assert.doesNotMatch(vibhavCss, new RegExp(warm), `vibhav.css has no ${warm}`);
  }

  // 3. The dark page-wash keeps its deep charcoal base.
  assert.match(vibhavCss, /#0d0d10/, "vibhav.css dark mode page-wash includes deep charcoal base");
});

test("Track 4 & 5: Skills import UI labels and copy", () => {
  const extJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/extensions/Extensions.jsx"), "utf8");

  // 1. User-facing labels
  assert.match(extJsx, /<span>New skill<\/span>/, "New skill button label");
  assert.match(extJsx, /<span>Import skill<\/span>/, "Import skill button label");
  assert.match(extJsx, /<span className="field-label">Name \*<\/span>/, "Clean 'Name *' field label");
  assert.match(extJsx, /<span className="field-label">Description<\/span>/, "Clean 'Description' field label");
  assert.match(extJsx, /<span className="field-label">Instructions \*<\/span>/, "Clean 'Instructions *' field label");

  // 2. Clear copy without jargon
  assert.match(
    extJsx,
    /Skills are reusable instructions\. Connected actions still require your approval\./,
    "Clear approval copy present"
  );
  assert.doesNotMatch(extJsx, /New Declarative Skill/, "Purged 'New Declarative Skill' jargon");
  assert.doesNotMatch(extJsx, /consequential external mutations/, "Purged 'consequential external mutations' jargon");

  // 3. Dropzone and file input supports .md and .zip
  assert.match(extJsx, /accept=["']\.md,\.zip,\.markdown["']/, "File input accepts .md and .zip");
  assert.match(extJsx, /className=\{`skill-dropzone/, "Dropzone element present");
  assert.match(extJsx, /Confirm import/, "Confirm import button present in preview stage");
});

