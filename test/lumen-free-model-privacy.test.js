import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);

after(async () => {
  await client.close?.();
});

mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => {
      req.authSession = { user: { id: "lumen-privacy-user" } };
      next();
    },
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
const {
  callModelWithFallback,
  callModelStreaming,
  callSearchIntentModel,
  InferenceUnavailableError,
  lumenStageApproval,
  MODEL_CONFIGS,
} = await import("../src/chat/providers.js");
const { buildIdentitySystemPrompt } = await import("../src/chat/prompts.js");

function snapshotConfig() {
  return {
    providerKeys: { ...config.providerKeys },
    providerBaseUrls: { ...config.providerBaseUrls },
    chatModels: { ...config.chatModels },
    lumenPrimaryApproved: config.lumenPrimaryApproved,
    lumenApprovals: {
      primaryModel: config.lumenApprovals.primaryModel,
      gateway: { ...config.lumenApprovals.gateway },
      secondary: { ...config.lumenApprovals.secondary },
      reserve: { ...config.lumenApprovals.reserve },
    },
    routeProviders: {
      nova: config.routeProviders.nova ? [...config.routeProviders.nova] : undefined,
      nebula: config.routeProviders.nebula ? [...config.routeProviders.nebula] : undefined,
    },
  };
}

function restoreConfig(snap) {
  config.providerKeys = { ...snap.providerKeys };
  config.providerBaseUrls = { ...snap.providerBaseUrls };
  config.chatModels = { ...snap.chatModels };
  config.lumenPrimaryApproved = snap.lumenPrimaryApproved;
  config.lumenApprovals = {
    primaryModel: snap.lumenApprovals.primaryModel,
    gateway: { ...snap.lumenApprovals.gateway },
    secondary: { ...snap.lumenApprovals.secondary },
    reserve: { ...snap.lumenApprovals.reserve },
  };
  config.routeProviders = {
    nova: snap.routeProviders.nova ? [...snap.routeProviders.nova] : [],
    nebula: snap.routeProviders.nebula ? [...snap.routeProviders.nebula] : [],
  };
}

const answer = (content = "Hello from Lumen") =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 15, completion_tokens: 5 },
  });

const streamChunk = (content = "Hello from Lumen stream") =>
  new Response(
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 5 },
    })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );

test("1. Endpoint restrictions and independent transport: Lumen sends primary to its independent host and key, without provider routing", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.primaryFree = "https://bytez.test/v1";
  config.providerKeys.primaryFree = "bytez-primary-key-xyz";
  config.chatModels.lumen = "bytez/model-a";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "bytez/model-a";

  let capturedBody;
  let capturedUrl;
  let capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return answer();
  };

  const messages = [{ role: "user", content: "Summarize today's headlines." }];
  const result = await callModelWithFallback("lumen", messages, undefined, {
    fetchImpl,
    maxRetries: 0,
  });

  assert.equal(capturedUrl, "https://bytez.test/v1/chat/completions");
  assert.equal(capturedHeaders.Authorization, "Bearer bytez-primary-key-xyz");
  assert.equal(capturedBody.model, "bytez/model-a");
  assert.equal(capturedBody.provider, undefined, "body.provider must not be set on independent Lumen transport");
  assert.equal(result.internalStage, "primaryFree");
});

test("2. Endpoint restrictions: provider-selected openrouter/free (and auto:free) cannot be approved", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  for (const model of ["openrouter/free", "openrouter/free:latest", "auto", "auto:free"]) {
    config.chatModels.lumen = model;
    config.lumenPrimaryApproved = true;
    config.lumenApprovals.primaryModel = model;
    assert.deepEqual(
      lumenStageApproval("primaryFree"),
      { approved: false, reason: "provider-selected-model" },
      `Model ${model} must be rejected as provider-selected`
    );

    config.chatModels.lumenFallback1 = model;
    config.lumenApprovals.gateway = { approved: true, model };
    assert.deepEqual(
      lumenStageApproval("gatewayFree"),
      { approved: false, reason: "provider-selected-model" },
      `Model ${model} must be rejected as provider-selected on gateway`
    );
  }
});

