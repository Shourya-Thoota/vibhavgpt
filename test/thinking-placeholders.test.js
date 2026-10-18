import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// No filler: without real thinking, nothing offers a thinking drawer. These
// read the component source, since JSX does not run in plain Node.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
const app = read("../frontend/src/App.jsx");
const tool = read("../frontend/src/components/ui/thinking-tool.jsx");
const trace = read("../frontend/src/components/ui/reasoning-trace.jsx");

test("the waiting reply carries no placeholder text that could open as a drawer", () => {
  assert.ok(!app.includes("Working on your request."), "the generic filler is gone");
  const waiting = app.match(/<ThinkingTool state="thinking"[^\n]*\/>/)?.[0];
  assert.ok(waiting, "found the waiting status");
  assert.doesNotMatch(waiting, /content=/, "the waiting status has no drawer text");
  for (const filler of ["Checking web sources for your answer.", "Saving the result to your conversation.", "Longer documents take up to a minute."]) {
    assert.ok(!waiting.includes(filler), `"${filler}" is not in the waiting status`);
  }
  assert.match(waiting, /sources=\{liveSources\}/, "real web sources can still be opened");
  // The status only opens when it has real content or sources.
  assert.match(tool, /const expandable = Boolean\(content\?\.trim\(\) \|\| sources\.length\);/);
});

test("the thinking drawer and Thought for X s appear only with real thinking", () => {
  // Live: no thinking text, no block.
  assert.match(trace, /if \(live\) \{\n\s*if \(!hasText\) return null;/);
  // Finished: no thinking text and no seconds, nothing at all.
  assert.match(trace, /if \(seconds === null && !hasText\) return null;/);
  // Text present: an expandable "Thought for X s" control, in the same orb
  // pill as the live thinking status.
  assert.match(trace, /aria-expanded=\{open\}/);
  assert.match(trace, /<button type="button" className="thinking-tool__toggle" aria-expanded=\{open\}/);
  assert.match(trace, /const restingOrb = <span className="thinking-tool__orb" aria-hidden="true"><i \/><i \/><i \/><\/span>;/);
  assert.doesNotMatch(trace, /data-active/, "the finished orb is at rest");
  assert.match(trace, /const label = seconds === null \? "Thought" : thoughtLabel\(seconds\);/);
  // The live block and the finished tag are both driven only by streamed thinking.
  assert.match(app, /\{liveReasoning && !streamText && <ReasoningTrace text=\{liveReasoning\} live \/>\}/);
  assert.match(app, /\{liveReasoning && streamText && <ReasoningTrace text=\{liveReasoning\} seconds=\{liveThought\} \/>\}/);
  assert.match(app, /if \(!streamedAny && reasoningSoFar\) setLiveThought\(elapsedSeconds\(thinkingStartedAt\)\);/);
});
