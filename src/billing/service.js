import { CREDIT_PURCHASE, parsePurchaseAmount, purchaseEligibility } from "../../frontend/src/flex-credits.js";
import Stripe from "stripe";
import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { logFailure } from "../security/error-log.js";
import { db } from "../db/client.js";
import { billingCustomers, creditLedger, subscriptions } from "../db/schema.js";
import { planPriceProblem } from "./price-check.js";

export const VALID_PRICE_LOOKUP_KEYS = new Set([
  "vibhavgpt_plus_monthly",
  "vibhavgpt_plus_yearly",
  "vibhavgpt_pro_monthly",
  "vibhavgpt_pro_yearly",
  "vibhavgpt_max_monthly",
  "vibhavgpt_max_yearly",
]);

// The purchase terms live in one shared module, so the screens and this server always say and charge the same thing.
export { CREDIT_PURCHASE };

// The tier for one of our own price lookup keys, or null for anything else.
// There is no default: an unknown or missing price never maps to a paid tier.
const PRICE_TIERS = new Map([
  ["vibhavgpt_plus_monthly", "plus"],
  ["vibhavgpt_plus_yearly", "plus"],
  ["vibhavgpt_pro_monthly", "pro"],
  ["vibhavgpt_pro_yearly", "pro"],
  ["vibhavgpt_max_monthly", "max"],
  ["vibhavgpt_max_yearly", "max"],
]);
const TIER_RANK = { plus: 1, pro: 2, max: 3 };

export function tierForPriceLookupKey(priceLookupKey) {
  return PRICE_TIERS.get(priceLookupKey) ?? null;
}

// Max's first prices ($50 a month, $500 a year). On 2026-11-15 their lookup keys moved to the $49.99 and $499.90 prices, so new checkouts
// charge those; a subscription already on a first price keeps it (Stripe never moves it), and is still known as Max, by its id, for
// webhooks, the account page and plan changes.
export const LEGACY_PRICE_LOOKUP_KEYS = Object.freeze(new Map([
  ["price_1UZK0mEvJtB4KP3epmg81zGY", "vibhavgpt_max_monthly"],
  ["price_1UZK0mEvJtB4KP3epTXokRWc", "vibhavgpt_max_yearly"],
]));

/** The plan key a billed price stands for: its own lookup key, or, for a price whose key moved on, the key it had. */
export function priceLookupKeyOf(price) {
  return price?.lookup_key || LEGACY_PRICE_LOOKUP_KEYS.get(price?.id) || "";
}

const billingInterval = (priceLookupKey) => (priceLookupKey?.endsWith("_yearly") ? "yearly" : "monthly");

// The tier the provider actually bills this subscription for, or null.
export function billedTier(subscription) {
  const item = subscription?.items?.data?.[0];
  const lookupKey = priceLookupKeyOf(item?.price);
  const fromLookup = tierForPriceLookupKey(lookupKey);
  if (fromLookup) return fromLookup;
  const priceId = item?.price?.id;
  if (priceId && (priceId === config.stripeMaxPriceId || priceId === config.stripeMaxYearlyPriceId)) {
    return "max";
  }
  return null;
}

// Newer provider API versions keep the billing period on the item.
function periodBoundary(subscription, field) {
  const seconds = subscription?.[field] ?? subscription?.items?.data?.[0]?.[field];
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

// The local row for a subscription as the provider reports it right now. A
// paid tier needs a paid status (active only follows a paid invoice; trialing
// only follows checkout) and a price we sell; anything else is free.
export function subscriptionRecordFor(subscription, userId) {
  const status = subscription.status;
  const tier = isPaidStatus(status) ? billedTier(subscription) ?? "free" : "free";
  return {
    userId,
    customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null,
    subscriptionId: subscription.id,
    tier,
    status,
    billingSource: "stripe",
    providerProductId: null,
    providerBasePlanId: null,
    providerPurchaseTokenHash: null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    currentPeriodStartedAt: periodBoundary(subscription, "current_period_start"),
    currentPeriodEndsAt: periodBoundary(subscription, "current_period_end"),
  };
}

function stripeClient() {
  if (!config.stripeSecretKey) throw new Error("Billing is not configured.");
  return new Stripe(config.stripeSecretKey);
}

export function checkoutRedirectUrls({ baseUrl, returnToApp = false, result }) {
  const accountUrl = returnToApp ? "vibhavgpt://account" : `${baseUrl}/account`;
  if (result === "credits") {
    return {
      successUrl: `${accountUrl}?credits=success`,
      cancelUrl: `${accountUrl}?credits=cancelled`,
    };
  }
  return {
    successUrl: `${accountUrl}?upgraded=true`,
    cancelUrl: accountUrl,
  };
}

// One trial per account, ever: any earlier subscription, in the local row or
// in the provider's records for this account, rules a new trial out.
export async function hadSubscriptionBefore({ userId, customerId }, { stripe, executor = db } = {}) {
  const row = await getSubscriptionForUser(userId, executor);
  if (row && (row.subscriptionId || row.status === "trialing" || (row.billingSource === "stripe" && row.tier !== "free"))) return true;
  if (customerId) {
    const listed = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 1 });
    if (listed.data.length) return true;
  }
  // A last net for subscriptions held under an older customer record. Search
  // can be unavailable on an account; the checks above still apply then.
  const searched = await stripe.subscriptions.search({ query: `metadata['userId']:'${userId.replace(/'/g, "\\'")}'`, limit: 1 }).catch(() => null);
  return Boolean(searched?.data?.length);
}

