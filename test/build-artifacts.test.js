// Build's file protocol (src/build/artifacts.js) and the streamed view of it (frontend/src/build-stream.js). Synthetic replies only.
import test from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_LIMITS, extractBuildArtifact, safeProjectPath } from "../src/build/artifacts.js";
import { visibleBuildStream } from "../frontend/src/build-stream.js";

const file = (path, content) => `<<<FILE path="${path}">>>\n${content}\n<<<END FILE>>>`;
const project = (files, { kind = "web", entry = "index.html", before = "I made a simple page.", after = "" } = {}) =>
  [before, `<<<PROJECT kind="${kind}" entry="${entry}">>>`, ...files, after].filter(Boolean).join("\n");

test("a complete project is read as files, and the summary the person sees has none of their contents", () => {
  const reply = project([file("index.html", "<!doctype html><title>Hi</title><script src=\"app.js\"></script>"), file("app.js", "console.log('hi');"), file("css/style.css", "body{margin:0}")]);
  const out = extractBuildArtifact(reply);
  assert.equal(out.status, "files");
  assert.equal(out.kind, "web");
  assert.equal(out.entry, "index.html");
  assert.deepEqual(out.files.map((f) => f.path), ["app.js", "css/style.css", "index.html"]);
  assert.equal(out.files.find((f) => f.path === "app.js").content, "console.log('hi');");
  assert.equal(out.reply, "I made a simple page.");
  assert.doesNotMatch(out.reply, /<<<|console\.log|doctype/);
  assert.equal(out.totalBytes, out.files.reduce((sum, f) => sum + f.bytes, 0));
});

test("a reply without markers is just a reply (a question, an explanation)", () => {
  const out = extractBuildArtifact("Who is the habit tracker for, and should it work offline?");
  assert.deepEqual(out, { status: "none", reply: "Who is the habit tracker for, and should it work offline?" });
});

test("a cut-off reply, a file without its end, or a missing project line is refused whole", () => {
  const good = project([file("index.html", "<p>ok</p>")]);
  assert.equal(extractBuildArtifact(good, { cutOff: true }).status, "invalid", "cut off by the length limit");
  assert.match(extractBuildArtifact(good, { cutOff: true }).problem, /cut off/);
  const unfinished = project([`<<<FILE path="index.html">>>\n<p>half`]);
  assert.match(extractBuildArtifact(unfinished).problem, /middle of a file/);
  assert.match(extractBuildArtifact(`Here.\n${file("index.html", "<p/>")}`).problem, /project line/);
  for (const bad of [unfinished]) assert.doesNotMatch(extractBuildArtifact(bad).reply, /<p>half/);
});

test("unsafe or unsupported paths, duplicates, unknown kinds and missing entries are refused", () => {
  for (const path of ["../secret.txt", "/etc/passwd", "C:/x.js", "a\\b.js", "a/../b.js", "./x.js", "a//b.js", ".env", "a/.git/config", "x".repeat(200) + ".js", "a/b/c/d/e/f/g.js"]) {
    assert.equal(safeProjectPath(path), null, path);
    assert.equal(extractBuildArtifact(project([file("index.html", "<p/>"), file(path, "x")])).status, "invalid", path);
  }
  assert.equal(extractBuildArtifact(project([file("index.html", "a"), file("INDEX.html", "b")])).status, "invalid", "a duplicate, ignoring case");
  assert.match(extractBuildArtifact(project([file("index.html", "a"), file("app.exe", "MZ")])).problem, /not a file type/);
  assert.match(extractBuildArtifact(project([file("index.html", "a")], { kind: "python" })).problem, /not a project type/);
  assert.match(extractBuildArtifact(project([file("main.js", "a")])).problem, /entry file/);
  assert.equal(safeProjectPath("src/components/App.jsx"), "src/components/App.jsx");
  assert.equal(safeProjectPath(".gitignore"), ".gitignore");
});

test("size and count limits are enforced on the whole set", () => {
  const big = "x".repeat(ARTIFACT_LIMITS.maxFileBytes + 1);
  assert.match(extractBuildArtifact(project([file("index.html", big)])).problem, /larger than/);
  const many = Array.from({ length: ARTIFACT_LIMITS.maxFiles + 1 }, (_, i) => file(i ? `f${i}.js` : "index.html", "x"));
  assert.match(extractBuildArtifact(project(many)).problem, /Build keeps up to/);
  const total = Array.from({ length: 4 }, (_, i) => file(i ? `f${i}.js` : "index.html", "y".repeat(ARTIFACT_LIMITS.maxFileBytes - 10)));
  assert.match(extractBuildArtifact(project(total)).problem, /The project is larger than/);
});

test("while it streams, Build shows the summary and a line per file, never the raw files", () => {
  const partial = `Making it now.\n<<<PROJECT kind="web" entry="index.html">>>\n<<<FILE path="index.html">>>\n<!doctype html>\n<<<END FILE>>>\n<<<FILE path="app.js">>>\nconst secret = 1`;
  const shown = visibleBuildStream(partial);
  assert.match(shown, /Making it now\./);
  assert.match(shown, /Wrote index\.html/);
  assert.match(shown, /Writing app\.js…/);
  assert.doesNotMatch(shown, /doctype|const secret|<<</);
  assert.doesNotMatch(visibleBuildStream("Almost there <<<FI"), /<<</, "a marker still arriving is held back");
});
