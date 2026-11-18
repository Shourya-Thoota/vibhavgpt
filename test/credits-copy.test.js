import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { format } from "node:util";

import { PRODUCT_KNOWLEDGE, buildProductKnowledgeAddendum, buildProductKnowledgeSystemPrompt, productKnowledgeFor } from "../frontend/src/product-knowledge.js";
import { COMPARISON_GROUPS, comparisonGroupsFor } from "../frontend/src/plan-comparison.js";
import { PUBLIC_PAGES, pricingFaqFor } from "../frontend/src/public-pages.js";
import {
  FLEX_DASHBOARD_BLURB_CREDITS,
  FLEX_DASHBOARD_BLURB_LEGACY,
  PUBLIC_CREDITS_MODE,
  USAGE_NAV_DESCRIPTION_LEGACY,
  USAGE_SETTINGS_ROW_LEGACY,
  creditsKnowledgeOverrides,
  creditsPolicySentence,
  creditsPricingFootnote,
  creditsPricingRule,
  usageNavDescription,
  usageSettingsDescription,
} from "../frontend/src/credits-copy.js";
import { MONTHLY_CREDITS, typicalWeeklyAllocation } from "../frontend/src/credits-policy.js";
import { checkCreditsCopyMatchesServer, describeCreditsMatch, startCreditsPolicySync } from "../frontend/src/credits-guard.js";
import { applyServerCreditsPolicy, currentCreditsMode, resetCreditsRuntime, subscribeCreditsMode } from "../frontend/src/credits-runtime.js";
import { metadataHtml, updateMetadata } from "../frontend/scripts/public-html.js";
import { compareCreditsDeployment, readPageCreditsCopy, readServerCredits } from "../scripts/verify-credits-consistency.js";

const MODES = ["expiry", "carry"];
// Words that belong to the superseded gates. None may describe an included allowance under credits.
const OLD_GATE_WORDS = /\btokens?\b|5-hour|five-hour|24-hour|24 hours|rolling|\$0\.25|15 AI requests|MTAB|token cap/i;
const VENDORS = /openrouter|openai|anthropic|gemini|claude|groq|composio|deepseek|qwen|moonshot|kimi/i;

const allowanceCopy = (mode) => {
  const k = productKnowledgeFor(mode);
  // Every plan's card blurb is scanned too, Max included: no plan may describe its allowance in tokens.
  const plans = k.plans.flatMap((plan) => [plan.description, ...(plan.id === "max" ? [] : [...plan.features, ...plan.details.filter((line) => !/MB per file|Library of|costs \$/.test(line))])]);
  return [
    ...plans,
    k.terms.find(([heading]) => heading === "Image & document credits")[1],
    k.credits,
    k.thinkingEffort,
    creditsPricingFootnote(mode),
    // creditsPricingRule is an instruction to the assistant that names the old gates in order to forbid them,
    // so it is checked separately (see the assistant test), not as customer copy.
    ...pricingFaqFor(mode).filter(([question]) => /allowances reset|image & document credits remove/.test(question)).flat(),
    JSON.stringify(comparisonGroupsFor(mode).find((group) => group.title === "Monthly allowance")),
    usageNavDescription(mode),
    usageSettingsDescription(mode),
    FLEX_DASHBOARD_BLURB_CREDITS,
  ];
};

// ---- Inactive: nothing about the existing pages moves ------------------------------------------

