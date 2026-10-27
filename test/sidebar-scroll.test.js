import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The sidebar is a full-height column: head, New chat, nav, secondary links and
// foot keep their size, and the chat history fills the rest and scrolls on its
// own, so chats are never cut off and never push the account foot off screen.
// A window too short for that, and the phone drawer, scroll as one column instead.
// These are CSS-source and rendered-markup checks. They do not prove how it scrolls;
// that was measured separately in a real browser (see the change notes).
const css = readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf("}", start) + 1);
};

async function renderSidebar(props = {}) {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import Sidebar from "./components/Sidebar.jsx";
        const noop = () => {};
        export const render = (props) => renderToStaticMarkup(<Sidebar api={async () => ({ conversations: [], groups: [] })} user={{ name: "Ada Learner", email: "ada@example.com" }}
          appearance={{}} rail={false} sidebarOpen={false} setSidebarOpen={noop} setCollapsed={noop} brand={<span>VibhavGPT</span>} tierKey="free" tierLabel="Free"
          page="chat" go={noop} newChat={noop} newChatInGroup={noop} openConversation={noop} onOpenImageSession={noop} onSignOut={noop} {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  const dir = mkdtempSync(join(tmpdir(), "sidebar-scroll-"));
  try {
    const file = join(dir, "sidebar.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file).render(props);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the sidebar is a full-height flex column that never lets its foot fall off screen", () => {
  const sidebar = rule(".sidebar");
  assert.match(sidebar, /height: 100vh;\s*height: 100dvh;\s*max-height: 100dvh;/, "fits the visible screen, phone browser bars included");
  assert.match(sidebar, /display: flex;\s*flex-direction: column;/);
  assert.match(sidebar, /overflow-x: hidden;\s*overflow-y: auto;/, "the column can still scroll as a whole, as the short-window fallback");
  assert.match(css, /\.sidebar > :not\(\.conversation-history\) \{ flex-shrink: 0; \}/, "head, New chat, nav and foot are never squeezed");
  assert.match(css, /\.sidebar__foot \{ margin-top: auto;/, "the foot sits at the bottom");
});

test("the chat history fills the space left and scrolls independently, with room under the last chat", () => {
  const history = rule(".conversation-history");
  assert.match(history, /flex: 1 1 0%;[\s\S]*min-height: 0;/, "takes all remaining height and may shrink");
  assert.doesNotMatch(history, /min-height: \d+px/, "no rigid minimum height that would push the column into scrolling");
  const list = rule(".conversation-history__list");
  assert.match(list, /flex: 1 1 0%;/);
  assert.match(list, /min-height: 0;/);
  assert.match(list, /overflow-y: auto;/);
  assert.match(list, /padding: 0 0 24px;/, "no padding above the first section, and the last chat clears the foot");
  assert.match(list, /scrollbar-width: thin;\s*scrollbar-color: var\(--line-strong\) transparent;/, "a subtle themed scrollbar");
  assert.match(css, /\.conversation-history__list::-webkit-scrollbar-thumb \{[^}]*background: var\(--line-strong\);/);
});

test("in the rendered sidebar, the history sits in the column between the fixed parts", async () => {
  for (const variant of ["chat", "study", "image"]) {
    const html = await renderSidebar({ variant });
    const aside = html.match(/^<aside class="sidebar"[^>]*>/);
    assert.ok(aside, `${variant}: the sidebar is the column`);
    const history = html.indexOf('class="conversation-history');
    assert.ok(history > 0, `${variant}: has its history section`);
    assert.ok(html.indexOf('class="sidebar__head"') < history && history < html.indexOf('class="sidebar__foot"'), `${variant}: head above, foot below`);
    assert.match(html.slice(history), /^class="conversation-history[^"]*"[^>]*>(<div class="conversation-history__head">[\s\S]*?<\/div>)?[\s\S]*?<div class="conversation-history__list">/, `${variant}: chats live in the scrolling list`);
  }
});

test("on phones the drawer, and on a short desktop window, are one scroll column with the account pinned", () => {
  const mobile = readFileSync(new URL("../frontend/src/mobile.css", import.meta.url), "utf8");
  assert.match(mobile, /\.sidebar \{[^}]*height: 100vh;\s*height: 100dvh;/);
  // A nested history scroller would get a sliver under the controls, so the column
  // scrolls as a whole. Those rules are one shared block in styles.css.
  const start = css.indexOf("@media (max-width: 760px), (max-height: 720px) {");
  assert.ok(start > 0, "one block serves the phone drawer and the short window");
  const column = css.slice(start, css.indexOf("\n}\n", start));
  assert.match(column, /\.conversation-history \{ flex: 0 0 auto; min-height: auto; \}/);
  assert.match(column, /\.conversation-history__list \{ flex: none; min-height: auto; overflow: visible;/, "chats flow at full height");
  assert.match(column, /\.sidebar__foot \{ display: contents; \}/);
  assert.match(column, /\.sidebar__foot > \.ui-menu \{\s*position: sticky;/, "the account button stays on screen");
  assert.match(column, /\.sidebar__foot > :first-child \{ margin-top: auto; \}/, "the footer settles at the bottom of a short column");
  assert.doesNotMatch(css, /sidebar__more/, "no group at the bottom of the sidebar");
  assert.match(css, /\.sidebar \{[^}]*overflow-y: auto;/, "the column itself scrolls");
  assert.doesNotMatch(mobile, /\.sidebar__foot > :first-child \{ margin-top: auto; \}/, "the drawer no longer carries its own copy of these rules");
  assert.match(mobile, /\.sidebar \{[^}]*gap: 22px;/, "the drawer keeps its own section gap");
});
