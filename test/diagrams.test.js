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
        import DiagramViewer from "./components/DiagramViewer.jsx";
        export const viewer = (props) => renderToStaticMarkup(<DiagramViewer {...props} />);`,
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
  assert.match(viewer, /const \{ default: mermaid \} = await import\("mermaid"\);/, "loaded only when a reply has a diagram");
  assert.doesNotMatch(viewer, /^import .*from "mermaid";/m);
  assert.doesNotMatch(read("frontend/src/App.jsx"), /from "mermaid"/);
  assert.deepEqual({ ...MERMAID_CONFIG }, { startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: "inherit" });
  assert.match(viewer, /if \(!\(await mermaid\.parse\(source, \{ suppressErrors: true \}\)\)\) throw new Error\("invalid"\);/);
  assert.match(viewer, /if \(state\.status === "error"\) return fallback;/);
  assert.match(viewer, /document\.getElementById\(`d\$\{id\}`\)\?\.remove\(\);/, "mermaid's error graphic is cleared");
  assert.match(viewer, /attributeFilter: \["data-theme"\]/, "redrawn when the theme changes");
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
  assert.match(css, /@media \(max-width: 640px\) \{\n\s*\.diagram-viewer__action \{ min-height: 44px; \}/);
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
