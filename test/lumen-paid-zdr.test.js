// Slice 5.3: Lumen's paid zero-retention route (CHAT_LUMEN_ROUTE=paid-zdr), staged and off by default. The guard must see, from each
// pinned host's live policy, training: false and no retention before anything is sent; the request is pinned to those hosts with no
// fallbacks; the default stays the free gateway; the staged rollback and every other tier are unchanged. Nothing reaches the network.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config, lumenChatRouteFrom, LUMEN_PAID_ZDR_DEFAULT_PROVIDERS } = await import("../src/config.js");
const guard = await import("../src/chat/route-policy-guard.js");
const { guardedRoutes, routeInventory } = await import("../src/chat/route-inventory.js");
const { callModelStreaming, getModelConfig, InferenceUnavailableError } = await import("../src/chat/providers.js");

const ROUTER = "https://openrouter.ai/api/v1";
const FREE = "fixture/gemma-instruct:free";
const PAID = "fixture/gemma-instruct";
const policy = (over = {}) => ({ training: false, trainingOpenRouter: false, retainsPrompts: false, canPublish: false, safetyRetention: false, requiresUserIDs: false, ...over });
const host = (name, tag, dataPolicy) => ({ name, tag, dataPolicy, pricing: { prompt: "0.00000014", completion: "0.0000004" } });
function documents(model, hosts) {
  const endpointsJson = { data: { id: model, endpoints: hosts.map((h) => ({ name: `${h.name} | ${model}`, model_id: model, provider_name: h.name, tag: h.tag, pricing: h.pricing, context_length: 262144, status: 0 })) } };
  const records = hosts.map((h) => JSON.stringify({ model_variant_slug: model, provider_name: h.name, provider_info: { name: h.name, dataPolicy: h.dataPolicy }, data_policy: h.dataPolicy }).replace(/"/g, "\\\"")).join(",");
  return { endpointsJson, providersHtml: `<script>self.__next_f.push([1,"[${records}]"])</script>` };
}
const fetchFor = (docs) => async (url) => {
  if (String(url).endsWith("/endpoints")) return Response.json(docs.endpointsJson);
  if (String(url).endsWith("/providers")) return new Response(docs.providersHtml);
  return new Response("not found", { status: 404 });
};
const quiet = { info() {}, warn() {} };
const HOSTS = ["crusoe/bf16", "parasail/fp8"];
const compliant = () => documents(PAID, [host("Crusoe", "crusoe/bf16", policy()), host("Parasail", "parasail/fp8", policy())]);

const saved = { route: config.lumenChatRoute, hosts: config.lumenPaidZdrProviders, fallback1: config.chatModels.lumenFallback1, base: config.providerBaseUrls.paid, key: config.providerKeys.paid };
afterEach(() => {
  config.lumenChatRoute = saved.route;
  config.lumenPaidZdrProviders = saved.hosts;
  config.chatModels.lumenFallback1 = saved.fallback1;
  config.providerBaseUrls.paid = saved.base;
  config.providerKeys.paid = saved.key;
  guard.resetRoutePolicyStateForTests();
});
function paidZdr() {
  config.lumenChatRoute = "paid-zdr";
  config.lumenPaidZdrProviders = [...HOSTS];
  config.chatModels.lumenFallback1 = FREE;
  config.providerBaseUrls.paid = ROUTER;
  config.providerKeys.paid = "fixture-key";
}
const verify = (docs) => guard.verifyRoutePolicy({ ...guardedRoutes().find((r) => r.route === "lumen"), fetchImpl: fetchFor(docs), log: quiet });

test("the mode is opt-in: unset or anything else is the free gateway; staged stays the rollback", () => {
  assert.equal(lumenChatRouteFrom({}), "gateway");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: "something" }), "gateway");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: "staged" }), "staged");
  assert.equal(lumenChatRouteFrom({ CHAT_LUMEN_ROUTE: " Paid-ZDR " }), "paid-zdr");
  assert.deepEqual(LUMEN_PAID_ZDR_DEFAULT_PROVIDERS, ["crusoe/bf16", "parasail/fp8", "deepinfra/fp8"]);
});

