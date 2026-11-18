import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TOKEN_QUOTAS } from "../frontend/src/token-quotas.js";
import { COMPARISON_GROUPS } from "../frontend/src/plan-comparison.js";
import { creditsAllowanceGroup } from "../frontend/src/credits-copy.js";
import { productKnowledgeFor, buildProductKnowledgeSystemPrompt } from "../frontend/src/product-knowledge.js";
import { assertModelPlanAccess } from "../src/usage/service.js";

// Vulcan is a Pro model (and Max's, when it launches). The picker, the profile router and the upgrade notice already say so; this keeps the
// plan table, the server's table-driven check and every line of public copy saying the same, in the legacy wording and in credits mode.
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the plan table gives Vulcan to Pro and Max only", () => {
  assert.deepEqual(TOKEN_QUOTAS.free.vesper, { monthly: 0, rolling: 0 });
  assert.deepEqual(TOKEN_QUOTAS.plus.vesper, { monthly: 0, rolling: 0 }, "Plus has no Vulcan allowance");
  assert.ok(TOKEN_QUOTAS.pro.vesper.monthly > 0 && TOKEN_QUOTAS.pro.vesper.rolling > 0);
  assert.ok(TOKEN_QUOTAS.max.vesper.monthly > 0 && TOKEN_QUOTAS.max.vesper.rolling > 0);
});

test("the server's table-driven plan check refuses Plus for Vulcan and says Pro", () => {
  assert.throws(() => assertModelPlanAccess("plus", "vesper"), (error) => error.reason === "plan" && error.requiredPlan === "Pro or Max" && error.feature === "Vulcan", "Plus is refused, and told to choose Pro");
  assert.doesNotThrow(() => assertModelPlanAccess("pro", "vesper"));
  assert.doesNotThrow(() => assertModelPlanAccess("max", "vesper"));
  assert.throws(() => assertModelPlanAccess("free", "vesper"), (error) => error.requiredPlan === "Pro or Max");
});

test("the pricing table shows no Plus Vulcan allowance, in the legacy wording and in credits mode", () => {
  const legacy = COMPARISON_GROUPS.find((g) => g.title === "Monthly allowance").rows.find((r) => r.label === "Vulcan");
  assert.equal(legacy.values[0], null, "Free");
  assert.equal(legacy.values[1], null, "Plus: no allowance");
  assert.match(legacy.values[2], /^\d/, "Pro has a number");
  assert.equal(legacy.values[3], "Included", "Max");
  const credits = creditsAllowanceGroup().rows.find((r) => r.label === "Vulcan");
  assert.deepEqual(credits.values, [null, null, "Included", "Included"], "credits mode: Pro and Max only");
  // Nebula was retired on 2026-11-14 and has no row.
  assert.equal(creditsAllowanceGroup().rows.find((r) => r.label === "Nebula"), undefined);
});

// Every clause that names Vulcan must not also name Plus, except to say it is not on Plus. The clauses are cut at commas and full stops.
const clausesAboutVesper = (text) => String(text).split(/[.;,\n]/).filter((clause) => /Vulcan/.test(clause));

test("no public statement says Plus includes Vulcan, in either wording", () => {
  for (const mode of [null, "carry", "expiry"]) {
    const knowledge = productKnowledgeFor(mode);
    const label = mode ?? "legacy";
    const plus = knowledge.plans.find((p) => p.id === "plus");
    const pro = knowledge.plans.find((p) => p.id === "pro");
    const free = knowledge.plans.find((p) => p.id === "free");
    assert.doesNotMatch([...plus.features, ...plus.details, plus.description].join(" "), /300K|Vulcan (300|is included|included)/, `${label}: Plus lists no Vulcan allowance`);
    assert.match(free.details.join(" "), /Vulcan requires Pro, and Zenith requires Max\./, `${label}: Free's note`);
    assert.match([...pro.features, ...pro.details].join(" ") + (mode ? " Vulcan" : ""), /Vulcan/, `${label}: Pro still lists Vulcan`);
    // Vulcan is Pro and up, never Plus; Zenith is Max.
    assert.match(knowledge.thinkingEffort, /Pro provides thinking-effort controls for Vulcan, and Max for Vulcan and Zenith\./, `${label}: thinking effort`);
    for (const text of [JSON.stringify(plus), knowledge.thinkingEffort, buildProductKnowledgeSystemPrompt({ creditsMode: mode })]) {
      for (const clause of clausesAboutVesper(text)) {
        if (!/Plus/.test(clause)) continue;
        assert.match(clause, /(not|requires Pro|on Pro)/i, `${label}: "${clause.trim().slice(0, 120)}" must not give Vulcan to Plus`);
      }
    }
  }
});

test("the sources that write public copy do not name Vulcan beside Plus", () => {
  for (const file of ["frontend/src/product-knowledge.js", "frontend/src/credits-copy.js", "frontend/src/plan-comparison.js", "frontend/src/public-pages.js", "frontend/src/Legal.jsx"]) {
    const text = read(file).replace(/\/\/.*$/gm, "");
    for (const clause of clausesAboutVesper(text.replace(/`[^`]*\$\{[^}]*\}[^`]*`/g, (m) => m))) {
      if (!/Plus/.test(clause)) continue;
      assert.match(clause, /(not|requires Pro|on Pro)/i, `${file}: "${clause.trim().slice(0, 120)}"`);
    }
  }
});

test("the picker, the profile router and the notice still say Pro, and the chat router still refuses Plus", () => {
  // Slice 7: the picker's least plan per model is the shared lineup's (HOUSE_MIN_PLAN): Vulcan is Pro, Zenith is Max.
  assert.match(read("frontend/src/App.jsx"), /minTier: HOUSE_MIN_PLAN\[entry\.value\]/);
  assert.match(read("frontend/src/model-marketplace.js"), /vesper: "pro", zenith: "max"/);
  assert.match(read("src/profile/router.js"), /if \(tier === "plus"\) return canonical !== "vesper";/);
  assert.match(read("frontend/src/components/notice/WorkspaceNotice.jsx"), /feature === "Vulcan" \? "Pro"/);
  assert.match(read("src/chat/router.js"), /plan === "plus" && \(calculatedMu > 7\.00/);
  assert.match(read("src/usage/plan-throttle-policy.js"), /Plus tier profiles are strictly forbidden from executing Extra High tier models/);
});