test("while credits are off, every existing surface is exactly what it was", () => {
  assert.equal(PUBLIC_CREDITS_MODE, null, "the build variable is unset by default");
  assert.equal(productKnowledgeFor(), PRODUCT_KNOWLEDGE);
  assert.equal(productKnowledgeFor(null), PRODUCT_KNOWLEDGE);
  assert.equal(productKnowledgeFor("yes"), PRODUCT_KNOWLEDGE, "an unrecognised mode selects nothing");
  assert.equal(buildProductKnowledgeSystemPrompt(), buildProductKnowledgeSystemPrompt({ creditsMode: null }));
  assert.equal(buildProductKnowledgeAddendum("pricing plans"), buildProductKnowledgeAddendum("pricing plans", { creditsMode: null }));
  assert.equal(comparisonGroupsFor(), COMPARISON_GROUPS);
  assert.equal(PUBLIC_PAGES["/pricing"].faq, pricingFaqFor(null));
  assert.equal(usageNavDescription(null), USAGE_NAV_DESCRIPTION_LEGACY);
  assert.equal(usageSettingsDescription(null), USAGE_SETTINGS_ROW_LEGACY);
  assert.match(JSON.stringify(PUBLIC_PAGES["/pricing"].faq), /15 AI requests in any 24-hour period/, "the current pricing FAQ still states the current limits");
  assert.match(PRODUCT_KNOWLEDGE.plans[0].features[0], /15 AI requests/);
  assert.match(FLEX_DASHBOARD_BLURB_LEGACY, /do not add Chat or Study usage/);
});

