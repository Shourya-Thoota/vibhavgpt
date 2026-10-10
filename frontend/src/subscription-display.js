export function subscriptionSummary(subscription) {
  if (!subscription) return { plan: "Free", status: "No subscription", provider: null };
  const labels = { free: "Free", plus: "Plus", pro: "Pro", paid: "Pro" };
  return {
    plan: labels[subscription.tier] ?? "Free",
    status: subscription.cancelAtPeriodEnd ? "Cancellation scheduled" : subscription.status.replaceAll("_", " "),
    // Where the plan is paid, in the reader's terms. The payment processor is
    // named on the legal pages only, never in the product.
    provider: !subscription.billingSource || subscription.billingSource === "stripe" ? "Web billing" : "Android app",
  };
}
