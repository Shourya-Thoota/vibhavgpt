// Customer wording for AI credits, in one place. Every function takes the carry
// mode explicitly ("expiry" or "carry"), so no sentence can describe a policy
// that was not selected; with no mode, nothing here is used and the existing
// copy stands.
//
// The static public pages (pricing, terms) are built ahead of time, so they take
// their mode from the build variable VITE_CREDITS_PUBLIC_COPY. It must be set to
// the same value as the server's CREDITS_CARRY_MODE in the same release, and
// stays unset until then. Signed-in screens read the server's own policy.

import { CARRY_MODES, MONTHLY_CREDITS, normalizeCarryMode, typicalWeeklyAllocation, wholeCreditsPhrase } from "./credits-policy.js";
import { TOKEN_QUOTAS } from "./token-quotas.js";
import { THIRD_PARTY_BILLING_NOTE } from "./model-marketplace.js";

// Vite compiles the value into the browser bundle and the server-rendered components. The build's own
// script (prerender-public.js) imports the page data in plain Node, where there is no import.meta.env,
// so it reads the same variable from the environment. Without this the static FAQ and its structured
// data would keep the old wording on a page whose body already says credits.
const publicCopyFlag = import.meta.env?.VITE_CREDITS_PUBLIC_COPY
  ?? (typeof process !== "undefined" ? process.env?.VITE_CREDITS_PUBLIC_COPY : undefined);
export const PUBLIC_CREDITS_MODE = normalizeCarryMode(publicCopyFlag);

const CREDIT_EXPLANATION = "AI credits measure model use. Larger models and longer conversations use more of them, and a single message uses only part of a credit.";

export function creditsPolicySentence(mode) {
  if (mode === CARRY_MODES.CARRY) {
    return "Credits are allocated each week from your monthly allowance. Unused credits carry forward within the month, and a later week's credits are never available early.";
  }
  if (mode === CARRY_MODES.EXPIRY) {
    return "Credits are allocated each week from your monthly allowance. Unused credits expire when the week resets.";
  }
  return "";
}

const aboutWeekly = (plan) => `about ${wholeCreditsPhrase(typicalWeeklyAllocation(plan)[0])} a week`;
const monthlyPhrase = (plan) => `${MONTHLY_CREDITS[plan]} AI credits`;

/** Plan rows for the pricing page and the assistant's product facts. */
function creditsPlans(plans, mode) {
  const policy = creditsPolicySentence(mode);
  return plans.map((plan) => {
    if (plan.id === "free") {
      return {
        ...plan,
        features: [`${monthlyPhrase("free")} each UTC calendar month, allocated weekly, shared by Lumen and Study`, ...plan.features.slice(1)],
        details: [
          `Free includes Lumen and Study with ${monthlyPhrase("free")} each UTC calendar month, allocated weekly (${aboutWeekly("free")}). ${CREDIT_EXPLANATION} ${policy} Vulcan requires Pro, and Zenith requires Max.`,
          ...plan.details.slice(1),
        ],
      };
    }
    if (plan.id === "plus" || plan.id === "pro" || plan.id === "max") {
      const name = plan.name;
      return {
        ...plan,
        // Pro's card blurb names token allowances; Plus's does not name any allowance.
        description: plan.id === "pro"
          ? "More AI credits and room for larger projects."
          : plan.id === "max"
            ? "Highest capacity for high-volume work and larger projects."
            : plan.description,
        features: [`${monthlyPhrase(plan.id)} per month, allocated weekly, across every model ${name} includes`, ...plan.features.slice(1)],
        details: [
          plan.details[0],
          `${name} includes ${monthlyPhrase(plan.id)} per month, allocated weekly (${aboutWeekly(plan.id)}). ${CREDIT_EXPLANATION} ${policy}`,
          "On yearly billing, credits are still allocated month by month, never a year at once.",
          ...plan.details.slice(3),
        ],
      };
    }
    return {
      ...plan,
      features: plan.features.map((line) => line.replace("monthly usage allowance", "monthly AI credit allowance")),
      details: plan.details.map((line) => line.replace("monthly usage allowance", "monthly AI credit allowance")),
    };
  });
}

const FLEX_TERMS = "Image & document credits (previously called Flex Credits) are optional, bought on the web in one payment, and do not renew as a subscription. $1 buys 100 credits, and they do not expire. They pay for documents beyond a plan's included number: on Plus, each document after the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond a plan's image allowance. Credits held for a request are returned when that request fails.";

const FLEX_PROMPT = "Image & document credits (previously called Flex Credits) can be bought on the web for $1 to $500 in $0.10 steps; $1 buys 100 credits, and they do not expire. On Plus, each document beyond the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond a plan's image allowance. Pro and Max have unlimited documents and Free has none, so there is nothing for credits to pay for on those plans. Credits held for a request are returned when it fails.";

