import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
config.databaseUrl ||= process.env.DATABASE_URL;
const { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, ImageModelError, availableImageModels, resolveImageModel, imageUserHash } = await import("../src/generation/image-models.js");
const { generateImage } = await import("../src/generation/service.js");
const { routeAllowed, guardedRoutes, AURA_IMAGE_ENGINE, AURA_MAX_RETENTION_DAYS } = await import("../src/chat/route-inventory.js");
const guard = await import("../src/chat/route-policy-guard.js");
const { inferenceUserHash } = await import("../src/chat/providers.js");

// The router's two public documents for Aura's engine, in the shape the guard reads (see test/route-policy.test.js).
const ROUTER = "https://openrouter.ai/api/v1";
const auraDocuments = (dataPolicy) => {
  const endpointsJson = { data: { id: AURA_IMAGE_ENGINE, architecture: { input_modalities: ["text", "image"] }, endpoints: [{ name: `xAI | ${AURA_IMAGE_ENGINE}`, model_id: AURA_IMAGE_ENGINE, provider_name: "xAI", tag: "xai", pricing: { image: "0.01" }, status: 0 }] } };
  const record = JSON.stringify({ model_variant_slug: AURA_IMAGE_ENGINE, provider_name: "xAI", provider_info: { name: "xAI", dataPolicy }, data_policy: dataPolicy }).replace(/"/g, "\\\"");
  return { endpointsJson, providersHtml: `<script>self.__next_f.push([1,"[${record}]"])</script>` };
};
const policy = (over = {}) => ({ training: false, trainingOpenRouter: false, retainsPrompts: true, retentionDays: 30, canPublish: false, safetyRetention: true, requiresUserIDs: true, ...over });
const fetchFor = (docs) => async (url) => (String(url).endsWith("/endpoints") ? Response.json(docs.endpointsJson) : String(url).endsWith("/providers") ? new Response(docs.providersHtml) : new Response("", { status: 404 }));
const auraRoute = () => guardedRoutes().find((route) => route.route === "image-aura");
// Puts Aura on the router (as in production) and records the guard's verdict for the given published policy.
async function verifyAura(t, dataPolicy) {
  const before = config.providerBaseUrls.paid;
  config.providerBaseUrls.paid = ROUTER;
  t.after(() => { config.providerBaseUrls.paid = before; guard.resetRoutePolicyStateForTests("image-aura"); });
  return guard.verifyRoutePolicy({ ...auraRoute(), fetchImpl: fetchFor(auraDocuments(dataPolicy)), log: { info() {}, warn() {} } });
}

const okFetch = (capture) => async (url, options) => {
  capture.url = url;
  capture.body = JSON.parse(options.body);
  return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }], usage: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const deps = (capture) => ({
  apiKey: "test-key",
  reserve: async () => ({ id: "usage-1", creditReservationId: "credit-1" }),
  finalize: async () => {},
  cancel: async () => {},
  fetchImpl: okFetch(capture),
});

test("Prism is the default and a request that names no model gets Prism", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "prism");
  for (const requested of [undefined, null, ""]) assert.equal(resolveImageModel(requested).id, "prism");
  assert.equal(resolveImageModel("PRISM").id, "prism");
});

test("An unknown image model is refused, never swapped for Prism", () => {
  assert.throws(() => resolveImageModel("dall-e"), (error) => error instanceof ImageModelError && error.status === 400 && error.code === "image_model_unknown");
  for (const key of ["__proto__", "constructor", "toString"]) assert.throws(() => resolveImageModel(key), (error) => error instanceof ImageModelError && error.code === "image_model_unknown");
});

test("Aura is approved and on by default (owner, 2026-11-15); IMAGE_AURA_ENABLED=false switches it off", (t) => {
  assert.equal(config.imageAuraEnabled, true, "with IMAGE_AURA_ENABLED unset, Aura's flag is on");
  t.after(() => { config.imageAuraEnabled = true; });
  config.imageAuraEnabled = false;
  assert.deepEqual(availableImageModels().map((model) => model.id), ["prism"]);
  assert.throws(() => resolveImageModel("aura"), (error) => error instanceof ImageModelError && error.status === 403 && error.code === "image_model_unavailable");
});

