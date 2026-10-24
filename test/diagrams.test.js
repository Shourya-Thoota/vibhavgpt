import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGRAM_FORMAT, isDiagramLanguage, MERMAID_CONFIG, mermaidThemeVariables } from "../frontend/src/diagrams.js";

// ```mermaid blocks in replies are drawn as diagrams. Mermaid itself loads
// only when a reply has one, runs in strict mode, and takes the theme's
// colours; a block still arriving is a placeholder, and one mermaid can't
// read falls back to the ordinary code block.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function renderViewer() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import DiagramViewer, { DiagramFailed, DiagramSource } from "./components/DiagramViewer.jsx";
        export * from "./components/DiagramViewer.jsx";
        export const viewer = (props) => renderToStaticMarkup(<DiagramViewer {...props} />);
        export const source = (props) => renderToStaticMarkup(<DiagramSource {...props} />);
        export const failed = (props) => renderToStaticMarkup(<DiagramFailed {...props} />);`,
      resolveDir: new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
    external: ["mermaid"], define: { "process.env.NODE_ENV": '"production"' },
  });
  const dir = mkdtempSync(join(tmpdir(), "diagram-viewer-"));
  try {
    const file = join(dir, "viewer.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mermaid blocks become diagrams; other code stays code", () => {
  assert.equal(isDiagramLanguage("mermaid"), true);
  assert.equal(isDiagramLanguage("Mermaid"), true);
  assert.equal(isDiagramLanguage("javascript"), false);
  const app = read("frontend/src/App.jsx");
  assert.match(app, /if \(isDiagramLanguage\(language\)\) return <DiagramBlock text=\{text\} fallback=\{block\} \/>;/);
  assert.match(app, /function DiagramBlock\(\{ text, fallback \}\) \{\n\s*const settled = useContext\(ReplySettledContext\);\n\s*return <DiagramViewer source=\{text\} settled=\{settled\} fallback=\{fallback\} \/>;/);
});

test("while a reply is arriving the diagram is a placeholder; once it has, it draws with copy and full-screen actions", async () => {
  const { viewer } = await renderViewer();
  const source = "flowchart TD\n  A --> B";
  assert.equal(viewer({ source, settled: false, fallback: null }), '<div class="diagram-viewer diagram-viewer--pending" role="status">Drawing your diagram...</div>', "half a diagram is never drawn");
  const settled = viewer({ source, settled: true, fallback: null });
  assert.match(settled, /<figure class="diagram-viewer" data-status="pending">/);
  assert.match(settled, /Copy source<\/button>/);
  assert.match(settled, /<button type="button" class="diagram-viewer__action" disabled="">.*Full screen<\/button>/, "full screen waits for the drawing");
  assert.match(settled, /diagram-viewer__canvas--loading" role="status">Drawing your diagram\.\.\./);
});

test("mermaid loads on demand in strict mode, and syntax it can't read falls back to the code block", () => {
  const viewer = read("frontend/src/components/DiagramViewer.jsx");
  assert.match(viewer, /load = \(\) => import\("mermaid"\)/, "loaded only when a diagram is drawn");
  assert.equal(viewer.match(/import\("mermaid"\)/g).length, 1, "and from nowhere else");
  assert.match(viewer, /const \{ default: mermaid \} = await load\(\);/);
  assert.doesNotMatch(viewer, /^import .*from "mermaid";/m);
  assert.doesNotMatch(read("frontend/src/App.jsx"), /from "mermaid"/);
  assert.deepEqual({ ...MERMAID_CONFIG }, { startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: "inherit" });
  assert.match(viewer, /if \(!\(await mermaid\.parse\(source, \{ suppressErrors: true \}\)\)\) throw new Error\("invalid"\);/);
  assert.match(viewer, /if \(state\.status === "error"\) return <DiagramFailed fallback=\{fallback\} \/>;/);
  assert.match(viewer, /doc\?\.getElementById\?\.\(`d\$\{id\}`\)\?\.remove\(\);/, "mermaid's error graphic is cleared");
  assert.match(viewer, /attributeFilter: APPEARANCE_ATTRIBUTES/, "redrawn when the theme or accent changes");
  assert.match(viewer, /setZoom\(\(value\) => Math\.min\(3, value \+ 0\.25\)\)/);
  assert.ok(JSON.parse(read("frontend/package.json")).dependencies.mermaid, "a frontend dependency");
});

test("diagram colours come from the theme tokens, resolved to real colours", () => {
  const seen = [];
  const probe = { style: {}, remove() { seen.push("removed"); } };
  const doc = {
    body: { append: () => seen.push("added") },
    createElement: () => probe,
    defaultView: { getComputedStyle: (element) => ({ color: `resolved(${element.style.color})` }) },
  };
  const variables = mermaidThemeVariables(doc);
  assert.equal(variables.primaryTextColor, "resolved(var(--color-ink))");
  assert.equal(variables.primaryBorderColor, "resolved(var(--color-accent))");
  assert.equal(variables.background, "resolved(var(--color-paper-2))");
  assert.deepEqual(seen, ["added", "removed"], "the probe is cleaned up");
  assert.deepEqual(mermaidThemeVariables({}), {});
  const css = read("frontend/src/diagrams.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "tokens only");
  assert.match(css, /\.diagram-viewer__canvas \{[^}]*overflow: auto;/, "wide diagrams scroll inside the reply");
  assert.match(css, /@media \(max-width: 760px\) \{\n\s*\.diagram-viewer__action \{ min-height: 44px; \}/, "full-size toolbar targets at the app's phone width");
  assert.doesNotMatch(css, /max-width: 640px/);
});

test("every tier and Study are told to write diagrams as mermaid blocks", async () => {
  const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");
  const { studyPrompt } = await import("../src/chat/study.js");
  assert.match(DIAGRAM_FORMAT, /one fenced code block with the language mermaid, using standard Mermaid syntax/);
  assert.match(DIAGRAM_FORMAT, /To change an earlier diagram, write the whole updated block again\./);
  for (const tier of ["lumen", "nova", "nebula", "vesper", "study"]) assert.ok(buildIdentitySystemPrompt(tier, { query: "Draw a flowchart of photosynthesis" }).includes(DIAGRAM_FORMAT), tier);
  assert.ok(studyPrompt("study").includes(DIAGRAM_FORMAT));
  assert.doesNotMatch(DIAGRAM_FORMAT, /—|–/);
});

// The real reply renderer (AssistantBody in App.jsx, exposed to this test only
// by an in-memory export), rendered on the server. Mermaid itself is never loaded.
async function renderReply() {
  const require = createRequire(new URL("../frontend/package.json", import.meta.url));
  const esbuild = require("esbuild");
  const { basename, dirname, resolve } = await import("node:path");
  const srcDir = resolve(new URL("../frontend/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderToStaticMarkup } from "react-dom/server";
        import { AssistantBody } from "./App.jsx";
        export const reply = (text) => renderToStaticMarkup(<AssistantBody text={text} animate={false} />);`,
      resolveDir: srcDir,
      loader: "jsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", logLevel: "silent",
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty", ".woff2": "empty" },
    external: ["mermaid"], define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "expose-reply", setup(build) {
      build.onLoad({ filter: /App\.jsx$/ }, (args) => (basename(args.path) === "App.jsx" && resolve(dirname(args.path)) === srcDir
        ? { contents: `${readFileSync(args.path, "utf8")}\nexport { AssistantBody };\n`, loader: "jsx" }
        : undefined));
    } }],
  });
  const dir = mkdtempSync(join(tmpdir(), "diagram-reply-"));
  try {
    const file = join(dir, "reply.cjs");
    writeFileSync(file, result.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("two mermaid blocks and one code block in a reply make two diagrams and one code block", async () => {
  const { reply } = await renderReply();
  const html = reply("Here:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```js\nconst x = 1;\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\nAnd `mermaid` inline stays text.");
  assert.equal(html.match(/class="diagram-viewer[" ]/g)?.length, 2, "two diagrams");
  assert.equal(html.match(/class="code-block"/g)?.length, 1, "one ordinary code block");
  assert.match(html, /<span class="code-block__language">js<\/span>/);
  assert.match(html, /<p>And <code[^>]*>mermaid<\/code> inline stays text\.<\/p>/, "inline code is never a diagram");
  const plain = reply("No diagrams here.\n\n```python\nprint(1)\n```");
  assert.doesNotMatch(plain, /diagram-viewer/, "a reply without a mermaid block has no viewer, so mermaid is never asked for");
  assert.equal(plain.match(/class="code-block"/g)?.length, 1);
});

class FakeIntersectionObserver {
  static made = [];
  constructor(callback, options) { this.callback = callback; this.options = options; this.observed = []; this.disconnected = false; FakeIntersectionObserver.made.push(this); }
  observe(node) { this.observed.push(node); }
  disconnect() { this.disconnected = true; }
  fire(isIntersecting) { this.callback([{ isIntersecting }]); }
}

test("a diagram is drawn only when it comes within 600px of view, and the watcher goes when it does", async () => {
  const { watchNearView, scrollRoot, NEAR_VIEW_MARGIN } = await renderViewer();
  assert.equal(NEAR_VIEW_MARGIN, "600px");
  const node = { id: "figure" }, root = { id: "thread" };
  let near = 0;
  const stop = watchNearView(node, () => { near += 1; }, { Observer: FakeIntersectionObserver, root });
  const observer = FakeIntersectionObserver.made.at(-1);
  assert.deepEqual(observer.options, { root, rootMargin: "600px" }, "measured against the scrolling thread, with a 600px margin");
  assert.deepEqual(observer.observed, [node]);
  observer.fire(false);
  assert.equal(near, 0, "far out of view: nothing drawn, mermaid never asked for");
  observer.fire(true);
  assert.equal(near, 1, "close to view: drawing starts");
  assert.equal(observer.disconnected, true, "and stops watching");

  const second = watchNearView(node, () => { near += 1; }, { Observer: FakeIntersectionObserver });
  second();
  assert.equal(FakeIntersectionObserver.made.at(-1).disconnected, true, "unmounting disconnects");
  let immediate = 0;
  watchNearView(node, () => { immediate += 1; }, { Observer: undefined });
  assert.equal(immediate, 1, "without IntersectionObserver it simply draws");

  const thread = { parentElement: null, overflow: "auto" };
  const figure = { parentElement: { parentElement: thread, overflow: "visible" } };
  assert.equal(scrollRoot(figure, { getComputedStyle: (element) => ({ overflowY: element.overflow }) }), thread, "the nearest scrolling ancestor");
  assert.equal(scrollRoot(figure, { getComputedStyle: () => ({ overflowY: "visible" }) }), null);

  const viewer = read("frontend/src/components/DiagramViewer.jsx");
  assert.match(viewer, /if \(!settled \|\| near\) return undefined;\s*const node = holderRef\.current;\s*return watchNearView\(node, \(\) => setNear\(true\), \{ root: scrollRoot\(node\) \}\);/, "the watcher's disconnect is the effect's cleanup");
  assert.match(viewer, /if \(!settled \|\| !near\) return undefined;\s*let cancelled = false;\s*drawDiagram\(\{ id, source \}\)/, "nothing is drawn, or loaded, before the reply arrives and the diagram is near");
  assert.match(viewer, /<figure ref=\{holderRef\} className="diagram-viewer"/);
});

test("drawing makes one attempt: it loads mermaid, draws, and on failure clears up without retrying", async () => {
  const { drawDiagram } = await renderViewer();
  const removed = [];
  const doc = { getElementById: (id) => ({ remove: () => removed.push(id) }) };
  const calls = [];
  const fakeMermaid = (parsed) => ({ default: {
    initialize: (options) => calls.push(["initialize", options.securityLevel]),
    parse: async () => { calls.push(["parse"]); return parsed; },
    render: async (id) => { calls.push(["render", id]); return { svg: "<svg>ok</svg>" }; },
  } });
  let loads = 0;
  assert.equal(await drawDiagram({ id: "d1", source: "flowchart TD\n A-->B", doc, load: async () => { loads += 1; return fakeMermaid(true); } }), "<svg>ok</svg>");
  assert.deepEqual(calls, [["initialize", "strict"], ["parse"], ["render", "d1"]]);
  assert.equal(loads, 1);

  calls.length = 0;
  await assert.rejects(drawDiagram({ id: "d2", source: "not a diagram", doc, load: async () => { loads += 1; return fakeMermaid(false); } }));
  assert.deepEqual(calls, [["initialize", "strict"], ["parse"]], "never rendered after a failed parse");
  assert.equal(loads, 2, "one load per attempt, no retry");
  assert.deepEqual(removed, ["d2", "dd2"], "mermaid's leftover error graphic is removed");
  await assert.rejects(drawDiagram({ id: "d3", source: "x", doc, load: async () => { throw new Error("chunk failed"); } }), /chunk failed/);

  const viewer = read("frontend/src/components/DiagramViewer.jsx");
  assert.match(viewer, /\}, \[source, settled, near, appearance, id\]\);/, "a new attempt only for new source, arrival, view or colours, never for its own result");
});