// Short notes shown on the Stripe Checkout page, above the pay button
// (submit) and below it (after_submit). Every line must match what this file
// and the Terms actually do: a first subscription gets a 7-day trial, plans
// renew unless canceled, cancellation is in Plan and billing, and Flex
// Credits are a one-time purchase added once the payment is confirmed.
const CANCEL_NOTE = "You can cancel in VibhavGPT under Plan and billing. Billing terms are at vibhavgpt.com/terms.";
export const CHECKOUT_TEXT = {
  trial: {
    submit: { message: "Your 7-day VibhavGPT trial starts today. When it ends, you are billed the price shown, and your plan renews unless you cancel." },
    after_submit: { message: CANCEL_NOTE },
  },
  paid: {
    submit: { message: "Your VibhavGPT plan starts today and you are billed the price shown. Your plan renews unless you cancel." },
    after_submit: { message: CANCEL_NOTE },
  },
  credits: {
    submit: { message: "This is a one-time purchase of VibhavGPT image & document credits. It does not renew." },
    after_submit: { message: "Your credits are added to your VibhavGPT account once the payment is confirmed. Credit terms are at vibhavgpt.com/terms." },
  },
};

// Max is authorized for release with monthly and annual billing.
export function isMaxCheckoutConfigured() {
  return true;
}

function assertPlanPurchasable(priceLookupKey) {
  if (tierForPriceLookupKey(priceLookupKey) === "max" && !isMaxCheckoutConfigured()) {
    throw new Error("The selected plan is unavailable.");
  }
}

export async function createCheckoutSession({ userId, email, priceLookupKey, origin, returnToApp = false }, { stripe, executor = db, getCustomer = getOrCreateBillingCustomer } = {}) {
  if (!tierForPriceLookupKey(priceLookupKey ?? "")) throw new Error("Invalid price selection.");
  assertPlanPurchasable(priceLookupKey);
  const client = stripe ?? stripeClient();
  const price = await resolvePlanPrice(client, priceLookupKey);
  const baseUrl = config.clientOrigins.includes(origin) ? origin : config.clientOrigins[0];
  const redirects = checkoutRedirectUrls({ baseUrl, returnToApp });
  const customerId = await getCustomer({ userId, email }, { stripe: client, executor });
  const isMax = tierForPriceLookupKey(priceLookupKey) === "max";
  const trial = !isMax && !(await hadSubscriptionBefore({ userId, customerId }, { stripe: client, executor }));
  // The tier is never taken from metadata; the webhook reads the billed price.
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    customer: customerId,
    client_reference_id: userId,
    subscription_data: { ...(trial ? { trial_period_days: 7 } : {}), metadata: { userId } },
    metadata: { userId },
    custom_text: trial ? CHECKOUT_TEXT.trial : CHECKOUT_TEXT.paid,
    success_url: redirects.successUrl,
    cancel_url: redirects.cancelUrl,
  });
  return session.url;
}

