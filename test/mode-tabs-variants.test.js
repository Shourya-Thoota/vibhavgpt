import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");
const mobileCss = fs.readFileSync(path.resolve("frontend/src/mobile.css"), "utf8");
const chatRefCss = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");
const tokensCss = () => fs.readFileSync(path.resolve("frontend/src/theme/vibhav.css"), "utf8");

test("mode tabs variants: App.jsx distinguishes notch and study variants", () => {
  // buildTabs declaration must support explicit variant
  assert.match(appJsx, /const\s+buildTabs\s*=\s*\([^)]*variant\s*=\s*"notch"[^)]*\)/, "buildTabs has variant parameter defaulting to notch");
  assert.match(appJsx, /className=\{\s*`mode-tabs mode-tabs--\$\{variant\}`\s*\}/, "buildTabs emits mode-tabs--${variant}");
  assert.match(appJsx, /className=\{\s*`mode-tabs__tab mode-tabs__tab--\$\{variant\}`\s*\}/, "buildTabs emits mode-tabs__tab--${variant}");

  // modeTabs (Chat | Image) must be instantiated with "notch"
  assert.match(
    appJsx,
    /const\s+modeTabs\s*=\s*buildTabs\(\s*\["chat",\s*"image"\][^\n]+,\s*"notch"\s*\)/,
    "Chat | Image passes 'notch' variant",
  );

  // studyTabs (Chat | Study) must be instantiated with "study"
  assert.match(
    appJsx,
    /const\s+studyTabs\s*=\s*buildTabs\(\s*\["chat",\s*"study"\][^\n]+,\s*"study"\s*\)/,
    "Chat | Study passes 'study' variant",
  );
});

test("mode tabs variants: Chat | Image restores original notch styling", () => {
  // Mobile CSS: Segmented grid container, sliding thumb, and restrained dimensions
  assert.match(mobileCss, /\.mode-tabs--notch\s*\{[^}]*display:\s*grid/s, "mobile.css notch has grid display");
  assert.match(mobileCss, /\.mode-tabs--notch\s*\{[^}]*width:\s*min\(100%,\s*180px\)/s, "mobile.css notch has constrained width");
  assert.match(mobileCss, /\.mode-tabs--notch\s*\{[^}]*border-radius:\s*var\(--r-pill[^}]*\)/s, "mobile.css notch has pill border-radius");
  assert.match(mobileCss, /\.mode-tabs--notch::before\s*\{[^}]*transform:\s*translateX\(calc\(100%\s*\*\s*var\(--tab-index\)\)\)/s, "mobile.css notch has translateX sliding thumb");
  assert.match(mobileCss, /\.mode-tabs--notch\s+\.mode-tabs__tab\s*\{[^}]*height:\s*32px/s, "mobile.css notch tab height 32px");
  assert.match(mobileCss, /\.mode-tabs--notch\s+\.mode-tabs__tab\s*\{[^}]*font-weight:\s*600/s, "mobile.css notch tab font-weight 600");

  // Chat-reference CSS: Desktop workspace header notch
  assert.match(chatRefCss, /\.workspace\s+\.mode-tabs--notch\s*\{[^}]*display:\s*grid/s, "chat-reference.css workspace notch has grid display");
  assert.match(chatRefCss, /\.workspace\s+\.mode-tabs--notch\s*\{[^}]*width:\s*min\(100%,\s*180px\)/s, "chat-reference.css workspace notch has constrained width");
  assert.match(chatRefCss, /\.workspace\s+\.mode-tabs--notch::before\s*\{[^}]*transform:\s*translateX\(calc\(100%\s*\*\s*var\(--tab-index\)\)\)/s, "chat-reference.css workspace notch has translateX sliding thumb");
});