test("a diagram mermaid can't draw says so, above its source and Copy button", async () => {
  const { failed, DIAGRAM_FAILED_NOTE } = await renderViewer();
  assert.equal(DIAGRAM_FAILED_NOTE, "Couldn't draw this diagram; showing its source.");
  const { createElement } = createRequire(new URL("../frontend/package.json", import.meta.url))("react");
  const block = createElement("div", { className: "code-block" }, createElement("button", { className: "code-block__copy" }, "Copy"));
  const html = failed({ fallback: block });
  assert.match(html, /<p class="diagram-viewer-failed__note" role="note">Couldn(&#x27;|')t draw this diagram; showing its source\.<\/p>/);
  assert.match(html, /<div class="code-block"><button class="code-block__copy">Copy<\/button><\/div>/, "the original block stays, Copy and all");
});

test("Show source reveals the original block with its Copy button, and Hide source hides it", async () => {
  const { source, viewer } = await renderViewer();
  const { createElement } = createRequire(new URL("../frontend/package.json", import.meta.url))("react");
  const block = createElement("div", { className: "code-block" }, createElement("button", { className: "code-block__copy" }, "Copy"));
  const hidden = source({ shown: false, onToggle() {}, fallback: block });
  assert.match(hidden, /aria-expanded="false"[^>]*>.*Show source<\/button>/);
  assert.doesNotMatch(hidden, /code-block/, "hidden by default");
  const shown = source({ shown: true, onToggle() {}, fallback: block });
  assert.match(shown, /aria-expanded="true"[^>]*>.*Hide source<\/button>/);
  assert.match(shown, /<div class="diagram-viewer__source"><div class="code-block"><button class="code-block__copy">Copy<\/button><\/div><\/div>/);
  const component = read("frontend/src/components/DiagramViewer.jsx");
  assert.match(component, /\{state\.status === "ready" && <DiagramSource shown=\{showSource\} onToggle=\{\(\) => setShowSource\(\(shown\) => !shown\)\} fallback=\{fallback\} \/>\}/, "under each drawn diagram, toggling");
  assert.match(viewer({ source: "flowchart TD\n A-->B", settled: true, fallback: block }), /Copy source<\/button>/, "Copy source stays in the toolbar");
});

class FakeMutationObserver {
  static made = [];
  constructor(callback) { this.callback = callback; this.disconnected = false; FakeMutationObserver.made.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
}

test("diagrams are redrawn when either the sky or the accent colour changes", async () => {
  const { watchAppearance, appearanceKey, APPEARANCE_ATTRIBUTES } = await renderViewer();
  assert.deepEqual(APPEARANCE_ATTRIBUTES, ["data-theme", "data-accent"]);
  const attributes = { "data-theme": "dark", "data-accent": "cyan" };
  const doc = { documentElement: { getAttribute: (name) => attributes[name] ?? null } };
  assert.equal(appearanceKey(doc), "dark|cyan");
  const seen = [];
  const stop = watchAppearance((key) => seen.push(key), { doc, Observer: FakeMutationObserver });
  const observer = FakeMutationObserver.made.at(-1);
  assert.equal(observer.target, doc.documentElement);
  assert.deepEqual(observer.options, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  attributes["data-accent"] = "violet";
  observer.callback();
  attributes["data-theme"] = "light";
  observer.callback();
  assert.deepEqual(seen, ["dark|violet", "light|violet"], "each change schedules a redraw with the new colours");
  stop();
  assert.equal(observer.disconnected, true);
  const viewer = read("frontend/src/components/DiagramViewer.jsx");
  assert.match(viewer, /useEffect\(\(\) => watchAppearance\(setAppearance\), \[\]\);/);
  assert.match(viewer, /\[source, settled, near, appearance, id\]/, "the drawing depends on the appearance");
});