export async function createCustomerPortalSession({ userId, origin }, executor = db) {
  const subscription = await getSubscriptionForUser(userId, executor);
  if (subscription?.billingSource !== "stripe" || !subscription?.customerId) {
    throw new Error("There is no Stripe billing profile for this account yet.");
  }
  const stripe = stripeClient();
  const baseUrl = config.clientOrigins.includes(origin) ? origin : config.clientOrigins[0];
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.customerId,
    return_url: `${baseUrl}/?billing=return`,
  });
  return session.url;
}

// A balance is not sold to an account that could not spend it. Free has no documents and Pro and Max have unlimited ones, so there is nothing
// for the credits to pay for. A balance already held is not touched by this.
export function assertCreditPurchaseAllowed(tier) {
  const eligibility = purchaseEligibility(tier);
  if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { status: 403, code: "credits_not_usable_on_plan" });
}

export function normalizeCreditPurchaseAmount(amount) {
  const parsed = parsePurchaseAmount(amount);
  if (!parsed.ok) throw new Error(parsed.error);
  return { dollars: parsed.dollars, cents: parsed.cents, credits: parsed.credits };
}

export function creditCheckoutSessionParams({ userId, customerId, cents, credits, redirects }) {
  return {
    mode: "payment",
    customer: customerId,
    client_reference_id: userId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: cents,
        product_data: { name: `VibhavGPT image & document credits (${credits})` },
      },
    }],
    metadata: {
      kind: "credit_purchase",
      userId,
      credits: String(credits),
      amountCents: String(cents),
    },
    payment_intent_data: { metadata: { kind: "credit_purchase", userId, credits: String(credits) } },
    custom_text: CHECKOUT_TEXT.credits,
    success_url: redirects.successUrl,
    cancel_url: redirects.cancelUrl,
  };
}

export async function createCreditCheckoutSession({ userId, email, amount, origin, returnToApp = false }, { stripe = stripeClient(), getCustomer = getOrCreateBillingCustomer } = {}) {
  const { dollars, cents, credits } = normalizeCreditPurchaseAmount(amount);
  const baseUrl = config.clientOrigins.includes(origin) ? origin : config.clientOrigins[0];
  const redirects = checkoutRedirectUrls({ baseUrl, returnToApp, result: "credits" });
  const customerId = await getCustomer({ userId, email }, { stripe });
  const session = await stripe.checkout.sessions.create(creditCheckoutSessionParams({ userId, customerId, cents, credits, redirects }));
  return { url: session.url, credits, dollars };
}

export async function getSubscriptionForUser(userId, executor = db) {
  const [record] = await executor.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  return record ?? null;
}

async function getStoredBillingCustomer(userId, executor = db) {
  const [record] = await executor
    .select({ customerId: billingCustomers.customerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, userId))
    .limit(1);
  return record?.customerId ?? null;
}

async function storeBillingCustomer({ userId, customerId }, executor = db) {
  await executor
    .insert(billingCustomers)
    .values({ userId, customerId })
    .onConflictDoNothing();
  return getStoredBillingCustomer(userId, executor);
}

// The deterministic Stripe idempotency key makes concurrent/retried checkout
// creation safe even before the local mapping has been committed.
export async function getOrCreateBillingCustomer({ userId, email }, { stripe = stripeClient(), executor = db } = {}) {
  const storedCustomerId = await getStoredBillingCustomer(userId, executor);
  if (storedCustomerId) return storedCustomerId;

  const subscription = await getSubscriptionForUser(userId, executor);
  const customerId = subscription?.customerId
    ?? (await stripe.customers.create({ email, metadata: { userId } }, { idempotencyKey: `billing-customer:${userId}` })).id;
  const persistedCustomerId = await storeBillingCustomer({ userId, customerId }, executor);
  if (!persistedCustomerId) throw new Error("Unable to prepare a billing profile.");
  return persistedCustomerId;
}

export function creditPurchaseHistoryItem(entry, session) {
  const paymentIntent = session && typeof session.payment_intent === "object" ? session.payment_intent : null;
  const latestCharge = paymentIntent && typeof paymentIntent.latest_charge === "object" ? paymentIntent.latest_charge : null;
  const amountFromMetadata = Number(session?.metadata?.amountCents);
  return {
    id: entry.externalReference?.replace("stripe_checkout:", "") ?? entry.id,
    purchasedAt: session?.created ? new Date(session.created * 1000) : entry.createdAt,
    creditsGranted: entry.credits,
    amountCents: Number.isSafeInteger(session?.amount_total) ? session.amount_total : (Number.isSafeInteger(amountFromMetadata) ? amountFromMetadata : null),
    currency: session?.currency ?? "usd",
    status: session?.payment_status === "paid" ? "paid" : "recorded",
    receiptUrl: latestCharge?.receipt_url ?? null,
  };
}