test("3. Independent fallback chain: primary failure falls back to gateway (BazaarLink), never direct Study/Vulcan or router key", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.primaryFree = "https://primary.bytez.test/v1";
  config.providerKeys.primaryFree = "bytez-primary-key-111";
  config.chatModels.lumen = "candidate-primary";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "candidate-primary";

  config.providerBaseUrls.gatewayFree = "https://gateway.bazaarlink.test/v1";
  config.providerKeys.gatewayFree = "bazaarlink-gateway-key-222";
  config.chatModels.lumenFallback1 = "candidate-gateway";
  config.lumenApprovals.gateway = { approved: true, model: "candidate-gateway" };

  config.providerBaseUrls.paid = "https://router.openrouter.test/api/v1";
  config.providerKeys.paid = "openrouter-paid-secret-never-use";
  config.providerBaseUrls.direct = "https://api.openai.com/v1";
  config.providerKeys.direct = "direct-project-key-never-use";
  config.providerKeys.study = "direct-project-key-never-use";

  const requestedUrls = [];
  const requestedAuthHeaders = [];
  const requestedHeaders = [];
  const requestedModels = [];

  const fetchImpl = async (url, init) => {
    requestedUrls.push(url);
    requestedAuthHeaders.push(init.headers?.Authorization);
    requestedHeaders.push(init.headers);
    const body = JSON.parse(init.body);
    requestedModels.push(body.model);
    assert.equal(body.provider, undefined, "body.provider must not be present on any Lumen request");

    if (body.model === "candidate-primary") {
      return new Response(JSON.stringify({ error: { message: "Primary quota exceeded" } }), { status: 429 });
    }
    if (body.model === "candidate-gateway") {
      return answer("Gateway free served reply");
    }
    throw new Error(`Unexpected model contacted: ${body.model}`);
  };

  const messages = [{ role: "user", content: "What is the speed of light?" }];
  const served = await callModelWithFallback("lumen", messages, undefined, {
    fetchImpl,
    maxRetries: 0,
  });

  assert.equal(served.internalStage, "gatewayFree");
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0], "https://primary.bytez.test/v1/chat/completions");
  assert.equal(requestedUrls[1], "https://gateway.bazaarlink.test/v1/chat/completions");
  assert.equal(requestedAuthHeaders[0], "Bearer bytez-primary-key-111");
  assert.equal(requestedAuthHeaders[1], "Bearer bazaarlink-gateway-key-222");
  assert.equal(requestedHeaders[1]["X-Free-Fallback"], "false", "Gateway stage must send X-Free-Fallback: false");
  assert.deepEqual(requestedModels, ["candidate-primary", "candidate-gateway"]);

  assert.ok(!requestedUrls.some((u) => u.includes("openai.com") || u.includes("openrouter.test")), "Direct or router URLs must never be contacted for Lumen");
  for (const h of requestedAuthHeaders) {
    assert.ok(!h.includes("direct-project-key-never-use"), "Direct key must never be used in Lumen requests");
    assert.ok(!h.includes("openrouter-paid-secret-never-use"), "Router key must never be used in Lumen requests");
  }
});

