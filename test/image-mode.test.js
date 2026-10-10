import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { productModeFromPath, productPath } from "../frontend/src/product-modes.js";

async function generationService() {
  process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
  const { config } = await import("../src/config.js");
  config.databaseUrl ||= process.env.DATABASE_URL;
  return import("../src/generation/service.js");
}
const { IMAGE_ASPECT_RATIOS, generateImage } = await generationService();

test("Image routes round-trip without changing conversation identity", () => {
  assert.equal(productModeFromPath("/app/image"), "image");
  assert.equal(productModeFromPath("/app/image/"), "image");
  assert.equal(productModeFromPath("/app/study"), "study");
  assert.equal(productModeFromPath("/app"), "chat");
  assert.equal(productPath("image", "abc"), "/app/image?conversation=abc");
  assert.equal(productPath("image"), "/app/image");
});

test("Image mode is an accepted workspace on the server", () => {
  const router = readFileSync(new URL("../src/profile/router.js", import.meta.url), "utf8");
  assert.match(router, /\["chat", "study", "image"\]\.includes\(productMode\)/);
});

test("Every aspect ratio choice maps to a supported generation size", () => {
  assert.deepEqual(Object.keys(IMAGE_ASPECT_RATIOS).sort(), ["landscape", "portrait", "square"]);
});

test("Image generation loops per variation and enforces the per-tier quota on each call", () => {
  const router = readFileSync(new URL("../src/generation/router.js", import.meta.url), "utf8");
  assert.match(router, /Math\.min\(MAX_VARIATIONS, Math\.max\(1, Number\.parseInt\(req\.body\?\.variations, 10\) \|\| 1\)\)/);
  assert.match(router, /const size = typeof req\.body\?\.size === "string"/);
  assert.match(router, /await generateImage\(\{ userId, prompt: finalPrompt, aspectRatio, size, referenceImage \}\)/);
  assert.match(router, /if \(images\.length\) break;/, "a later variation failing (e.g. quota exhausted) must keep the earlier successful ones instead of discarding them");
});

test("A reference image may come from an upload or an earlier generation, never another account's file", () => {
  const router = readFileSync(new URL("../src/generation/router.js", import.meta.url), "utf8");
  assert.match(router, /getOwnedAttachment\(userId, referenceAttachmentId\)/);
  assert.match(router, /\["image", "generated-image"\]\.includes\(referenceRecord\.kind\)/);
});

test("Image generation uses the dedicated image endpoint without a model fallback", () => {
  const service = readFileSync(new URL("../src/generation/service.js", import.meta.url), "utf8");
  assert.match(service, /`\$\{baseUrl\}\/images`/);
  assert.match(service, /model: config\.imageGenerationModel/);
  assert.doesNotMatch(service, /\bquality\b/);
  assert.doesNotMatch(service, /images\/generations|requestedModel|gpt-image/);
});

// Shape and style came back in the October 2026 studio redesign as compact
// controls the endpoint honours (see the contract test below); an unsupported
// quality setting and an expanded options panel stay out.
test("Image composer keeps provider-unsupported controls out of the UI", () => {
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  assert.match(workspace, /IMAGE_IDEAS/);
  assert.doesNotMatch(workspace, /image-composer__options|Customize/);
  assert.doesNotMatch(workspace, /Image quality|composer\.quality/);
  assert.doesNotMatch(workspace, /ImageVoiceInput/);
});

test("Image routing sends the documented dedicated-API request shape and defaults unsupported ratios to square", async () => {
  let request;
  let finalized = false;
  const result = await generateImage(
    { userId: "user-1", prompt: "A bright test image", aspectRatio: "unsupported", size: "1024x1024" },
    {
      apiKey: "test-key",
      reserve: async () => ({ id: "usage-1", creditReservationId: "credit-1" }),
      finalize: async () => { finalized = true; },
      cancel: async () => assert.fail("successful generation must not refund its reservation"),
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }], usage: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  );
  assert.equal(request.url, `${config.providerBaseUrls.paid}/images`);
  assert.deepEqual(request.body, { model: config.imageGenerationModel, prompt: "A bright test image", n: 1, aspect_ratio: "1:1", output_format: "png", size: "1024x1024" });
  assert.equal(result.buffer.toString(), "png");
  assert.equal(finalized, true);
});

