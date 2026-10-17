import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
const { config } = await import("../src/config.js");
config.stripeSecretKey = "sk_test_local_verification";
config.stripeWebhookSecret = "whsec_local_verification";
const { CHECKOUT_TEXT, applySubscriptionEvent, checkoutRedirectUrls, createCustomerPortalSession, createCreditCheckoutSession, creditCheckoutSessionParams, creditPurchaseHistoryItem, normalizeCreditPurchaseAmount, tierForPriceLookupKey, verifyWebhookSignature } = await import("../src/billing/service.js");

test("a non-web subscription cannot open a Stripe portal even with a stale Stripe customer ID", async () => {
  const executor = {
    select() { return this; }, from() { return this; }, where() { return this; },
    async limit() { return [{ billingSource: "app", customerId: "cus_stale_web_profile" }]; },
  };
  await assert.rejects(createCustomerPortalSession({ userId: "app-user", origin: "https://vibhavgpt.com" }, executor), /no Stripe billing profile/);
});

test("checkout redirect URLs preserve web checkout and return Capacitor users to the app", () => {
  assert.deepEqual(checkoutRedirectUrls({ baseUrl: "https://vibhavgpt.com" }), {
    successUrl: "https://vibhavgpt.com/account?upgraded=true",
    cancelUrl: "https://vibhavgpt.com/account",
  });
  assert.deepEqual(checkoutRedirectUrls({ baseUrl: "https://vibhavgpt.com", returnToApp: true }), {
    successUrl: "vibhavgpt://account?upgraded=true",
    cancelUrl: "vibhavgpt://account",
  });
});

test("Stripe lookup keys map to the correct subscription tier", () => {
  assert.equal(tierForPriceLookupKey("vibhavgpt_plus_monthly"), "plus");
  assert.equal(tierForPriceLookupKey("vibhavgpt_plus_yearly"), "plus");
  assert.equal(tierForPriceLookupKey("vibhavgpt_pro_monthly"), "pro");
  assert.equal(tierForPriceLookupKey("vibhavgpt_pro_yearly"), "pro");
  for (const unknown of ["", "vibhavgpt_team_monthly", "pro", "something_else"]) assert.equal(tierForPriceLookupKey(unknown), null, unknown);
});

// The webhook reads the subscription from the provider; this stands in for it.
const trialingPro = { id: "sub_123", status: "trialing", customer: "cus_123", cancel_at_period_end: false, metadata: { userId: "user-123" },
  items: { data: [{ id: "si_123", price: { id: "price_pro", lookup_key: "vibhavgpt_pro_monthly" }, current_period_start: 1_790_000_000, current_period_end: 1_790_604_800 }] } };

test("a correctly signed checkout event creates a Pro trial record", async () => {
  const payload = JSON.stringify({
    id: "evt_test_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: "user-123",
        customer: "cus_123",
        subscription: "sub_123",
        metadata: { userId: "user-123", tier: "pro" },
      },
    },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.stripeWebhookSecret,
  });
  const event = verifyWebhookSignature(Buffer.from(payload), signature);
  const records = [];
  // Pro comes from the price the provider bills, not from the event metadata.
  const changed = await applySubscriptionEvent(event, { persist: async (record) => records.push(record), retrieveSubscription: async () => trialingPro });
  assert.equal(changed, true);
  assert.deepEqual(records, [
    {
      userId: "user-123",
      customerId: "cus_123",
      subscriptionId: "sub_123",
      tier: "pro",
      status: "trialing",
      billingSource: "stripe",
      providerProductId: null,
      providerBasePlanId: null,
      providerPurchaseTokenHash: null,
      cancelAtPeriodEnd: false,
      currentPeriodStartedAt: new Date(1_790_000_000 * 1000),
      currentPeriodEndsAt: new Date(1_790_604_800 * 1000),
    },
  ]);
});

test("an invalid signature is rejected", () => {
  assert.throws(
    () => verifyWebhookSignature(Buffer.from("{}"), "t=1,v1=not-a-real-signature"),
    /signature/i,
  );
});

test("credit purchases scale at exactly 100 credits per dollar", () => {
  assert.deepEqual(normalizeCreditPurchaseAmount(5), { dollars: 5, cents: 500, credits: 500 });
  assert.deepEqual(normalizeCreditPurchaseAmount(7.5), { dollars: 7.5, cents: 750, credits: 750 });
  assert.deepEqual(normalizeCreditPurchaseAmount(50), { dollars: 50, cents: 5000, credits: 5000 });
  assert.throws(() => normalizeCreditPurchaseAmount(0.9), /\$1 to \$500/);
  assert.throws(() => normalizeCreditPurchaseAmount(5.55), /\$0\.10 increments/);
});