test("4. Exhaustion: when all free stages fail or quota is exceeded, Lumen returns safe branded 503 unavailability", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.primaryFree = "https://primary.bytez.test/v1";
  config.providerKeys.primaryFree = "key-primary-1";
  config.chatModels.lumen = "candidate-primary";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "candidate-primary";

  config.providerBaseUrls.gatewayFree = "https://gateway.bazaarlink.test/v1";
  config.providerKeys.gatewayFree = "key-gateway-2";
  config.chatModels.lumenFallback1 = "candidate-gateway";
  config.lumenApprovals.gateway = { approved: true, model: "candidate-gateway" };

  config.providerBaseUrls.secondaryFree = "https://secondary.test/v1";
  config.providerKeys.secondaryFree = "key-secondary-3";
  config.chatModels.lumenFallback2 = "candidate-secondary";
  config.lumenApprovals.secondary = { approved: true, model: "candidate-secondary" };

  config.providerBaseUrls.reserveFree = "https://reserve.aistudio.test/v1";
  config.providerKeys.reserveFree = "key-reserve-4";
  config.chatModels.lumenFallback3 = "candidate-reserve";
  config.lumenApprovals.reserve = { approved: true, model: "candidate-reserve" };

  config.providerBaseUrls.paid = "https://router.openrouter.test/api/v1";
  config.providerKeys.paid = "router-paid-key";
  config.providerBaseUrls.direct = "https://api.openai.com/v1";
  config.providerKeys.direct = "direct-project-key";

  const contacted = [];
  const failingFetch = async (url, init) => {
    contacted.push({ url, model: JSON.parse(init.body).model });
    return new Response(JSON.stringify({ error: { message: "Temporarily overloaded" } }), { status: 503 });
  };

  const messages = [{ role: "user", content: "Need a quick summary." }];
  await assert.rejects(
    callModelWithFallback("lumen", messages, undefined, {
      fetchImpl: failingFetch,
      maxRetries: 0,
    }),
    (err) => {
      assert.ok(err instanceof InferenceUnavailableError);
      assert.equal(err.status, 503);
      assert.equal(err.code, "inference-unavailable");
      assert.equal(err.message, "VibhavGPT is temporarily unavailable. Please try again shortly.");
      return true;
    }
  );

  assert.equal(contacted.length, 4);
  assert.deepEqual(contacted.map((c) => c.model), [
    "candidate-primary",
    "candidate-gateway",
    "candidate-secondary",
    "candidate-reserve",
  ]);
  assert.deepEqual(contacted.map((c) => c.url), [
    "https://primary.bytez.test/v1/chat/completions",
    "https://gateway.bazaarlink.test/v1/chat/completions",
    "https://secondary.test/v1/chat/completions",
    "https://reserve.aistudio.test/v1/chat/completions",
  ]);
});

test("5. Credential isolation across stages: each independent stage receives only its own credential, never cross-stage, router, or direct keys", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  const PRIMARY_KEY = "bytez-primary-secret-key-111";
  const GATEWAY_KEY = "bazaarlink-gateway-secret-key-222";
  const SECONDARY_KEY = "secondary-secret-key-333";
  const RESERVE_KEY = "aistudio-reserve-secret-key-444";
  const DIRECT_SECRET = "direct-super-secret-key-study-vesper";
  const ROUTER_SECRET = "paid-router-secret-key-openrouter";

  config.providerBaseUrls.primaryFree = "https://primary.test/v1";
  config.providerKeys.primaryFree = PRIMARY_KEY;
  config.chatModels.lumen = "m1";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "m1";

  config.providerBaseUrls.gatewayFree = "https://gateway.test/v1";
  config.providerKeys.gatewayFree = GATEWAY_KEY;
  config.chatModels.lumenFallback1 = "m2";
  config.lumenApprovals.gateway = { approved: true, model: "m2" };

  config.providerBaseUrls.secondaryFree = "https://secondary.test/v1";
  config.providerKeys.secondaryFree = SECONDARY_KEY;
  config.chatModels.lumenFallback2 = "m3";
  config.lumenApprovals.secondary = { approved: true, model: "m3" };

  config.providerBaseUrls.reserveFree = "https://reserve.test/v1";
  config.providerKeys.reserveFree = RESERVE_KEY;
  config.chatModels.lumenFallback3 = "m4";
  config.lumenApprovals.reserve = { approved: true, model: "m4" };

  config.providerKeys.direct = DIRECT_SECRET;
  config.providerKeys.study = DIRECT_SECRET;
  config.providerKeys.paid = ROUTER_SECRET;

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers });
    if (requests.length === 4) return answer("Served by reserve");
    return new Response(JSON.stringify({ error: { message: "Stage 503" } }), { status: 503 });
  };

  const result = await callModelWithFallback("lumen", [{ role: "user", content: "Hello" }], undefined, {
    fetchImpl,
    maxRetries: 0,
  });

  assert.equal(result.internalStage, "reserveFree");
  assert.equal(requests.length, 4);

  const expectedKeys = [PRIMARY_KEY, GATEWAY_KEY, SECONDARY_KEY, RESERVE_KEY];
  for (let i = 0; i < requests.length; i++) {
    const authHeader = requests[i].headers.Authorization;
    assert.equal(authHeader, `Bearer ${expectedKeys[i]}`);
    const rawHeaders = JSON.stringify(requests[i].headers);
    assert.ok(!rawHeaders.includes(DIRECT_SECRET), `Stage ${i + 1} must not contain direct secret`);
    assert.ok(!rawHeaders.includes(ROUTER_SECRET), `Stage ${i + 1} must not contain router secret`);
    for (let j = 0; j < expectedKeys.length; j++) {
      if (j !== i) {
        assert.ok(!rawHeaders.includes(expectedKeys[j]), `Stage ${i + 1} must not contain stage ${j + 1} secret`);
      }
    }
  }
});

