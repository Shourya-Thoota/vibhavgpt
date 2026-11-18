import assert from "node:assert/strict";
import test from "node:test";
import { buildProductKnowledgeAddendum, buildProductKnowledgeSystemPrompt, PRODUCT_KNOWLEDGE } from "../frontend/src/product-knowledge.js";
import { buildIdentitySystemPrompt } from "../src/chat/prompts.js";
import { protectPlainDollarSigns } from "../frontend/src/markdown.js";
import { providerTermsPattern } from "./provider-terms.js";

test("product facts include current pricing, limits, credit costs, refund policy, and support route", () => {
  const prompt = buildProductKnowledgeSystemPrompt();
  assert.match(prompt, /\$4\.99 per month or \$49\.99 per year/);
  assert.match(prompt, /\$12\.99 per month or \$129\.99 per year/);
  assert.match(prompt, /up to 15 AI requests in any 24-hour period/i);
  assert.match(prompt, /shared \$0\.25 (included )?allowance each UTC calendar month/i);
  assert.match(prompt, /one message or action can use more than one AI request/i);
  assert.doesNotMatch(prompt, /15 prompts in any 24-hour period/);
  assert.doesNotMatch(prompt, /1M tokens per calendar month and 100K per rolling 5 hours/);
  assert.match(prompt, /Lumen 8M \/ 800K; Study 4M \/ 400K/);
  assert.match(prompt, /Lumen 12M \/ 1.2M/);
  // Nova and Nebula were retired on 2026-11-14 and are not described as plan features.
  assert.doesNotMatch(prompt, /Lumen and Nova|Nebula (requires|is on|\d)/);
  assert.match(prompt, /100 image generations and 20 document generations per subscription billing month/);
  assert.match(prompt, /400 image generations per UTC calendar month and unlimited document generations/);
  assert.match(prompt, /Refund eligibility and processing follow applicable law/);
  assert.doesNotMatch(prompt, /Google ?Play/i);
  const publicPrivacy = PRODUCT_KNOWLEDGE.privacy.map(([, body]) => body).join(" ");
  assert.match(publicPrivacy, /AI inference providers, which process your messages and other content to generate responses/);
  // Service providers are named by category, never by vendor.
  for (const category of ["AI inference providers", "hosting and database", "email delivery", "error monitoring", "payment processing"]) {
    assert.match(publicPrivacy, new RegExp(category));
  }
  assert.match(prompt, /support@pansophy\.com/);
  assert.match(prompt, /official company domain is pansophy\.com/);
  assert.doesNotMatch(prompt, /Pansophy's official domain is pansophy\.tech/);
  const sellable = [...PRODUCT_KNOWLEDGE.plans.flatMap((plan) => [...plan.features, ...plan.details]), PRODUCT_KNOWLEDGE.credits].join(" ");
  assert.doesNotMatch(sellable, /voice|dictation|Comet/i);
  assert.match(prompt, /They do not add Chat or Study usage/i);
  assert.match(prompt, /images cannot be bought beyond a plan's image allowance/i);
  assert.doesNotMatch(prompt, /cost 3 (Flex )?credits|3 Flex Credits each/i, "images never use credits, so no price in credits is promised");
  assert.match(prompt, /image & document credits do not add images or unlock documents on Free/i);
  assert.match(prompt, /previously called Flex Credits/i);
  assert.match(prompt, /Free includes 2 image generations per week/i);
  // The image watermark policy (owner decision, 2026-11-16, superseding #70): the assistant is told it as it is enforced.
  assert.match(prompt, /Images made on Free carry a small black-and-white VibhavGPT watermark[^.]*cannot be turned off on Free/);
  assert.match(prompt, /watermark is optional on Plus and off by default/);
  assert.match(prompt, /Higher effort may consume more output tokens/);
  assert.match(prompt, /\$1 buys 100 credits, and they do not expire/);
  assert.doesNotMatch(prompt, /weekly allowances|voice exchanges per week|unlimited voice|30 Nebula usage units and 5 Nebula usage units/);
  assert.equal(PRODUCT_KNOWLEDGE.refunds.includes("does not issue refunds"), false);
});

test("every model receives the same authoritative product knowledge", () => {
  for (const model of ["lumen", "nova", "nebula", "vesper"]) {
    const prompt = buildIdentitySystemPrompt(model);
    assert.match(prompt, /<vibhavgpt-product-knowledge>/);
    assert.match(prompt, /Settings, then Security/);
  }
});

test("pricing questions receive the exact maintained plan facts as a correctness backstop", () => {
  const addendum = buildProductKnowledgeAddendum("What does VibhavGPT Plus cost compared with Pro?");
  assert.match(addendum, /Free: \$0/);
  assert.match(addendum, /Lumen 8M \/ 800K; Study 4M \/ 400K/);
  assert.match(addendum, /up to 15 AI requests in any 24-hour period/i);
  assert.match(addendum, /one message or action can use more than one AI request/i);
  assert.match(addendum, /25 MB per file and image uploads to 10 MB/);
  assert.match(addendum, /80 MB per file and image uploads to 20 MB/);
  assert.equal(buildProductKnowledgeAddendum("Help me plan a trip to Boston"), "");
});

test("VibhavGPT questions receive maintained product facts without claiming a documentation search", () => {
  const addendum = buildProductKnowledgeAddendum("How do I delete my VibhavGPT account?");
  assert.match(addendum, /VibhavGPT product information/);
  assert.match(addendum, /Retention and deletion/);
  assert.doesNotMatch(addendum, /Searched VibhavGPT docs/);
});

test("identity questions receive the creator answer instead of a vague model-only identity", () => {
  const addendum = buildProductKnowledgeAddendum("Who made you?");
  assert.match(addendum, /VibhavGPT was created by Vibhav Thoota/i);
  assert.match(addendum, /Do not substitute an underlying provider/i);
  assert.match(buildProductKnowledgeSystemPrompt(), /Identity: VibhavGPT was created by Vibhav Thoota/i);
  assert.match(buildProductKnowledgeAddendum("Who created VibhavGPT?"), /VibhavGPT was created by Vibhav Thoota/i);
});

test("plain currency is escaped while real inline TeX stays available to KaTeX", () => {
  assert.equal(
    protectPlainDollarSigns("Plus is $4.99/mo or $49.99/yr."),
    "Plus is \\$4.99/mo or \\$49.99/yr.",
  );
  assert.equal(protectPlainDollarSigns("$x + y$"), "$x + y$");
  assert.equal(protectPlainDollarSigns("$\\frac{1}{2}$"), "$\\frac{1}{2}$");
  assert.equal(protectPlainDollarSigns("Pay $5 or $10."), "Pay \\$5 or \\$10.");
  assert.equal(
    protectPlainDollarSigns("- **Free ($0):** Lumen\n- **Plus ($4.99/mo or $49.99/yr):** Nebula"),
    "- **Free (\\$0):** Lumen\n- **Plus (\\$4.99/mo or \\$49.99/yr):** Nebula",
  );
});

test("Terms describe today's service: no voice, no app-store billing", () => {
  const terms = PRODUCT_KNOWLEDGE.terms.map(([title, body]) => `${title} ${body}`).join(" ");
  assert.doesNotMatch(terms, /\bvoice\b|Comet|dictation|transcri|Google ?Play/i);
  assert.match(terms, /billed monthly or annually through our payment processor/);
});

test("Privacy keeps the historical voice providers on the policy page only, in the past tense", async () => {
  const { readFile } = await import("node:fs/promises");
  const legal = await readFile(new URL("../frontend/src/Legal.jsx", import.meta.url), "utf8");
  assert.match(legal, /Before voice features were removed in October 2026, voice dictation audio and Live Comet voice calls were also processed by AI inference providers\./);
  const privacy = PRODUCT_KNOWLEDGE.privacy.map(([, body]) => body).join(" ");
  assert.doesNotMatch(privacy, /\bvoice\b|Comet|Google ?Play/i);
  assert.doesNotMatch(legal, /Railway|PostgreSQL|Resend|Sentry|Stripe/);
  assert.doesNotMatch(legal, providerTermsPattern);
  assert.doesNotMatch(buildProductKnowledgeSystemPrompt(), /\bvoice\b|Comet|Google ?Play/i);
  assert.doesNotMatch(buildProductKnowledgeSystemPrompt(), providerTermsPattern);
});

test("the Guarantee is VibhavGPT's own first-person promise, and the legal pages keep it", () => {
  const promises = PRODUCT_KNOWLEDGE.guarantee.map(([heading]) => heading);
  assert.deepEqual(promises, ["We never train on your chats", "We never sell your data", "We never show ads", "You can export or delete everything, any time"]);
  // The Guarantee speaks only for VibhavGPT: no provider, route or
  // third-party training language, and no hedging.
  const guarantee = PRODUCT_KNOWLEDGE.guarantee.flat().join(" ");
  assert.doesNotMatch(guarantee, /provider|upstream|third[- ]party|route|anyone else's|may |might |except/i);
  const terms = PRODUCT_KNOWLEDGE.terms.map(([, body]) => body).join(" ");
  const privacy = PRODUCT_KNOWLEDGE.privacy.map(([, body]) => body).join(" ");
  for (const text of [terms, privacy]) {
    assert.match(text, /vibhavgpt\.com\/guarantee/);
    assert.match(text, /we never train on your chats, we never sell your data, we never show ads/i);
  }
  // The provider disclosure is neutral: who processes messages, and why.
  assert.match(privacy, /AI inference providers, which process your messages and other content to generate responses/);
  assert.doesNotMatch(privacy, /no-training|not used to train models|do not promise|may retain or use content/);
  assert.doesNotMatch(terms, /routes that do not train/);
  const all = [...PRODUCT_KNOWLEDGE.guarantee.flat(), terms, privacy].join(" ");
  assert.doesNotMatch(all, /\u2014/, "no em dashes in legal or Guarantee copy");
});

test("the payment processor is named on the legal pages, never in what the assistant is told", () => {
  const prompt = buildProductKnowledgeSystemPrompt();
  assert.doesNotMatch(prompt, /Stripe/);
  assert.match(prompt, /The VibhavGPT Guarantee:\n- We never train on your chats/);
  // Provider names stay on the legal pages.
  assert.doesNotMatch(prompt, providerTermsPattern);
  assert.doesNotMatch(buildProductKnowledgeAddendum("How does VibhavGPT billing and cancellation work?"), /Stripe/);
  const trainingAnswer = buildProductKnowledgeAddendum("Does VibhavGPT train on my data?");
  assert.match(trainingAnswer, /We never train on your chats/);
  assert.doesNotMatch(trainingAnswer, providerTermsPattern);
});

test("no vendor names anywhere in the Terms, Privacy Policy, or Guarantee", () => {
  const legalText = [...PRODUCT_KNOWLEDGE.terms, ...PRODUCT_KNOWLEDGE.privacy, ...PRODUCT_KNOWLEDGE.guarantee].flat().join(" ");
  assert.doesNotMatch(legalText, /Railway|PostgreSQL|Resend|Sentry|Stripe/);
  assert.doesNotMatch(legalText, providerTermsPattern);
});

test("the Privacy Policy no longer says deleting an account cancels a subscription", () => {
  const [, retention] = PRODUCT_KNOWLEDGE.privacy.find(([heading]) => heading === "Retention and deletion");
  assert.doesNotMatch(retention, /canceled as part of|cancelled as part of|deletion cancels|is canceled (first|when)/i);
  assert.ok(retention.endsWith("Account deletion is blocked while a web subscription is active; cancel it in Plan and billing first."));
  const privacy = PRODUCT_KNOWLEDGE.privacy.map(([, body]) => body).join(" ");
  assert.doesNotMatch(privacy, /subscription is canceled as part of the account-deletion process/i);
});

// The sub-processor list (legal audit, 2026-11-16) names vendors, so it lives apart from the policy sections that also brief the assistant.
test("the Privacy page publishes the sub-processor list; the assistant is never given it", async () => {
  const { SUBPROCESSORS_SECTION } = await import("../frontend/src/subprocessors.js");
  const [title, body] = SUBPROCESSORS_SECTION;
  assert.equal(title, "Sub-processors");
  for (const name of ["Railway", "Stripe", "Resend", "Cloudflare", "Sentry", "OpenRouter", "OpenAI", "Groq", "Tavily", "OpenWeather", "Composio"]) assert.match(body, new RegExp(name), name);
  const legal = (await import("node:fs")).readFileSync(new URL("../frontend/src/Legal.jsx", import.meta.url), "utf8");
  assert.match(legal, /title === "AI, hosting, and service providers" \? \[section, \[\.\.\.SUBPROCESSORS_SECTION\]\]/);
  const prompt = buildProductKnowledgeSystemPrompt();
  assert.doesNotMatch(prompt, /Sub-processors|OpenRouter|Tavily|Composio/);
});
