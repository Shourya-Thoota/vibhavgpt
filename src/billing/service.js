import Stripe from "stripe";
import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { billingCustomers, creditLedger, subscriptions } from "../db/schema.js";

export const VALID_PRICE_LOOKUP_KEYS = new Set([
  "vibhavgpt_plus_monthly",
  "vibhavgpt_plus_yearly",
  "vibhavgpt_pro_monthly",
  "vibhavgpt_pro_yearly",
]);

export const CREDIT_PURCHASE = Object.freeze({
  minimumCents: 100,
  maximumCents: 50_000,
  creditsPerDollar: 100,
  presets: [5, 10, 20, 50],
});

export function tierForPriceLookupKey(priceLookupKey) {
  return priceLookupKey.startsWith("vibhavgpt_plus_") ? "plus" : "pro";
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

export async function createCheckoutSession({ userId, email, priceLookupKey, origin, returnToApp = false }) {
  if (!VALID_PRICE_LOOKUP_KEYS.has(priceLookupKey)) throw new Error("Invalid price selection.");
  const stripe = stripeClient();
  const prices = await stripe.prices.list({ lookup_keys: [priceLookupKey], limit: 1 });
  const price = prices.data[0];
  if (!price) throw new Error("The selected plan is unavailable.");
  const tier = tierForPriceLookupKey(priceLookupKey);
  const baseUrl = config.clientOrigins.includes(origin) ? origin : config.clientOrigins[0];
  const redirects = checkoutRedirectUrls({ baseUrl, returnToApp });
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    customer_email: email,
    client_reference_id: userId,
    subscription_data: { trial_period_days: 7, metadata: { userId, tier } },
    metadata: { userId, tier },
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

export function normalizeCreditPurchaseAmount(amount) {
  const dollars = Number(amount);
  const cents = Math.round(dollars * 100);
  const faithfullyRepresented = Number.isFinite(dollars) && Math.abs(dollars * 100 - cents) < 0.0001;
  if (!faithfullyRepresented || cents < CREDIT_PURCHASE.minimumCents || cents > CREDIT_PURCHASE.maximumCents || cents % 10 !== 0) {
    throw new Error("Enter an amount from $1 to $500 in $0.10 increments.");
  }
  return { dollars: cents / 100, cents, credits: cents };
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
        product_data: { name: `VibhavGPT Flex Credits (${credits})` },
      },
    }],
    metadata: {
      kind: "credit_purchase",
      userId,
      credits: String(credits),
      amountCents: String(cents),
    },
    payment_intent_data: { metadata: { kind: "credit_purchase", userId, credits: String(credits) } },
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

async function priceForLookupKey(stripe, priceLookupKey) {
  if (!VALID_PRICE_LOOKUP_KEYS.has(priceLookupKey)) throw new Error("Invalid price selection.");
  const prices = await stripe.prices.list({ lookup_keys: [priceLookupKey], limit: 1, active: true });
  if (!prices.data[0]) throw new Error("The selected plan is unavailable.");
  return prices.data[0];
}

export async function changeSubscriptionPlan({ userId, priceLookupKey }) {
  const record = await getSubscriptionForUser(userId);
  if (record && record.billingSource !== "stripe") throw new Error("This plan wasn't bought on the web, so it can't be changed here. It ends at the close of its paid period.");
  if (!record?.subscriptionId) throw new Error("No active Stripe subscription was found for this account.");
  const stripe = stripeClient();
  const price = await priceForLookupKey(stripe, priceLookupKey);
  const current = await stripe.subscriptions.retrieve(record.subscriptionId);
  const item = current.items.data[0];
  if (!item) throw new Error("The Stripe subscription has no billable item.");
  const tier = tierForPriceLookupKey(priceLookupKey);
  const updated = await stripe.subscriptions.update(record.subscriptionId, {
    items: [{ id: item.id, price: price.id }],
    proration_behavior: "none",
    cancel_at_period_end: false,
    metadata: { ...current.metadata, userId, tier },
  });
  await saveSubscription({
    userId,
    customerId: typeof updated.customer === "string" ? updated.customer : record.customerId,
    subscriptionId: updated.id,
    tier,
    status: updated.status,
    currentPeriodStartedAt: updated.current_period_start ? new Date(updated.current_period_start * 1000) : record.currentPeriodStartedAt,
    currentPeriodEndsAt: updated.current_period_end ? new Date(updated.current_period_end * 1000) : record.currentPeriodEndsAt,
  });
  return { tier, status: updated.status, currentPeriodEndsAt: updated.current_period_end ? new Date(updated.current_period_end * 1000) : null };
}