test("6. Configuration-failure & unapproved stage fail-closed: unapproved or misconfigured stages yield zero outbound requests", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.chatModels.lumen = "m1";
  config.chatModels.lumenFallback1 = "m2";
  config.chatModels.lumenFallback2 = "m3";
  config.chatModels.lumenFallback3 = "m4";

  // When all stages are unapproved
  config.lumenPrimaryApproved = false;
  config.lumenApprovals.primaryModel = "m1";
  config.lumenApprovals.gateway = { approved: false, model: "m2" };
  config.lumenApprovals.secondary = { approved: false, model: "m3" };
  config.lumenApprovals.reserve = { approved: false, model: "m4" };

  config.providerBaseUrls.primaryFree = "https://primary.test/v1";
  config.providerKeys.primaryFree = "pk1";
  config.providerBaseUrls.gatewayFree = "https://gateway.test/v1";
  config.providerKeys.gatewayFree = "pk2";
  config.providerBaseUrls.secondaryFree = "https://secondary.test/v1";
  config.providerKeys.secondaryFree = "pk3";
  config.providerBaseUrls.reserveFree = "https://reserve.test/v1";
  config.providerKeys.reserveFree = "pk4";

  let outboundCalls = 0;
  const fetchImpl = async () => {
    outboundCalls++;
    return answer();
  };

  await assert.rejects(
    callModelWithFallback("lumen", [{ role: "user", content: "Test ping" }], undefined, { fetchImpl, maxRetries: 0 }),
    InferenceUnavailableError
  );
  assert.equal(outboundCalls, 0, "No outbound fetch when all stages unapproved");

  // Pinned model mismatch revokes approval
  config.lumenPrimaryApproved = false; // primary unapproved
  config.lumenApprovals.gateway = { approved: true, model: "m2-different-model" }; // pinned mismatch
  config.lumenApprovals.secondary = { approved: true, model: "m3" }; // approved!
  config.lumenApprovals.reserve = { approved: false, model: "m4" };

  let calledUrls = [];
  const fetchSecond = async (url) => {
    calledUrls.push(url);
    return answer("Secondary answered");
  };

  const res = await callModelWithFallback("lumen", [{ role: "user", content: "Test ping" }], undefined, { fetchImpl: fetchSecond, maxRetries: 0 });
  assert.equal(res.internalStage, "secondaryFree");
  assert.equal(calledUrls.length, 1);
  assert.equal(calledUrls[0], "https://secondary.test/v1/chat/completions");
});

