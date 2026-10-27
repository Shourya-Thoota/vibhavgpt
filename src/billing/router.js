import express, { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import { applySubscriptionEvent, cancelSubscriptionForUser, changeSubscriptionPlan, createCheckoutSession, DOWNGRADE_PAUSED, createCreditCheckoutSession, createCustomerPortalSession, getCreditPurchaseHistory, getSubscriptionDetailsForUser, getSubscriptionForUser, tierForPriceLookupKey, verifyWebhookSignature } from "./service.js";
import { getCurrentUsage } from "../usage/service.js";
import { logFailure } from "../security/error-log.js";

export const billingRouter = Router();

billingRouter.get("/subscription", requireSession, async (req, res, next) => {
  try {
    const subscription = await getSubscriptionDetailsForUser(req.authSession.user.id);
    return res.json({ subscription: subscription ? { tier: subscription.tier, status: subscription.status, billingSource: subscription.billingSource ?? "stripe", currentPeriodEndsAt: subscription.currentPeriodEndsAt, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd } : null });
  } catch (error) { return next(error); }
});

// Downgrades stay paused until they can be applied at the period end.
export const PLAN_CHANGE_PAUSED = Object.freeze({
  code: "plan-change-paused",
  error: "Plan changes are paused right now. Please contact support to change your plan.",
});

// The request only chooses a price. The tier is granted by the signed webhook
// once the provider has the change, after payment for an upgrade; this route
// never writes one, and answers { pending: true } when the change is asked for.
billingRouter.post("/change-plan", requireSession, async (req, res, next) => {
  try {
    const result = await changeSubscriptionPlan({ userId: req.authSession.user.id, priceLookupKey: req.body?.priceLookupKey ?? "" });
    return res.json(result);
  } catch (error) {
    if (error.code === DOWNGRADE_PAUSED) return res.status(409).json(PLAN_CHANGE_PAUSED);
    if (["already-on-plan", "plan-ending", "change-scheduled", "plan-change-unavailable"].includes(error.code)) return res.status(409).json({ code: error.code, error: error.message });
    if (["Invalid price selection.", "The selected plan is unavailable."].includes(error.message)) return res.status(400).json({ error: error.message });
    if (error.message.startsWith("No active") || error.message.includes("no billable") || error.message.includes("can't be changed here")) return res.status(409).json({ error: error.message });
    return next(error);
  }
});

billingRouter.post("/cancel", requireSession, async (req, res, next) => {
  try { return res.json({ subscription: await cancelSubscriptionForUser(req.authSession.user.id) }); }
  catch (error) { if (error.message.startsWith("No active") || error.message.includes("can't be changed here")) return res.status(409).json({ error: error.message }); return next(error); }
});

billingRouter.post("/portal", requireSession, async (req, res, next) => {
  try {
    const url = await createCustomerPortalSession({
      userId: req.authSession.user.id,
      origin: req.headers.origin,
    });
    return res.json({ url });
  } catch (error) {
    // The service's message names the payment processor; the reader gets
    // the same fact without it.
    if (error.message.startsWith("There is no Stripe")) return res.status(409).json({ error: "There is no billing profile for this account yet." });
    return next(error);
  }
});

billingRouter.post("/checkout", requireSession, async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const [usage, currentSubscription] = await Promise.all([
      getCurrentUsage(userId),
      getSubscriptionForUser(userId),
    ]);
    const requestedTier = tierForPriceLookupKey(req.body?.priceLookupKey ?? "");
    if (usage.tier === "pro" || usage.tier === requestedTier) {
      return res.status(409).json({ error: `Your account already has an active ${usage.tier === "plus" ? "Plus" : "Pro"} subscription.`, code: "already-subscribed" });
    }
    if (currentSubscription && ["active", "trialing"].includes(currentSubscription.status)
      && currentSubscription.tier !== "free"
      && (!currentSubscription.currentPeriodEndsAt || currentSubscription.currentPeriodEndsAt > new Date())) {
      return res.status(409).json({ error: `Your ${currentSubscription.tier === "plus" ? "Plus" : "Pro"} plan is active until ${currentSubscription.currentPeriodEndsAt ? new Date(currentSubscription.currentPeriodEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "its period ends"}. You can choose a plan here after that.`, code: "already-subscribed" });
    }
    const url = await createCheckoutSession({
      userId: req.authSession.user.id,
      email: req.authSession.user.email,
      priceLookupKey: req.body?.priceLookupKey,
      origin: req.headers.origin,
      returnToApp: req.body?.returnToApp === true,
    });
    return res.json({ url });
  } catch (error) {
    if (error.message === "Invalid price selection.") return res.status(400).json({ error: error.message });
    return next(error);
  }
});

billingRouter.post("/credits/checkout", requireSession, async (req, res, next) => {
  try {
    const result = await createCreditCheckoutSession({
      userId: req.authSession.user.id,
      email: req.authSession.user.email,
      amount: req.body?.amount,
      origin: req.headers.origin,
      returnToApp: req.body?.returnToApp === true,
    });
    return res.json(result);
  } catch (error) {
    if (error.message.startsWith("Enter an amount")) return res.status(400).json({ error: error.message });
    return next(error);
  }
});

billingRouter.get("/credit-purchases", requireSession, async (req, res, next) => {
  try {
    const purchases = await getCreditPurchaseHistory(req.authSession.user.id);
    return res.json({ purchases });
  } catch (error) {
    return next(error);
  }
});

// This must be mounted before express.json() so the signed raw payload is preserved.
export const stripeWebhookHandler = [
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let stage = "verify";
    try {
      const event = verifyWebhookSignature(req.body, req.headers["stripe-signature"]);
      stage = "apply";
      await applySubscriptionEvent(event);
      return res.status(200).json({ received: true });
    } catch (error) {
      logFailure("billing_webhook_failed", error, { stage }, "warn");
      return res.status(400).json({ error: "Webhook could not be verified." });
    }
  },
];
