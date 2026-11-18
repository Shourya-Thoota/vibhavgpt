import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { STATUS_FILTERS, availableStatusFilters, groupConnectors, connectorNeedsPermissions } from "../frontend/src/components/extensions/connector-directory.js";
import { COMPARISON_GROUPS } from "../frontend/src/plan-comparison.js";
import { PRODUCT_KNOWLEDGE } from "../frontend/src/product-knowledge.js";
import { defaultConnectors } from "./support/extensions-fixture.js";

// The Extensions page after its redesign (connector directory and skills), the removed + menu memory switch, and the memory wording.
// This file reads source, styles and data; the behaviour in a browser is in browser-extensions-directory.test.js.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const JSX = "frontend/src/components/extensions/Extensions.jsx";
const CSS = "frontend/src/components/extensions/extensions-directory.css";
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stripJsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const published = () => defaultConnectors().filter((c) => c.catalogVisible !== false);

// ---- Grouping and the filter ----------------------------------------------------------------------------

test("the list is Connected first, then plain category headings, and a connected connector is listed once", () => {
  const groups = groupConnectors(published());
  assert.equal(groups[0].title, "Connected");
  assert.deepEqual(groups[0].items.map((c) => c.id), ["gmail", "googledrive", "weather", "web_search"]);
  assert.deepEqual(groups.slice(1).map((g) => g.title), ["Productivity", "Communication", "Developer", "Project management", "Data", "Design", "Scheduling", "Media"], "the directory's own category order");
  const ids = groups.flatMap((g) => g.items.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length, "no connector appears twice");
  assert.equal(ids.length, published().length, "and none is lost");
  for (const group of groups.slice(1)) assert.ok(group.items.every((c) => c.status !== "connected"), `${group.title} holds only connectors that are not connected`);
  assert.equal(new Set(groups.map((g) => g.id)).size, groups.length, "each group has its own id, for its heading");
});

test("there is no Connected group when nothing is connected, and a connector without a category is listed under Other", () => {
  const none = published().map((c) => ({ ...c, status: "disconnected", enabled: false }));
  assert.equal(groupConnectors(none).some((g) => g.title === "Connected"), false);
  const loose = [{ id: "x", name: "X", status: "disconnected" }, { id: "y", name: "Y", category: "Data", status: "disconnected" }];
  assert.deepEqual(groupConnectors(loose).map((g) => g.title), ["Other", "Data"]);
  assert.deepEqual(groupConnectors([]), []);
});

test("a filter is offered only when it would show something, so there is no empty 'Needs permissions'", () => {
  const all = published();
  assert.deepEqual(availableStatusFilters(all).map((o) => o.id), ["all", "connected", "not_connected", "needs_permissions"], "Gmail needs permissions, so all four are offered");
  assert.ok(connectorNeedsPermissions(all.find((c) => c.id === "gmail")));

  const fine = all.map((c) => ({ ...c, missingApps: [], unavailableFeatures: [] }));
  assert.deepEqual(availableStatusFilters(fine).map((o) => o.id), ["all", "connected", "not_connected"], "nothing needs permissions: that option is not there");

  const allConnected = fine.map((c) => (c.id === "slack" ? { ...c, status: "connected" } : { ...c, status: "connected" }));
  assert.deepEqual(availableStatusFilters(allConnected).map((o) => o.id), ["all", "connected"], "nothing is unconnected: Not connected is not there");

  assert.deepEqual(availableStatusFilters(all, { query: "weather" }).map((o) => o.id), ["all", "connected"], "a search narrows the options to what is left");
  assert.deepEqual(availableStatusFilters(all, { query: "github" }).map((o) => o.id), ["all", "not_connected"]);
  assert.deepEqual(availableStatusFilters(all, { query: "zzz" }).map((o) => o.id), ["all"], "nothing matches: only All");
  // The chosen filter is always listed, so the control never shows a value that is not in it.
  assert.ok(availableStatusFilters(all, { query: "zzz", selected: "needs_permissions" }).some((o) => o.id === "needs_permissions"));
  // The filters themselves are unchanged.
  assert.deepEqual(STATUS_FILTERS.map((o) => o.id), ["all", "connected", "not_connected", "needs_permissions"]);
});