test("7. Google signature preservation: reserve stage extra_content preserved on Google models and stripped on non-Google models", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.primaryFree = "https://primary.test/v1";
  config.providerKeys.primaryFree = "pk1";
  config.chatModels.lumen = "primary-model";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "primary-model";

  config.providerBaseUrls.gatewayFree = "https://gateway.test/v1";
  config.providerKeys.gatewayFree = "pk2";
  config.chatModels.lumenFallback1 = "gateway-model";
  config.lumenApprovals.gateway = { approved: true, model: "gateway-model" };

  config.providerBaseUrls.secondaryFree = "https://secondary.test/v1";
  config.providerKeys.secondaryFree = "pk3";
  config.chatModels.lumenFallback2 = "secondary-model";
  config.lumenApprovals.secondary = { approved: true, model: "secondary-model" };

  config.providerBaseUrls.reserveFree = "https://reserve.test/v1";
  config.providerKeys.reserveFree = "pk4";
  config.chatModels.lumenFallback3 = "google/gemini-2.5-flash";
  config.lumenApprovals.reserve = { approved: true, model: "google/gemini-2.5-flash" };

  const signedCall = {
    index: 0,
    id: "call-google",
    type: "function",
    function: { name: "weather", arguments: '{"location":"London"}' },
    extra_content: { google: { thought_signature: "test-google-thought-signature-xyz" } },
  };

  const history = [
    { role: "user", content: "What is the weather?" },
    { role: "assistant", content: null, tool_calls: [signedCall] },
    { role: "tool", tool_call_id: "call-google", content: "Sunny" },
  ];

  let reserveBody;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === config.chatModels.lumenFallback3) {
      reserveBody = body;
      return answer("Weather is sunny");
    }
    return new Response(JSON.stringify({ error: { message: "Stage 503" } }), { status: 503 });
  };

  await callModelWithFallback("lumen", history, undefined, { fetchImpl, maxRetries: 0 });

  assert.ok(reserveBody, "Reserve stage must have received the request");
  assert.deepEqual(
    reserveBody.messages[1].tool_calls[0].extra_content,
    { google: { thought_signature: "test-google-thought-signature-xyz" } },
    "Google model on reserve stage must preserve extra_content"
  );

  // Now test with non-Google reserve model
  config.chatModels.lumenFallback3 = "meta-llama/llama-3.3-70b-instruct";
  config.lumenApprovals.reserve = { approved: true, model: "meta-llama/llama-3.3-70b-instruct" };

  reserveBody = null;
  await callModelWithFallback("lumen", history, undefined, { fetchImpl, maxRetries: 0 });

  assert.ok(reserveBody, "Reserve stage must have received the request");
  assert.equal(
    reserveBody.messages[1].tool_calls[0].extra_content,
    undefined,
    "Non-Google model must strip extra_content"
  );
});