test("the shipped sources contain no credits wording on any page that is built by default", async () => {
  // The default build prerenders from these modules with no mode, so the built pages carry the existing copy.
  const defaults = JSON.stringify([PRODUCT_KNOWLEDGE.plans, PRODUCT_KNOWLEDGE.terms, PRODUCT_KNOWLEDGE.credits, COMPARISON_GROUPS, PUBLIC_PAGES["/pricing"].faq]);
  assert.doesNotMatch(defaults, /AI credits|allocated weekly|weekly allocation/i);
  const envFiles = await Promise.all([".env.example", "frontend/.env.example", "frontend/.env"].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8").catch(() => "")));
  for (const text of envFiles) assert.doesNotMatch(text, /^\s*VITE_CREDITS_PUBLIC_COPY\s*=\s*\S/m, "the build variable is not set in any committed env file");
  assert.doesNotMatch(envFiles[0], /^\s*CREDITS_POLICY_ENABLED\s*=\s*true/m);
});

// ---- Active: the wording follows the policy -------------------------------------------------------

test("credits wording never describes the superseded gates", () => {
  for (const mode of MODES) {
    for (const text of allowanceCopy(mode)) {
      assert.doesNotMatch(text, OLD_GATE_WORDS, `${mode}: "${String(text).slice(0, 90)}..."`);
      assert.doesNotMatch(text, VENDORS);
      assert.doesNotMatch(text, /—/, "no em dashes in text customers read");
    }
  }
});

test("each plan's credits wording matches the shared policy numbers", () => {
  for (const mode of MODES) {
    const [free, plus, pro, max] = productKnowledgeFor(mode).plans;
    assert.match(free.features[0], new RegExp(`^${MONTHLY_CREDITS.free} AI credits`));
    assert.match(plus.features[0], new RegExp(`^${MONTHLY_CREDITS.plus} AI credits`));
    assert.match(pro.features[0], new RegExp(`^${MONTHLY_CREDITS.pro} AI credits`));
    assert.match(free.details[0], new RegExp(`about ${typicalWeeklyAllocation("free")[0]} credit a week`));
    assert.match(plus.details[1], new RegExp(`about ${typicalWeeklyAllocation("plus")[0]} credits a week`));
    assert.match(pro.details[1], new RegExp(`about ${typicalWeeklyAllocation("pro")[0]} credits a week`));
    assert.match(max.details[1], new RegExp(`about ${typicalWeeklyAllocation("max")[0]} credits a week`));
    assert.match(max.features[0], new RegExp(`^${MONTHLY_CREDITS.max} AI credits`));
    const groups = comparisonGroupsFor(mode).find((group) => group.title === "Monthly allowance");
    assert.deepEqual(groups.rows[0].values, [String(MONTHLY_CREDITS.free), String(MONTHLY_CREDITS.plus), String(MONTHLY_CREDITS.pro), String(MONTHLY_CREDITS.max)]);
    assert.match(groups.rows[1].values[3], new RegExp(`About ${typicalWeeklyAllocation("max")[0]} credits a week`));
  }
});

test("model access in the credits comparison is the same access the plans have today", () => {
  for (const mode of MODES) {
    const rows = Object.fromEntries(comparisonGroupsFor(mode).find((group) => group.title === "Monthly allowance").rows.map((row) => [row.label, row.values]));
    assert.deepEqual(rows["Lumen"], ["Included", "Included", "Included", "Included"]);
    assert.deepEqual(rows["Study"], ["Included", "Included", "Included", "Included"]);
    assert.deepEqual(rows["Vulcan"], [null, null, "Included", "Included"], "Free and Plus do not include Vulcan: it is a Pro and Max model");
    assert.deepEqual(rows["Zenith"], [null, null, null, "Included"], "Zenith is a Max model");
    assert.equal(rows["Nebula"] ?? rows["Lumen and Nova"], undefined, "the retired tiers have no row");
    // Every other group is shared, not copied.
    const others = comparisonGroupsFor(mode).filter((group) => group.title !== "Monthly allowance");
    assert.deepEqual(others, COMPARISON_GROUPS.filter((group) => group.title !== "Monthly allowance"));
  }
});

test("the two policies are worded differently, and only as what they are", () => {
  const expiry = creditsPolicySentence("expiry");
  const carry = creditsPolicySentence("carry");
  assert.match(expiry, /expire when the week resets/);
  assert.doesNotMatch(expiry, /carry forward/);
  assert.match(carry, /carry forward within the month/);
  assert.match(carry, /never available early/);
  assert.doesNotMatch(carry, /expire/);
  assert.equal(creditsPolicySentence(null), "", "no mode, no claim");
  assert.notEqual(creditsPricingFootnote("expiry"), creditsPricingFootnote("carry"));
  assert.match(productKnowledgeFor("expiry").plans[1].details[1], /expire/);
  assert.match(productKnowledgeFor("carry").plans[1].details[1], /carry forward/);
});

test("annual billing is described as monthly allocation, never a year of credits at once", () => {
  for (const mode of MODES) {
    for (const id of ["plus", "pro"]) {
      const plan = productKnowledgeFor(mode).plans.find((entry) => entry.id === id);
      assert.ok(plan.details.some((line) => /yearly billing, credits are still allocated month by month/.test(line)), `${id}/${mode}`);
    }
    assert.match(creditsPricingFootnote(mode), /yearly billing, credits are still allocated month by month/);
  }
});

test("image & document credits are kept apart from AI credits in every surface that mentions both", () => {
  for (const mode of MODES) {
    const k = productKnowledgeFor(mode);
    const terms = k.terms.find(([heading]) => heading === "Image & document credits")[1];
    for (const text of [terms, k.credits, FLEX_DASHBOARD_BLURB_CREDITS]) {
      assert.match(text, /do not add Chat or Study usage/);
      assert.match(text, /images cannot be bought beyond (a plan's|your) (image )?allowance/);
      assert.doesNotMatch(text, /Flex Credits (do|are|can)/, "the current name leads; the old one appears only as 'previously called'");
    }
    // What a credit actually pays for, as enforced: one credit per Plus document past the 20 a month, never an image.
    assert.match(terms, /previously called Flex Credits/);
    assert.match(terms, /each document after the 20 a month uses 1 credit/);
    assert.doesNotMatch(terms, /3 (Flex )?Credits? each|image generations beyond/i);
    assert.match(k.credits, /\$1 to \$500 in \$0\.10 steps/);
    assert.match(k.credits, /\$1 buys 100 credits/);
  }
  assert.match(FLEX_DASHBOARD_BLURB_LEGACY, /do not expire/, "the legacy dashboard text keeps the no-expiry statement");
});

test("the assistant's product facts follow the active policy and nothing else changes", () => {
  for (const mode of MODES) {
    const prompt = buildProductKnowledgeSystemPrompt({ creditsMode: mode });
    assert.match(prompt, /Free 5, Plus 60, Pro 180/);
    assert.match(prompt, new RegExp(creditsPolicySentence(mode).slice(0, 60)));
    assert.doesNotMatch(prompt, /5-hour token caps|rolling 5-hour|15 AI requests/);
    assert.match(prompt, /\$4\.99/);
    assert.match(prompt, /VibhavGPT Guarantee/);
    // The assistant's rule forbids describing the old gates; it never asserts them.
    assert.match(creditsPricingRule(mode), /Do not describe usage as tokens or as a daily or five-hour limit/);
    const addendum = buildProductKnowledgeAddendum("what does the Plus plan cost", { creditsMode: mode });
    assert.match(addendum, /60 AI credits/);
    assert.doesNotMatch(addendum, /rolling 5-hour/);
  }
  // Unchanged parts are the same objects, not copies that could drift.
  const k = productKnowledgeFor("expiry");
  assert.equal(k.privacy, PRODUCT_KNOWLEDGE.privacy);
  assert.equal(k.guarantee, PRODUCT_KNOWLEDGE.guarantee);
  assert.equal(k.models, PRODUCT_KNOWLEDGE.models);
  assert.equal(creditsKnowledgeOverrides(PRODUCT_KNOWLEDGE, "carry").plans.length, PRODUCT_KNOWLEDGE.plans.length);
});

test("plan facts other than the allowance are carried over exactly", () => {
  for (const mode of MODES) {
    productKnowledgeFor(mode).plans.forEach((plan, index) => {
      const base = PRODUCT_KNOWLEDGE.plans[index];
      for (const key of ["id", "name", "monthly", "yearly"]) assert.equal(plan[key], base[key], `${plan.id}.${key}`);
      // Only Pro's blurb named tokens; every other blurb is carried over untouched.
      if (plan.id === "pro") assert.equal(plan.description, "More AI credits and room for larger projects.");
      else assert.equal(plan.description, base.description, `${plan.id}.description`);
    });
    const [free, plus, pro] = productKnowledgeFor(mode).plans;
    assert.deepEqual(free.features.slice(1), PRODUCT_KNOWLEDGE.plans[0].features.slice(1));
    assert.deepEqual(plus.features.slice(1), PRODUCT_KNOWLEDGE.plans[1].features.slice(1));
    assert.deepEqual(pro.features.slice(1), PRODUCT_KNOWLEDGE.plans[2].features.slice(1));
    assert.ok(plus.details.some((line) => /25 MB/.test(line)), "upload sizes remain");
    assert.ok(plus.details.some((line) => /Library of the documents/.test(line)), "the library line remains");
    assert.equal(plus.details[0], PRODUCT_KNOWLEDGE.plans[1].details[0], "the price line is untouched");
  }
});

// ---- Frontend and backend agree ---------------------------------------------------------------------

test("the build's credits mode and the server's policy are compared without changing any screen", () => {
  assert.deepEqual(describeCreditsMatch(null, { active: false, version: "v1" }), { build: null, server: null, match: true, serverVersion: "v1" });
  assert.deepEqual(describeCreditsMatch("expiry", { active: true, carryMode: "expiry", version: "v1" }), { build: "expiry", server: "expiry", match: true, serverVersion: "v1" });
  assert.equal(describeCreditsMatch("expiry", { active: false }).match, false, "pages say credits, server enforces the old gates");
  assert.equal(describeCreditsMatch(null, { active: true, carryMode: "carry" }).match, false, "pages say the old gates, server enforces credits");
  assert.equal(describeCreditsMatch("expiry", { active: true, carryMode: "carry" }).match, false, "the two policies differ");
  assert.equal(describeCreditsMatch(null, { active: false, reason: "carry_mode_unselected" }).match, true, "enabled without a choice is inactive on both sides");
});

test("the build script reads the same mode as the page components: plain Node sees the variable too", () => {
  // prerender-public.js imports the page data in plain Node, where Vite's import.meta.env does not exist.
  // If this read only import.meta.env, a credits build would ship a credits page body with an old-limits FAQ.
  const read = (value) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const { PUBLIC_CREDITS_MODE } = await import('./frontend/src/credits-copy.js'); const { PUBLIC_PAGES } = await import('./frontend/src/public-pages.js'); console.log(JSON.stringify({ mode: PUBLIC_CREDITS_MODE, faq: JSON.stringify(PUBLIC_PAGES['/pricing'].faq) }));"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, VITE_CREDITS_PUBLIC_COPY: value },
  }));
  const unset = read("");
  assert.equal(unset.mode, null);
  assert.match(unset.faq, /15 AI requests in any 24-hour period/);
  for (const mode of MODES) {
    const built = read(mode);
    assert.equal(built.mode, mode);
    assert.doesNotMatch(built.faq, OLD_GATE_WORDS, `${mode}: the static FAQ and its structured data carry no old-limit wording`);
    assert.match(built.faq, /AI credits/);
    assert.match(built.faq, mode === "carry" ? /carry forward within the month/ : /expire when the week resets/);
  }
  assert.equal(read("sometimes").mode, null, "a value that is not a policy selects nothing");
});