export async function cancelSubscriptionForUser(userId) {
  const record = await getSubscriptionForUser(userId);
  if (record && record.billingSource !== "stripe") throw new Error("This plan wasn't bought on the web, so it can't be changed here. It ends at the close of its paid period.");
  if (!record?.subscriptionId) throw new Error("No active Stripe subscription was found for this account.");
  const stripe = stripeClient();
  const updated = await stripe.subscriptions.update(record.subscriptionId, { cancel_at_period_end: true });
  await saveSubscription({
    userId,
    customerId: typeof updated.customer === "string" ? updated.customer : record.customerId,
    subscriptionId: updated.id,
    tier: record.tier,
    status: updated.status,
    currentPeriodStartedAt: updated.current_period_start ? new Date(updated.current_period_start * 1000) : record.currentPeriodStartedAt,
    currentPeriodEndsAt: updated.current_period_end ? new Date(updated.current_period_end * 1000) : record.currentPeriodEndsAt,
  });
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
    console.warn("Conflicting Stripe subscription cancellation failed.", {
      code: /^[a-z0-9_.-]{1,60}$/i.test(String(error?.code ?? "")) ? error.code : "stripe-error",
      status: Number.isInteger(error?.statusCode) ? error.statusCode : null,
    });
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

export async function applySubscriptionEvent(event, { persist = saveSubscription, grantCredits = grantCreditPurchase } = {}) {
  const object = event.data?.object;
  const userId = extractUserId(object);
  if (!userId) return false;

  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    if (object.metadata?.kind === "credit_purchase") {
      if (object.payment_status !== "paid") return false;
      return grantCredits({
        userId,
        credits: object.metadata?.credits,
        checkoutSessionId: object.id,
      });
    }
    const saved = await persist({
      userId,
      customerId: typeof object.customer === "string" ? object.customer : null,
      subscriptionId: typeof object.subscription === "string" ? object.subscription : null,
      tier: object.metadata?.tier === "plus" ? "plus" : "pro",
      status: "trialing",
      billingSource: "stripe",
      providerProductId: null,
      providerBasePlanId: null,
      providerPurchaseTokenHash: null,
      cancelAtPeriodEnd: false,
    });
    if (saved === false) await cancelConflictingStripeSubscription(typeof object.subscription === "string" ? object.subscription : null);
    return true;
  }

  if (["customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const status = event.type === "customer.subscription.deleted" ? "canceled" : object.status;
    const saved = await persist({
      userId,
      customerId: typeof object.customer === "string" ? object.customer : null,
      subscriptionId: object.id,
      tier: isPaidStatus(status) ? (object.metadata?.tier === "plus" ? "plus" : "pro") : "free",
      status,
      billingSource: "stripe",
      providerProductId: null,
      providerBasePlanId: null,
      providerPurchaseTokenHash: null,
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
      currentPeriodStartedAt: object.current_period_start ? new Date(object.current_period_start * 1000) : null,
      currentPeriodEndsAt: object.current_period_end ? new Date(object.current_period_end * 1000) : null,
    });
    if (saved === false && isPaidStatus(status)) await cancelConflictingStripeSubscription(object.id);
    return true;
  }
  return false;
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.stripeWebhookSecret || !signature) throw new Error("Invalid webhook signature.");
  return stripeClient().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

// Cancels every paid subscription the account has. The stored subscription
// and the account's customers are checked directly; the metadata search is
// a last net for a subscription the database never recorded. Search can be
// unavailable on an account, so it may fail without blocking the others.
export async function cancelActiveSubscriptionsForUser(userId, { subscriptionId = null, customerIds = [] } = {}, stripe = stripeClient()) {
  const toCancel = new Map();
  if (subscriptionId) {
    const known = await stripe.subscriptions.retrieve(subscriptionId).catch((error) => (error?.statusCode === 404 ? null : Promise.reject(error)));
    if (known && isPaidStatus(known.status)) toCancel.set(known.id, known);
  }
  for (const customer of new Set(customerIds.filter(Boolean))) {
    const listed = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
    for (const subscription of listed.data) if (isPaidStatus(subscription.status)) toCancel.set(subscription.id, subscription);
  }
  const searched = await stripe.subscriptions.search({ query: `metadata['userId']:'${userId.replace(/'/g, "\\'")}'` }).catch(() => ({ data: [] }));
  for (const subscription of searched.data) if (isPaidStatus(subscription.status)) toCancel.set(subscription.id, subscription);
  for (const id of toCancel.keys()) await stripe.subscriptions.cancel(id);
  return [...toCancel.keys()];
}