test("Reference image requests preserve uploaded bytes in typed image references and settle actual usage", async (t) => {
  for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
    await t.test(mimeType, async () => {
      const reference = Buffer.from([0, 1, 2, 253, 254, 255]);
      let finalized;
      const result = await generateImage({
        userId: "user-1", prompt: "Paint this scene in watercolor", aspectRatio: "portrait",
        referenceImage: { mimeType, buffer: reference },
      }, {
        apiKey: "test-key",
        reserve: async () => ({ id: "usage-ref", creditReservationId: "credit-ref" }),
        cancel: async () => assert.fail("successful reference generation must keep its reservation"),
        finalize: async (...args) => { finalized = args; },
        fetchImpl: async (url, options) => {
          assert.equal(url, `${config.providerBaseUrls.paid}/images`);
          const body = JSON.parse(options.body);
          assert.deepEqual(body.input_references, [{
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${reference.toString("base64")}` },
          }]);
          assert.equal(body.model, config.imageGenerationModel);
          assert.equal(body.aspect_ratio, "9:16");
          return Response.json({ data: [{ b64_json: Buffer.from("generated").toString("base64") }],
            usage: { prompt_tokens: 23, completion_tokens: 100, cost: 0.04 } });
        },
      });
      assert.equal(result.referenceApplied, true);
      assert.equal(result.buffer.toString(), "generated");
      assert.equal(finalized[0], "usage-ref");
      assert.equal(finalized[1].prompt_tokens, 23);
      assert.equal(finalized[1].completion_tokens, 100);
    });
  }
});

test("Rejected reference generations refund their reservation and redact upstream errors", async () => {
  let cancelled;
  await assert.rejects(generateImage({ userId: "user-1", prompt: "Use this reference",
    referenceImage: { mimeType: "image/png", buffer: Buffer.from("reference") },
  }, {
    apiKey: "test-key",
    reserve: async () => ({ id: "usage-ref", creditReservationId: "credit-ref" }),
    cancel: async (...args) => { cancelled = args; },
    finalize: async () => assert.fail("rejected generation must not settle usage"),
    fetchImpl: async () => Response.json({ error: { message: "Private upstream reference error" } }, { status: 400 }),
  }), (error) => error.message === "Image generation is temporarily unavailable. Please try again shortly.");
  assert.deepEqual(cancelled, ["usage-ref", "credit-ref"]);
});

test("Image quota errors stop before any provider request", async () => {
  let requested = false;
  const quotaError = Object.assign(new Error("Image quota reached."), { code: "usage-limit", status: 429 });
  await assert.rejects(
    generateImage({ userId: "user-1", prompt: "A test image" }, {
      apiKey: "test-key",
      reserve: async () => { throw quotaError; },
      fetchImpl: async () => { requested = true; },
    }),
    (error) => error === quotaError,
  );
  assert.equal(requested, false);
});

test("Image provider failures use a generic message and refund the existing credit reservation", async () => {
  let cancelled;
  await assert.rejects(
    generateImage({ userId: "user-1", prompt: "A test image" }, {
      apiKey: "test-key",
      reserve: async () => ({ id: "usage-1", creditReservationId: "credit-1" }),
      cancel: async (...args) => { cancelled = args; },
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "upstream-specific failure" } }), { status: 503, headers: { "Content-Type": "application/json" } }),
    }),
    /Image generation is temporarily unavailable\. Please try again shortly\./,
  );
  assert.deepEqual(cancelled, ["usage-1", "credit-1"]);
});

// Gallery ownership and pagination are exercised against Postgres in
// image-library.test.js, including equal timestamps and foreign cursors.

test("Image prompts carry style direction and a quality brief while keeping the subject first", async () => {
  const { composeImagePrompt, IMAGE_STYLES } = await generationService();
  const watercolor = composeImagePrompt("A lighthouse at dusk.  ", "watercolor");
  assert.ok(watercolor.startsWith("A lighthouse at dusk. Style: "));
  assert.ok(watercolor.includes(IMAGE_STYLES.watercolor));
  assert.match(watercolor, /coherent anatomy, hands and perspective/);
  assert.match(watercolor, /Do not add any text/);
  // Text is only suppressed when the request does not ask for any.
  assert.doesNotMatch(composeImagePrompt("A poster titled Night Swim"), /Do not add any text/);
  // A style outside the presets is passed through as written.
  assert.match(composeImagePrompt("A cat", "Vaporwave"), /Style: Vaporwave style\./);
  assert.doesNotMatch(composeImagePrompt("A cat"), /Style:/);
});

test("Image studio offers only shapes and styles the server understands", async () => {
  const { IMAGE_STYLES } = await generationService();
  const workspace = readFileSync(new URL("../frontend/src/components/ImageWorkspace.jsx", import.meta.url), "utf8");
  const values = (name) => [...workspace.slice(workspace.indexOf(`const ${name} = [`), workspace.indexOf("];", workspace.indexOf(`const ${name} = [`))).matchAll(/value: "([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(values("SHAPES").sort(), Object.keys(IMAGE_ASPECT_RATIOS).sort());
  for (const style of values("STYLE_PRESETS").filter(Boolean)) assert.ok(Object.hasOwn(IMAGE_STYLES, style), `${style} must be a server style preset`);
  assert.ok(workspace.includes("aspectRatio: shape, style, ...(reference?.id ? { referenceAttachmentId: reference.id } : {})"), "a chosen reference image is sent with the request");
  // One image per request: the count selector was removed.
  assert.doesNotMatch(workspace, /COUNTS|variations: count/);
});
