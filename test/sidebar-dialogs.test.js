import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Dialogs opened from the sidebar (New project, folders, Move chat) cover the
// whole window, centred over a dimmed backdrop. They are position: fixed, so
// no ancestor in the sidebar may become their containing block: a
// backdrop-filter, filter, transform, perspective, contain or will-change on
// the sidebar box confined the New project dialog to the sidebar.
const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), "utf8");
const CONTAINING = /(?:^|[\s;{])(?:backdrop-filter|filter|perspective|contain|will-change)\s*:|(?:^|[\s;{])transform\s*:(?!\s*none\b)/;

test("the sidebar box never becomes the containing block for its dialogs", () => {
  const sheets = readdirSync(new URL("../frontend/src/", import.meta.url)).filter((name) => name.endsWith(".css"));
  for (const sheet of sheets) {
    const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const onSidebar = selectors.split(",").some((selector) => /^\.sidebar(?:\[data-open="true"\])?$/.test(selector.trim()));
      // The phone drawer slides in with a transform while closed; once open
      // (the only time its dialogs can open) it is transform: none.
      const closedDrawer = sheet === "styles.css" && /translateX\(-102%\)/.test(body);
      if (onSidebar && !closedDrawer) assert.doesNotMatch(body, CONTAINING, `${sheet}: ${selectors.trim()} { ${body.trim()} }`);
    }
  }
  // The frosted look is kept, on a layer behind the content.
  assert.match(read("cosmos.css"), /\.sidebar::before \{[^}]*position: absolute;[^}]*inset: 0;[^}]*z-index: -1;[^}]*backdrop-filter: blur\(6px\);[^}]*pointer-events: none;/);
  assert.match(read("cosmos.css"), /\.sidebar \{[^}]*isolation: isolate;/);
});

test("the shared dialog is a centred, full-window overlay that closes on Escape or a backdrop click and submits on Enter", () => {
  const css = read("styles.css");
  assert.match(css, /\.ui-scrim \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 100;[^}]*display: grid;[^}]*place-items: center;[^}]*backdrop-filter: blur\(3px\);/);
  const ui = read("components/ui.jsx");
  const modal = ui.slice(ui.indexOf("export function Modal("), ui.indexOf("export function Modal(") + 2600);
  assert.match(modal, /if \(event\.key === "Escape"\) onClose\(\);/);
  assert.match(modal, /onPointerDown=\{\(event\) => event\.target === event\.currentTarget && onClose\(\)\}/, "backdrop click closes");
  assert.match(modal, /const Panel = onSubmit \? "form" : "div";/, "a form, so Enter submits");
  assert.match(modal, /aria-modal="true"/);
});

test("the New project dialog names its field and focuses it", () => {
  const library = read("components/ConversationLibrary.jsx");
  assert.match(library, /<Field label=\{dialog\?\.kind === "project" \? "Project name" : "Folder name"\}>\s*<input className="input" autoFocus maxLength=\{80\}/);
  assert.match(library, /dialog\?\.kind === "project" \? "Create project" : "Create folder"/);
  assert.match(library, /<button type="button" className="btn btn--quiet" onClick=\{closeDialog\}>Cancel<\/button>/);
});
