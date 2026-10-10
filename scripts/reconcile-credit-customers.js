import Stripe from "stripe";
import { desc, eq } from "drizzle-orm";
import { config } from "../src/config.js";
import { db, pool } from "../src/db/client.js";
import { creditLedger } from "../src/db/schema.js";

const apply = process.argv.includes("--apply");
const confirmed = process.env.CONFIRM_GUEST_CREDIT_RECONCILIATION === "relink";

if (apply && !confirmed) {
  throw new Error("Refusing to change historical payment associations without CONFIRM_GUEST_CREDIT_RECONCILIATION=relink.");
}
if (!config.stripeSecretKey) throw new Error("Stripe is not configured.");

const stripe = new Stripe(config.stripeSecretKey);

function checkoutIdFor(entry) {
  return entry.externalReference?.startsWith("stripe_checkout:")
    ? entry.externalReference.slice("stripe_checkout:".length)
    : null;
}

async function run() {
  const entries = await db
    .select({ userId: creditLedger.userId, credits: creditLedger.credits, externalReference: creditLedger.externalReference, createdAt: creditLedger.createdAt })
    .from(creditLedger)
    .where(eq(creditLedger.kind, "stripe_purchase"))
    .orderBy(desc(creditLedger.createdAt));

  const candidates = [];
  for (const entry of entries) {
    const checkoutSessionId = checkoutIdFor(entry);
    if (!checkoutSessionId) continue;
    const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, { expand: ["payment_intent"] });
    if (session.payment_status !== "paid" || session.customer) continue;

    const paymentIntent = typeof session.payment_intent === "object" ? session.payment_intent : null;
    candidates.push({
      checkoutSessionId,
      paymentIntentId: paymentIntent?.id ?? (typeof session.payment_intent === "string" ? session.payment_intent : null),
      userId: entry.userId,
      creditsGranted: entry.credits,
      amountCents: session.amount_total,
      currency: session.currency,
      purchasedAt: new Date(session.created * 1000).toISOString(),
      emailPresent: Boolean(session.customer_details?.email),
      relinkable: false,
      classification: "not-relinkable-checkout-payment-intent",
    });
  }

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", candidateCount: candidates.length, candidates }, null, 2));
    return;
  }

  // Checkout owns these completed PaymentIntents and rejects later customer
  // reassignment. Do not create mappings or attempt an update: historical
  // purchases remain visible through the first-party ledger-backed history.
  const results = candidates.map((candidate) => ({ ...candidate, result: candidate.classification }));
  console.log(JSON.stringify({ mode: "apply", candidateCount: candidates.length, results }, null, 2));
}

try {
  await run();
} finally {
  await pool.end();
}