test("guard: paid-zdr accepts only pinned hosts that neither train nor retain, and fails closed otherwise", () => {
  const evaluate = (docs, hosts = HOSTS) => guard.evaluateRoutePolicy({ ...docs, model: PAID, mode: "pinned", hosts, requireZeroRetention: true });
  assert.equal(evaluate(compliant()).ok, true);
  assert.deepEqual(evaluate(compliant()).allowedHosts, ["Crusoe", "Parasail"]);
  const retains = evaluate(documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ retainsPrompts: true, retentionDays: 30 }))]));
  assert.deepEqual([retains.ok, retains.reason, retains.positiveEvidence], [false, "retention-not-zero", true]);
  const safety = evaluate(documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ safetyRetention: true }))]));
  assert.deepEqual([safety.ok, safety.reason], [false, "retention-not-zero"]);
  const unstated = evaluate(documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ retainsPrompts: undefined }))]));
  assert.equal(unstated.reason, "retention-not-zero", "retention must be stated as false, not merely absent");
  const trains = evaluate(documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ training: true }))]));
  assert.equal(trains.reason, "training-not-false");
  // Quantization is pinned: a host serving another precision is not the configured host.
  const otherPrecision = evaluate(documents(PAID, [host("Crusoe", "crusoe/fp4", policy())]));
  assert.equal(otherPrecision.reason, "provider-not-serving");
  // One configured host failing does not matter while another passes; only passing hosts are reported as allowed.
  const mixed = evaluate(documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ retainsPrompts: true })), host("Parasail", "parasail/fp8", policy())]));
  assert.deepEqual([mixed.ok, mixed.allowedHosts], [true, ["Parasail"]]);
});

test("routing: paid-zdr is closed until verified, then pinned to the configured hosts, paid model, no fallbacks, no data_collection", async () => {
  paidZdr();
  const inventory = routeInventory().find((r) => r.route === "lumen");
  assert.deepEqual([inventory.model, inventory.mode, inventory.gate, inventory.hosts], [PAID, "pinned", "strict", HOSTS]);
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/generation")) return new Response("{}", { status: 404 });
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi." } }] })}\n\n`));
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`));
      c.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  // Unverified: strict gate, nothing is sent.
  await assert.rejects(callModelStreaming("lumen", [{ role: "user", content: "hello" }], undefined, { fetchImpl }), InferenceUnavailableError);
  assert.equal(sent.length, 0);
  // Verified: one request, to the router, pinned.
  assert.equal((await verify(compliant())).ok, true);
  const result = await callModelStreaming("lumen", [{ role: "user", content: "hello" }], undefined, { fetchImpl });
  assert.equal(result.data.choices[0].message.content, "Hi.");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${ROUTER}/chat/completions`);
  assert.equal(sent[0].body.model, PAID, "the same model without :free");
  assert.deepEqual(sent[0].body.provider, { order: HOSTS, only: HOSTS, allow_fallbacks: false });
  assert.equal("data_collection" in sent[0].body.provider, false);
  assert.equal(sent[0].body.user, undefined, "no per-user hash is sent to the paid hosts");
});

test("a paid-zdr host that starts retaining closes the route on the next check", async () => {
  paidZdr();
  assert.equal((await verify(compliant())).ok, true);
  const flipped = documents(PAID, [host("Crusoe", "crusoe/bf16", policy({ retainsPrompts: true })), host("Parasail", "parasail/fp8", policy({ retainsPrompts: true }))]);
  assert.equal((await verify(flipped)).ok, false);
  let calls = 0;
  await assert.rejects(callModelStreaming("lumen", [{ role: "user", content: "hello" }], undefined, { fetchImpl: async () => { calls += 1; return Response.json({}); } }), InferenceUnavailableError);
  assert.equal(calls, 0);
});

test("nothing else changes: the default stays the free gateway, and the other tiers' routes are identical in either mode", () => {
  const snapshot = () => Object.fromEntries(["nova", "nebula", "vesper", "study"].map((key) => [key, JSON.stringify(getModelConfig(key).chain.map((e) => ({ provider: e.provider, model: e.model, routing: e.providerRouting ?? null })))]));
  // Production default (no CHAT_LUMEN_ROUTE): the free gateway. (The shared test setup runs the staged chain, so set it here.)
  config.lumenChatRoute = lumenChatRouteFrom({});
  const gatewayMode = snapshot();
  assert.equal(getModelConfig("lumen").chain[0].provider, "gatewayFree");
  paidZdr();
  assert.deepEqual(snapshot(), gatewayMode);
  assert.equal(getModelConfig("lumen").chain.length, 1);
  config.lumenChatRoute = "staged";
  assert.equal(getModelConfig("lumen").chain.length, 4, "the staged rollback is intact");
});
