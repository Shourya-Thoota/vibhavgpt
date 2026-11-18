#!/usr/bin/env node
// Checks that the two hand-set Max price variables, STRIPE_PRICE_ID_MAX and STRIPE_PRICE_ID_MAX_YEARLY, point at the right Stripe prices, without
// ever printing a key, a price id or any other value. Run by the owner where those variables are present, for example:
//
//   railway run --service vibhavgpt --environment production npm run billing:verify-max-prices
//
// It makes read-only Stripe calls only (retrieve and list prices). It creates no checkout session, charge, customer or subscription.
//
// Output is one line per item, using only these words:
//   MATCH     the variable names the active USD recurring price on the right interval, under our lookup key, at the approved amount,
//             and it is the same price the lookup key finds
//   MISSING   the variable is not set (checkout then uses the lookup key, which is checked on its own line, so this is safe)
//   MISMATCH  followed by a reason: not-found, inactive, not-recurring, wrong-currency, wrong-interval, wrong-plan, other-price, wrong-amount
// Exit code: 0 ready (every set variable MATCHes and both lookup keys are found), 1 not ready, 2 could not check.

import { pathToFileURL } from "node:url";
import { planPriceProblem, APPROVED_MAX_PRICES } from "../src/billing/price-check.js";

export const MAX_VARIABLES = Object.freeze([
  { name: "STRIPE_PRICE_ID_MAX", lookupKey: "vibhavgpt_max_monthly" },
  { name: "STRIPE_PRICE_ID_MAX_YEARLY", lookupKey: "vibhavgpt_max_yearly" },
]);

/** Judges both variables and both lookup keys. Returns the lines to print and whether Max checkout is ready. */
export async function evaluateMaxPriceMapping({ stripe, env = process.env }) {
  const lines = [];
  let ready = true;
  for (const { name, lookupKey } of MAX_VARIABLES) {
    const found = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 3 })).data;
    const lookupOk = found.length === 1 && planPriceProblem(found[0], lookupKey) === null && found[0].unit_amount === APPROVED_MAX_PRICES[lookupKey];
    const lookupWord = found.length === 0 ? "MISSING" : found.length > 1 ? "MISMATCH more-than-one-active-price" : lookupOk ? "MATCH" : `MISMATCH ${planPriceProblem(found[0], lookupKey) ?? "wrong-amount"}`;
    lines.push(`lookup ${lookupKey}: ${lookupWord}`);
    if (!lookupOk) ready = false;

    const pinnedId = String(env[name] ?? "").trim() || (name === "STRIPE_PRICE_ID_MAX_YEARLY" ? String(env.STRIPE_PRICE_ID_MAX_ANNUAL ?? "").trim() : "");
    if (!pinnedId) { lines.push(`${name}: MISSING`); continue; }
    const price = await stripe.prices.retrieve(pinnedId).catch(() => null);
    let word;
    if (!price) word = "MISMATCH not-found";
    else {
      const problem = planPriceProblem(price, lookupKey);
      if (problem) word = `MISMATCH ${problem}`;
      else if (found[0] && price.id !== found[0].id) word = "MISMATCH other-price";
      else if (price.unit_amount !== APPROVED_MAX_PRICES[lookupKey]) word = "MISMATCH wrong-amount";
      else word = "MATCH";
    }
    lines.push(`${name}: ${word}`);
    if (word !== "MATCH") ready = false;
  }
  lines.push(ready ? "READY" : "NOT READY");
  return { lines, ready };
}

async function main() {
  const key = String(process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) { console.error("STRIPE_SECRET_KEY is not set here, so nothing was checked."); return 2; }
  try {
    const { default: Stripe } = await import("stripe");
    const { lines, ready } = await evaluateMaxPriceMapping({ stripe: new Stripe(key) });
    for (const line of lines) console.log(line);
    return ready ? 0 : 1;
  } catch {
    console.error("Stripe could not be reached or refused the read, so nothing was concluded.");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