test("8. Auxiliary features isolation: search intent continues to use primaryFree configuration without repointing", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.primaryFree = "https://auxiliary.primary.test/v1";
  config.providerKeys.primaryFree = "aux-primary-key-123";
  config.providerBaseUrls.paid = "https://router.paid.test/api/v1";
  config.providerKeys.paid = "router-key-paid-456";

  config.searchIntentModel = "aux/search-intent-classifier";
  config.lumenPrimaryApproved = true;

  let auxUrl;
  let auxHeaders;
  const auxFetch = async (url, init) => {
    auxUrl = url;
    auxHeaders = init.headers;
    return Response.json({ choices: [{ message: { content: '{"search":false}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  };

  await callSearchIntentModel([{ role: "user", content: "Search query test" }], { fetchImpl: auxFetch });

  assert.equal(auxUrl, "https://auxiliary.primary.test/v1/chat/completions");
  assert.equal(auxHeaders.Authorization, "Bearer aux-primary-key-123");
  assert.notEqual(auxHeaders.Authorization, "Bearer router-key-paid-456");
});

test("9. Preserved Lumen text-only UI, branded identity, and streaming SSE behavior on independent provider", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  assert.equal(MODEL_CONFIGS.lumen.supportsVision, false);

  const lumenPrompt = buildIdentitySystemPrompt("lumen", { query: "Who are you?" });
  assert.ok(lumenPrompt.includes("You are VibhavGPT Lumen, the lightweight and quick VibhavGPT assistant"));
  assert.ok(lumenPrompt.includes("VibhavGPT Lumen"));
  assert.ok(lumenPrompt.includes("lightweight and quick VibhavGPT assistant"));
  assert.ok(!lumenPrompt.includes("OpenAI"));
  assert.ok(!lumenPrompt.includes("Google"));
  assert.ok(!lumenPrompt.includes("Anthropic"));
  assert.ok(!lumenPrompt.includes("Bytez"));
  assert.ok(!lumenPrompt.includes("BazaarLink"));

  config.providerBaseUrls.primaryFree = "https://primary.stream.test/v1";
  config.providerKeys.primaryFree = "lumen-primary-stream-key";
  config.chatModels.lumen = "candidate-stream:free";
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = "candidate-stream:free";

  const receivedDeltas = [];
  let capturedStreamUrl;
  let capturedStreamHeaders;
  const streamFetch = async (url, init) => {
    capturedStreamUrl = url;
    capturedStreamHeaders = init.headers;
    return streamChunk("Streaming answer from Lumen");
  };

  const streamed = await callModelStreaming("lumen", [{ role: "user", content: "Tell me a joke" }], undefined, {
    fetchImpl: streamFetch,
    onDelta: (text) => receivedDeltas.push(text),
    maxRetries: 0,
  });

  assert.equal(capturedStreamUrl, "https://primary.stream.test/v1/chat/completions");
  assert.equal(capturedStreamHeaders.Authorization, "Bearer lumen-primary-stream-key");
  assert.equal(streamed.internalStage, "primaryFree");
  assert.equal(receivedDeltas.join(""), "Streaming answer from Lumen");
  assert.equal(streamed.data.choices[0].message.content, "Streaming answer from Lumen");
});

for (const [modeName, caller, successResponse] of [
  ["non-streaming", callModelWithFallback, () => answer("Synthetic fallback answered")],
  ["streaming", callModelStreaming, () => streamChunk("Synthetic streaming fallback answered")],
]) {
  test(`Full 4-stage fallback (${modeName}): routes to each independent endpoint in sequence with its own key`, async (t) => {
    const snap = snapshotConfig();
    t.after(() => restoreConfig(snap));

    const PRIMARY_BASE = "https://primary.provider.test/v1";
    const PRIMARY_KEY = "key-p1";
    const GATEWAY_BASE = "https://gateway.provider.test/v1";
    const GATEWAY_KEY = "key-g2";
    const SECONDARY_BASE = "https://secondary.provider.test/v1";
    const SECONDARY_KEY = "key-s3";
    const RESERVE_BASE = "https://reserve.provider.test/v1";
    const RESERVE_KEY = "key-r4";

    config.providerBaseUrls.primaryFree = PRIMARY_BASE;
    config.providerKeys.primaryFree = PRIMARY_KEY;
    config.providerBaseUrls.gatewayFree = GATEWAY_BASE;
    config.providerKeys.gatewayFree = GATEWAY_KEY;
    config.providerBaseUrls.secondaryFree = SECONDARY_BASE;
    config.providerKeys.secondaryFree = SECONDARY_KEY;
    config.providerBaseUrls.reserveFree = RESERVE_BASE;
    config.providerKeys.reserveFree = RESERVE_KEY;

    config.chatModels.lumen = "m-primary";
    config.chatModels.lumenFallback1 = "m-gateway";
    config.chatModels.lumenFallback2 = "m-secondary";
    config.chatModels.lumenFallback3 = "m-reserve";

    config.lumenPrimaryApproved = true;
    config.lumenApprovals.primaryModel = "m-primary";
    config.lumenApprovals.gateway = { approved: true, model: "m-gateway" };
    config.lumenApprovals.secondary = { approved: true, model: "m-secondary" };
    config.lumenApprovals.reserve = { approved: true, model: "m-reserve" };

    const outboundRequests = [];
    const fetchImpl = async (url, init) => {
      const parsedBody = JSON.parse(init.body);
      outboundRequests.push({
        url,
        authorization: init.headers?.Authorization,
        xFreeFallback: init.headers?.["X-Free-Fallback"],
        model: parsedBody.model,
        provider: parsedBody.provider,
      });

      if (parsedBody.model !== "m-reserve") {
        return new Response(JSON.stringify({ error: { message: "Stage overloaded" } }), { status: 503 });
      }
      return successResponse();
    };

    const messages = [{ role: "user", content: "Test fallback chain" }];
    const result = await caller("lumen", messages, undefined, { fetchImpl, maxRetries: 0 });

    assert.equal(outboundRequests.length, 4, "Every Lumen fallback must be attempted in order");
    assert.deepEqual(
      outboundRequests.map((r) => r.model),
      ["m-primary", "m-gateway", "m-secondary", "m-reserve"]
    );
    assert.equal(result.internalStage, "reserveFree");

    const expectedEndpoints = [
      `${PRIMARY_BASE}/chat/completions`,
      `${GATEWAY_BASE}/chat/completions`,
      `${SECONDARY_BASE}/chat/completions`,
      `${RESERVE_BASE}/chat/completions`,
    ];
    const expectedKeys = [PRIMARY_KEY, GATEWAY_KEY, SECONDARY_KEY, RESERVE_KEY];

    for (let i = 0; i < outboundRequests.length; i++) {
      const req = outboundRequests[i];
      assert.equal(req.url, expectedEndpoints[i], `Fallback ${i + 1} (${req.model}) must hit exact stage URL`);
      assert.equal(req.authorization, `Bearer ${expectedKeys[i]}`, `Fallback ${i + 1} (${req.model}) must carry exact stage credential`);
      assert.equal(req.provider, undefined, `Fallback ${i + 1} (${req.model}) must not have provider routing body`);
      if (i === 1) {
        assert.equal(req.xFreeFallback, "false", "Gateway stage must send X-Free-Fallback: false");
      }
    }
  });
}

test("11. Nova and Nebula router isolation: Nova and Nebula continue using OpenRouter with their routeProviders, completely isolated from Lumen", async (t) => {
  const snap = snapshotConfig();
  t.after(() => restoreConfig(snap));

  config.providerBaseUrls.paid = "https://router.paid.test/api/v1";
  config.providerKeys.paid = "router-paid-key";

  config.chatModels.nova = "nova-test-model";
  config.routeProviders.nova = ["nova-route-alpha", "nova-route-beta"];

  config.chatModels.nebula = "nebula-test-model";
  config.routeProviders.nebula = ["nebula-route-gamma"];
  config.nebulaDataPolicyVerified = true;

  let novaRequest;
  const novaFetch = async (url, init) => {
    novaRequest = { url, headers: init.headers, body: JSON.parse(init.body) };
    return answer("Nova reply");
  };

  await callModelWithFallback("nova", [{ role: "user", content: "Nova test" }], undefined, { fetchImpl: novaFetch, maxRetries: 0 });

  assert.equal(novaRequest.url, "https://router.paid.test/api/v1/chat/completions");
  assert.equal(novaRequest.headers.Authorization, "Bearer router-paid-key");
  assert.deepEqual(novaRequest.body.provider, {
    only: ["nova-route-alpha", "nova-route-beta"],
    sort: "price",
    allow_fallbacks: true,
    data_collection: "deny",
  });

  let nebulaRequest;
  const nebulaFetch = async (url, init) => {
    nebulaRequest = { url, headers: init.headers, body: JSON.parse(init.body) };
    return answer("Nebula reply");
  };

  await callModelWithFallback("nebula", [{ role: "user", content: "Nebula test" }], undefined, { fetchImpl: nebulaFetch, maxRetries: 0 });

  assert.equal(nebulaRequest.url, "https://router.paid.test/api/v1/chat/completions");
  assert.equal(nebulaRequest.headers.Authorization, "Bearer router-paid-key");
  assert.deepEqual(nebulaRequest.body.provider, {
    only: ["nebula-route-gamma"],
    sort: "price",
    allow_fallbacks: true,
    data_collection: "deny",
  });
});
