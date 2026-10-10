import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const { categorizeFact, parseImportedFacts } = await import("../src/memory/service.js");

test("memory classifier uses product categories without inventing an area", () => {
  assert.deepEqual(categorizeFact("User prefers concise answers with examples."), { category: "preferences", area: null });
  assert.deepEqual(categorizeFact("User is studying calculus this semester."), { category: "academics", area: null });
  assert.deepEqual(categorizeFact("User likes Liverpool football."), { category: "interests", area: null });
  assert.deepEqual(categorizeFact("User lives in New York."), { category: "profile", area: null });
});

test("memory imports preserve headings as categories and named project areas", () => {
  const facts = parseImportedFacts(`
## Preferences
- Prefers concise answers.

## Academics
- Is studying topology.

## VibhavGPT
- Is rebuilding the memory page.
- Uses Railway for deployment.
`);

  assert.deepEqual(facts.map(({ category, area }) => ({ category, area })), [
    { category: "preferences", area: null },
    { category: "academics", area: null },
    { category: "area", area: "VibhavGPT" },
    { category: "area", area: "VibhavGPT" },
  ]);
  assert.equal(facts.some((fact) => /imported context/i.test(fact.content)), false);
});
