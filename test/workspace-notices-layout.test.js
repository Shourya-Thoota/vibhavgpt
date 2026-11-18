import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Workspace notice component and CSS exist and define restrained accessible design", () => {
  const componentPath = path.resolve("frontend/src/components/notice/WorkspaceNotice.jsx");
  const cssPath = path.resolve("frontend/src/components/notice/workspace-notice.css");

  assert.ok(fs.existsSync(componentPath), "WorkspaceNotice.jsx exists");
  assert.ok(fs.existsSync(cssPath), "workspace-notice.css exists");

  const component = fs.readFileSync(componentPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");

  // Verified notice anatomy: title, explanation, CTA, dismiss
  assert.match(component, /workspace-notice__title/, "Contains title element");
  assert.match(component, /workspace-notice__explanation/, "Contains explanation element");
  assert.match(component, /workspace-notice__cta/, "Contains primary CTA element");
  assert.match(component, /workspace-notice__dismiss/, "Contains separated dismiss element");

  // Restrained accent-tinted surfaces and modest borders
  // Slice 6: the notice is the shared Banner. Its look lives in ui/banner.css: tokens only, a tinted surface, the control radius, no
  // edge stripe, and it stacks on phones. workspace-notice.css only places it.
  const banner = fs.readFileSync(path.resolve("frontend/src/components/ui/banner.css"), "utf8");
  assert.match(component, /<Banner/, "renders through the shared Banner");
  assert.match(banner, /border-radius: var\(--radius-input\)/, "the control radius, from a token");
  assert.match(banner, /--banner-fill: var\(--color-warn-soft\)/, "a restrained tinted surface per tone");
  assert.match(banner, /@media \(max-width: 580px\)/, "Responsive stacking on mobile viewports");
  assert.doesNotMatch(banner.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,8}\b|rgba?\(|border-left:/i, "no raw colour, no edge stripe");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "the placement sheet has no raw colour");
});

test("Layout ownership: mode-tabs-bar does not absolute-position over workspace notices", () => {
  const chatRefCss = fs.readFileSync(path.resolve("frontend/src/chat-reference.css"), "utf8");

  // Ensure absolute top:0 positioning is removed from empty chat mode-tabs-bar
  assert.doesNotMatch(
    chatRefCss,
    /\.workspace__main:has\(\.chat__scroll\[data-empty\]\)\s*>\s*\.mode-tabs-bar\s*\{\s*position:\s*absolute;\s*top:\s*0/i,
    "mode-tabs-bar is not absolutely positioned over the top of empty chat workspace"
  );

  // Instead, mode-tabs-bar stays in normal flow in its own dedicated row
  assert.match(
    chatRefCss,
    /\.workspace__main\s*>\s*\.mode-tabs-bar\s*\{[^}]*position:\s*relative;/i,
    "mode-tabs-bar maintains dedicated document-flow position"
  );
});

test("Notice logic: Tier-aware upgrade suppression for Pro users and verified reset display", () => {
  const component = fs.readFileSync(path.resolve("frontend/src/components/notice/WorkspaceNotice.jsx"), "utf8");

  // Pro tier users must NOT be shown misleading 'See plans'
  assert.match(component, /isProUser/, "Component detects Pro tier user");
  assert.match(component, /primaryLabel = "View usage"/, "Pro users see View usage instead of upgrade CTA");

  // Verified reset date/time without fake countdowns
  assert.match(component, /formattedReset/, "Formats verified reset time when available");
  assert.match(component, /rolling/, "Differentiates rolling-window throttles from monthly caps");
});

test("App integration: WorkspaceNotice mounted in workspace with deduplication and mode-switch clearing", () => {
  const appJsx = fs.readFileSync(path.resolve("frontend/src/App.jsx"), "utf8");

  // WorkspaceNotice mounted above mode-tabs-bar in workspace__main
  assert.match(appJsx, /<WorkspaceNotice[\s\S]*?<div className="mode-tabs-bar">/i, "WorkspaceNotice mounted above mode-tabs-bar");

  // Mode switching clears stale capability notices
  assert.match(appJsx, /productMode === "image"[\s\S]*?productMode === "chat"/, "Mode switching clears stale capability notices");

  // Event listener deduplicates identical alerts
  assert.match(appJsx, /current\.reason === detail\.reason && current\.feature === detail\.feature/, "Deduplicates repeated notices");
});