test("the allocation maths lives in one file; nothing else defines the unit or the weekly formula", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(js|jsx)$/.test(entry.name)) files.push(path);
    }
  };
  await walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  await walk(new URL("../frontend/src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const definers = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/export const CREDIT_MICROS|const CREDIT_MICROS\s*=|function allocationSchedule|function computeCreditBalance/.test(source)) definers.push(file.replace(/\\/g, "/").split("/").slice(-2).join("/"));
  }
  assert.deepEqual(definers, ["src/credits-policy.js"], "only the shared module");
  for (const file of ["../src/usage/credits.js", "../frontend/src/credits-view.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /credits-policy\.js/, `${file} imports the shared module`);
  }
  // The service reaches the shared maths only through credits.js, and keeps no unit constant of its own.
  const usageService = await readFile(new URL("../src/usage/service.js", import.meta.url), "utf8");
  assert.match(usageService, /from "\.\/credits\.js"/);
  for (const file of ["../src/usage/credits.js", "../src/usage/service.js", "../frontend/src/credits-view.js", "../frontend/src/App.jsx"]) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), /\b50_?000\b/, `${file} has no credit-unit constant of its own`);
  }
});

// ---- Rollback consistency: the running page follows the server; the static pages are marked and checked ----

const ROOT = new URL("..", import.meta.url);
const policyBody = (overrides = {}) => ({ version: "v-test", active: false, carryMode: null, scheduledFor: null, activatedAt: null, reason: "disabled", unit: { creditMicros: 50_000 }, ...overrides });
const fakeRoot = () => ({ dataset: {} });
const answering = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });

test("the running page shows what the server enforces, so a server-only change reaches every open page", () => {
  resetCreditsRuntime();
  try {
    assert.equal(currentCreditsMode(), PUBLIC_CREDITS_MODE, "before the server answers, the build's mode: the first paint matches the prerendered page");
    let notified = 0;
    const unsubscribe = subscribeCreditsMode(() => { notified += 1; });
    assert.equal(applyServerCreditsPolicy(policyBody({ active: true, carryMode: "expiry", reason: "active" })), "expiry");
    assert.equal(currentCreditsMode(), "expiry");
    assert.equal(notified, 1);
    applyServerCreditsPolicy(policyBody({ active: true, carryMode: "expiry", reason: "active" }));
    assert.equal(notified, 1, "the same answer again changes nothing and re-renders nothing");
    assert.equal(applyServerCreditsPolicy(policyBody({ active: true, carryMode: "carry", reason: "active" })), "carry");
    assert.equal(notified, 2);
    // Rollback: the server turns credits off. The page returns to the existing wording, whatever the build says.
    assert.equal(applyServerCreditsPolicy(policyBody()), null);
    assert.equal(currentCreditsMode(), null);
    assert.equal(notified, 3);
    unsubscribe();
    applyServerCreditsPolicy(policyBody({ active: true, carryMode: "expiry", reason: "active" }));
    assert.equal(notified, 3, "an unsubscribed listener is not called");
  } finally { resetCreditsRuntime(); }
});

