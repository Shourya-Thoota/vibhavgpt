// PR 3: the shared route-policy guard for every model route on the router. Fixtures are built in the shape of the router's real
// documents (the Endpoints API JSON, and the escaped endpoint records embedded in a model's public providers page; see the Lumen golden
// fixture in test/fixtures/lumen-gateway). Nothing here reaches the network.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { config } = await import("../src/config.js");
const guard = await import("../src/chat/route-policy-guard.js");
const inventory = await import("../src/chat/route-inventory.js");
const { callModelWithFallback, InferenceUnavailableError } = await import("../src/chat/providers.js");

const ROUTER = "https://openrouter.ai/api/v1";
const policy = (over = {}) => ({ training: false, trainingOpenRouter: false, retainsPrompts: false, canPublish: false, safetyRetention: false, requiresUserIDs: false, ...over });
const host = (name, tag, dataPolicy, pricing = { prompt: "0.000001", completion: "0.000002" }) => ({ name, tag, dataPolicy, pricing });

function documents(model, hosts) {
  const endpointsJson = { data: { id: model, endpoints: hosts.map((h) => ({ name: `${h.name} | ${model}`, model_id: model, provider_name: h.name, tag: h.tag, pricing: h.pricing, context_length: 131072, max_completion_tokens: 8192, status: 0 })) } };
  // Escaped as the page serves it: one record per host, starting at its model_variant_slug.
  const records = hosts.map((h) => JSON.stringify({ model_variant_slug: model, provider_name: h.name, provider_info: { name: h.name, dataPolicy: h.dataPolicy }, data_policy: h.dataPolicy }).replace(/"/g, "\\\"")).join(",");
  return { endpointsJson, providersHtml: `<script>self.__next_f.push([1,"[${records}]"])</script>` };
}
const fetchFor = (docs) => async (url) => {
  if (String(url).endsWith("/endpoints")) return Response.json(docs.endpointsJson);
  if (String(url).endsWith("/providers")) return new Response(docs.providersHtml);
  return new Response("not found", { status: 404 });
};
const quiet = { info() {}, warn() {} };

const saved = {
  base: config.providerBaseUrls.paid, key: config.providerKeys.paid, nova: config.chatModels.nova, novaHosts: config.routeProviders.nova,
  image: config.imageGenerationModel, vesper: config.chatModels.vesper, transport: config.vesperTransport,
};
afterEach(() => {
  Object.assign(config.providerBaseUrls, { paid: saved.base });
  Object.assign(config.providerKeys, { paid: saved.key });
  Object.assign(config.chatModels, { nova: saved.nova, vesper: saved.vesper });
  config.routeProviders.nova = saved.novaHosts;
  config.imageGenerationModel = saved.image;
  config.vesperTransport = saved.transport;
  guard.resetRoutePolicyStateForTests();
});
function onRouter() {
  config.providerBaseUrls.paid = ROUTER;
  config.providerKeys.paid = "fixture-key";
}

test("pinned (Nova, Nebula): safe while one named host passes; the flagged host is reported, not used as the evidence", () => {
  const model = "fixture/nova-model";
  const docs = documents(model, [host("Host A", "host-a/fp8", policy()), host("Host B", "host-b", policy({ training: true })), host("Host C", "host-c", policy())]);
  const result = guard.evaluateRoutePolicy({ ...docs, model, mode: "pinned", hosts: ["host-a/fp8", "host-b"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.allowedHosts, ["Host A"], "Host C is not on the route's list");
  assert.deepEqual(result.hosts.map((h) => [h.host, h.reason]), [["Host A", "verified"], ["Host B", "training-not-false"]]);
  const none = guard.evaluateRoutePolicy({ ...documents(model, [host("Host A", "host-a/fp8", policy({ training: true })), host("Host B", "host-b", policy({ canPublish: true }))]), model, mode: "pinned", hosts: ["host-a", "Host B"] });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "no-compliant-host");
  assert.equal(none.positiveEvidence, true, "every named host was ruled out by its own policy");
});

test("a host-name mismatch or an unreadable page is 'could not tell', never evidence", () => {
  const model = "fixture/nova-model";
  const mismatch = guard.evaluateRoutePolicy({ ...documents(model, [host("Host A", "host-a", policy())]), model, mode: "pinned", hosts: ["someone-else"] });
  assert.equal(mismatch.reason, "provider-not-serving");
  assert.equal(Boolean(mismatch.positiveEvidence), false);
  const unreadable = guard.evaluateRoutePolicy({ endpointsJson: documents(model, [host("Host A", "host-a", policy())]).endpointsJson, providersHtml: "<html>changed</html>", model, mode: "pinned", hosts: ["host-a"] });
  assert.equal(unreadable.reason, "policy-not-found");
  assert.equal(Boolean(unreadable.positiveEvidence), false);
});

test("deny (Vulcan): a host that retains prompts does not count, matching what deny allows; one non-retaining, non-training host passes", () => {
  const model = "fixture/vesper-model";
  const retaining = guard.evaluateRoutePolicy({ ...documents(model, [host("Host R", "host-r", policy({ retainsPrompts: true, retentionDays: 30 }))]), model, mode: "deny" });
  assert.equal(retaining.ok, false);
  assert.equal(retaining.reason, "retains-prompts");
  assert.equal(retaining.positiveEvidence, true);
  const mixed = guard.evaluateRoutePolicy({ ...documents(model, [host("Host R", "host-r", policy({ retainsPrompts: true })), host("Host Z", "host-z", policy())]), model, mode: "deny" });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.allowedHosts, ["Host Z"]);
});