test("Aura opens only on a verified route: an unchecked or unverified route keeps it closed", (t) => {
  const before = config.providerBaseUrls.paid;
  t.after(() => { config.providerBaseUrls.paid = before; });
  // On a base URL the gate cannot check, Aura is closed (routeAllowed alone would wave an uncheckable route through).
  config.providerBaseUrls.paid = "https://images.example.test/v1";
  assert.equal(routeAllowed("image-aura"), true, "precondition: the general gate passes routes it cannot check");
  assert.throws(() => resolveImageModel("aura"), (error) => error.code === "image_model_unavailable");
  // On the router, the strict gate needs a recorded, verified policy; none has been recorded yet.
  config.providerBaseUrls.paid = ROUTER;
  assert.equal(routeAllowed("image-aura"), false);
  assert.ok(!availableImageModels().some((model) => model.id === "aura"));
});

test("with its host's published terms (no training, prompts kept up to 30 days), Aura is verified, listed and chosen", async (t) => {
  const result = await verifyAura(t, policy());
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(availableImageModels().map((model) => model.id), ["prism", "aura"]);
  assert.equal(availableImageModels().find((model) => model.default).id, "prism", "Prism stays the default");
  assert.equal(resolveImageModel("aura").id, "aura");
});

test("Aura closes if its host's terms get worse: longer or unstated retention, training, or publishing", async (t) => {
  for (const [over, reason] of [
    [{ retentionDays: AURA_MAX_RETENTION_DAYS + 1 }, "retention-over-limit"],
    [{ retentionDays: undefined }, "retention-over-limit"],
    [{ training: true }, "training-not-false"],
    [{ canPublish: true }, "publishes-prompts"],
  ]) {
    await t.test(reason + " " + JSON.stringify(over), async (tt) => {
      const result = await verifyAura(tt, policy(over));
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assert.throws(() => resolveImageModel("aura"), (error) => error.code === "image_model_unavailable");
    });
  }
});

test("Aura's route is strict, pinned to its one host, with a 30-day retention ceiling", (t) => {
  // Guarded routes are the ones on the router, as in production.
  const before = config.providerBaseUrls.paid;
  t.after(() => { config.providerBaseUrls.paid = before; });
  config.providerBaseUrls.paid = ROUTER;
  const route = auraRoute();
  assert.deepEqual({ mode: route.mode, hosts: route.hosts, maxRetentionDays: route.maxRetentionDays, requireZeroRetention: route.requireZeroRetention }, { mode: "pinned", hosts: ["xai"], maxRetentionDays: 30, requireZeroRetention: false });
  const inventory = readFileSync(new URL("../src/chat/route-inventory.js", import.meta.url), "utf8");
  assert.match(inventory, /\{ route: "image-aura",[^\n]*mode: "pinned"[^\n]*maxRetentionDays: AURA_MAX_RETENTION_DAYS, gate: "strict" \}/);
});

test("an Aura request is pinned, refuses data collection, and carries only a pseudonymous account id", async (t) => {
  await verifyAura(t, policy());
  const capture = {};
  await generateImage({ userId: "user-1", prompt: "A test", aspectRatio: "square", imageModel: IMAGE_MODELS.aura }, deps(capture));
  assert.equal(capture.body.model, AURA_IMAGE_ENGINE);
  assert.deepEqual(capture.body.provider, { allow_fallbacks: false, data_collection: "deny" });
  assert.match(capture.body.user, /^u_[0-9a-f]{32}$/);
  assert.equal(capture.body.user, imageUserHash("aura", "user-1"), "stable for the account");
  assert.notEqual(capture.body.user, imageUserHash("aura", "user-2"));
  assert.notEqual(capture.body.user, inferenceUserHash("user-1"), "not the id any other route sends");
  assert.doesNotMatch(JSON.stringify(capture.body), /user-1/, "the account id itself never leaves");
});

