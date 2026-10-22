import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writing Tools (the AI Detector and Humanizer) open from the Study home
// screen and the Study sidebar, need no session, and lead back to Study.
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

test("the Study sidebar has a Writing Tools button under New study session, highlighted while open", async () => {
  const render = await renderComponents();
  const closed = render.sidebar({ onOpenWritingTools: () => {} });
  assert.match(closed, /New study session<\/span><\/button><nav class="sidebar__nav" aria-label="Study tools"><button type="button" class="sidebar__link"[^>]*>.*?<span>Writing Tools<\/span><\/button><\/nav>/, "directly under New study session");
  assert.doesNotMatch(closed, /data-active="true"[^>]*>.*?Writing Tools/);
  const open = render.sidebar({ onOpenWritingTools: () => {}, writingToolsActive: true });
  assert.match(open, /<button type="button" class="sidebar__link" data-active="true" aria-current="page"[^>]*>.*?<span>Writing Tools<\/span>/);
  assert.doesNotMatch(render.sidebar({ variant: "chat", onOpenWritingTools: () => {} }), /Writing Tools/, "only in Study");
});

test("the tools render on their own, with no session or document, and a Back to Study button", async () => {
  const render = await renderComponents();
  const html = render.tools({ onBack: () => {} });
  assert.match(html, /<button type="button" class="btn btn--secondary writing-tools__back">.*?Back to Study<\/button>/);
  assert.match(html, /VibhavGPT Writing Tools/);
  assert.match(html, /VibhavGPT AI Detector/);
  assert.doesNotMatch(html, /<iframe|<script/i);
  assert.doesNotMatch(render.tools({}), /Back to Study/, "no back button without somewhere to go back to");
});

test("the Study home screen has a Writing tools chip that opens the tools, not a prompt", () => {
  assert.match(app, /\{STUDY_STARTERS\.map\([\s\S]*?\)\}\s*\{onOpenWritingTools && <button type="button" className="btn btn--secondary study-starters__tool" onClick=\{onOpenWritingTools\}><PenLine size=\{14\} strokeWidth=\{2\} \/>Writing tools<\/button>\}/);
  assert.match(app, /renderChat\(\{ mode: productMode, onOpenWritingTools: productMode === "study" \? openWritingTools : undefined \}\)/, "only Study's home screen gets the chip");
  assert.match(read("frontend/src/study.css"), /\.study-starters \.study-starters__tool\{[^}]*color:var\(--color-accent\)/, "it carries the accent");
});

test("the chip and the sidebar switch Study to the tools, and Back, New study session or another mode switch back", () => {
  assert.match(app, /const writingToolsOpen = page === "chat" && productMode === "study" && studyView === "writing";/);
  assert.match(app, /const openWritingTools = \(\) => \{\s*setStudyView\("writing"\);\s*setSidebarOpen\(false\);\s*go\("chat"\);\s*\};/, "opens at once, and closes the phone drawer");
  assert.match(app, /onOpenWritingTools=\{openWritingTools\}\s*writingToolsActive=\{writingToolsOpen\}/, "the sidebar opens it and shows it active");
  assert.match(app, /: writingToolsOpen \? <StudyWritingTools api=\{api\} onBack=\{\(\) => setStudyView\("chat"\)\} \/>/, "Back to Study returns to the study view");
  assert.match(app, /const newChat = \(\) => \{\s*setStudyView\("chat"\);/, "New study session leaves the tools");
  assert.match(app, /const openConversation = \(conversationId, mode = productMode\) => \{\s*setStudyView\("chat"\);/, "opening a session leaves the tools");
  assert.match(app, /useEffect\(\(\) => \{ if \(productMode !== "study"\) setStudyView\("chat"\); \}, \[productMode\]\);/);
  assert.doesNotMatch(read("frontend/src/components/StudyWorkspace.jsx"), /StudyWritingTools/, "the unused StudyWorkspace no longer pretends to host them");
});
