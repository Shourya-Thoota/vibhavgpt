import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FIXES_ROOT = path.resolve("C:/Users/vibha/dev/VibhavGPT-fixes-clone");

test("Chat header: Component structure, thinking control gating and clean composer", () => {
  const headerJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/chat/ChatHeader.jsx"), "utf8");
  const appJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/App.jsx"), "utf8");

  // 1. Thinking controls are restricted to reasoning-capable models only
  assert.match(headerJsx, /\[\"nova\", \"nebula\", \"vesper\", \"auto\"\]\.includes\(normalizedModelId\)/, "Thinking supported only for nova, nebula, vesper, and auto");
  assert.match(headerJsx, /supportsReasoning:\s*false/, "Lumen explicitly does NOT support reasoning controls");
  assert.match(headerJsx, /\{supportsThinking && \(/, "Thinking pill is conditionally rendered ONLY when model supports thinking");

  // 2. Chat header: Single unified model and effort selection in composer; no floating top header
  assert.doesNotMatch(appJsx, /<div className=\"chat-top-selector-container\">/, "Floating top selector container removed from chat top");
  assert.match(appJsx, /className=\"composer__model\"/, "Composer has single model selector");
  assert.match(appJsx, /className=\"composer__effort\"/, "Composer has single reasoning effort selector");

  // 3. No competing 'Personal Workspace' switcher
  assert.doesNotMatch(headerJsx, /Personal Workspace/, "No synthetic Personal Workspace switcher in ChatHeader");
  assert.match(headerJsx, /project && \(/, "Uses natural project context from group");

  // 4. Upgrade badge wording on locked models
  assert.match(headerJsx, /Upgrade/, "Locked models say Upgrade, not Plus");

  // 5. Extensions destination connected
  assert.match(headerJsx, /onOpenExtensions/, "Provides direct shortcut to Extensions");
});

test("Chat header & Extensions: Gradient continuity, zero opaque bands, and font loading", () => {
  const catalogCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/catalog/catalog.css"), "utf8");
  const headerCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/chat/chat-header.css"), "utf8");
  const fontsCss = fs.readFileSync(path.join(FIXES_ROOT, "frontend/public/fonts/v1/fonts.css"), "utf8");

  // 1. Chat top container has transparent background and no backdrop blur band
  const topSelectorRule = catalogCss.match(/\.chat-top-selector-container\s*\{[^}]*\}/)?.[0] || "";
  assert.match(topSelectorRule, /background:\s*transparent\s*!important/, "Top container background is transparent");
  assert.match(topSelectorRule, /backdrop-filter:\s*none\s*!important/, "Backdrop blur band is eliminated");

  // 2. ChatHeader CSS preserves gradient
  const headerRule = headerCss.match(/\.chat-header\s*\{[^}]*\}/)?.[0] || "";
  assert.match(headerRule, /background:\s*transparent\s*!important/, "ChatHeader background is transparent");
  assert.match(headerRule, /border:\s*none\s*!important/, "No borders cutting across canvas");

  // 3. Real font loading for Google Sans
  assert.match(fontsCss, /font-family:\s*['"]Google Sans['"]/, "Google Sans @font-face is declared in fonts.css");
  assert.match(fontsCss, /url\(['"](?:\.\.\/|\/fonts\/)GoogleSans-latin\.woff2['"]\)/, "GoogleSans-latin.woff2 is referenced");
  assert.match(fontsCss, /url\(['"](?:\.\.\/|\/fonts\/)GoogleSans-latin-ext\.woff2['"]\)/, "GoogleSans-latin-ext.woff2 is referenced");

  // Verify actual font files exist on disk
  assert.ok(fs.existsSync(path.join(FIXES_ROOT, "frontend/public/fonts/GoogleSans-latin.woff2")), "GoogleSans-latin.woff2 exists");
  assert.ok(fs.existsSync(path.join(FIXES_ROOT, "frontend/public/fonts/GoogleSans-latin-ext.woff2")), "GoogleSans-latin-ext.woff2 exists");
});

test("Extensions Hub: 3-tab destination and sidebar navigation integration", () => {
  const sidebarJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/Sidebar.jsx"), "utf8");
  const extJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/components/extensions/Extensions.jsx"), "utf8");
  const appJsx = fs.readFileSync(path.join(FIXES_ROOT, "frontend/src/App.jsx"), "utf8");

  // 1. Sidebar includes Extensions link
  assert.match(sidebarJsx, /\{ id: "extensions", label: "Extensions", icon: <Blocks/, "Sidebar CHAT_LINKS includes Extensions");

  // 2. Extensions component has unified plugins and skills tabs
  assert.match(extJsx, /activeTab === "plugins"/, "Plugins tab present");
  assert.match(extJsx, /activeTab === "skills"/, "Skills tab present");

  // 3. App.jsx routes to Extensions page
  assert.match(appJsx, /page === "extensions"/, "App.jsx handles page === 'extensions'");
  assert.match(appJsx, /<Extensions/, "Renders Extensions component");
});
