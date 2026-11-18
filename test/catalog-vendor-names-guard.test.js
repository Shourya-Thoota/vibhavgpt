// The server side of the vendor-name guard (test/vendor-names-guard.test.js covers the frontend). No other AI company's brand or model
// name may appear in the model catalog's labels or in what the catalog API serves. The only exception is the routing keys of the seed
// (`id`, `routerModelId`): they name the upstream route and the existing model keys, are needed unchanged for routing and history,
// and are never served (the API serves VibhavGPT's own tiers only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const { SEED_MODEL_REFERENCE_MATRIX } = await import("../src/models/seed-catalog.js");
const { buildSeedRegistrySnapshot, formatGroupDisplayName, getCatalogForUser, serializeModelForCatalog } = await import("../src/models/catalog-service.js");

const VENDOR = /\b(openai|open ai|anthropic|claude|chatgpt|gpt-?[0-9o][\w.-]*|moonshot(?: ?ai)?|kimi|gemini|google|deepseek|qwen|alibaba|mistral|mixtral|llama|meta|xai|x-ai|grok|nvidia|nemotron|zhipu|z-ai|z\.ai|glm-?[0-9][\w.-]*|xiaomi|mimo|minimax|cohere|perplexity|openrouter|haiku|sonnet|opus)\b/i;
const ROUTING_KEYS = new Set(["id", "routerModelId"]);

function vendorStrings(value, path = "", skip = () => false) {
  if (typeof value === "string") return VENDOR.test(value) ? [`${path} = ${JSON.stringify(value)}`] : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => (skip(key, path) ? [] : vendorStrings(child, path ? `${path}.${key}` : key, skip)));
}

test("every seed catalog label is neutral: brand, developer, familyGroup, modelName, notes and every other non-routing field", () => {
  const found = SEED_MODEL_REFERENCE_MATRIX.flatMap((entry, i) => vendorStrings(entry, `[${i}:${entry.id}]`, (key, path) => ROUTING_KEYS.has(key) && !path.includes(".")));
  assert.deepEqual(found, []);
});

test("the seed file's comments and code name no other company outside the routing keys", () => {
  const lines = fs.readFileSync("src/models/seed-catalog.js", "utf8").split(/\r?\n/);
  const found = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(id|routerModelId):\s*"[^"]*",?\s*$/.test(line))
    // Code that refers to a seed entry by its routing key (for example a replacement map) is routing data, not a label.
    .filter(({ line }) => !/^\s*"[^"]+":\s*"[^"]+",?\s*$/.test(line))
    .filter(({ line }) => VENDOR.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
  assert.deepEqual(found, []);
});

test("the catalog API JSON names no other company, for every plan, from either seed snapshot", async () => {
  for (const plan of ["free", "plus", "pro", "max"]) {
    for (const customerFacingOnly of [true, false]) {
      const out = await getCatalogForUser({ userPlan: plan, snapshot: buildSeedRegistrySnapshot({ customerFacingOnly }) });
      assert.ok(out.models.length > 0);
      assert.deepEqual(out.models.map((m) => m.id).sort(), ["lumen", "vesper"], "only VibhavGPT's own current tiers are served (Nova and Nebula are retired)");
      assert.deepEqual(vendorStrings(out), [], `plan ${plan}, customerFacingOnly ${customerFacingOnly}`);
    }
  }
});

test("even an unfiltered third-party entry serializes with neutral labels (only its routing id differs)", () => {
  const found = buildSeedRegistrySnapshot({ customerFacingOnly: false })
    .map((item) => serializeModelForCatalog(item, "max"))
    .filter(Boolean)
    .flatMap((dto) => vendorStrings(dto, dto.id, (key, path) => key === "id" && path === dto.id));
  assert.deepEqual(found, []);
});

test("group names never echo a provider id", () => {
  for (const id of ["anthropic", "openai", "google", "xai", "alibaba", "moonshot", "nvidia", "zhipu", "xiaomi", "deepseek", "provider-a"]) {
    assert.equal(formatGroupDisplayName(id), "More models", id);
  }
  assert.equal(formatGroupDisplayName("vibhavgpt"), "VibhavGPT");
  assert.match("Claude 3.5 Haiku", VENDOR, "the guard is not vacuous");
});