test("credit Checkouts always use an app-associated customer rather than the guest email path", async () => {
  const params = creditCheckoutSessionParams({
    userId: "user-credit-customer",
    customerId: "cus_owned_by_user",
    cents: 500,
    credits: 500,
    redirects: { successUrl: "https://vibhavgpt.com/account?credits=success", cancelUrl: "https://vibhavgpt.com/account?credits=cancelled" },
  });
  assert.equal(params.customer, "cus_owned_by_user");
  assert.equal("customer_email" in params, false);

  let created;
  await createCreditCheckoutSession(
    { userId: "user-credit-customer", email: "person@example.com", amount: 5, origin: "https://vibhavgpt.com" },
    {
      getCustomer: async () => "cus_owned_by_user",
      stripe: { checkout: { sessions: { create: async (value) => { created = value; return { url: "https://checkout.example.test" }; } } } },
    },
  );
  assert.equal(created.customer, "cus_owned_by_user");
  assert.equal("customer_email" in created, false);
});

test("credit purchase history presents the Checkout/PaymentIntent record without invoice dependence", () => {
  const item = creditPurchaseHistoryItem(
    { id: "ledger-1", credits: 300, externalReference: "stripe_checkout:cs_historical", createdAt: new Date("2026-09-13T12:00:00Z") },
    {
      created: 1_789_300_800,
      amount_total: 300,
      currency: "usd",
      payment_status: "paid",
      payment_intent: { latest_charge: { receipt_url: "https://receipts.example.test/receipt" } },
    },
  );
  assert.equal(item.id, "cs_historical");
  assert.equal(item.creditsGranted, 300);
  assert.equal(item.amountCents, 300);
  assert.equal(item.receiptUrl, "https://receipts.example.test/receipt");
});

test("a paid credit checkout grants its balance through the webhook path", async () => {
  const grants = [];
  const changed = await applySubscriptionEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_credit_123",
        payment_status: "paid",
        client_reference_id: "user-credits",
        metadata: { kind: "credit_purchase", userId: "user-credits", credits: "200" },
      },
    },
  }, { grantCredits: async (record) => { grants.push(record); return true; } });
  assert.equal(changed, true);
  assert.deepEqual(grants, [{ userId: "user-credits", credits: "200", checkoutSessionId: "cs_credit_123" }]);
});

test("a canceled subscription downgrades the user", async () => {
  const records = [];
  await applySubscriptionEvent(
    {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "canceled",
          current_period_end: 1_800_000_000,
          metadata: { userId: "user-123" },
        },
      },
    },
    {
      persist: async (record) => records.push(record),
      retrieveSubscription: async () => ({ ...trialingPro, status: "canceled", current_period_end: 1_800_000_000 }),
    },
  );
  assert.equal(records[0].tier, "free");
  assert.equal(records[0].status, "canceled");
  assert.equal(records[0].subscriptionId, "sub_123");
});

test("credit Checkout shows the one-time purchase notes and changes nothing else", () => {
  const redirects = { successUrl: "https://vibhavgpt.com/account?credits=success", cancelUrl: "https://vibhavgpt.com/account?credits=cancelled" };
  const { custom_text: text, ...rest } = creditCheckoutSessionParams({ userId: "user-1", customerId: "cus_1", cents: 750, credits: 750, redirects });
  assert.deepEqual(text, CHECKOUT_TEXT.credits);
  assert.match(text.submit.message, /one-time/);
  for (const { message } of Object.values(text)) {
    assert.ok(message.length <= 300);
    assert.doesNotMatch(message, /\u2014/);
  }
  // Every field but custom_text, exactly as it was before the notes were added.
  assert.deepEqual(rest, {
    mode: "payment",
    customer: "cus_1",
    client_reference_id: "user-1",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 750, product_data: { name: "VibhavGPT Flex Credits (750)" } } }],
    metadata: { kind: "credit_purchase", userId: "user-1", credits: "750", amountCents: "750" },
    payment_intent_data: { metadata: { kind: "credit_purchase", userId: "user-1", credits: "750" } },
    success_url: redirects.successUrl,
    cancel_url: redirects.cancelUrl,
  });
});
