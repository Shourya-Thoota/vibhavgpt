import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceRegistry, groundCitations } from "../src/search/citations.js";

// The manually checked citation evaluation set (test/fixtures/citation-eval.json, docs/evals/citations.md): real retrieved sources, a
// candidate claim per sentence, and a reader's verdict on whether the cited excerpt supports it. This holds the automated support check
// to what was recorded, and keeps its limits visible: a structural check is not proof that a source supports a claim.
const evalSet = JSON.parse(readFileSync(new URL("./fixtures/citation-eval.json", import.meta.url), "utf8"));

for (const { question, sources, claims } of evalSet.cases) {
  test(`eval: ${question}`, () => {
    const registry = new SourceRegistry();
    registry.addSearch({ results: sources });
    for (const claim of claims) {
      const { text, removed } = groundCitations(claim.sentence, registry.list(), { evidence: registry.evidence() });
      const kept = /\[\d+\]/.test(text);
      assert.equal(kept ? "kept" : "removed", claim.automated, `${claim.sentence} -> ${text}`);
      if (claim.automated === "removed") {
        assert.ok(removed.unsupported > 0, "counted as an unsupported citation");
        assert.equal(text, claim.sentence.replace(/ ?\[\d+\]/g, ""), "the claim stays, its citations go");
      }
    }
  });
}

test("eval summary: no supported claim loses its citation, and the only unsupported citations kept are the documented limits", () => {
  const claims = evalSet.cases.flatMap((entry) => entry.claims);
  const falseRemovals = claims.filter((c) => c.manual === "supported" && c.automated === "removed");
  const missed = claims.filter((c) => c.manual === "unsupported" && c.automated === "kept");
  assert.equal(falseRemovals.length, 0, "a supported claim must keep its citation");
  assert.equal(claims.filter((c) => c.manual === "unsupported" && c.automated === "removed").length, 3, "invented figures and dates are caught (7,300 tonnes, 1676, 44 mm)");
  // A claim with no number, and a misattributed number that the excerpt does contain: the automated check cannot see either.
  assert.deepEqual(missed.map((c) => c.sentence), [
    "It is the most romantic monument in Europe [1].",
    "A 2005 survey measured 8,850 metres [1].",
  ]);
  for (const c of claims) assert.ok(c.why.length > 20, "every verdict records its reason");
  for (const source of evalSet.cases.flatMap((entry) => entry.sources)) assert.ok(source.content.length <= 400, "excerpts stay short");
});