/** The fields of the product facts that change under credits; the caller merges them over the base. */
export function creditsKnowledgeOverrides(base, mode) {
  return {
    plans: creditsPlans(base.plans, mode),
    terms: base.terms.map(([heading, body]) => (heading === "Image & document credits" ? [heading, FLEX_TERMS] : [heading, body])),
    credits: FLEX_PROMPT,
    thinkingEffort: "Pro provides thinking-effort controls for Vulcan, and Max for Vulcan and Zenith. Higher effort may use more AI credits. Study uses low-cost reasoning settings. All chat and Study usage is measured in AI credits.",
  };
}

export function creditsPricingRule(mode) {
  return `Mandatory pricing-answer rule: For a plan question, state the correct web price and the complete listed access and limits for each plan asked about. Each plan includes a monthly number of AI credits (Free ${MONTHLY_CREDITS.free}, Plus ${MONTHLY_CREDITS.plus}, Pro ${MONTHLY_CREDITS.pro}, Max ${MONTHLY_CREDITS.max}) allocated in weekly portions, plus upload sizes. Free includes 2 image generations per week, and Plus, Pro, and Max include image and document generations. ${creditsPolicySentence(mode)} One message or action can use more than one model call, and a single call uses only part of a credit. Do not describe usage as tokens or as a daily or five-hour limit, and do not call it unlimited. Do not describe Pro or Max model or image limits as unlimited unless the matching plan detail explicitly says so.`;
}

// ---- Pricing page ------------------------------------------------------------

const included = (plan, model) => (TOKEN_QUOTAS[plan][model].monthly > 0 ? "Included" : null);
const modelRow = (label, model) => ({ label, values: [included("free", model), included("plus", model), included("pro", model), "Included"] });

/** Replaces the token-based "Monthly allowance" group. Model access still comes from the plan table. */
export function creditsAllowanceGroup() {
  return {
    title: "Monthly allowance",
    rows: [
      { label: "AI credits per month", note: "allocated weekly", values: [`${MONTHLY_CREDITS.free}`, `${MONTHLY_CREDITS.plus}`, `${MONTHLY_CREDITS.pro}`, `${MONTHLY_CREDITS.max}`] },
      { label: "Weekly allocation", note: "in a typical 30-day month", values: [aboutWeekly("free").replace("about ", "About "), aboutWeekly("plus").replace("about ", "About "), aboutWeekly("pro").replace("about ", "About "), aboutWeekly("max").replace("about ", "About ")] },
      modelRow("Lumen", "lumen"),
      modelRow("Study", "study"),
      modelRow("Vulcan", "vesper"),
      // Zenith (Slice 7): Max only. Third-party models are metered per turn, so they are not rows here (the footnote says how).
      modelRow("Zenith", "zenith"),
    ],
  };
}

export function creditsPricingFootnote(mode) {
  return `AI credits are shared by every model your plan includes. ${creditsPolicySentence(mode)} Each message or action uses part of a credit, and larger models and longer conversations use more. On yearly billing, credits are still allocated month by month. Subscriptions and image & document credits are bought on the web, and image & document credits do not add AI credits. Max includes every model Pro has, plus Zenith, with our highest monthly AI credit allowance. ${THIRD_PARTY_BILLING_NOTE}`;
}

// ---- Pricing FAQ ---------------------------------------------------------------

export function creditsPricingFaq(base, mode) {
  return base.map(([question, answer]) => {
    if (question === "How do allowances reset?") {
      return [question, `Each plan includes a monthly number of AI credits, allocated in weekly portions. ${creditsPolicySentence(mode)} Your Usage page shows what is available this week, your monthly allowance, and when the next allocation or reset happens.`];
    }
    if (question === "Do image & document credits remove chat limits?") {
      return [question, "No. Image & document credits (previously Flex Credits) only pay for extra documents on Plus, 1 credit each after the 20 a month. They don't add Chat or Study usage, and images can't be bought beyond your plan's allowance. Pro and Max have unlimited documents. Read the plans above before buying so you know which allowances are included."];
    }
    return [question, answer];
  });
}

// ---- Signed-in screens ---------------------------------------------------------

export const USAGE_NAV_DESCRIPTION_LEGACY = "Monthly usage limit, rolling limits, and token usage";
export const usageNavDescription = (mode) => (mode ? "AI credits, weekly allocation, and monthly allowance" : USAGE_NAV_DESCRIPTION_LEGACY);
export const USAGE_SETTINGS_ROW_LEGACY = "See how much of your plan's allowance you have used this period.";
export const usageSettingsDescription = (mode) => (mode ? "See your AI credits available this week and this month." : USAGE_SETTINGS_ROW_LEGACY);
export const FLEX_DASHBOARD_BLURB_LEGACY = "Image & document credits do not expire. On Plus, each document after the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond your allowance.";
export const FLEX_DASHBOARD_BLURB_CREDITS = "Image & document credits do not expire and are separate from AI credits. On Plus, each document after the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond your allowance.";
