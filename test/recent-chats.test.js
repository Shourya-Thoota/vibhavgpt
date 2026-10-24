import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Recent chats: the whole row opens a chat, a long title ellipsizes before the
// menu instead of running under it, the open chat is marked for sight and for
// screen readers, and the menu is a 44px target that touch screens always see.
const css = readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
const mobile = readFileSync(new URL("../frontend/src/mobile.css", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../frontend/src/components/Sidebar.jsx", import.meta.url), "utf8");
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf("}", start) + 1);
};

async function renderRow(props) {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import { ConversationRow } from "./components/ConversationLibrary.jsx";
        const noop = () => {};
        export const render = (props) => renderToStaticMarkup(<ConversationRow onOpen={noop} onRename={noop} onMove={noop} onDelete={noop} {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "expose-row", setup(build) {
      build.onLoad({ filter: /ConversationLibrary\.jsx$/ }, (args) => (basename(args.path) === "ConversationLibrary.jsx"
        ? { contents: `${readFileSync(args.path, "utf8")}\nexport { ConversationRow };\n`, loader: "jsx" }
        : undefined));
    } }],
  });
  const dir = mkdtempSync(join(tmpdir(), "recent-chats-"));
  try {
    const file = join(dir, "row.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file).render(props);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const longTitle = "A very long chat title about thermodynamics, entropy and the arrow of time";

test("the open chat is marked with aria-current; the others are not", async () => {
  const active = await renderRow({ conversation: { id: "c1", title: "Physics", updatedAt: null }, active: true });
  const idle = await renderRow({ conversation: { id: "c2", title: "History", updatedAt: null }, active: false });
  assert.match(active, /<div class="conversation-item" data-active="true">/);
  assert.match(active, /<button type="button" class="conversation-item__open" title="Physics" aria-current="page">/);
  assert.doesNotMatch(idle, /data-active|aria-current/);
});

test("a row shows its full title on hover and opens from one full-width button", async () => {
  const html = await renderRow({ conversation: { id: "c1", title: longTitle, updatedAt: null }, active: false });
  assert.match(html, new RegExp(`class="conversation-item__open" title="${longTitle}"[^>]*><span>${longTitle}</span><small>`));
  const untitled = await renderRow({ conversation: { id: "c3", title: "", updatedAt: null }, active: false });
  assert.match(untitled, /title="Untitled chat"[^>]*><span>Untitled chat<\/span>/);
});

test("the menu button is labelled Chat options and sits beside the row, never inside it", async () => {
  const html = await renderRow({ conversation: { id: "c1", title: "Physics", updatedAt: null }, active: false });
  assert.match(html, /<button type="button" class="conversation-item__actions" aria-label="Chat options for Physics" aria-haspopup="menu" aria-expanded="false">/);
  assert.doesNotMatch(html.slice(0, html.indexOf("</button>")), /conversation-item__actions/, "a menu click can never land on the open button");
  // The image sessions list shares the same row markup.
  assert.match(sidebar, /className="conversation-item__open" title=\{name\} aria-current=\{active \? "page" : undefined\}/);
  assert.match(sidebar, /aria-label=\{`Chat options for \$\{name\}`\}/);
});

test("a long title ellipsizes in its own column before the time and the menu", () => {
  const open = rule(".conversation-item__open");
  assert.match(open, /grid-template-columns: minmax\(0, 1fr\) auto;/, "title shrinks, the time keeps its width on the same line");
  assert.match(open, /padding: 11px 2px 11px 12px;/);
  assert.match(css, /\.conversation-item__open > span \{ overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.conversation-item__open small \{ color: var\(--faint\); font-size: 0\.68rem;[^}]*white-space: nowrap; \}/, "the time is small, muted and never wraps");
  const actions = rule(".conversation-item__actions");
  assert.match(actions, /flex: 0 0 auto;\s*width: 44px;\s*height: 44px;/, "the menu keeps its own 44px column");
  assert.match(actions, /opacity: 0;/, "hidden but still holding its space, so the title never flows under it");
});

test("active, hover and focus states read clearly in every theme", () => {
  assert.match(rule(".conversation-item"), /min-height: 44px;/);
  assert.match(css, /\.conversation-item\[data-active\] \{ background: var\(--accent-soft\); box-shadow: inset 3px 0 0 var\(--accent\); \}/);
  assert.match(css, /\.conversation-item:hover:not\(\[data-active\]\) \{ background: var\(--surface-2\); \}/);
  assert.match(css, /\.conversation-item__open:focus-visible,\s*\.conversation-item__actions:focus-visible \{ outline: 2px solid var\(--color-focus\); outline-offset: -2px; \}/);
  assert.doesNotMatch(css, /\.conversation-item:hover \{ transform/, "no hover nudge that could push the row sideways out of the list");
  const block = css.slice(css.indexOf(".conversation-item {"), css.indexOf("@media (hover: none), (pointer: coarse)"));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i, "only theme tokens, so dark mode and accents carry through");
});

test("the menu shows on hover, focus and the open chat, and always on touch screens", () => {
  assert.match(css, /\.conversation-item:hover \.conversation-item__actions,\s*\.conversation-item:focus-within \.conversation-item__actions,\s*\.conversation-item\[data-active\] \.conversation-item__actions,\s*\.conversation-item__actions\[aria-expanded="true"\] \{ opacity: 1; \}/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{\s*\.conversation-item__actions \{ opacity: 1; \}\s*\}/);
  assert.match(mobile, /\.sidebar__link, \.conversation-item__open \{ min-height: 44px; \}/, "drawer rows stay 44px tall");
  assert.match(mobile, /\.conversation-item__actions \{ width: 44px; height: 44px; margin-right: 0; \}/, "drawer menu stays a 44px target");
});
