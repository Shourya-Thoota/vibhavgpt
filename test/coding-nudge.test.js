import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// The coding nudge suggested switching to Nebula. Nebula was retired on 2026-11-14, so the nudge is gone and nothing
// in the chat suggests a retired model.
test("the chat never suggests switching to a retired model", async () => {
  const source = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.equal(existsSync(new URL("../frontend/src/coding-nudge.js", import.meta.url)), false);
  assert.doesNotMatch(source, /codingNudge|Switch to Nebula|Switch to Nova|changeModel\("(nebula|nova)"\)/);
});
