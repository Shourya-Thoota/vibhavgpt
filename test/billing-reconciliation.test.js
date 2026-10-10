import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("historical Checkout credit reconciliation classifies immutable payments without attempting reassignment", async () => {
  const source = await readFile(new URL("../scripts/reconcile-credit-customers.js", import.meta.url), "utf8");
  assert.match(source, /classification: "not-relinkable-checkout-payment-intent"/);
  assert.match(source, /result: candidate\.classification/);
  assert.doesNotMatch(source, /paymentIntents\.update/);
  assert.doesNotMatch(source, /getOrCreateBillingCustomer/);
});