test("A Prism request is byte-for-byte the request it was before models could be chosen", async () => {
  const capture = {};
  await generateImage({ userId: "user-1", prompt: "A test", aspectRatio: "square", imageModel: IMAGE_MODELS.prism }, deps(capture));
  assert.equal(capture.url, `${config.providerBaseUrls.paid}/images`);
  assert.deepEqual(capture.body, { model: config.imageGenerationModel, prompt: "A test", n: 1, aspect_ratio: "1:1", output_format: "png" });
  assert.equal("provider" in capture.body, false);
  assert.equal("user" in capture.body, false, "Prism sends no user id");
});

test("A disabled model never reaches the provider or reserves credit", async (t) => {
  t.after(() => { config.imageAuraEnabled = true; });
  config.imageAuraEnabled = false;
  let reserved = false;
  let fetched = false;
  await assert.rejects(generateImage(
    { userId: "user-1", prompt: "A test", aspectRatio: "square", imageModel: IMAGE_MODELS.aura },
    { apiKey: "test-key", reserve: async () => { reserved = true; return {}; }, finalize: async () => {}, cancel: async () => {}, fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); } },
  ));
  assert.equal(reserved, false);
  assert.equal(fetched, false);
});

test("The router resolves the model before any work, records it on the image, and lists only available models", () => {
  const router = readFileSync(new URL("../src/generation/router.js", import.meta.url), "utf8");
  assert.match(router, /imageModel = resolveImageModel\(req\.body\?\.imageModel\)/);
  assert.match(router, /res\.status\(error\.status\)\.json\(\{ error: error\.message, code: error\.code \}\)/);
  assert.match(router, /generateImage\(\{ userId, prompt: finalPrompt, aspectRatio, size, referenceImage, imageModel \}\)/);
  assert.match(router, /imageModel: imageModel\.id \}/);
  assert.match(router, /"\/image-models"[\s\S]{0,200}availableImageModels\(\)/);
});

test("Image models are shown by their branded names only, never an engine or vendor", () => {
  for (const model of availableImageModels()) {
    assert.match(model.name, /^VibhavGPT (Prism|Aura)$/);
    assert.deepEqual(Object.keys(model).sort(), ["default", "id", "maxReferences", "name"]);
  }
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(workspace, /grok|x-ai|xai|muse-image|meta\//i);
});

test("The composer sends the model chosen at Generate, keeps a variation on its source's model, and labels the inspector", () => {
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  assert.match(workspace, /body: \{ prompt: text, aspectRatio: shape, style, imageModel,/);
  assert.match(workspace, /imageModel: image\.meta\?\.imageModel \?\? "prism"/);
  assert.match(workspace, /api\("\/api\/generation\/image-models"\)/);
  assert.match(workspace, /imageModels\.length > 1 &&/, "with only Prism available there is nothing to choose, so no dropdown");
  assert.match(workspace, /<dt>Model<\/dt><dd>\{IMAGE_MODEL_NAMES\[inspecting\.meta\?\.imageModel\] \?\? "VibhavGPT Prism"\}/);
});

test("the privacy policy states Aura's terms without naming its provider, and the composer has no inline Aura sentence", async () => {
  const { PRODUCT_KNOWLEDGE } = await import("../frontend/src/product-knowledge.js");
  const [, retention] = PRODUCT_KNOWLEDGE.privacy.find(([heading]) => heading === "Retention and deletion");
  assert.match(retention, /If you choose VibhavGPT Aura in Image mode \(VibhavGPT Prism is the default\), Aura's image provider may keep your prompt and any reference images for up to 30 days and receives a pseudonymous account identifier, never your name or email; it does not use them to train AI models\./);
  assert.equal(AURA_MAX_RETENTION_DAYS, 30, "the policy's 30 days is the route's ceiling");
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  // The owner removed the inline sentence under the composer (2026-11-15); the Privacy Policy keeps the terms.
  assert.doesNotMatch(workspace, /studio-model-note|Aura's image provider may keep/);
  assert.doesNotMatch(retention, /xAI|Grok|x-ai/i);
});
