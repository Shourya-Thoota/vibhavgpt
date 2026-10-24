import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The sidebar is a full-height column: head, New chat, nav and foot keep their
// size, and the chat history fills the rest and scrolls on its own, so chats
// are never cut off and never push the account foot off screen.
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
  assert.match(sidebar, /overflow-x: hidden;\s*overflow-y: auto;/, "only a screen too short for everything scrolls the whole column");
  assert.match(css, /\.sidebar > :not\(\.conversation-history\) \{ flex-shrink: 0; \}/, "head, New chat, nav and foot are never squeezed");
  assert.match(css, /\.sidebar__foot \{ margin-top: auto;/, "the foot sits at the bottom");
});

test("the chat history fills the space left and scrolls independently, with room under the last chat", () => {
  assert.match(rule(".conversation-history"), /flex: 1 1 0%;[\s\S]*min-height: 160px;/, "takes all remaining height, never collapsing to nothing");
  const list = rule(".conversation-history__list");
  assert.match(list, /flex: 1 1 0%;/);
  assert.match(list, /min-height: 0;/);
  assert.match(list, /overflow-y: auto;/);
  assert.match(list, /padding: 1px 0 24px;/, "the last chat clears the foot");
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

test("on phones the drawer is one full-height scroll column with the account pinned", () => {
  const mobile = readFileSync(new URL("../frontend/src/mobile.css", import.meta.url), "utf8");
  assert.match(mobile, /\.sidebar \{[^}]*height: 100vh;\s*height: 100dvh;/);
  // Head, New chat, nav and Apps fill most of a phone's height, so a nested
  // history scroller would get a sliver; the drawer scrolls as a whole.
  const drawer = mobile.slice(mobile.indexOf("/* --- Drawer: one scroll column"));
  assert.match(drawer, /\.conversation-history \{ flex: 0 0 auto; min-height: auto; \}/);
  assert.match(drawer, /\.conversation-history__list \{ flex: none; min-height: auto; overflow: visible;/, "chats flow at full height");
  assert.match(drawer, /\.sidebar__foot \{ display: contents; \}/);
  assert.match(drawer, /\.sidebar__foot > \.ui-menu \{\s*position: sticky;/, "the account button stays on screen");
  assert.match(css, /\.sidebar \{[^}]*overflow-y: auto;/, "the drawer itself scrolls");
});