test("only an active policy with a valid mode changes the wording; a stale or unrecognised answer never advertises credits", () => {
  resetCreditsRuntime();
  try {
    assert.equal(applyServerCreditsPolicy(policyBody({ active: false, carryMode: "expiry", reason: "before_activation" })), null, "scheduled is not active");
    assert.equal(applyServerCreditsPolicy(policyBody({ active: true, carryMode: "sometimes", reason: "active" })), null, "an unknown mode is not a mode");
    assert.equal(applyServerCreditsPolicy(undefined), null, "an empty answer is credits off");
    assert.equal(applyServerCreditsPolicy({ active: true, carryMode: "carry" }), "carry");
  } finally { resetCreditsRuntime(); }
  assert.equal(currentCreditsMode(), PUBLIC_CREDITS_MODE, "forgetting the server's answer returns to the build's mode");
});

test("the policy check records build, server and shown modes on the page and warns only on a mismatch", async () => {
  resetCreditsRuntime();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(format(...args));
  try {
    const stale = fakeRoot();
    const mismatch = await checkCreditsCopyMatchesServer({ fetchImpl: answering(policyBody({ active: true, carryMode: "expiry", reason: "active" })), root: stale });
    assert.equal(mismatch.match, false, "the default build is credits-off, the server says expiry");
    assert.deepEqual(stale.dataset, { creditsCopy: "off", creditsServer: "expiry", creditsShown: "expiry", creditsPolicy: "v-test" }, "shown follows the server, not the build");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /built for credits mode "off" but the server is enforcing "expiry"/);

    const agreeing = fakeRoot();
    const agree = await checkCreditsCopyMatchesServer({ fetchImpl: answering(policyBody()), root: agreeing });
    assert.equal(agree.match, true);
    assert.deepEqual(agreeing.dataset, { creditsCopy: "off", creditsServer: "off", creditsShown: "off", creditsPolicy: "v-test" });
    assert.equal(warnings.length, 1, "no warning when they agree");

    // The server cannot be reached or answers with an error: nothing changes and nothing throws.
    applyServerCreditsPolicy(policyBody({ active: true, carryMode: "carry", reason: "active" }));
    assert.equal(await checkCreditsCopyMatchesServer({ fetchImpl: async () => { throw new Error("offline"); }, root: fakeRoot() }), null);
    assert.equal(await checkCreditsCopyMatchesServer({ fetchImpl: answering({}, { ok: false }), root: fakeRoot() }), null);
    assert.equal(currentCreditsMode(), "carry", "the last answer stands when a later check fails");
  } finally { console.warn = realWarn; resetCreditsRuntime(); }
});