// ---- The page's source ----------------------------------------------------------------------------------

test("no row is tagged 'Not connected', and nothing counts the directory on screen", () => {
  const jsx = stripJsComments(read(JSX));
  assert.doesNotMatch(jsx, /Not connected/, "that word is only the filter's own label, in connector-directory.js");
  assert.doesNotMatch(jsx, /extensions-tabs__badge|extensions-filter-count|category-pill|extensions-category-pills|extensions-result-count/, "no count badge, no pill row");
  // The only use of the count is the spoken status line.
  assert.equal((jsx.match(/resultCountLabel/g) ?? []).length, 2, "defined once, used once");
  assert.match(jsx, /<p className="sr-only" role="status" aria-live="polite">\{resultCountLabel\}<\/p>/);
  assert.doesNotMatch(jsx, /\{(?:visibleConnectors|connectors|skills)\.length\}/, "no length is printed in a tab, chip or heading");
  assert.doesNotMatch(jsx, /connectors-empty|empty-skills-panel|border: 1px dashed|dashed/);
});

test("a mark appears only when it says something, always with a word", () => {
  const jsx = stripJsComments(read(JSX));
  const marks = [...jsx.matchAll(/<span className="ext-mark[^"]*">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, "").trim());
  // A row under the "Connected" heading no longer repeats a visible "Connected" badge (the heading says it); each row's state is still given in
  // words, to a screen reader, and every problem state keeps a visible word.
  assert.ok(marks.includes("Needs permissions") && marks.includes("Needs reconnecting") && marks.includes("Setup required") && marks.includes("Waiting for authorization") && marks.includes("Disabled"));
  assert.ok(!marks.includes("Connected"), "no per-row Connected badge repeating the group heading");
  for (const mark of marks) assert.ok(/[A-Za-z]{4,}/.test(mark), `"${mark}" is a word, not a colour or an icon alone`);
  assert.match(jsx, /\{isConnected && <span className="sr-only">Connected<\/span>\}/, "each connected row's state is still announced");
  assert.match(jsx, /<h2 className="ext-group__title"/, "and the visible group heading carries it");
  // Each mark is conditional on a state; there is no unconditional status span in a row.
  assert.match(jsx, /\{needsReconnect && \(\s*<span className="ext-mark ext-mark--warn">/);
  assert.match(jsx, /\{needsPermissions && \(\s*<span className="ext-mark ext-mark--warn">/);
  assert.match(jsx, /\{!enabled && <span className="ext-mark">Disabled<\/span>\}/, "a skill is marked only when it is off");
});

test("every row's buttons are named for their service, and the behaviour behind them is unchanged", () => {
  const jsx = stripJsComments(read(JSX));
  for (const name of ["Manage ${displayName}", "Disconnect ${displayName}", "Enable or disable ${displayName}", "${displayName} requires owner setup"]) {
    assert.ok(jsx.includes("`" + name + "`"), `aria-label ${name}`);
  }
  // The connect button is named for its service, and says "Reconnect" for a connection the provider has lost.
  assert.ok(jsx.includes("`${needsReconnect ? \"Reconnect\" : \"Connect\"} ${displayName}`"), "aria-label Connect/Reconnect ${displayName}");
  // The same requests, in the same order, with the same confirmation.
  assert.ok(jsx.includes("/initiate`"));
  assert.ok(jsx.includes("/disconnect`"));
  assert.match(jsx, /method: "PATCH",\s*body: JSON\.stringify\(\{ enabled: nextState \}\)/);
  assert.match(jsx, /window\.confirm\(`Disconnect \$\{displayName\}\? Tools from this service will stop being available to your assistant\.`\)/);
  assert.match(jsx, /openConnectorAuthorization\(/);
  // Enable, disable and disconnect live in a Manage panel under the row, opened by a disclosure.
  assert.match(jsx, /aria-expanded=\{manageOpen\}[\s\S]*?aria-controls=\{panelId\}/);
  assert.match(jsx, /\{isConnected && manageOpen && \(\s*<div className="ext-row__manage" id=\{panelId\}>/);
  assert.match(jsx, /role="switch"/);
  assert.match(jsx, /\{!isSystem && \(/, "the built-in services still cannot be disconnected");
});

test("the Skills tab has one set of Import and Create skill actions, in every state, and no invented templates", () => {
  const jsx = stripJsComments(read(JSX));
  assert.equal((jsx.match(/aria-label="Import skill"/g) ?? []).length, 1, "one Import");
  assert.equal((jsx.match(/aria-label="Create skill"/g) ?? []).length, 1, "one Create skill");
  assert.equal((jsx.match(/onClick=\{openNewSkillModal\}/g) ?? []).length, 1);
  assert.doesNotMatch(jsx, /extensions-actions-row/, "the second set, in the empty box, is gone");
  assert.doesNotMatch(jsx, /skills\.length\}<\/span>|extensions-tabs__badge/, "no count chip on the tab");
  const skills = jsx.slice(jsx.indexOf('id="ext-panel-skills"'));
  assert.doesNotMatch(skills.slice(0, skills.indexOf("SKILL CREATION") > 0 ? skills.indexOf("SKILL CREATION") : undefined), /template|starter|example/i, "no template or starter is offered: none exists in the product");
});

test("the empty Skills state says what a skill is and what happens in chat, and each sentence is true of the code", () => {
  const jsx = read(JSX);
  const empty = jsx.match(/<div className="ext-empty">([\s\S]*?)<\/div>/)[1];
  const sentences = [...empty.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/&rsquo;/g, "’").trim());
  assert.deepEqual(sentences, [
    "A skill is a set of instructions you save once, such as how you want a weekly update written.",
    "In chat, type / and pick a skill. Its instructions are added to the assistant’s guidance for that reply.",
    "If you pick none, every enabled skill applies. Disable a skill to stop that.",
  ], "two or three plain sentences");
  // 1. A skill is saved instructions (plain prompt text, no code).
  const service = read("src/skills/service.js");
  assert.match(service, /Skill instructions are required\./);
  assert.match(service, /declarative prompt instructions only/);
  // 2. In chat the picked skill's instructions go into the assistant's guidance for that reply.
  const chat = read("src/chat/router.js");
  assert.match(chat, /<CustomSkills>\\nThe user has enabled the following custom skills\. Follow their instructions when responding:/);
  assert.match(chat, /### Skill: \$\{s\.name\}\\n\$\{s\.instructions\}/);
  // 3. The picker is the slash in the message box.
  assert.match(read("frontend/src/composer-mentions.js"), /detectSkillSlash/);
  assert.match(read("frontend/src/components/composer/ComposerMentions.jsx"), /detectMentionTrigger/);
  // 4. With none picked, every enabled skill applies; a disabled one never does.
  assert.match(chat, /requestedSelectedSkillIds\.length\s*\?\s*userSkillsList\.filter\(\(s\) => requestedSelectedSkillIds\.includes\(s\.id\) && s\.enabled\)\s*:\s*userSkillsList\.filter\(\(s\) => s\.enabled\)/);
  assert.doesNotMatch(sentences.join(" "), /\b(?:leverage|seamless|robust|powerful|unlock|supercharge|effortless|cutting-edge|revolutionary|elevate)\b/i);
});

test("the page keeps its stable hooks and the shared styles the Settings connectors page still uses", () => {
  const jsx = read(JSX);
  for (const hook of ['className="page page--wide extensions-page"', "extensions-back", 'role="tablist"', "extensions-tabs__tab", "skills-library", 'activeTab === "plugins"', 'activeTab === "skills"']) assert.ok(jsx.includes(hook), hook);
  const shared = read("frontend/src/components/extensions/extensions.css");
  for (const rule of [".connector-row", ".connector-toggle", ".status-badge", ".connectors-list", ".skill-dialog", ".skill-dropzone", ".service-logo"]) assert.ok(shared.includes(rule), `${rule} is still there for the pages and dialogs that use it`);
  for (const gone of [".category-pill", ".extension-card", ".extensions-filter-btn", ".empty-skills-panel", ".skill-row {"]) assert.equal(shared.includes(gone), false, `${gone} is gone`);
  const settings = read("frontend/src/components/ConnectorsSettings.jsx");
  assert.match(settings, /className="connector-row"|className=\{`connector-row/, "Settings > Connectors still renders its own rows");
});

// ---- The stylesheet ------------------------------------------------------------------------------------

test("the stylesheet uses theme tokens only: every var() exists, and no raw colour, length, shadow or stripe is written", () => {
  const css = stripCssComments(read(CSS));
  const theme = read("frontend/src/theme/vibhav.css");
  const defined = new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
  for (const token of used) assert.ok(defined.has(token), `${token} is defined in the theme`);
  for (const token of ["--hit-min", "--gap-hit", "--ring-width", "--ring-offset", "--logo-md", "--page-narrow", "--switch-width", "--switch-height", "--switch-knob", "--switch-inset", "--switch-travel", "--veil-hover", "--veil-press", "--veil-fill", "--dur-spin", "--color-warn"]) {
    assert.ok(defined.has(token), `${token} was added to the theme before the stylesheet used it`);
  }
  const body = css.replace(/@media[^{]*\{/g, "{"); // a breakpoint is a media query, which cannot read a token
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "no raw colour");
  assert.doesNotMatch(body, /(?<![\w-])-?\d*\.?\d+(?:px|rem|em|ms|s)\b/, "no raw length or duration: each is a token");
  assert.doesNotMatch(css, /box-shadow|text-shadow|drop-shadow/, "no shadows");
  assert.doesNotMatch(css, /border-(?:left|inline-start)\s*:/, "no stripe on a row");
  assert.doesNotMatch(css, /dashed|dotted/, "no dashed box");
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /transition\s*:\s*all\b|transition-property\s*:\s*all\b/, "no transition: all");
});

test("only transform and opacity animate, and nothing moves under reduced motion", () => {
  const css = stripCssComments(read(CSS));
  const props = [...css.matchAll(/transition\s*:\s*([^;]+);/g)].flatMap((m) => m[1].split(",").map((part) => part.trim().split(/\s+/)[0])).filter((p) => p && p !== "none");
  assert.ok(props.length >= 6, "there are transitions");
  for (const prop of props) assert.ok(["transform", "opacity"].includes(prop), `transition on ${prop} is only transform or opacity`);
  for (const frames of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\})\s*\}/g)) assert.match(frames[1], /^\s*(?:to|from|\d+%)\s*\{\s*transform:/, "keyframes move only a transform");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /transition: none;/);
  assert.match(reduced, /\.ext-spin \{ animation: none; \}/);
  for (const selector of [".ext-btn", ".ext-btn::before", ".ext-btn__chevron", ".ext-select__control", ".ext-switch__track::after", ".extensions-tabs__tab::after"]) assert.ok(reduced.includes(selector), `${selector} stops moving`);
});

test("every control has all eight states, with a solid ring of at least 2px", () => {
  const css = stripCssComments(read(CSS));
  const rule = (selector) => css.split("}").map((r) => r.trim()).filter((r) => r.startsWith(selector)).join("} ");
  for (const [name, base] of [["button", ".ext-btn"], ["filter", ".ext-select__control"]]) {
    for (const [state, selector] of [
      ["hover", `${base}:hover`], ["focus-visible", `${base}:focus-visible`], ["active", `${base}:active`], ["disabled", `${base}:disabled`],
    ]) assert.ok(css.includes(selector), `${name}: ${state} (${selector})`);
  }
  assert.ok(css.includes('.ext-btn[aria-busy="true"]') && css.includes('.ext-select__control[aria-busy="true"]'), "loading");
  assert.ok(css.includes('.ext-btn[data-state="error"]') && css.includes('.ext-select__control[aria-invalid="true"]'), "error");
  assert.ok(css.includes('.ext-btn[data-state="success"]') && css.includes('.ext-select__control[data-state="success"]'), "success");
  assert.match(rule(".ext-btn:focus-visible"), /outline: var\(--ring-width\) solid var\(--color-focus\);/, "a solid ring");
  assert.match(rule(".ext-btn:disabled"), /cursor: not-allowed/);
  assert.match(rule(".ext-btn:active"), /transform: scale\(var\(--press-scale\)\)/);
  assert.match(rule(".ext-btn {"), /min-height: var\(--hit-min\);[\s\S]*min-width: var\(--hit-min\)/, "a 44px target");
  assert.match(css, /\.ext-btn::before \{[^}]*opacity: 0;/, "hover and press fade an overlay, so only opacity animates");
  // The theme's ring is 2px, and a control is 44px.
  const theme = read("frontend/src/theme/vibhav.css");
  assert.match(theme, /--ring-width: 2px;/);
  assert.match(theme, /--hit-min: 44px;/, "in px: the desktop type scale shrinks rem, and a target must not shrink with it");
  assert.match(theme, /--gap-hit: 8px;/);
  assert.match(css, /\.ext-row__actions \{[^}]*gap: var\(--gap-hit\)/, "neighbouring controls are 8px apart");
});

test("the accent is a fill for the one primary action and the focus ring, never small text", () => {
  const css = stripCssComments(read(CSS));
  const accentLines = css.split("\n").filter((l) => /--color-accent\b(?!-)/.test(l));
  for (const line of accentLines) assert.doesNotMatch(line, /(?<![\w-])color\s*:\s*var\(--color-accent\)/, `accent is not a text colour: ${line.trim()}`);
  // The only fill in the sheet is the primary button.
  const fills = [...css.matchAll(/([^{}]+)\{[^}]*background:\s*var\(--color-accent\)/g)].map((m) => m[1].trim());
  assert.deepEqual(fills, [".ext-btn--primary"]);
  const jsx = read(JSX);
  assert.equal((jsx.match(/ext-btn--primary/g) ?? []).length, 1, "one filled primary action in the page");
});

// ---- Tokens: contrast in both skies -------------------------------------------------------------------

const hex = (value) => { const n = parseInt(value.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const luminance = ([r, g, b]) => { const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [luminance(hex(a)), luminance(hex(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test("the warning colour reads at 4.5:1 on its own tint and on the paper, in both skies", () => {
  const theme = read("frontend/src/theme/vibhav.css");
  const values = (name) => [...theme.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`, "g"))].map((m) => m[1]);
  // The dark sky is defined before the light one in the theme.
  const [warnDark, warnLight] = values("--color-warn");
  const [softDark, softLight] = values("--color-warn-soft");
  const [paperDark, paperLight] = values("--color-paper");
  assert.ok(warnDark && warnLight && softDark && softLight && paperDark && paperLight, "all six values found");
  for (const [sky, warn, soft, paper] of [["dark", warnDark, softDark, paperDark], ["light", warnLight, softLight, paperLight]]) {
    assert.ok(ratio(warn, soft) >= 4.5, `${sky}: warning on its tint ${ratio(warn, soft).toFixed(1)}:1`);
    assert.ok(ratio(warn, paper) >= 4.5, `${sky}: warning on the paper ${ratio(warn, paper).toFixed(1)}:1`);
  }
});

// ---- The memory switch and the memory wording ------------------------------------------------------------

test("the + menu has no memory switch and the composer no longer reads or sends a per-chat memory choice", () => {
  const app = stripJsComments(read("frontend/src/App.jsx"));
  // "Use memory when answering" is the account-wide Settings switch (Slice 3), not the removed per-chat one.
  assert.doesNotMatch(app, /Use memory(?! when answering)|useMemoryChosen|setUseMemory|memoryAccountOn|\buseMemory\b/, "none of the switch's code is left");
  // The menu: Photos, Files, the writing tools where offered, and Response mode where it applies, with no divider left dangling.
  const menu = app.slice(app.indexOf(">Photos</MenuItem>"), app.indexOf("</Menu>", app.indexOf(">Photos</MenuItem>")));
  assert.match(menu, />Files<\/MenuItem>/);
  assert.match(menu, /\{mode !== "study" && <>\s*<MenuSeparator \/>\s*<MenuGroup label="Response mode">/, "the divider belongs to Response mode, so Study does not end on one");
  assert.doesNotMatch(menu, /Brain size=\{16\} \/>\} description=\{memory/);
});

test("memory itself still works: Settings can turn it off, the Memory page lists and deletes it, and the server still honours a per-chat choice", () => {
  const app = read("frontend/src/App.jsx");
  assert.match(app, /<SettingsGroup title="How memory works"/);
  // Slice 3: using memories and saving new ones are separate Settings switches.
  assert.match(app, /label="Use memory when answering"/, "the Settings switch for using memory");
  assert.match(app, /label="Save new memories"/, "the Settings switch for saving memory");
  assert.match(app, /Clear all memory/, "the Memory page");
  const router = read("src/memory/router.js");
  assert.match(router, /memoryRouter\.delete\("\/:id"/, "delete one");
  assert.match(router, /memoryRouter\.delete\("\/"/, "delete all");
  assert.match(router, /memoryRouter\.put\("\/settings"/, "turn it off");
  // The per-conversation value is kept on the server (not deleted): a chat that was set to Off stays Off.
  const chat = read("src/chat/router.js");
  assert.match(chat, /requestedUseMemory/);
  assert.match(read("src/db/schema.js"), /useMemory: boolean\("use_memory"\)/);
  assert.ok(fs.existsSync(path.join(root, "test/chat-use-memory.test.js")), "and its tests remain");
});

test("the public memory statement matches the product: turn it off or delete it, and no copy claims a per-chat control", () => {
  const row = COMPARISON_GROUPS.find((g) => g.title === "Every plan").rows.find((r) => /^Memory/.test(r.label));
  assert.equal(row.label, "Memory you can turn off or delete");
  assert.deepEqual(row.values, [true, true, true, true]);
  const free = PRODUCT_KNOWLEDGE.plans.find((p) => p.id === "free").details.join(" ");
  assert.match(free, /Every plan can search its past chats, turn memory off or delete what it has saved, and add an optional location for local answers\./);
  for (const file of ["frontend/src/plan-comparison.js", "frontend/src/product-knowledge.js", "frontend/src/public-pages.js", "frontend/src/credits-copy.js", "frontend/src/Legal.jsx", "frontend/src/onboarding.js", "frontend/public/home/index.html"]) {
    assert.doesNotMatch(stripJsComments(read(file)), /memory[^.]{0,40}(?:single|one|this|each|per) (?:chat|conversation)|(?:single|one|this|each|per) (?:chat|conversation)[^.]{0,40}memory|also for a single chat/i, `${file} does not claim per-chat memory control`);
  }
});

// ---- Links -----------------------------------------------------------------------------------------------

test("links in text take the theme's link class, not the browser's default blue", () => {
  const link = read("frontend/src/styles.css").match(/\.link \{[^}]*\}/)[0];
  assert.match(link, /color: var\(--color-accent-text\);/);
  assert.match(read("frontend/src/components/LocationSettings.jsx"), /<a className="link" href="https:\/\/www\.geonames\.org\/"/);
  assert.match(read("frontend/src/components/ActionApprovalCard.jsx"), /<a className="link" href=\{providerFileLink\(action\.result\)\}/);
  assert.match(read("frontend/src/components/ConnectorsSettings.jsx"), /<a className="link" href=\{manualAuthLink\}/);
  // Extensions shows it as the shared Banner's one action: a button-styled link, never the browser's default blue.
  assert.match(read(JSX), /action=\{<a className="btn btn--secondary" href=\{manualAuthLink\}/);
});
