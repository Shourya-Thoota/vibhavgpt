import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPARISON_GROUPS } from "../frontend/src/plan-comparison.js";

// The site-wide accuracy audit (2026-11-15) found two strings that still described retired models. They must describe what runs now.
const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");

test("the thinking levels describe the level, not a retired model, and Low is not called thinking-free", () => {
  const options = app.slice(app.indexOf("const THINKING_OPTIONS = ["), app.indexOf("];", app.indexOf("const THINKING_OPTIONS = [")));
  assert.doesNotMatch(options, /\b(?:Nova|Nebula)\b/, "no retired model is named");
  // Low maps to the provider's low reasoning level (chat/reasoning-effort.js: low -> "low"), which still thinks.
  assert.match(options, /value: "low", label: "Low", description: "Fastest replies, with the least thinking first\."/);
  assert.doesNotMatch(options, /without thinking/);
});

test("the plan comparison footnote names the models Free actually shares its allowance between", () => {
  const footnote = app.slice(app.indexOf('<p className="compare__footnote">'), app.indexOf("</p>", app.indexOf('<p className="compare__footnote">')));
  const freeRows = COMPARISON_GROUPS[0].rows.filter((row) => /shared|Shares the Free allowance/i.test(String(row.values[0] ?? ""))).map((row) => row.label);
  assert.deepEqual(freeRows, ["Lumen", "Study"], "the comparison table's Free models");
  assert.match(footnote, /Lumen and Study share this allowance/);
  assert.doesNotMatch(footnote, /\bNova\b/, "Nova was retired on 2026-11-14");
});