test("the page keeps asking: at start, whenever the tab regains focus, and on a timer; stopping removes all three", async () => {
  const listeners = new Map();
  const target = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  let asked = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { asked += 1; return { ok: true, json: async () => policyBody() }; };
  // The interval is driven by a mock clock, so nothing here depends on real elapsed time.
  mock.timers.enable({ apis: ["setInterval"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let stop = () => {};
  try {
    stop = startCreditsPolicySync({ intervalMs: 1000, target });
    await settle();
    assert.equal(asked, 1, "asked once at start");
    listeners.get("focus")();
    await settle();
    assert.equal(asked, 2, "asked again on focus");
    mock.timers.tick(1000);
    await settle();
    assert.equal(asked, 3, "asked again when the interval elapsed");
    mock.timers.tick(2000);
    await settle();
    assert.equal(asked, 5, "and on each interval after that");
    stop();
    assert.equal(listeners.has("focus"), false, "the focus listener is removed");
    mock.timers.tick(10_000);
    await settle();
    assert.equal(asked, 5, "no further requests after stopping");
    assert.equal(typeof startCreditsPolicySync({ target: null }), "function", "no window, nothing to do, still returns a stopper");
  } finally {
    stop();
    mock.timers.reset();
    globalThis.fetch = realFetch;
    resetCreditsRuntime();
  }
});

function nodeEval(script, env = {}) {
  const clean = { ...process.env };
  delete clean.VITE_CREDITS_PUBLIC_COPY;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, env: { ...clean, ...env }, encoding: "utf8" }).trim();
}

test("every prerendered page carries a marker for the credits wording it was built with, and rebuilding the head never duplicates it", () => {
  assert.match(metadataHtml("/pricing"), /<meta name="vibhavgpt-credits-copy" content="off">/, "off by default");
  const script = "import('./frontend/scripts/public-html.js').then(({metadataHtml})=>console.log(metadataHtml('/pricing').match(/vibhavgpt-credits-copy\" content=\"([^\"]*)\"/)[1]))";
  assert.equal(nodeEval(script, { VITE_CREDITS_PUBLIC_COPY: "expiry" }), "expiry");
  assert.equal(nodeEval(script, { VITE_CREDITS_PUBLIC_COPY: "carry" }), "carry");
  assert.equal(nodeEval(script, { VITE_CREDITS_PUBLIC_COPY: "banana" }), "off", "an unrecognised build value is credits off, never a third wording");

  const shell = `<!doctype html><html><head><meta charset="utf-8"><title>Old</title><meta name="vibhavgpt-credits-copy" content="carry"></head><body></body></html>`;
  const once = updateMetadata(shell, "/pricing");
  const twice = updateMetadata(once, "/pricing");
  const tags = (html) => html.replace(/>\s+</g, "><"); // the step has always left a blank line when re-run; the tags are what matter
  assert.equal(tags(twice), tags(once), "re-running the metadata step changes no tag");
  assert.equal((once.match(/vibhavgpt-credits-copy/g) ?? []).length, 1, "exactly one marker");
  assert.match(once, /vibhavgpt-credits-copy" content="off"/, "a stale marker from an earlier build is replaced, not kept");
});

test("the deployment check reads the marker and the wording from a page and the mode from the server's policy", () => {
  assert.deepEqual(readPageCreditsCopy(`<meta name="vibhavgpt-credits-copy" content="expiry"><p>Your AI credits</p>`), { marker: "expiry", wording: "credits" });
  assert.deepEqual(readPageCreditsCopy(`<meta name="vibhavgpt-credits-copy" content="off"><p>15 AI requests per day</p>`), { marker: "off", wording: "legacy" });
  assert.deepEqual(readPageCreditsCopy(`<p>Pricing</p>`), { marker: null, wording: "unknown" });
  assert.equal(readPageCreditsCopy(`<meta name="vibhavgpt-credits-copy" content="weird">`).marker, null, "an unknown marker value is no marker");
  assert.equal(readServerCredits(policyBody({ active: true, carryMode: "carry", reason: "active" })).mode, "carry");
  assert.equal(readServerCredits(policyBody({ active: false, carryMode: "carry", reason: "before_activation", scheduledFor: "2026-12-01T00:00:00.000Z" })).mode, "off", "scheduled is not enforced");
  assert.equal(readServerCredits(null).mode, "off");
});

test("the deployment check passes only when pages and server agree, and names each way they can disagree", () => {
  const off = { marker: "off", wording: "legacy" };
  const expiry = { marker: "expiry", wording: "credits" };
  const serverOff = policyBody();
  const serverExpiry = policyBody({ active: true, carryMode: "expiry", reason: "active" });

  assert.equal(compareCreditsDeployment({ page: off, policy: serverOff }).ok, true, "off and off");
  assert.equal(compareCreditsDeployment({ page: expiry, policy: serverExpiry }).ok, true, "expiry and expiry");
  assert.equal(compareCreditsDeployment({ page: off, policy: serverOff, expect: "off" }).ok, true);
  assert.equal(compareCreditsDeployment({ page: expiry, policy: serverExpiry, expect: "expiry" }).ok, true);

  // The rollback gap: the server was turned off but the pages still say credits.
  const rolledBack = compareCreditsDeployment({ page: expiry, policy: serverOff });
  assert.equal(rolledBack.ok, false);
  assert.match(rolledBack.problems[0], /^static-copy-stale/);
  // The activation gap: the server is enforcing credits but the pages still show the old limits.
  assert.match(compareCreditsDeployment({ page: off, policy: serverExpiry }).problems[0], /^static-copy-stale/);
  // A different mode on each side.
  assert.match(compareCreditsDeployment({ page: { marker: "carry", wording: "credits" }, policy: serverExpiry }).problems[0], /^static-copy-stale/);
  // Scheduled but not yet reached: the server enforces nothing, so credits pages are stale.
  assert.equal(compareCreditsDeployment({ page: expiry, policy: policyBody({ reason: "before_activation", scheduledFor: "2026-12-01T00:00:00.000Z" }) }).ok, false);

  assert.match(compareCreditsDeployment({ page: { marker: null, wording: "legacy" }, policy: serverOff }).problems[0], /^page-marker-missing/, "an older build has no marker");
  assert.match(compareCreditsDeployment({ page: { marker: "off", wording: "credits" }, policy: serverOff }).problems[0], /^page-wording-disagrees-with-its-marker/);
  assert.match(compareCreditsDeployment({ page: { marker: "expiry", wording: "legacy" }, policy: serverExpiry }).problems[0], /^page-wording-disagrees-with-its-marker/);

  const wrongExpect = compareCreditsDeployment({ page: off, policy: serverOff, expect: "carry" });
  assert.equal(wrongExpect.ok, false);
  assert.ok(wrongExpect.problems.some((problem) => problem.startsWith("server-not-as-expected")));
  assert.ok(wrongExpect.problems.some((problem) => problem.startsWith("pages-not-as-expected")));
});

test("the deployment check exits 2, not 0, when it cannot reach what it must compare", () => {
  let status = null;
  try {
    execFileSync(process.execPath, ["scripts/verify-credits-consistency.js", "--site", "http://127.0.0.1:9", "--api", "http://127.0.0.1:9"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    status = 0;
  } catch (error) { status = error.status; }
  assert.equal(status, 2, "unreachable is 'could not check', never a pass");
  let bad = null;
  try {
    execFileSync(process.execPath, ["scripts/verify-credits-consistency.js", "--expect", "sometimes"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    bad = 0;
  } catch (error) { bad = error.status; }
  assert.equal(bad, 2, "an invalid --expect is refused");
  const pkg = JSON.parse(execFileSync(process.execPath, ["-p", "JSON.stringify(require('./package.json').scripts)"], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(pkg["credits:verify"], "node scripts/verify-credits-consistency.js");
});

test("no screen reads the build's mode directly: each follows the server through the runtime store", async () => {
  const read = (path) => readFile(new URL(`../frontend/src/${path}`, import.meta.url), "utf8");
  for (const path of ["App.jsx", "Legal.jsx", "components/PublicPageDetails.jsx"]) {
    const source = await read(path);
    assert.match(source, /useCreditsMode\(\)/, `${path} reads the mode from the runtime store`);
    assert.doesNotMatch(source, /PUBLIC_CREDITS_MODE/, `${path} must not bake in the build's mode`);
  }
  assert.match(await read("main.jsx"), /startCreditsPolicySync\(\)/, "the app starts following the server at boot");
});
