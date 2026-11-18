import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import {
  callModelWithFallback,
  callModelStreaming,
  InferenceUnavailableError,
} from "../src/chat/providers.js";

test("Lumen non-streaming skips unconfigured primaryFree and recovers on approved gatewayFree", async () => {
  const previousPrimary = config.providerKeys.primaryFree;
  config.providerKeys.primaryFree = undefined;
  config.providerKeys.gatewayFree = "test-gateway-key";
  config.chatModels.lumenFallback1 = "fixture-gateway-model";
  config.lumenApprovals.gateway = { approved: true, model: "fixture-gateway-model" };

  try {
    const requests = [];
    const res = await callModelWithFallback("lumen", [{ role: "user", content: "test" }], undefined, {
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return Response.json({
          choices: [{ message: { content: "gateway-ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
      },
    });

    assert.equal(res.internalStage, "gatewayFree");
    assert.equal(res.data.choices[0].message.content, "gateway-ok");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${config.providerBaseUrls.gatewayFree}/chat/completions`);
    assert.equal(requests[0].headers.Authorization, "Bearer test-gateway-key");
  } finally {
    config.providerKeys.primaryFree = previousPrimary;
  }
});

test("Lumen streaming skips unconfigured primaryFree and recovers on approved gatewayFree", async () => {
  const previousPrimary = config.providerKeys.primaryFree;
  config.providerKeys.primaryFree = undefined;
  config.providerKeys.gatewayFree = "test-gateway-key";
  config.chatModels.lumenFallback1 = "fixture-gateway-model";
  config.lumenApprovals.gateway = { approved: true, model: "fixture-gateway-model" };

  try {
    const requests = [];
    const res = await callModelStreaming("lumen", [{ role: "user", content: "test" }], undefined, {
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return new Response(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "stream-gateway-ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });

    assert.equal(res.internalStage, "gatewayFree");
    assert.equal(res.data.choices[0].message.content, "stream-gateway-ok");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${config.providerBaseUrls.gatewayFree}/chat/completions`);
  } finally {
    config.providerKeys.primaryFree = previousPrimary;
  }
});

test("Lumen fails closed without inference requests when no approved/configured route exists", async () => {
  const previousPrimary = config.providerKeys.primaryFree;
  const previousGateway = config.providerKeys.gatewayFree;
  const previousSecondary = config.providerKeys.secondaryFree;
  const previousReserve = config.providerKeys.reserveFree;

  config.providerKeys.primaryFree = undefined;
  config.providerKeys.gatewayFree = undefined;
  config.providerKeys.secondaryFree = undefined;
  config.providerKeys.reserveFree = undefined;

  try {
    let calls = 0;
    await assert.rejects(
      callModelWithFallback("lumen", [{ role: "user", content: "test" }], undefined, {
        fetchImpl: async () => {
          calls++;
          return Response.json({});
        },
      }),
      InferenceUnavailableError
    );
    assert.equal(calls, 0);

    let streamCalls = 0;
    await assert.rejects(
      callModelStreaming("lumen", [{ role: "user", content: "test" }], undefined, {
        fetchImpl: async () => {
          streamCalls++;
          return Response.json({});
        },
      }),
      InferenceUnavailableError
    );
    assert.equal(streamCalls, 0);
  } finally {
    config.providerKeys.primaryFree = previousPrimary;
    config.providerKeys.gatewayFree = previousGateway;
    config.providerKeys.secondaryFree = previousSecondary;
    config.providerKeys.reserveFree = previousReserve;
  }
});
