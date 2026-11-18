// Slice 6, task 0: the boot line's lumenAvailable describes the route Lumen is actually on. Under CHAT_LUMEN_ROUTE=paid-zdr it follows
// that route's guard, not the free gateway stage that route does not use.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
const guard = await import("../src/chat/route-policy-guard.js");
const { guardedRoutes } = await import("../src/chat/route-inventory.js");
const { inferencePolicyReport, logInferencePolicy } = await import("../src/chat/policy-report.js");

const PAID = "fixture/gemma-instruct";
const policy = { training: false, trainingOpenRouter: false, retainsPrompts: false, canPublish: false, safetyRetention: false };
const docs = {
  endpointsJson: { data: { endpoints: [{ provider_name: "Crusoe", tag: "crusoe/bf16", model_id: PAID, pricing: { prompt: "0.00000014", completion: "0.0000004" } }] } },
  providersHtml: `<script>self.__next_f.push([1,"[${JSON.stringify({ model_variant_slug: PAID, provider_name: "Crusoe", data_policy: policy }).replace(/"/g, "\\\"")}]"])</script>`,
};
const fetchImpl = async (url) => (String(url).endsWith("/endpoints") ? Response.json(docs.endpointsJson) : new Response(docs.providersHtml));
const saved = { route: config.lumenChatRoute, hosts: config.lumenPaidZdrProviders, fb: config.chatModels.lumenFallback1, base: config.providerBaseUrls.paid, key: config.providerKeys.paid };
afterEach(() => {
  Object.assign(config, { lumenChatRoute: saved.route, lumenPaidZdrProviders: saved.hosts });
  config.chatModels.lumenFallback1 = saved.fb;
  config.providerBaseUrls.paid = saved.base;
  config.providerKeys.paid = saved.key;
  guard.resetRoutePolicyStateForTests();
});

test("paid-zdr: lumenAvailable follows the paid route's guard, not the unused free gateway stage", async () => {
  Object.assign(config, { lumenChatRoute: "paid-zdr", lumenPaidZdrProviders: ["crusoe/bf16"] });
  config.chatModels.lumenFallback1 = `${PAID}:free`;
  config.providerBaseUrls.paid = "https://openrouter.ai/api/v1";
  config.providerKeys.paid = "fixture-key";
  const before = inferencePolicyReport();
  assert.equal(before.lumenAvailable, false, "closed until its guard has verified it");
  assert.deepEqual(before.lumenActiveRoute, { route: "paid-zdr", configured: true, approved: false, reason: "policy-unverified" });

  await guard.verifyRoutePolicy({ ...guardedRoutes().find((r) => r.route === "lumen"), fetchImpl, log: { info() {}, warn() {} } });
  const lines = { info: [], warn: [] };
  const after = logInferencePolicy({ info: (l) => lines.info.push(l), warn: (l) => lines.warn.push(l) });
  assert.equal(after.lumenAvailable, true);
  assert.deepEqual(after.lumenActiveRoute, { route: "paid-zdr", configured: true, approved: true, reason: "verified" });
  assert.equal(after.lumenStages.find((s) => s.stage === "gatewayFree").approved, false, "the free stage is reported as it is, and does not decide availability");
  assert.equal(lines.info.length, 1, "logged at info, not as a warning");
  assert.doesNotMatch(lines.info[0], /fixture-key|https?:\/\//, "names and yes/no only");
});
