import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

// With AI credits active, what a person is told about their allowance is credits released weekly (and carried or expired by policy). It is
// not "15 AI requests in any 24 hours", a daily or five-hour limit, or a monthly token cap: those are the older rules, still supported and still
// stated, unchanged, when credits are off. This guards both halves: credit mode never claims the old limits, and legacy mode keeps them.

const { productKnowledgeFor } = await import("../frontend/src/product-knowledge.js");
const { comparisonGroupsFor } = await import("../frontend/src/plan-comparison.js");
const { creditsPricingFootnote } = await import("../frontend/src/credits-copy.js");
const { pricingFaqFor } = await import("../frontend/src/public-pages.js");
const { usageOverviewView } = await import("../frontend/src/usage-overview-view.js");
const { usagePayload } = await import("./support/usage-fixture.js");

// What no credit-mode screen or product explanation may say.
const LEGACY_CLAIM = /15 (AI )?(requests|prompts)|24[- ]hour|per day|a day\b|daily|five-hour|5-hour|rolling|\btokens?\b|\$0\.25/i;
// The Usage screen says things about real dates ("each month") that the pattern above would be too broad for, so it is held to the claims
// that are specifically the older rules.
const LEGACY_USAGE_CLAIM = /15 (AI )?(requests|prompts)|24[- ]hour|daily|five-hour|5-hour|\btokens?\b/i;
const CREDIT_MODES = ["carry", "expiry"];

for (const mode of CREDIT_MODES) {
  test(`credit mode (${mode}): plans, terms, credits, FAQ, comparison and footnote make no legacy-limit claim`, () => {
    const knowledge = productKnowledgeFor(mode);
    const parts = {
      plans: knowledge.plans,
      terms: knowledge.terms,
      credits: knowledge.credits,
      thinkingEffort: knowledge.thinkingEffort,
      faq: pricingFaqFor(mode),
      comparison: comparisonGroupsFor(mode),
      footnote: creditsPricingFootnote(mode),
    };
    for (const [name, value] of Object.entries(parts)) {
      const text = JSON.stringify(value);
      const found = [...text.matchAll(new RegExp(LEGACY_CLAIM.source, "gi"))].map((m) => text.slice(Math.max(0, m.index - 50), m.index + 60));
      assert.deepEqual(found, [], `${mode}/${name} still states an older limit`);
    }
  });

  test(`credit mode (${mode}): each plan's principal allowance is its AI credits, as the policy releases them`, () => {
    const plans = productKnowledgeFor(mode).plans;
    for (const plan of plans) {
      assert.match(plan.features[0], /^\d+ AI credits/, `${plan.id}: the first thing a plan says is its credits`);
      assert.match(plan.features[0], /week/i, `${plan.id}: and that they arrive weekly`);
    }
  });

  test(`credit mode (${mode}): the Usage screen for a Free account speaks in credits only`, () => {
    const view = usageOverviewView(usagePayload({ tier: "free", carryMode: mode, spentCredits: 1, imagesUsed: 1 }), { locale: "en-US", timeZone: "UTC" });
    const text = JSON.stringify({ chat: view.chat, images: view.images, documents: view.documents, extra: view.extra });
    assert.doesNotMatch(text, LEGACY_USAGE_CLAIM, "no daily, five-hour or token wording on the Usage screen");
    assert.match(JSON.stringify(view.chat), /AI credits/);
  });
}

test("legacy mode still states the older rules, unchanged (intentionally supported)", () => {
  const free = productKnowledgeFor(null).plans.find((plan) => plan.id === "free");
  assert.match(JSON.stringify(free), /15 AI requests in any 24-hour period/);
  const row = comparisonGroupsFor(null).find((group) => group.title === "Monthly allowance").rows[0];
  assert.match(row.values[0], /15 AI requests in any 24 hours/);
  assert.match(JSON.stringify(pricingFaqFor(null)), /24-hour period/);
});