// Ledger entries are created only by the paid webhook path. Reading this view
// neither mutates a balance nor relies on Stripe invoices (one-time Checkouts
// create PaymentIntents instead).
export async function getCreditPurchaseHistory(userId, { stripe = stripeClient(), executor = db } = {}) {
  const entries = await executor
    .select({ id: creditLedger.id, credits: creditLedger.credits, externalReference: creditLedger.externalReference, createdAt: creditLedger.createdAt })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, "stripe_purchase")))
    .orderBy(desc(creditLedger.createdAt));

  return Promise.all(entries.map(async (entry) => {
    const checkoutSessionId = entry.externalReference?.startsWith("stripe_checkout:")
      ? entry.externalReference.slice("stripe_checkout:".length)
      : null;
    if (!checkoutSessionId) return creditPurchaseHistoryItem(entry, null);
    try {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, { expand: ["payment_intent.latest_charge"] });
      return creditPurchaseHistoryItem(entry, session);
    } catch {
      // The ledger remains an accurate, user-scoped fallback if a historical
      // provider record is unavailable.
      return creditPurchaseHistoryItem(entry, null);
    }
  }));
}

export async function getSubscriptionDetailsForUser(userId) {
  const record = await getSubscriptionForUser(userId);
  if (!record) return null;
  if (record.billingSource !== "stripe") return { ...record, cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd) };
  if (!record.subscriptionId || !config.stripeSecretKey) return { ...record, cancelAtPeriodEnd: false };
  try {
    const stripeSubscription = await stripeClient().subscriptions.retrieve(record.subscriptionId);
    return { ...record, cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end) };
  } catch {
    return { ...record, cancelAtPeriodEnd: false };
  }
}

// The price a checkout or plan change charges. Max may be pinned to an exact price by STRIPE_PRICE_ID_MAX / STRIPE_PRICE_ID_MAX_YEARLY, but a
// pinned price is used only if it is the right one (active, USD, recurring, the chosen interval, our own lookup key for this plan). A slip in
// those hand-set variables is logged by kind (never the id) and the price our lookup key names is used instead, so it cannot charge the wrong thing.
export async function resolvePlanPrice(stripe, priceLookupKey) {
  const pinnedId = priceLookupKey === "vibhavgpt_max_monthly" ? config.stripeMaxPriceId
    : priceLookupKey === "vibhavgpt_max_yearly" ? config.stripeMaxYearlyPriceId
    : null;
  let price = null;
  if (pinnedId) {
    const candidate = await stripe.prices.retrieve(pinnedId).catch(() => null);
    const problem = planPriceProblem(candidate, priceLookupKey);
    if (problem) console.warn(JSON.stringify({ event: "billing_price_override_rejected", priceLookupKey, problem }));
    else price = candidate;
  }
  if (!price) {
    const prices = await stripe.prices.list({ lookup_keys: [priceLookupKey], limit: 1, active: true });
    price = prices.data[0];
    // The price our own lookup key names is held to the same rule for Max. If it is wrong too, nothing is charged: the plan is unavailable,
    // never another plan or another interval.
    const problem = tierForPriceLookupKey(priceLookupKey) === "max" && price ? planPriceProblem(price, priceLookupKey) : null;
    if (problem) {
      console.warn(JSON.stringify({ event: "billing_price_rejected", priceLookupKey, source: "lookup", problem }));
      price = null;
    }
  }
  if (!price) throw new Error("The selected plan is unavailable.");
  return price;
}

async function priceForLookupKey(stripe, priceLookupKey) {
  if (!VALID_PRICE_LOOKUP_KEYS.has(priceLookupKey)) throw new Error("Invalid price selection.");
  assertPlanPurchasable(priceLookupKey);
  return resolvePlanPrice(stripe, priceLookupKey);
}

// A refused plan change, carrying the code the route answers with.
export class PlanChangeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const DOWNGRADE_PAUSED = "downgrade-paused";

