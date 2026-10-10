import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The billing and usage services are replaced with spies, so these tests
// prove which billing calls each route makes. Nothing reaches the payment
// provider or a database.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const calls = [];
const spy = (name, result) => async (...args) => { calls.push(name); return typeof result === "function" ? result(...args) : result; };
let usageTier = "free";
let changePlanBehaviour = () => ({ pending: true });
const changePlanArgs = [];
let storedSubscription = null;

mock.module(new URL("../src/billing/service.js", import.meta.url).href, {
  namedExports: {
    applySubscriptionEvent: spy("applySubscriptionEvent", true),
    cancelSubscriptionForUser: spy("cancelSubscriptionForUser", {}),
    changeSubscriptionPlan: spy("changeSubscriptionPlan", (...args) => changePlanBehaviour(...args)),
    DOWNGRADE_PAUSED: "downgrade-paused",
    createCheckoutSession: spy("createCheckoutSession", "https://checkout.example.test"),
    createCreditCheckoutSession: spy("createCreditCheckoutSession", "https://checkout.example.test"),
    createCustomerPortalSession: spy("createCustomerPortalSession", "https://portal.example.test"),
    getCreditPurchaseHistory: spy("getCreditPurchaseHistory", []),
    getSubscriptionDetailsForUser: spy("getSubscriptionDetailsForUser", null),
    getSubscriptionForUser: spy("getSubscriptionForUser", () => storedSubscription),
    tierForPriceLookupKey: (key) => (key.startsWith("vibhavgpt_plus_") ? "plus" : "pro"),
    verifyWebhookSignature: () => { throw new Error("not used in these tests"); },
  },
});
mock.module(new URL("../src/usage/service.js", import.meta.url).href, {
  namedExports: { getCurrentUsage: spy("getCurrentUsage", () => ({ tier: usageTier })) },
});

const { default: express } = await import("express");
const { billingRouter, PLAN_CHANGE_PAUSED } = await import("../src/billing/router.js");

async function request(t, path, { session = null, body = {} } = {}) {
  const app = express();
  app.use(express.json());
  if (session) app.use((req, _res, next) => { req.authSession = session; next(); });
  app.use("/api/billing", billingRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const plusMember = { user: { id: "plus-member", email: "member@example.invalid" } };

test("change-plan passes only the chosen price to the service and answers pending", async (t) => {
  calls.length = 0;
  changePlanBehaviour = (args) => { changePlanArgs.push(args); return { pending: true }; };
  const { status, body } = await request(t, "/api/billing/change-plan", { session: plusMember, body: { priceLookupKey: "vibhavgpt_pro_monthly", tier: "pro", status: "active" } });
  assert.equal(status, 200);
  assert.deepEqual(body, { pending: true });
  assert.deepEqual(changePlanArgs.at(-1), { userId: "plus-member", priceLookupKey: "vibhavgpt_pro_monthly" }, "a tier or status in the request is ignored");
  assert.deepEqual(calls, ["changeSubscriptionPlan"]);
});

test("a downgrade keeps the existing paused 409", async (t) => {
  changePlanBehaviour = () => { throw Object.assign(new Error("paused"), { code: "downgrade-paused" }); };
  const { status, body } = await request(t, "/api/billing/change-plan", { session: plusMember, body: { priceLookupKey: "vibhavgpt_plus_monthly" } });
  assert.equal(status, 409);
  assert.deepEqual(body, { code: "plan-change-paused", error: "Plan changes are paused right now. Please contact support to change your plan." });
  assert.deepEqual(PLAN_CHANGE_PAUSED, body);
  changePlanBehaviour = () => { throw new Error("Invalid price selection."); };
  assert.equal((await request(t, "/api/billing/change-plan", { session: plusMember, body: { priceLookupKey: "forged" } })).status, 400);
});

test("change-plan without a session is still refused with 401", async (t) => {
  calls.length = 0;
  const { status } = await request(t, "/api/billing/change-plan", { body: { priceLookupKey: "vibhavgpt_pro_monthly" } });
  assert.equal(status, 401);
  assert.deepEqual(calls, []);
});

test("checkout still refuses an existing subscriber with 409 already-subscribed", async (t) => {
  calls.length = 0;
  usageTier = "plus";
  storedSubscription = { tier: "plus", status: "active", billingSource: "stripe", subscriptionId: "sub_test" };
  const same = await request(t, "/api/billing/checkout", { session: plusMember, body: { priceLookupKey: "vibhavgpt_plus_monthly" } });
  assert.equal(same.status, 409);
  assert.equal(same.body.code, "already-subscribed");
  usageTier = "pro";
  const pro = await request(t, "/api/billing/checkout", { session: plusMember, body: { priceLookupKey: "vibhavgpt_plus_yearly" } });
  assert.equal(pro.status, 409);
  assert.equal(pro.body.code, "already-subscribed");
  assert.ok(!calls.includes("createCheckoutSession"), "no checkout session is created for an existing subscriber");
});

test("a refused or pending plan change never shows the new plan before the server confirms it", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("async function purchase(planId)");
  const purchase = app.slice(start, app.indexOf("async function cancelPlan()", start));
  const [tryBlock, catchBlock] = purchase.split("} catch (err) {");
  assert.match(tryBlock, /api\("\/api\/billing\/change-plan"/);
  assert.match(catchBlock, /setError\(message \|\| /, "the server's error text is shown");
  assert.doesNotMatch(catchBlock, /reload|setSubscription|setNotice|assign\(/, "a refusal neither reloads nor changes the plan shown");
  assert.doesNotMatch(tryBlock, /setSubscription\(/, "the reply never sets the plan shown");
  assert.match(tryBlock, /else if \(result\.pending\) \{[\s\S]*?if \(await waitForPlan\(planId\)\) window\.location\.reload\(\);/, "a pending change reloads only once the server shows the new plan");
  const wait = app.slice(app.indexOf("async function waitForPlan(planId)"), start);
  assert.match(wait, /api\("\/api\/billing\/subscription"/);
  assert.match(wait, /latest\?\.subscription\?\.tier === planId/);
});
