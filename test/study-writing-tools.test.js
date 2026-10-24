import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writing Tools in Study mode: Clever AI's Detector and Humanizer in
// sandboxed frames. VibhavGPT has no writing-tools backend of its own.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the old /api/study detect and humanize endpoints are gone", () => {
  const server = read("src/server.js");
  assert.doesNotMatch(server, /\/api\/study|studyRouter|study\/router/);
  assert.doesNotMatch(read("frontend/src/components/StudyWritingTools.jsx"), /\/api\/study/, "nothing calls them");
  assert.doesNotMatch(read(".env.example"), /CLEVER_AI_API/, "no settings left for them");
});

// The Writing Tools screen embeds Clever AI's Detector and Humanizer as
// sandboxed frames, compiled with the frontend's esbuild and rendered here.
async function renderTools(props = {}) {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import StudyWritingTools, { WIDGETS, embedUrl } from "./components/StudyWritingTools.jsx";
        export { WIDGETS, embedUrl };
        export const render = (props) => renderToStaticMarkup(<StudyWritingTools {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const dir = mkdtempSync(join(tmpdir(), "writing-tools-"));
  try {
    const file = join(dir, "tools.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    const module = createRequire(import.meta.url)(file);
    return { ...module, html: module.render(props) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DETECTOR_URL = "https://widgets.cleverhumanizer.ai/embed/95f9d2d141d74ec580880c266b813f7b?theme=light";
const HUMANIZER_URL = "https://widgets.cleverhumanizer.ai/embed/1e5f37671c4f49c696409a6a12345c5f?theme=light";
const frames = (html) => [...html.matchAll(/<div class="writing-tools-widget-wrapper" style="display:(block|none)" data-tab="(\w+)"><iframe ([^>]*)><\/iframe><\/div>/g)]
  .map(([, display, tab, attributes]) => ({ display, tab, attributes }));

test("both Clever AI tools are sandboxed frames on their exact light-theme embed URLs", async () => {
  const { html, WIDGETS, embedUrl } = await renderTools();
  assert.deepEqual(WIDGETS.map((widget) => embedUrl(widget.id)), [DETECTOR_URL, HUMANIZER_URL]);
  const [detector, humanizer] = frames(html);
  assert.equal(detector.tab, "detector");
  assert.equal(humanizer.tab, "humanizer");
  assert.ok(detector.attributes.includes(`src="${DETECTOR_URL}"`), "the Detector frame's URL");
  assert.ok(humanizer.attributes.includes(`src="${HUMANIZER_URL}"`), "the Humanizer frame's URL");
  for (const { attributes } of [detector, humanizer]) {
    assert.match(attributes, /loading="lazy"/);
    assert.match(attributes, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/);
    assert.doesNotMatch(attributes, /allow-top-navigation|allow-modals/, "nothing more than the four permissions");
    assert.match(attributes, /style="width:100%;height:600px;border:none;display:block"/);
  }
  assert.match(detector.attributes, /title="AI Detector"/);
  assert.match(humanizer.attributes, /title="AI Humanizer"/);
});

test("switching tabs only hides a frame: both stay mounted, so nothing reloads or loses its text", async () => {
  const { html } = await renderTools();
  assert.deepEqual(frames(html).map(({ tab, display }) => `${tab}:${display}`), ["detector:block", "humanizer:none"], "the active tab's frame shows, the other is mounted but hidden");
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  assert.match(component, /\{WIDGETS\.map\(\(widget\) => <WidgetFrame key=\{widget\.tab\} widget=\{widget\} visible=\{tab === widget\.tab\} \/>\)\}/, "every frame always renders; only visibility follows the tab");
  assert.match(component, /style=\{\{ display: visible \? "block" : "none" \}\}/);
});

test("Clever AI's script never runs on the page; only verified resize messages from its frames are accepted", () => {
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  assert.doesNotMatch(component, /widget\.js|<script|createElement\(["']script|dangerouslySetInnerHTML/, "no third-party code on the page");
  assert.match(component, /event\.source !== node\.contentWindow \|\| event\.origin !== WIDGET_ORIGIN \|\| event\.data\?\.channel !== channel \|\| event\.data\?\.type !== "clever:resize"/);
  assert.match(component, /postMessage\(\{ type: "clever:init", channel, scheme: "light" \}, WIDGET_ORIGIN\)/, "the init message goes only to the widget's origin");
  assert.match(component, /next >= 100 && next <= 20000/, "heights are bounded");
});

test("the screen keeps the VibhavGPT header and tells people Clever AI handles their text", async () => {
  const { html } = await renderTools({ onBack: () => {} });
  assert.match(html, /Back to Study<\/button>/);
  assert.doesNotMatch(html, /writing-tools__eyebrow|writing-tools__title|VIBHAVGPT WRITING TOOLS/i, "no kicker or duplicate title above the tool");
  assert.match(html, /<span>AI Detector<\/span>[\s\S]*<span>AI Humanizer<\/span>/);
  assert.match(html, /<p class="writing-tools__notice">Writing tools run via Clever AI\. Text processed through these tools is handled according to provider guidelines and does not affect your VibhavGPT chat history\.<\/p>/);
  assert.doesNotMatch(html, /VibhavGPT AI Detector|VibhavGPT Humanizer/, "Clever's tools aren't presented as VibhavGPT's own");
  assert.match(read("frontend/src/App.jsx"), /writingToolsOpen \? <div className="writing-tools-scroll"><StudyWritingTools api=\{api\}/, "it lives in Study mode, in its own scroll area");
});

test("the Privacy Policy discloses that Clever AI processes Writing Tools text", () => {
  const knowledge = read("frontend/src/product-knowledge.js");
  assert.match(knowledge, /The Writing Tools in Study \(the AI Detector and the AI Humanizer\) are provided by Clever AI and run in a window served by Clever AI: text you enter in them goes directly to Clever AI, is processed under Clever AI's own data policies, and is not saved with your VibhavGPT conversations or chat history\./);
});

test("each frame sits in a white card that never clips it, so the widget's footer shows", () => {
  const css = read("frontend/src/writing-tools.css");
  assert.match(css, /\.writing-tools-widget-wrapper \{[^}]*max-width: 820px;[^}]*border-radius: 16px;[^}]*border: 1px solid rgba\(0, 0, 0, 0\.08\);[^}]*background: #ffffff;[^}]*box-shadow: 0 4px 20px rgba\(0, 0, 0, 0\.06\);/);
  assert.match(css, /\.writing-tools__notice \{[^}]*margin: 14px auto 0;[^}]*font-size: 13px;[^}]*line-height: 1\.5;[^}]*color: var\(--color-muted\);[^}]*text-align: center;/);
  assert.doesNotMatch(css, /position: absolute|pointer-events: none|::after|::before/, "no overlay or mask over the frame");
  assert.match(css, /@media \(max-width: 760px\)/, "it adapts to phones, at the app's phone width");
});

test("the tools scroll inside Study's fixed-height column, well past the end of the widget", () => {
  const css = read("frontend/src/writing-tools.css");
  assert.match(css, /\.writing-tools-scroll \{\s*flex: 1;\s*min-height: 0;\s*height: 100%;\s*overflow-y: auto;/, "a scroll area that fills the column");
  assert.match(css, /\.writing-tools \{[^}]*padding: var\(--space-sm\) var\(--space-md\) 80px;/, "a short top, 80px of room at the bottom");
  assert.doesNotMatch(css, /max-height/, "nothing caps a frame's height");
  assert.match(read("frontend/src/styles.css"), /\.workspace__main\[data-product-mode="study"\] > \.screen \{ display: flex; flex: 1; flex-direction: column; min-height: 0; \}/, "the column the scroll area fills");
  const component = read("frontend/src/components/StudyWritingTools.jsx");
  assert.match(component, /\{WIDGETS\.map\(\(widget\) => <WidgetFrame key=\{widget\.tab\}/, "both frames get the resize listener");
  assert.match(component, /setHeight\(next\)/);
});

test("Settings rows and groups have room to breathe on wider screens", () => {
  const css = read("frontend/src/settings.css");
  const block = css.slice(css.lastIndexOf("@media (min-width: 761px) {"));
  assert.match(block, /\.settings-row \{ gap: 10px 16px; padding: 16px 20px;/);
  assert.match(block, /\.settings-stack \{ gap: 40px; \}/);
  assert.match(block, /\.settings-group__head \{ margin-bottom: 12px; \}/);
  assert.match(block, /\.settings-row__text \{ gap: 4px; \}/, "help text sits clearly under its label");
});