// Plan changes never write a tier. The provider is asked for the change, and
// the signed webhook grants the new tier once the provider reports it.
//  - An upgrade (a higher tier, or monthly to yearly) on a paid plan is
//    invoiced immediately and applied only if that invoice is paid
//    (always_invoice + pending_if_incomplete). A declined charge leaves the
//    subscription, and so the tier, as it was.
//  - During a trial the change keeps the trial; the new price is billed when
//    the trial ends.
//  - Downgrades are paused: applying them at the period end needs a
//    subscription schedule, which is not built yet.
export async function changeSubscriptionPlan({ userId, priceLookupKey }, { stripe, executor = db } = {}) {
  const targetTier = tierForPriceLookupKey(priceLookupKey ?? "");
  if (!targetTier) throw new Error("Invalid price selection.");
  const record = await getSubscriptionForUser(userId, executor);
  if (record && record.billingSource !== "stripe") throw new Error("This plan wasn't bought on the web, so it can't be changed here. It ends at the close of its paid period.");
  if (!record?.subscriptionId) throw new Error("No active Stripe subscription was found for this account.");
  const client = stripe ?? stripeClient();
  const current = await client.subscriptions.retrieve(record.subscriptionId);
  if (!isPaidStatus(current.status)) throw new Error("No active Stripe subscription was found for this account.");
  const item = current.items?.data?.[0];
  if (!item) throw new Error("The Stripe subscription has no billable item.");
  const currentKey = priceLookupKeyOf(item.price);
  const currentTier = tierForPriceLookupKey(currentKey);
  if (!currentTier) throw new PlanChangeError("plan-change-unavailable", "This plan can't be changed here. Please contact support to change your plan.");
  if (currentKey === priceLookupKey) throw new PlanChangeError("already-on-plan", "You're already on this plan.");
  const downgrade = TIER_RANK[targetTier] < TIER_RANK[currentTier]
    || (targetTier === currentTier && billingInterval(currentKey) === "yearly" && billingInterval(priceLookupKey) === "monthly");
  if (downgrade) throw new PlanChangeError(DOWNGRADE_PAUSED, "Plan changes are paused right now. Please contact support to change your plan.");
  if (current.cancel_at_period_end) throw new PlanChangeError("plan-ending", "Your plan is set to end at the close of this period, so it can't be changed now. You can choose a new plan after it ends.");
  if (current.schedule) throw new PlanChangeError("change-scheduled", "A plan change is already scheduled. Please contact support to change your plan.");
  const price = await priceForLookupKey(client, priceLookupKey);
  const items = [{ id: item.id, price: price.id }];
  if (current.status === "trialing") {
    await client.subscriptions.update(current.id, { items, proration_behavior: "none" });
    return { pending: true, trialing: true };
  }
  await client.subscriptions.update(current.id, { items, proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" });
  return { pending: true };
}

export async function cancelSubscriptionForUser(userId, { stripe, executor = db } = {}) {
  const record = await getSubscriptionForUser(userId, executor);
  if (record && record.billingSource !== "stripe") throw new Error("This plan wasn't bought on the web, so it can't be changed here. It ends at the close of its paid period.");
  if (!record?.subscriptionId) throw new Error("No active Stripe subscription was found for this account.");
  const client = stripe ?? stripeClient();
  const updated = await client.subscriptions.update(record.subscriptionId, { cancel_at_period_end: true });
  // Stored now rather than left to the webhook, so deleting the account right
  // after canceling is not refused while the webhook is still on its way.
  await saveSubscription({
    userId,
    customerId: typeof updated.customer === "string" ? updated.customer : record.customerId,
    subscriptionId: updated.id,
    tier: record.tier,
    status: updated.status,
    cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
    currentPeriodStartedAt: updated.current_period_start ? new Date(updated.current_period_start * 1000) : record.currentPeriodStartedAt,
    currentPeriodEndsAt: updated.current_period_end ? new Date(updated.current_period_end * 1000) : record.currentPeriodEndsAt,
  }, executor);
  return { cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end), currentPeriodEndsAt: updated.current_period_end ? new Date(updated.current_period_end * 1000) : null };
}

function extractUserId(object) {
  return object?.metadata?.userId ?? object?.client_reference_id ?? null;
}

function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

export async function saveSubscription(record, executor = db) {
  return executor.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${record.userId}, 0))`);
    const [current] = await tx.select().from(subscriptions)
      .where(eq(subscriptions.userId, record.userId)).limit(1);
    // A paid plan from an earlier, non-web billing source keeps precedence
    // until its period ends, so a web checkout can't silently replace it.
    const currentIsOtherSourceActive = current && current.billingSource !== "stripe"
      && ["active", "trialing"].includes(current.status)
      && current.tier !== "free"
      && (!current.currentPeriodEndsAt || current.currentPeriodEndsAt > new Date());
    if (currentIsOtherSourceActive && record.billingSource === "stripe") return false;
    // An event about an older subscription (replayed or late) never ends or
    // lowers the subscription the account is on now.
    const currentIsOtherLiveSubscription = current && record.subscriptionId && current.subscriptionId
      && current.subscriptionId !== record.subscriptionId
      && ["active", "trialing"].includes(current.status) && current.tier !== "free"
      && (!current.currentPeriodEndsAt || current.currentPeriodEndsAt > new Date());
    if (currentIsOtherLiveSubscription && !(isPaidStatus(record.status) && record.tier !== "free")) return false;

    const values = { ...record, updatedAt: new Date() };
    if (current) await tx.update(subscriptions).set(values).where(eq(subscriptions.id, current.id));
    else await tx.insert(subscriptions).values(values);
    return true;
  });
}

async function cancelConflictingStripeSubscription(subscriptionId) {
  if (!subscriptionId || !config.stripeSecretKey) throw new Error("A conflicting Stripe subscription could not be safely canceled.");
  try {
    await stripeClient().subscriptions.cancel(subscriptionId);
  } catch (error) {
    logFailure("stripe_conflicting_cancel_failed", error, {}, "warn");
    throw error;
  }
}

export async function grantCreditPurchase({ userId, credits, checkoutSessionId }, executor = db) {
  const amount = Number(credits);
  if (!userId || !Number.isSafeInteger(amount) || amount <= 0 || !checkoutSessionId) return false;
  const created = await executor
    .insert(creditLedger)
    .values({
      userId,
      credits: amount,
      kind: "stripe_purchase",
      externalReference: `stripe_checkout:${checkoutSessionId}`,
    })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
  return created.length > 0;
}

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);
const INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed"]);
const retrieveProviderSubscription = (subscriptionId) => stripeClient().subscriptions.retrieve(subscriptionId);

function subscriptionIdFromInvoice(invoice) {
  const id = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription;
  return typeof id === "string" ? id : id?.id ?? null;
}

// Signed events say which subscription changed; the tier always comes from
// that subscription as the provider reports it now, never from the event's
// own copy or from metadata. A replayed or out-of-order event therefore
// re-applies the current state, and nothing raises a tier the provider is
// not billing for.
async function syncSubscription(subscriptionId, userIdHint, { persist, retrieveSubscription }) {
  if (!subscriptionId) return false;
  const subscription = await retrieveSubscription(subscriptionId);
  if (!subscription?.id) return false;
  const userId = subscription.metadata?.userId ?? userIdHint ?? null;
  if (!userId) return false;
  const record = subscriptionRecordFor(subscription, userId);
  const saved = await persist(record);
  if (saved === false && isPaidStatus(record.status) && record.tier !== "free" && record.billingSource === "stripe") {
    // Only an active plan from another billing source refuses a paid web
    // subscription; that duplicate is canceled rather than double-billed.
    await cancelConflictingStripeSubscription(subscription.id);
  }
  return saved !== false;
}

export async function applySubscriptionEvent(event, { persist = saveSubscription, grantCredits = grantCreditPurchase, retrieveSubscription = retrieveProviderSubscription } = {}) {
  const object = event.data?.object;
  if (!object) return false;

  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    const userId = extractUserId(object);
    if (!userId) return false;
    if (object.metadata?.kind === "credit_purchase") {
      if (object.payment_status !== "paid") return false;
      return grantCredits({
        userId,
        credits: object.metadata?.credits,
        checkoutSessionId: object.id,
      });
    }
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id ?? null;
    return syncSubscription(subscriptionId, userId, { persist, retrieveSubscription });
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    return syncSubscription(object.id, object.metadata?.userId, { persist, retrieveSubscription });
  }

  if (INVOICE_EVENTS.has(event.type)) {
    return syncSubscription(subscriptionIdFromInvoice(object), object.parent?.subscription_details?.metadata?.userId, { persist, retrieveSubscription });
  }
  return false;
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.stripeWebhookSecret || !signature) throw new Error("Invalid webhook signature.");
  return stripeClient().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

