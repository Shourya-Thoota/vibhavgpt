import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writing Tools (the AI Detector and Humanizer) open in place on the Study home screen, from a chip under the composer or from the
// composer's + menu. They need no session, they are not a screen or a sidebar item of their own, and the browser's Back closes them.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("frontend/src/App.jsx");

// The real components, compiled with the frontend's esbuild and rendered to HTML.
async function renderComponents() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import Sidebar from "./components/Sidebar.jsx";
        import StudyWritingTools from "./components/StudyWritingTools.jsx";
        const noop = () => {};
        export const sidebar = (props) => renderToStaticMarkup(<Sidebar variant="study" api={async () => ({ conversations: [] })} user={{ name: "Ada Learner", email: "ada@example.com" }}
          appearance={{}} rail={false} sidebarOpen={false} setSidebarOpen={noop} setCollapsed={noop} brand={<span>VibhavGPT</span>} tierKey="free" tierLabel="Free"
          page="chat" go={noop} newChat={noop} newChatInGroup={noop} openConversation={noop} onOpenImageSession={noop} onSignOut={noop} {...props} />);
        export const tools = (props) => renderToStaticMarkup(<StudyWritingTools api={async () => ({})} {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  const dir = mkdtempSync(join(tmpdir(), "writing-tools-entry-"));
  try {
    const file = join(dir, "components.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the Study sidebar has no Writing Tools item: New study session is its only action, and the tools open in place", async () => {
  const render = await renderComponents();
  const html = render.sidebar({});
  assert.doesNotMatch(html, /Writing Tools/, "no sidebar item");
  assert.doesNotMatch(html, /aria-label="Study tools"/, "and no nav for one");
  assert.match(html, /New study session/);
  assert.doesNotMatch(app, /writingToolsActive|onOpenWritingTools=\{openWritingTools\}/, "the sidebar is not given the tools");
  assert.doesNotMatch(read("frontend/src/components/Sidebar.jsx"), /onOpenWritingTools|writingToolsActive/, "and takes no props for them");
});

test("the tools render on their own, with no session or document, and a Close button", async () => {
  const render = await renderComponents();
  const html = render.tools({ onBack: () => {} });
  assert.match(html, /<button type="button" class="btn btn--secondary writing-tools__back" aria-label="Close Writing tools">.*?Close<\/button>/);
  assert.match(html, /<header class="writing-tools__bar"><button [^>]*writing-tools__back[^>]*>.*?Close<\/button><div role="radiogroup" aria-label="Writing tool"/, "Close and the tool tabs share one bar");
  assert.match(html, /<h2>AI Detector<\/h2>/, "a second-level heading: the page's own greeting is its first");
  assert.doesNotMatch(html, /<h1/, "the page has one h1");
  assert.match(html, /<iframe [^>]*title="AI Detector"/, "the tools load in their own frames, with no session needed");
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(render.tools({}), /Close<\/button>/, "no close button without something to close");
});

test("the Study home screen has the tools as one row of chips, and Writing tools opens its panel there", () => {
  assert.match(app, /<div className="study-starters" role="group" aria-label="Study tools">/);
  assert.match(app, /\{STUDY_STARTERS\.map\(\(label\) => <button type="button" className="btn btn--secondary" key=\{label\} onClick=\{\(\) => \{ setDraft\(label\); inputRef\.current\?\.focus\(\); \}\}>/, "each tool works in place: it fills the box and sends nothing");
  assert.match(app, /<button type="button" className="btn btn--secondary study-starters__tool" aria-expanded=\{Boolean\(toolsPanel\)\} onClick=\{\(\) => \(toolsPanel \? onCloseWritingTools\?\.\(\) : onOpenWritingTools\("detector"\)\)\}>/, "the chip toggles the panel");
  assert.match(app, /\{toolsPanel\}\s*<\/>/, "the panel renders under the chips");
  assert.match(app, /renderChat\(\{ mode: productMode, onOpenWritingTools: productMode === "study" \? openWritingTools : undefined \}\)/, "only Study's home screen gets the chip");
  const css = read("frontend/src/compact.css");
  assert.match(css, /\.workspace \.study-starters \{\s*display: flex;\s*flex-wrap: wrap;\s*justify-content: center;/, "a row that wraps on a phone, never a column");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /\.study-starters[^{]*\{[^}]*(display: grid|flex-direction: column)/, "nothing stacks the chips");
  assert.match(css, /\.study-starters__tool \{ color: var\(--color-accent-text\)/, "the one that opens a panel carries the accent");
});

test("opening the tools adds one history entry, Back only closes the panel, and starting over or switching mode closes it too", () => {
  assert.match(app, /const writingToolsOpen = page === "chat" && productMode === "study" && studyView === "writing";/);
  assert.match(app, /const openWritingTools = \(tab\) => \{\s*const first = studyViewRef\.current !== "writing";[\s\S]*?if \(activeConversationId\) newChat\(\);\s*setWritingToolsTab\(tab === "humanizer" \? "humanizer" : "detector"\);\s*setStudyView\("writing"\);\s*setSidebarOpen\(false\);\s*go\("chat"\);[\s\S]*?if \(first\) window\.history\.pushState\(\{ writingTools: true \}, ""/, "opens at once on the asked-for tool, from a fresh Study home, with one history entry");
  assert.match(app, /const closeWritingTools = \(\) => \{\s*if \(window\.history\.state\?\.writingTools\) window\.history\.back\(\);\s*else setStudyView\("chat"\);\s*\};/, "closing goes back through history, so the entry does not pile up");
  assert.match(app, /if \(studyViewRef\.current === "writing" && !window\.history\.state\?\.writingTools\) \{ setStudyView\("chat"\); return; \}/, "Back closes the panel and rebuilds nothing, so a half-typed message stays");
  assert.match(app, /toolsPanel=\{writingToolsOpen \? <div className="writing-tools-inline"><StudyWritingTools key=\{writingToolsTab\} api=\{api\} initialTab=\{writingToolsTab\} onBack=\{closeWritingTools\} \/><\/div> : null\}/, "the panel is handed to the Study home, not given a screen of its own");
  assert.doesNotMatch(app, /writing-tools-scroll/, "no separate screen");
  assert.match(app, /const newChat = \(\) => \{\s*draftRef\.current = "";\s*setStudyView\("chat"\);/, "New study session leaves the tools (and clears the carried draft first)");
  assert.match(app, /const openConversation = \(conversationId, mode = productMode\) => \{\s*draftRef\.current = "";\s*setStudyView\("chat"\);/, "opening a session leaves the tools (and clears the carried draft first)");
  assert.match(app, /useEffect\(\(\) => \{ if \(productMode !== "study"\) setStudyView\("chat"\); \}, \[productMode\]\);/);
  assert.doesNotMatch(read("frontend/src/components/StudyWorkspace.jsx"), /StudyWritingTools/, "the unused StudyWorkspace no longer pretends to host them");
});

test("the composer's + menu has AI Detector and AI Humanizer in Study, each opening its own tab, and Response mode is a flat group elsewhere", () => {
  assert.match(app, /\{onOpenWritingTools && <>\s*<MenuSeparator \/>\s*<MenuGroup label="Writing tools">\s*<MenuItem icon=\{<ScanSearch size=\{16\} \/>\} description="Check text for AI writing patterns" onSelect=\{\(\) => onOpenWritingTools\("detector"\)\}>AI Detector<\/MenuItem>/);
  assert.match(app, /<MenuItem icon=\{<Wand2 size=\{16\} \/>\} description="Rewrite robotic text into natural human prose" onSelect=\{\(\) => onOpenWritingTools\("humanizer"\)\}>AI Humanizer<\/MenuItem>/);
  assert.match(app, /onClick=\{\(\) => \{ closeSheet\(\); onOpenWritingTools\("detector"\); \}\}>[\s\S]*?AI Detector<small>Check text for AI writing patterns<\/small>/, "the phone sheet too");
  assert.match(app, /onClick=\{\(\) => \{ closeSheet\(\); onOpenWritingTools\("humanizer"\); \}\}>[\s\S]*?AI Humanizer<small>Rewrite robotic text into natural human prose<\/small>/);
  assert.match(app, /<MenuItem icon=\{<FileText size=\{16\} \/>\} description="PDF, Word, text, CSV or JSON"[^\n]*Files<\/MenuItem>\n\s*\{onOpenWritingTools && <>/, "Photos and Files stay first");
  assert.match(app, /<MenuGroup label="Response mode">[\s\S]*?Concise<\/MenuItem>[\s\S]*?Detailed<\/MenuItem>[\s\S]*?Learning<\/MenuItem>\s*<\/MenuGroup>\s*<MenuSeparator \/>\s*<MenuItem [^\n]*onSelect=\{onOpenSettings\}>Custom<\/MenuItem>/, "Response mode is a flat group in the same menu (no second panel opened by hovering), with Custom, which opens Settings, set apart by a divider as before");
  assert.doesNotMatch(app.slice(app.indexOf("const addMenu"), app.indexOf("const addSheetButton")), /<MenuSub\b/, "the + menu has no nested menu");
  assert.doesNotMatch(app, /<MenuLabel>(Add to message|Writing tools|Response mode)<\/MenuLabel>/, "groups are told apart by dividers, not headings");
});

test("a submenu is a real menu: a chevron row with aria-haspopup, ArrowRight to open, ArrowLeft or Escape to close just it", () => {
  const ui = read("frontend/src/components/ui.jsx");
  assert.match(ui, /export function MenuSub\(/);
  for (const piece of ['role="menuitem"', 'aria-haspopup="menu"', "aria-expanded={open}", 'event.key === "ArrowRight"', 'event.key === "ArrowLeft" || event.key === "Escape"', "event.stopPropagation()", "<ChevronRight"]) assert.ok(ui.includes(piece), `keeps: ${piece}`);
  assert.match(ui, /\.filter\(\(item\) => !item\.closest\("\.ui-menu__submenu"\)\)/, "the outer menu's arrow keys do not wander into an open submenu");
});

test("the tools open on whichever tab was chosen, with the other still mounted", async () => {
  const render = await renderComponents();
  const tabs = (html) => [...html.matchAll(/class="writing-tools-widget-wrapper" style="display:(block|none)" data-tab="(\w+)"/g)].map(([, display, tab]) => `${tab}:${display}`);
  assert.deepEqual(tabs(render.tools({ initialTab: "humanizer" })), ["detector:none", "humanizer:block"]);
  assert.deepEqual(tabs(render.tools({ initialTab: "detector" })), ["detector:block", "humanizer:none"]);
  assert.deepEqual(tabs(render.tools({})), ["detector:block", "humanizer:none"], "the Detector by default");
  assert.match(render.tools({ initialTab: "humanizer" }), /data-value="humanizer" aria-checked="true"/, "its tab is the selected one");
});
