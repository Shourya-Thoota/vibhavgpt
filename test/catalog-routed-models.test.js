import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { SEED_MODEL_REFERENCE_MATRIX } from "../src/models/seed-catalog.js";
import { callModelWithFallback, callModelStreaming } from "../src/chat/providers.js";

const routedModels = SEED_MODEL_REFERENCE_MATRIX.filter(
  (m) => !["auto", "free", "lumen", "nova", "nebula", "vesper"].includes(m.id)
);

test("Catalog Routed Models: Exactly 27 models across 9 families", () => {
  assert.equal(routedModels.length, 27);
  const families = new Set(routedModels.map((m) => m.familyGroup));
  assert.equal(families.size, 9);
});

for (const seedModel of routedModels) {
  test(`Catalog Routing [${seedModel.id}]: routes to ${seedModel.routerModelId} with ZDR and no silent substitution`, async () => {
    let capturedBody, capturedUrl, capturedHeaders;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return Response.json({
        choices: [{ message: { content: "catalog-model-success" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      });
    };

    const res = await callModelWithFallback(seedModel.id, [{ role: "user", content: "Hello" }], undefined, {
      fetchImpl,
      reasoning: seedModel.capabilities.reasoning ? "high" : null,
    });

    assert.equal(res.data.choices[0].message.content, "catalog-model-success");
    // Verify no silent substitution
    assert.equal(capturedBody.model, seedModel.routerModelId);
    assert.equal(capturedUrl, `${config.providerBaseUrls.paid}/chat/completions`);
    // Verify privacy settings on router
    assert.deepEqual(capturedBody.provider, { allow_fallbacks: false, data_collection: "deny" });
    // Verify reasoning parameter behavior
    if (seedModel.capabilities.reasoning) {
      assert.ok(capturedBody.reasoning, `${seedModel.id} should include reasoning parameter`);
    } else {
      assert.ok(!capturedBody.reasoning || capturedBody.reasoning.effort === "none", `${seedModel.id} non-reasoning`);
    }
  });

  test(`Catalog Streaming [${seedModel.id}]: streams output without substitution`, async () => {
    let capturedBody;
    const fetchImpl = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "streamed-ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    };

    const res = await callModelStreaming(seedModel.id, [{ role: "user", content: "Hello" }], undefined, {
      fetchImpl,
      onDelta: () => true,
    });

    assert.equal(res.data.choices[0].message.content, "streamed-ok");
    assert.equal(capturedBody.model, seedModel.routerModelId);
    assert.deepEqual(capturedBody.provider, { allow_fallbacks: false, data_collection: "deny" });
  });
}