test("mode tabs variants: Chat | Study is a white segmented control with a sliding selected thumb", () => {
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*--seg-surface:\s*#fff/s, "light study surface is true white");
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*background:\s*var\(--seg-surface\)/s, "container paints the segment surface");
  assert.match(mobileCss, /\.mode-tabs--study\s*\{[^}]*padding:\s*var\(--seg-pad\)/s, "container pads its segments evenly");
  assert.match(mobileCss, /\.mode-tabs--study::before\s*\{[^}]*transform:\s*translateX\(calc\(var\(--tab-index/s, "selected thumb slides, so switching never reflows");
  assert.match(mobileCss, /\.mode-tabs--study\s+\.mode-tabs__tab\s*\{[^}]*min-height:\s*44px/s, "each segment is a 44px touch target");
  assert.match(mobileCss, /\.mode-tabs--study\s+\.mode-tabs__tab\[aria-selected="true"\]\s*\{[^}]*font-weight:\s*650/s, "selection is also carried by weight, not colour alone");
  assert.match(mobileCss, /prefers-reduced-motion:\s*reduce\)\s*\{\s*\.mode-tabs--study::before\s*\{\s*transition:\s*none/s, "thumb motion respects reduced motion");
  assert.doesNotMatch(chatRefCss, /\.workspace\s+\.start-below\s+\.mode-tabs[^{]*\{[^}]*background:\s*transparent/s, "below-composer rules never revert it to transparent text");
  assert.match(chatRefCss, /\.workspace\s+\.start-below__tabs\s*\{[^}]*min-height:\s*50px/s, "reserved height keeps the page from jumping");
});

test("mode tabs variants: Chat | Image keeps its original pre-6.1 pill, and Chat | Study wears the same treatment in both skies", () => {
  // Restored after Slice 6.1: the notch is the workspace's original (a --ref-row track, a --ref-seg thumb by day, --ref-composer by night,
  // with their own shadows), and Chat | Study takes those same values. The 6.1 ink-tint tokens are gone.
  assert.doesNotMatch(tokensCss(), /--pill-(track|thumb|edge)/, "the 6.1 pill tokens are removed");
  for (const css of [mobileCss, chatRefCss]) assert.doesNotMatch(css, /--pill-/);
  assert.match(chatRefCss, /\.workspace \.mode-tabs--notch \{[^}]*border-radius: 20px;\s*background: var\(--ref-row\);\s*box-shadow: inset 0 1px 2px rgb\(0 0 0 \/ 0\.05\), 0 1px 2px rgb\(0 0 0 \/ 0\.03\);/s);
  assert.match(chatRefCss, /\.workspace \.mode-tabs--notch::before \{[^}]*border-radius: 17px;\s*background: var\(--ref-seg\);\s*box-shadow: 0 1px 3px rgb\(0 0 0 \/ 0\.12\), 0 0 0 1px rgb\(0 0 0 \/ 0\.04\);/s);
  assert.match(chatRefCss, /:root:not\(\[data-theme="light"\]\) \.workspace \.mode-tabs--notch::before \{\s*background: var\(--ref-composer\);/);
  // Chat | Study: the same four values, by day and by night.
  assert.match(chatRefCss, /\.workspace \.mode-tabs--study \{\s*--seg-surface: var\(--ref-row\);\s*--seg-line: transparent;\s*--seg-shadow: inset 0 1px 2px rgb\(0 0 0 \/ 0\.05\), 0 1px 2px rgb\(0 0 0 \/ 0\.03\);\s*--seg-thumb: var\(--ref-seg\);\s*--seg-thumb-shadow: 0 1px 3px rgb\(0 0 0 \/ 0\.12\), 0 0 0 1px rgb\(0 0 0 \/ 0\.04\);/);
  assert.match(chatRefCss, /:root:not\(\[data-theme="light"\]\) \.workspace \.mode-tabs--study \{[^}]*--seg-thumb: var\(--ref-composer\);/s);
  assert.match(mobileCss, /\.mode-tabs--study::before \{[^}]*box-shadow: var\(--seg-thumb-shadow\);/s, "the study thumb takes the notch's raised shadow");
  for (const css of [mobileCss, chatRefCss]) assert.doesNotMatch(css, /--seg-surface:\s*(#fff|white|var\(--color-paper)/i, "never a paper or white block");
});

test("mode tabs variants: Accessibility, keyboard focus, and layout hierarchy", () => {
  // Focus visible styling exists for both variants
  assert.match(mobileCss, /\.mode-tabs--notch\s+\.mode-tabs__tab:focus-visible/s, "notch tab has focus-visible");
  assert.match(mobileCss, /\.mode-tabs--study\s+\.mode-tabs__tab:focus-visible/s, "study tab has focus-visible");

  // Layout hierarchy in App.jsx: WorkspaceNotice mounted before mode-tabs-bar
  const workspaceNoticeIndex = appJsx.indexOf("<WorkspaceNotice");
  const modeTabsBarIndex = appJsx.indexOf('className="mode-tabs-bar"');
  assert.ok(workspaceNoticeIndex > 0, "WorkspaceNotice is mounted in workspace");
  assert.ok(modeTabsBarIndex > 0, "mode-tabs-bar is mounted in workspace");
  assert.ok(
    workspaceNoticeIndex < modeTabsBarIndex,
    "WorkspaceNotice is mounted before mode-tabs-bar in JSX flow, preventing collision",
  );
});