test("unpinned: a paid model needs one non-training host (the account excludes paid hosts that train); a free model needs every host", () => {
  const paid = "fixture/image-model";
  const docs = documents(paid, [host("Host T", "host-t", policy({ training: true })), host("Host S", "host-s", policy())]);
  assert.equal(guard.evaluateRoutePolicy({ ...docs, model: paid, mode: "unpinned", accountExcludesTraining: true }).ok, true);
  const free = "fixture/classifier:free";
  const freeDocs = documents(free, [host("Host T", "host-t", policy({ training: true }), { prompt: "0", completion: "0" }), host("Host S", "host-s", policy(), { prompt: "0", completion: "0" })]);
  const result = guard.evaluateRoutePolicy({ ...freeDocs, model: free, mode: "unpinned", accountExcludesTraining: false });
  assert.equal(result.ok, false, "one training host is enough to rule a free unpinned model out");
  assert.equal(result.reason, "training-not-false");
  assert.equal(result.positiveEvidence, true);
  const gone = guard.evaluateRoutePolicy({ endpointsJson: { data: { endpoints: [] } }, providersHtml: "", model: free, mode: "unpinned" });
  assert.equal(gone.reason, "no-endpoints");
});

test("gates: an 'evidence' route closes only on policy evidence; a 'strict' route stays closed until verified", async () => {
  onRouter();
  config.chatModels.nova = "fixture/nova-model";
  config.routeProviders.nova = ["host-a", "host-b"];
  // Unverified (never checked, or the page could not be read): Nova keeps running, protected per request by data_collection: deny.
  assert.equal(inventory.routeAllowed("nova"), true);
  await guard.verifyRoutePolicy({ route: "nova", model: "fixture/nova-model", mode: "pinned", hosts: ["host-a", "host-b"], fetchImpl: async () => new Response("down", { status: 503 }), log: quiet });
  assert.equal(inventory.routeAllowed("nova"), true, "a failed fetch is not evidence");
  // Both hosts flip to training: the route has nowhere safe to go and closes.
  const flipped = documents("fixture/nova-model", [host("Host A", "host-a", policy({ training: true })), host("Host B", "host-b", policy({ training: true }))]);
  await guard.verifyRoutePolicy({ route: "nova", model: "fixture/nova-model", mode: "pinned", hosts: ["host-a", "host-b"], fetchImpl: fetchFor(flipped), log: quiet });
  assert.equal(inventory.routeAllowed("nova"), false);
  // The auto classifier (a free model, unpinned) is strict: closed until verified, and its current model has no endpoints at all.
  assert.equal(inventory.routeAllowed("auto-classifier"), false);
  await guard.verifyRoutePolicy({ route: "auto-classifier", model: inventory.AUTO_CLASSIFIER_MODEL, mode: "unpinned", fetchImpl: fetchFor({ endpointsJson: { data: { endpoints: [] } }, providersHtml: "" }), log: quiet });
  assert.equal(inventory.routeAllowed("auto-classifier"), false);
});

test("a route whose host flips to training fails closed: Nova sends nothing and answers with the unavailable state", async () => {
  onRouter();
  config.chatModels.nova = "fixture/nova-model";
  config.routeProviders.nova = ["host-a"];
  const flipped = documents("fixture/nova-model", [host("Host A", "host-a", policy({ training: true }))]);
  const logs = [];
  await guard.verifyRoutePolicy({ route: "nova", model: "fixture/nova-model", mode: "pinned", hosts: ["host-a"], fetchImpl: fetchFor(flipped), log: { info: (l) => logs.push(l), warn: (l) => logs.push(l) } });
  const line = JSON.parse(logs.at(-1));
  assert.deepEqual([line.event, line.route, line.approved, line.reason, line.positiveEvidence], ["route_policy", "nova", false, "training-not-false", true], "the log names the route and the reason");
  let calls = 0;
  await assert.rejects(callModelWithFallback("nova", [{ role: "user", content: "hello" }], undefined, { fetchImpl: async () => { calls += 1; return Response.json({}); } }), InferenceUnavailableError);
  assert.equal(calls, 0, "no request was sent");
});

test("the boot inventory names every configured route, its model and host name only, and what was decided; no keys or URL paths", () => {
  onRouter();
  config.chatModels.nova = "fixture/nova-model";
  config.routeProviders.nova = ["host-a"];
  config.imageGenerationModel = "fixture/image-model";
  const lumenBefore = config.chatModels.lumenFallback1;
  config.chatModels.lumenFallback1 = "fixture/lumen-model:free";
  config.chatModels.vesper = "fixture/vesper-model";
  config.vesperTransport = "router";
  const report = inventory.routeInventoryReport();
  config.chatModels.lumenFallback1 = lumenBefore;
  assert.equal(report.event, "route_inventory");
  const byRoute = Object.fromEntries(report.routes.map((r) => [r.route, r]));
  for (const name of ["lumen", "nova", "vesper", "image-generation", "auto-classifier"]) assert.ok(byRoute[name], `${name} is listed`);
  assert.equal(byRoute.nova.host, "openrouter.ai");
  assert.equal(byRoute.nova.model, "fixture/nova-model");
  assert.equal(byRoute["auto-classifier"].gate, "strict");
  assert.equal(byRoute.nova.gate, "evidence");
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /fixture-key|\/api\/v1|https?:\/\//, "no keys, no URLs");
  // A route whose host is not the router cannot be checked: it is listed as such, and left running.
  const study = report.routes.find((r) => r.route === "study");
  if (study) assert.equal(study.verification, "not-machine-verifiable");
});
