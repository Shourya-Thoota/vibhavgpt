process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { config } from "../src/config.js";
import {
  callModelWithFallback,
  callModelStreaming,
  providerEndpointUrl,
  providerApiKey,
  formatResponsesInput,
  formatResponsesTools,
  formatResponsesTextFormat,
  normalizeResponsesApiResponse,
  InferenceUnavailableError,
} from "../src/chat/providers.js";
import { reasoningParameter, MODEL_REASONING, PROVIDER_EFFORTS } from "../src/chat/reasoning-effort.js";
config.databaseUrl = "postgresql://unused:unused@127.0.0.1:9/unused";
config.authSecret = "test-only-auth-secret-not-used-for-anything-real";
const { responseTokenBudget, buildStructuredToolExchange, executeToolCall } = await import("../src/chat/router.js");
const { requestedToolCall, CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
const { normalizeThinkingEffort, thinkingUsageFor, actualApiCostUsd } = await import("../src/usage/service.js");

const DIRECT_BASE = "https://direct.test/v1";
const ROUTER_BASE = "https://router.test/v1";
const DIRECT_KEY = "test-direct-key-sk-proj-fixture";
const ROUTER_KEY = "test-router-key-sk-or-fixture";

beforeEach(() => {
  config.providerBaseUrls.direct = DIRECT_BASE;
  config.providerBaseUrls.study = DIRECT_BASE;
  config.providerBaseUrls.paid = ROUTER_BASE;

  config.providerKeys.direct = DIRECT_KEY;
  config.providerKeys.study = DIRECT_KEY;
  config.providerKeys.paid = ROUTER_KEY;

  config.vesperTransport = "direct";
  config.chatModels.vesper = "gpt-6.1-terra";
  config.chatModels.vesperDirect = "gpt-6.1-terra";
  config.chatModels.study = "gpt-6-luna";
  config.chatModels.nova = "anthropic/claude-haiku-5.5";
  config.chatModels.nebula = "google/gemini-3.8-flash";

  // Default-deny verification gate: unverified unless a test explicitly sets it true
  config.vesperDataPolicyVerified = false;
});

function sseStream(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

// -----------------------------------------------------------------------------
// 1. Privacy Gate: Default-Deny Verification Gate (Streaming and Non-Streaming)
// -----------------------------------------------------------------------------
test("1. Privacy gate: Unverified Vulcan blocks outbound requests in both streaming and non-streaming", async () => {
  config.vesperDataPolicyVerified = false;
  let outboundCalls = 0;
  const mockFetch = async () => {
    outboundCalls++;
    return Response.json({ choices: [{ message: { content: "Should never happen" } }] });
  };

  // Non-streaming path must reject before fetch
  await assert.rejects(
    callModelWithFallback("vesper", [{ role: "user", content: "Hello" }], undefined, { fetchImpl: mockFetch }),
    (err) => {
      assert.ok(err instanceof InferenceUnavailableError);
      return true;
    },
    "Non-streaming call must reject with InferenceUnavailableError when unverified",
  );
  assert.equal(outboundCalls, 0, "Zero outbound fetch calls made for unverified non-streaming Vulcan");

  // Streaming path must reject before fetch
  await assert.rejects(
    callModelStreaming("vesper", [{ role: "user", content: "Hello" }], undefined, { fetchImpl: mockFetch }),
    (err) => {
      assert.ok(err instanceof InferenceUnavailableError);
      return true;
    },
    "Streaming call must reject with InferenceUnavailableError when unverified",
  );
  assert.equal(outboundCalls, 0, "Zero outbound fetch calls made for unverified streaming Vulcan");

  // Study route must remain completely unaffected by Vulcan's verification state
  let studyCalled = false;
  const studyFetch = async (url) => {
    studyCalled = true;
    assert.equal(url, `${DIRECT_BASE}/chat/completions`);
    return Response.json({ choices: [{ message: { content: "Study works" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
  };
  const { data: studyData, internalStage } = await callModelWithFallback(
    "study",
    [{ role: "user", content: "Explain gravity" }],
    undefined,
    { fetchImpl: studyFetch },
  );
  assert.equal(studyCalled, true);
  assert.equal(internalStage, "study");
  assert.equal(studyData.choices[0].message.content, "Study works");
});

// -----------------------------------------------------------------------------
// 2. Direct Responses Host, Endpoint, Model ID, and Credential Selection
// -----------------------------------------------------------------------------
test("2. Direct Responses host, endpoint, model ID, and credential selection", async () => {
  config.vesperDataPolicyVerified = true;
  assert.equal(providerEndpointUrl({ provider: "direct", api: "responses" }), `${DIRECT_BASE}/responses`);
  assert.equal(providerApiKey({ provider: "direct" }), DIRECT_KEY);

  let capturedUrl, capturedInit;
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return Response.json({
      id: "resp-1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello from Terra" }] }],
      usage: { input_tokens: 15, output_tokens: 5 },
    });
  };

  const { data, internalStage } = await callModelWithFallback(
    "vesper",
    [{ role: "user", content: "Hello" }],
    undefined,
    { fetchImpl: mockFetch, maxTokens: 1024 },
  );

  assert.equal(internalStage, "direct");
  assert.equal(capturedUrl, `${DIRECT_BASE}/responses`);
  assert.equal(capturedInit.headers.Authorization, `Bearer ${DIRECT_KEY}`);
  assert.equal(capturedInit.headers["Content-Type"], "application/json");

  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, "gpt-6.1-terra");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 1024);
  assert.equal(body.provider, undefined, "Direct route must not contain OpenRouter provider wrapper");
  assert.equal(data.choices[0].message.content, "Hello from Terra");
  assert.equal(data.usage.prompt_tokens, 15);
  assert.equal(data.usage.completion_tokens, 5);
});

// -----------------------------------------------------------------------------
// 3. Strict Route Isolation: No Fallback to OpenRouter or Key Leakage
// -----------------------------------------------------------------------------
test("3. Strict route isolation and no cross-route fallback or credential leakage", async () => {
  config.vesperDataPolicyVerified = true;
  const directCalls = [];
  const routerCalls = [];

  const mockFetch = async (url, init) => {
    if (url.startsWith(DIRECT_BASE)) {
      directCalls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ error: { message: "Direct rate limit" } }), { status: 429 });
    }
    if (url.startsWith(ROUTER_BASE)) {
      routerCalls.push({ url, headers: init.headers });
      return Response.json({ choices: [{ message: { content: "Router OK" } }] });
    }
    return new Response("", { status: 500 });
  };

  await assert.rejects(
    callModelWithFallback("vesper", [{ role: "user", content: "Hi" }], undefined, {
      fetchImpl: mockFetch,
      maxRetries: 1,
    }),
    /temporarily unavailable/,
  );

  assert.ok(directCalls.length >= 1, "Direct route was attempted");
  assert.equal(routerCalls.length, 0, "OpenRouter was NEVER called for Vulcan");
  for (const call of directCalls) {
    assert.equal(call.headers.Authorization, `Bearer ${DIRECT_KEY}`);
    assert.notEqual(call.headers.Authorization, `Bearer ${ROUTER_KEY}`);
  }
});

// -----------------------------------------------------------------------------
// 4. Conversation and Vision Formatting for Responses API
// -----------------------------------------------------------------------------
test("4. System/custom instructions, multi-turn history, and vision formatting", () => {
  const history = [
    { role: "system", content: "You are VibhavGPT Vulcan, a helpful assistant." },
    {
      role: "user",
      content: [
        { type: "text", text: "Look at this:" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123xyz" } },
      ],
    },
    { role: "assistant", content: "I see the image." },
  ];

  const formatted = formatResponsesInput(history);
  assert.equal(formatted.length, 3);
  assert.deepEqual(formatted[0], { role: "system", content: "You are VibhavGPT Vulcan, a helpful assistant." });
  assert.deepEqual(formatted[1], {
    role: "user",
    content: [
      { type: "input_text", text: "Look at this:" },
      { type: "input_image", image_url: "data:image/jpeg;base64,abc123xyz" },
    ],
  });
  assert.deepEqual(formatted[2], { role: "assistant", content: "I see the image." });
});

// -----------------------------------------------------------------------------
// 5. Genuine Multi-Turn Stateless Tool Continuation Roundtrip
// -----------------------------------------------------------------------------
test("5. Real stateless Responses continuation: request -> tool call -> tool result -> follow-up turn", async () => {
  config.vesperDataPolicyVerified = true;
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for city",
        parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
        strict: true,
      },
    },
  ];

  const flattened = formatResponsesTools(tools);
  assert.deepEqual(flattened, [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather for city",
      parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
      strict: true,
    },
  ]);

  // Turn 1: User sends prompt, model replies with reasoning item (synthetic encrypted content) AND tool call
  const mockFetchTurn1 = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.ok(body.include.includes("reasoning.encrypted_content"));
    assert.ok(body.tools.some((t) => t.name === "utc_time"));
    return Response.json({
      id: "resp-turn-1",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_synth_enc_nonstream_01",
          encrypted_content: "gAAAAABl_synth_enc_nonstream_token_payload_abc123",
        },
        {
          type: "function_call",
          id: "fc_utc_42",
          call_id: "call_utc_42",
          name: "utc_time",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 30, output_tokens: 15 },
    });
  };

  const { data: turn1Data } = await callModelWithFallback(
    "vesper",
    [{ role: "user", content: "What is the current UTC time?" }],
    CHAT_TOOLS,
    { fetchImpl: mockFetchTurn1 },
  );

  assert.equal(turn1Data.choices[0].finish_reason, "tool_calls");
  assert.equal(turn1Data.choices[0].message.tool_calls.length, 1);
  assert.equal(turn1Data.choices[0].message.reasoning_items.length, 1);
  assert.equal(turn1Data.choices[0].message.reasoning_items[0].encrypted_content, "gAAAAABl_synth_enc_nonstream_token_payload_abc123");

  // Real tool loop execution: requestedToolCall -> executeToolCall -> buildStructuredToolExchange
  const toolCall = requestedToolCall(turn1Data, "What is the current UTC time?");
  assert.equal(toolCall.name, "utc_time");
  assert.equal(toolCall.format, "structured");

  const toolResult = await executeToolCall(toolCall, "What is the current UTC time?", { modelKey: "vesper" });
  assert.equal(toolResult.kind, "time");
  assert.ok(toolResult.content.includes("utc"));

  const toolExchange = buildStructuredToolExchange(
    toolCall,
    "What is the current UTC time?",
    toolResult.content,
    turn1Data.choices[0].message.reasoning_items,
  );
  assert.equal(toolExchange.length, 2);
  assert.equal(toolExchange[0].role, "assistant");
  assert.equal(toolExchange[0].reasoning_items.length, 1);
  assert.equal(toolExchange[0].reasoning_items[0].encrypted_content, "gAAAAABl_synth_enc_nonstream_token_payload_abc123");
  assert.equal(toolExchange[1].role, "tool");
  assert.equal(toolExchange[1].tool_call_id, "call_utc_42");

  // Turn 2: Follow-up request preserves required items and ordering
  const followUpConversation = [
    { role: "user", content: "What is the current UTC time?" },
    ...toolExchange,
  ];

  let turn2SentBody;
  const mockFetchTurn2 = async (_url, init) => {
    turn2SentBody = JSON.parse(init.body);
    return Response.json({
      id: "resp-turn-2",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The current UTC time is 2026-10-27T21:00:00Z." }],
        },
      ],
      usage: { input_tokens: 60, output_tokens: 20 },
    });
  };

  const { data: turn2Data } = await callModelWithFallback(
    "vesper",
    followUpConversation,
    CHAT_TOOLS,
    { fetchImpl: mockFetchTurn2 },
  );

  assert.equal(turn2SentBody.store, false);
  assert.ok(turn2SentBody.include.includes("reasoning.encrypted_content"));
  // Assert exact ordering: User message -> Reasoning item (with encrypted content) -> Function call -> Function call output
  assert.equal(turn2SentBody.input.length, 4);
  assert.deepEqual(turn2SentBody.input[0], { role: "user", content: "What is the current UTC time?" });
  assert.deepEqual(turn2SentBody.input[1], {
    type: "reasoning",
    id: "rs_synth_enc_nonstream_01",
    encrypted_content: "gAAAAABl_synth_enc_nonstream_token_payload_abc123",
  });
  assert.deepEqual(turn2SentBody.input[2], {
    type: "function_call",
    call_id: "call_utc_42",
    name: "utc_time",
    arguments: "{}",
  });
  assert.deepEqual(turn2SentBody.input[3], {
    type: "function_call_output",
    call_id: "call_utc_42",
    output: toolResult.content,
  });

  // Final answer reaches existing output pipeline
  assert.equal(turn2Data.choices[0].finish_reason, "stop");
  assert.equal(turn2Data.choices[0].message.content, "The current UTC time is 2026-10-27T21:00:00Z.");
  assert.equal(turn2Data.choices[0].message.reasoning_items, undefined, "Final answer has no reasoning items attached");
  assert.ok(!turn2Data.choices[0].message.content.includes("gAAAAABl"), "Encrypted content never leaks to visible answer text");

  // State isolation check: cannot leak into another request, tier, or user's context
  let otherSentBody;
  const mockFetchOther = async (_url, init) => {
    otherSentBody = JSON.parse(init.body);
    return Response.json({
      choices: [{ message: { content: "Other response" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
  };
  await callModelWithFallback("study", [{ role: "user", content: "Unrelated question" }], undefined, { fetchImpl: mockFetchOther });
  const otherSerialized = JSON.stringify(otherSentBody);
  assert.ok(!otherSerialized.includes("gAAAAABl"), "Synthetic encrypted reasoning cannot leak to Study tier");
  assert.ok(!otherSerialized.includes("rs_synth_enc_nonstream_01"), "Synthetic reasoning item ID cannot leak to Study tier");
});

// -----------------------------------------------------------------------------
// 6. Adversarial ReadableStream: Deliberately Split SSE, JSON, and Multibyte UTF-8
// -----------------------------------------------------------------------------
test("6. Streaming across deliberately split SSE frames, JSON tokens, and multibyte UTF-8 sequences", async () => {
  config.vesperDataPolicyVerified = true;

  // Multibyte characters:
  // "€" is 3 bytes: 0xE2, 0x82, 0xAC
  // "🎉" is 4 bytes: 0xF0, 0x9F, 0x8E, 0x89
  const textPayload = 'data: {"type":"response.output_text.delta","delta":"Total: 50€! 🎉"}\n\n';
  const donePayload = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":10,"input_tokens_details":{"cached_tokens":8},"output_tokens_details":{"reasoning_tokens":4}}}}\n\n';

  const fullBytes = new TextEncoder().encode(textPayload + donePayload);

  // We deliberately split the byte stream into small chunks slicing through:
  // 1) "da" / "ta: " (SSE frame header)
  // 2) JSON token boundary
  // 3) Slicing the 3-byte Euro sign right in the middle
  // 4) Slicing the 4-byte Party popper right in the middle
  // 5) Slicing across response.completed usage payload
  const euroIndex = textPayload.indexOf("€");
  const euroByteStart = new TextEncoder().encode(textPayload.slice(0, euroIndex)).length;
  const partyIndex = textPayload.indexOf("🎉");
  const partyByteStart = new TextEncoder().encode(textPayload.slice(0, partyIndex)).length;

  const rawChunks = [
    fullBytes.subarray(0, 2),                                // "da"
    fullBytes.subarray(2, 15),                               // "ta: {\"type\":\"r"
    fullBytes.subarray(15, euroByteStart + 1),               // up to first byte of "€" (0xE2)
    fullBytes.subarray(euroByteStart + 1, partyByteStart + 2), // remaining 2 bytes of "€" + first 2 bytes of "🎉"
    fullBytes.subarray(partyByteStart + 2, textPayload.length + 20), // remaining bytes of "🎉" + part of completed event
    fullBytes.subarray(textPayload.length + 20),             // remainder of completed event
  ];

  const streamResponse = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of rawChunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const deltas = [];
  const { data } = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Price" }],
    undefined,
    {
      fetchImpl: async () => streamResponse,
      onDelta: (text) => deltas.push(text),
    },
  );

  assert.equal(data.choices[0].message.content, "Total: 50€! 🎉");
  assert.ok(!data.choices[0].message.content.includes("\uFFFD"), "No Unicode replacement characters from split multibyte UTF-8");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.usage.prompt_tokens, 20);
  assert.equal(data.usage.completion_tokens, 10);
  assert.equal(data.usage.prompt_tokens_details.cached_tokens, 8);
  assert.equal(data.usage.completion_tokens_details.reasoning_tokens, 4);
});

// -----------------------------------------------------------------------------
// 7. Output Index vs Function-Call Indexing Decoupling
// -----------------------------------------------------------------------------
test("7. Global output_index versus function-call indexing with reasoning and message items before/between tool calls", async () => {
  config.vesperDataPolicyVerified = true;

  // Stream where output_index 0 is reasoning, 1 is message text, 2 is function call A,
  // 3 is message text, and 4 is function call B
  const chunks = [
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Evaluating query..." },
    { type: "response.output_text.delta", output_index: 1, delta: "I need to invoke tools." },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "call_a", name: "tool_alpha" } },
    { type: "response.function_call_arguments.delta", output_index: 2, call_id: "call_a", delta: '{"val":' },
    { type: "response.function_call_arguments.delta", output_index: 2, call_id: "call_a", delta: '10}' },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "call_a", name: "tool_alpha", arguments: '{"val":10}' } },
    { type: "response.output_text.delta", output_index: 3, delta: " Now second tool:" },
    { type: "response.output_item.added", output_index: 4, item: { type: "function_call", id: "call_b", name: "tool_beta" } },
    { type: "response.function_call_arguments.delta", output_index: 4, call_id: "call_b", delta: '{"flag":true}' },
    { type: "response.output_item.done", output_index: 4, item: { type: "function_call", id: "call_b", name: "tool_beta", arguments: '{"flag":true}' } },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 45,
          output_tokens: 25,
          input_tokens_details: { cached_tokens: 15 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      },
    },
  ];

  const reasoningDeltas = [];
  const textDeltas = [];
  let thinkingSignals = 0;

  const { data } = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Run both" }],
    [{ type: "function", function: { name: "tool_alpha" } }, { type: "function", function: { name: "tool_beta" } }],
    {
      fetchImpl: async () => sseStream(chunks),
      onReasoning: (t) => reasoningDeltas.push(t),
      onThinking: () => { thinkingSignals += 1; },
      onDelta: (t) => textDeltas.push(t),
    },
  );

  assert.equal(data.choices[0].finish_reason, "tool_calls");
  assert.equal(data.choices[0].message.tool_calls.length, 2, "Exactly two tool calls, with no sparse undefined slots");
  assert.equal(data.choices[0].message.tool_calls[0].id, "call_a");
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "tool_alpha");
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"val":10}');
  assert.equal(data.choices[0].message.tool_calls[1].id, "call_b");
  assert.equal(data.choices[0].message.tool_calls[1].function.name, "tool_beta");
  assert.equal(data.choices[0].message.tool_calls[1].function.arguments, '{"flag":true}');
  // No request asks this route for a summary, so a reasoning event is not
  // verified displayable text: only the fact that the model thought is relayed.
  assert.deepEqual(reasoningDeltas, [], "no reasoning text is relayed on an unverified route");
  assert.equal(thinkingSignals, 1, "the thinking is reported as activity");
});

test("7b. Hiding reasoning text from the client keeps the encrypted reasoning item the next tool turn needs", async () => {
  config.vesperDataPolicyVerified = true;
  const encrypted = "gAAAAABl_synth_enc_stream_token_payload_xyz789";
  const chunks = [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "I should call the lookup tool." },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: encrypted } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "call_x", name: "tool_alpha" } },
    { type: "response.function_call_arguments.delta", output_index: 1, call_id: "call_x", delta: "{}" },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "call_x", name: "tool_alpha", arguments: "{}" } },
    { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } } },
  ];
  const shown = [];
  let signals = 0;
  const { data } = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Look it up" }],
    [{ type: "function", function: { name: "tool_alpha" } }],
    { fetchImpl: async () => sseStream(chunks), onReasoning: (t) => shown.push(t), onThinking: () => { signals += 1; }, onDelta: () => true },
  );
  assert.deepEqual(shown, [], "the model's reasoning text is not relayed");
  assert.equal(signals, 1);
  assert.equal(data.choices[0].finish_reason, "tool_calls");
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "tool_alpha");
  assert.equal(data.choices[0].message.reasoning_items.length, 1, "the reasoning item is kept for the next call");
  assert.equal(data.choices[0].message.reasoning_items[0].encrypted_content, encrypted);
});

// -----------------------------------------------------------------------------
// 8. Responses Lifecycle: Failed, Incomplete, Refusal, and Premature EOF
// -----------------------------------------------------------------------------
test("8. Responses lifecycle: failed, incomplete, refusal, and premature EOF handling", async () => {
  config.vesperDataPolicyVerified = true;

  // 8a. Non-streaming status: "failed" must throw provider error and not normalize as success
  const failedMock = async () => Response.json({
    id: "resp-fail",
    status: "failed",
    failed_details: { code: "server_error", message: "Inference server failed" },
    usage: { input_tokens: 10, output_tokens: 0 },
  });

  await assert.rejects(
    callModelWithFallback("vesper", [{ role: "user", content: "Fail" }], undefined, { fetchImpl: failedMock }),
    /temporarily unavailable/,
  );

  // 8b. Non-streaming status: "incomplete" with max_output_tokens maps to finish_reason: "length"
  const incompleteMock = async () => Response.json({
    id: "resp-inc",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Beginning of an answer that was truncated" }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  const { data: incData } = await callModelWithFallback(
    "vesper",
    [{ role: "user", content: "Tell story" }],
    undefined,
    { fetchImpl: incompleteMock },
  );
  assert.equal(incData.choices[0].finish_reason, "length");
  assert.equal(incData.choices[0].message.content, "Beginning of an answer that was truncated");
  assert.equal(incData.usage.completion_tokens, 50);

  // 8c. Non-streaming refusal extraction
  const refusalMock = async () => Response.json({
    id: "resp-refuse",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        refusal: "I cannot comply with this safety-restricted request.",
      },
    ],
    usage: { input_tokens: 20, output_tokens: 5 },
  });

  const { data: refData } = await callModelWithFallback(
    "vesper",
    [{ role: "user", content: "Restricted request" }],
    undefined,
    { fetchImpl: refusalMock },
  );
  assert.equal(refData.choices[0].finish_reason, "refusal");
  assert.equal(refData.choices[0].message.refusal, "I cannot comply with this safety-restricted request.");
  assert.equal(refData.choices[0].message.content, "I cannot comply with this safety-restricted request.");

  // 8d. Streaming response.incomplete event preserves partial output and length finish_reason
  const streamingIncompleteChunks = [
    { type: "response.output_text.delta", delta: "Partial stream text" },
    {
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 80, output_tokens: 40 },
      },
    },
  ];

  const { data: streamIncData } = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Stream more" }],
    undefined,
    { fetchImpl: async () => sseStream(streamingIncompleteChunks) },
  );
  assert.equal(streamIncData.choices[0].finish_reason, "length");
  assert.equal(streamIncData.choices[0].message.content, "Partial stream text");
  assert.equal(streamIncData.usage.prompt_tokens, 80);
  assert.equal(streamIncData.usage.completion_tokens, 40);

  // 8e. Streaming premature EOF before response.completed throws and cleans up
  const prematureStream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"cut off prematurely"}\n\n'));
        controller.close(); // Closed without response.completed or finish_reason
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  await assert.rejects(
    callModelStreaming("vesper", [{ role: "user", content: "Hang" }], undefined, { fetchImpl: async () => prematureStream }),
    /temporarily unavailable/,
  );

  // 8f. Streaming refusal delta (without content) completes with refusal finish_reason without ReferenceError
  const streamingRefusalChunks = [
    { type: "response.refusal.delta", delta: "Safety policy restriction." },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ type: "message", role: "assistant", refusal: "Safety policy restriction." }],
        usage: { input_tokens: 15, output_tokens: 6 },
      },
    },
  ];

  const { data: streamRefData } = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Restricted query" }],
    undefined,
    { fetchImpl: async () => sseStream(streamingRefusalChunks) },
  );
  assert.equal(streamRefData.choices[0].finish_reason, "refusal");
  assert.equal(streamRefData.choices[0].message.refusal, "Safety policy restriction.");
  assert.equal(streamRefData.choices[0].message.content, "Safety policy restriction.");

  // 8g. Streaming error event throws provider-stream-error
  const streamingErrorEvent = [
    { type: "error", error: { message: "Stream engine fault", code: 500 } },
  ];
  await assert.rejects(
    callModelStreaming("vesper", [{ role: "user", content: "Fault" }], undefined, {
      fetchImpl: async () => sseStream(streamingErrorEvent),
      maxRetries: 0,
    }),
    /temporarily unavailable/,
  );

  // 8h. Streaming partial output followed by response.failed with confirmed usage
  let deliveredText = "";
  const streamingPartialFailureChunks = [
    { type: "response.output_text.delta", delta: "Good partial text." },
    {
      type: "response.failed",
      response: {
        error: { message: "Inference engine failed mid-generation", code: "server_error" },
        usage: { input_tokens: 50, output_tokens: 15 },
      },
    },
  ];
  await assert.rejects(
    callModelStreaming("vesper", [{ role: "user", content: "Fail mid stream" }], undefined, {
      fetchImpl: async () => sseStream(streamingPartialFailureChunks),
      onDelta: (d) => { deliveredText += d; return true; },
      maxRetries: 0,
    }),
    /temporarily unavailable/,
  );
  assert.equal(deliveredText, "Good partial text.");
});

// -----------------------------------------------------------------------------
// 9. Non-Streaming Usage, Cache/Reasoning Preservation, and Accounting Limitations
// -----------------------------------------------------------------------------
test("9. Non-streaming cached/reasoning usage preservation and cost settlement", async () => {
  config.vesperDataPolicyVerified = true;

  const trackerEvents = [];
  const usageTracker = {
    beforeCall: async () => trackerEvents.push("beforeCall"),
    record: async (usage) => trackerEvents.push({ record: usage }),
    release: async () => trackerEvents.push("release"),
  };

  const mockFetch = async () => Response.json({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens_details: { reasoning_tokens: 50 },
    },
  });

  const { data } = await callModelWithFallback("vesper", [{ role: "user", content: "Hi" }], undefined, {
    fetchImpl: mockFetch,
    usageTracker,
  });

  assert.equal(trackerEvents[0], "beforeCall");
  const recorded = trackerEvents[1]?.record;
  assert.equal(recorded.prompt_tokens, 1000);
  assert.equal(recorded.completion_tokens, 200);
  assert.equal(recorded.prompt_tokens_details?.cached_tokens, 400);
  assert.equal(recorded.completion_tokens_details?.reasoning_tokens, 50);

  // Normalized API response must preserve details
  assert.equal(data.usage.prompt_tokens, 1000);
  assert.equal(data.usage.completion_tokens, 200);
  assert.equal(data.usage.prompt_tokens_details?.cached_tokens, 400);
  assert.equal(data.usage.completion_tokens_details?.reasoning_tokens, 50);

  // Vulcan cost: $1.00/M in, $5.00/M out, $0.05/M cacheRead
  // uncached input: (1000 - 400) * 1.00 = 600
  // output: 200 * 5.00 = 1000
  // cached input: 400 * 0.05 = 20
  // total = (600 + 1000 + 20) / 1e6 = 0.00162
  const cost = actualApiCostUsd("vesper", recorded);
  assert.equal(cost, 0.00162);

  // NOTE on Cache-Write Accounting Limitation:
  // OpenAI Terra charges $1.25 per million tokens for cache writes (a 50% premium over base input).
  // However, VibhavGPT's database schema (usage_events) only tracks input_tokens, output_tokens,
  // cached_input_tokens (reads), and reasoning_tokens. Cache writes cannot be tracked or persisted
  // without a database migration (which is prohibited in this update). Hence, cache writes are not
  // tracked separately, and all uncached input is billed at the standard input price ($1.00/M).
});

// -----------------------------------------------------------------------------
// 10. Failure/Cancellation Settlement and Refund Assertions
// -----------------------------------------------------------------------------
test("10. Failure and cancellation settlement: reservations released/refunded on abort or failure", async () => {
  config.vesperDataPolicyVerified = true;

  // 10a. Client abort signal releases reservation without charging
  const abortEvents = [];
  const abortTracker = {
    beforeCall: async () => abortEvents.push("beforeCall"),
    record: async (u) => abortEvents.push({ record: u }),
    release: async () => abortEvents.push("release"),
  };

  const controller = new AbortController();
  const abortFetch = async () => {
    controller.abort();
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  };

  await assert.rejects(
    callModelWithFallback("vesper", [{ role: "user", content: "test" }], undefined, {
      signal: controller.signal,
      fetchImpl: abortFetch,
      usageTracker: abortTracker,
    }),
    /temporarily unavailable/,
  );

  assert.equal(abortEvents[0], "beforeCall");
  assert.equal(abortEvents[1], "release");
  assert.equal(abortEvents.filter((e) => e.record).length, 0, "No usage recorded on client cancellation");

  // 10b. Retryable 503 retries and settles on recovery
  let attempts = 0;
  const mockRetryFetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: "Server busy" } }), { status: 503 });
    }
    return Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered" }] }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };

  const result = await callModelWithFallback("vesper", [{ role: "user", content: "test" }], undefined, {
    fetchImpl: mockRetryFetch,
    maxRetries: 1,
  });

  assert.equal(attempts, 2, "Retried after 503 and recovered");
  assert.equal(result.data.choices[0].message.content, "Recovered");

  // 10c. Streaming cancellation releases reservation via tracker spy
  const streamAbortEvents = [];
  const streamTracker = {
    beforeCall: async () => streamAbortEvents.push("beforeCall"),
    record: async (u) => streamAbortEvents.push({ record: u }),
    release: async () => streamAbortEvents.push("release"),
  };
  const streamController = new AbortController();
  const mockStreamAbortFetch = async () => {
    streamController.abort();
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    throw err;
  };
  await assert.rejects(
    callModelStreaming("vesper", [{ role: "user", content: "Abort stream" }], undefined, {
      signal: streamController.signal,
      fetchImpl: mockStreamAbortFetch,
      usageTracker: streamTracker,
    }),
    /temporarily unavailable/,
  );
  assert.equal(streamAbortEvents[0], "beforeCall");
  assert.equal(streamAbortEvents[1], "release");
  assert.equal(streamAbortEvents.filter((e) => e.record).length, 0);
});

// -----------------------------------------------------------------------------
// 11. Saved Thinking Preferences Translation Coverage (Database Persistence Untested)
// -----------------------------------------------------------------------------
test("11. Saved thinking preferences translation coverage (database persistence untested in this fixture)", async () => {
  config.vesperDataPolicyVerified = true;

  const PREFERENCES = ["low", "normal", "high", "xhigh", "max"];
  for (const pref of PREFERENCES) {
    let sentBody;
    const mockFetch = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return Response.json({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    };

    // User profile preference normalization
    const normalized = normalizeThinkingEffort(pref);
    assert.equal(normalized, pref);

    // Unified thinking (#151): a stored Normal is Medium; High, Extra High and Max are High, the engine's highest ("max", which this
    // engine accepts). The stored value itself is never rewritten.
    const unified = { low: "low", normal: "medium", high: "max", xhigh: "max", max: "max" }[pref];
    const usageInfo = thinkingUsageFor("vesper", pref);
    assert.equal(usageInfo.effort, unified);

    await callModelWithFallback("vesper", [{ role: "user", content: "Test" }], undefined, {
      reasoning: usageInfo.providerEffort,
      fetchImpl: mockFetch,
    });

    assert.deepEqual(sentBody.reasoning, { effort: unified }, `Preference ${pref} is sent as ${unified}`);
  }

  // NOTE on Database Persistence Coverage:
  // Profile settings persistence into PostgreSQL user_profiles table is covered in in-memory
  // SQLite/PGlite test fixtures (see test/chat-message-persistence.test.js and test/model-preference.test.js).
  // Live multi-process PostgreSQL reload test coverage is missing locally because tests run against
  // an unused placeholder DATABASE_URL without a live PostgreSQL instance.
});

// -----------------------------------------------------------------------------
// 12. Verification of Capability Assumptions and Answer Budgets
// -----------------------------------------------------------------------------
test("12. Capability assumptions, mapping verification, and answer budgets", () => {
  // Check scale consistency
  assert.deepEqual(PROVIDER_EFFORTS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

  // Model reasoning mappings reconciled with authoritative OpenRouter metadata:
  assert.deepEqual(MODEL_REASONING["anthropic/claude-haiku-5.5"], {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    mandatory: false,
  });
  assert.deepEqual(MODEL_REASONING["google/gemini-3.8-flash"], {
    efforts: ["low", "medium", "high"],
    mandatory: true,
  });
  assert.deepEqual(MODEL_REASONING["gpt-6.1-terra"], {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    mandatory: false,
  });

  // Reconciled effort mappings:
  // Normal maps to balanced "medium" for models with granular support:
  assert.deepEqual(reasoningParameter("gpt-6.1-terra", "normal"), { effort: "medium" });
  assert.deepEqual(reasoningParameter("anthropic/claude-haiku-5.5", "normal"), { effort: "medium" });

  // For Nebula (google/gemini-3.8-flash), upstream OpenRouter supports ["low", "medium", "high"]:
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", "normal"), { effort: "medium" });
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", "low"), { effort: "low" });
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", "high"), { effort: "high" });
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", "xhigh"), { effort: "high" });
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", "max"), { effort: "high" });

  // When reasoning is disabled for internal steps (level === false), models supporting "none" send { effort: "none" },
  // while mandatory models send the lightest level with exclude: true:
  assert.deepEqual(reasoningParameter("gpt-6.1-terra", false), { effort: "none" });
  assert.deepEqual(reasoningParameter("anthropic/claude-haiku-5.5", false), { effort: "none" });
  assert.deepEqual(reasoningParameter("google/gemini-3.8-flash", false), { effort: "low", exclude: true });

  // Answer budget verification:
  // Nebula uses doubled headroom (floor 8,192) for mandatory thinking; other tiers use standard budgets
  assert.equal(responseTokenBudget("normal", "simple question", "vesper"), 2048);
  assert.equal(responseTokenBudget("normal", "simple question", "nebula"), 8192);
  assert.equal(responseTokenBudget("normal", "simple question", "nova"), 2048);
  assert.equal(responseTokenBudget("high", "write python script", "vesper"), 4096);
  assert.equal(responseTokenBudget("max", "complex reasoning", "vesper"), 8192);
});

// -----------------------------------------------------------------------------
// 13. Stateless Reasoning Continuation: Streaming Real Tool Loop Roundtrip
// -----------------------------------------------------------------------------
test("13. Stateless reasoning continuation (streaming): SSE reasoning with encrypted content + function call -> real tool loop -> follow-up turn preserves ordering and items -> stream completes without leakage", async () => {
  config.vesperDataPolicyVerified = true;

  // Turn 1: Streaming response with reasoning item (synthetic encrypted content) + function call
  const streamTurn1Chunks = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_synth_enc_stream_01",
        encrypted_content: "gAAAAABl_synth_enc_stream_token_payload_xyz987",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_synth_enc_stream_01",
        encrypted_content: "gAAAAABl_synth_enc_stream_token_payload_xyz987",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_time_stream_01",
        call_id: "call_time_stream_01",
        name: "utc_time",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      call_id: "call_time_stream_01",
      delta: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_time_stream_01",
        call_id: "call_time_stream_01",
        name: "utc_time",
        arguments: "{}",
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_synth_enc_stream_01",
            encrypted_content: "gAAAAABl_synth_enc_stream_token_payload_xyz987",
          },
          {
            type: "function_call",
            id: "fc_time_stream_01",
            call_id: "call_time_stream_01",
            name: "utc_time",
            arguments: "{}",
          },
        ],
        usage: { input_tokens: 35, output_tokens: 20 },
      },
    },
  ];

  let turn1SentBody;
  const mockFetchTurn1 = async (_url, init) => {
    turn1SentBody = JSON.parse(init.body);
    return sseStream(streamTurn1Chunks);
  };

  const turn1Result = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "What is the current time in UTC?" }],
    CHAT_TOOLS,
    { fetchImpl: mockFetchTurn1 },
  );

  assert.equal(turn1SentBody.store, false);
  assert.ok(turn1SentBody.include.includes("reasoning.encrypted_content"));
  assert.equal(turn1Result.data.choices[0].finish_reason, "tool_calls");
  assert.equal(turn1Result.data.choices[0].message.tool_calls.length, 1);
  assert.equal(turn1Result.data.choices[0].message.reasoning_items.length, 1);
  assert.equal(turn1Result.data.choices[0].message.reasoning_items[0].encrypted_content, "gAAAAABl_synth_enc_stream_token_payload_xyz987");

  // Real tool loop execution
  const toolCall = requestedToolCall(turn1Result.data, "What is the current time in UTC?");
  assert.equal(toolCall.name, "utc_time");
  const toolResult = await executeToolCall(toolCall, "What is the current time in UTC?", { modelKey: "vesper" });
  assert.equal(toolResult.kind, "time");

  const toolExchange = buildStructuredToolExchange(
    toolCall,
    "What is the current time in UTC?",
    toolResult.content,
    turn1Result.data.choices[0].message.reasoning_items,
  );
  assert.equal(toolExchange[0].role, "assistant");
  assert.equal(toolExchange[0].reasoning_items.length, 1);
  assert.equal(toolExchange[0].reasoning_items[0].encrypted_content, "gAAAAABl_synth_enc_stream_token_payload_xyz987");

  // Turn 2: Follow-up streamed turn
  const followUpConversation = [
    { role: "user", content: "What is the current time in UTC?" },
    ...toolExchange,
  ];

  let turn2SentBody;
  const streamTurn2Chunks = [
    { type: "response.output_text.delta", delta: "The verified UTC time " },
    { type: "response.output_text.delta", delta: "is confirmed." },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The verified UTC time is confirmed." }],
          },
        ],
        usage: { input_tokens: 65, output_tokens: 14 },
      },
    },
  ];

  const mockFetchTurn2 = async (_url, init) => {
    turn2SentBody = JSON.parse(init.body);
    return sseStream(streamTurn2Chunks);
  };

  let streamedDeltaText = "";
  const turn2Result = await callModelStreaming(
    "vesper",
    followUpConversation,
    CHAT_TOOLS,
    {
      fetchImpl: mockFetchTurn2,
      onDelta: (delta) => {
        streamedDeltaText += delta;
        return true;
      },
    },
  );

  // Assert Turn 2 outbound payload has store: false, include, and exact ordering
  assert.equal(turn2SentBody.store, false);
  assert.ok(turn2SentBody.include.includes("reasoning.encrypted_content"));
  assert.equal(turn2SentBody.input.length, 4);
  assert.deepEqual(turn2SentBody.input[0], { role: "user", content: "What is the current time in UTC?" });
  assert.deepEqual(turn2SentBody.input[1], {
    type: "reasoning",
    id: "rs_synth_enc_stream_01",
    encrypted_content: "gAAAAABl_synth_enc_stream_token_payload_xyz987",
  });
  assert.deepEqual(turn2SentBody.input[2], {
    type: "function_call",
    call_id: "call_time_stream_01",
    name: "utc_time",
    arguments: "{}",
  });
  assert.deepEqual(turn2SentBody.input[3], {
    type: "function_call_output",
    call_id: "call_time_stream_01",
    output: toolResult.content,
  });

  // Final answer verification
  assert.equal(streamedDeltaText, "The verified UTC time is confirmed.");
  assert.equal(turn2Result.data.choices[0].message.content, "The verified UTC time is confirmed.");
  assert.ok(!streamedDeltaText.includes("gAAAAABl"), "No encrypted content in streamed delta");

  // State isolation check: ensure another request does not retain reasoning items
  const cleanCall = await callModelStreaming(
    "vesper",
    [{ role: "user", content: "Independent request" }],
    CHAT_TOOLS,
    {
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.input.length, 1);
        assert.deepEqual(body.input[0], { role: "user", content: "Independent request" });
        return sseStream([
          { type: "response.output_text.delta", delta: "Independent reply" },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
        ]);
      },
    },
  );
  assert.equal(cleanCall.data.choices[0].message.content, "Independent reply");
});

// -----------------------------------------------------------------------------
// 14. Convert Structured Output Settings (Responses text.format vs Chat Completions response_format)
// -----------------------------------------------------------------------------
test("14. Structured output translation: Responses uses text.format while Chat Completions preserves response_format (streaming and non-streaming)", async () => {
  config.vesperDataPolicyVerified = true;

  // A. Responses API: json_object (non-streaming and streaming)
  let vesperJsonObjectNonStreamBody;
  await callModelWithFallback("vesper", [{ role: "user", content: "Give json" }], undefined, {
    responseFormat: { type: "json_object" },
    fetchImpl: async (_url, init) => {
      vesperJsonObjectNonStreamBody = JSON.parse(init.body);
      return Response.json({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"result":true}' }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  assert.deepEqual(vesperJsonObjectNonStreamBody.text, { format: { type: "json_object" } });
  assert.equal(vesperJsonObjectNonStreamBody.response_format, undefined, "Responses API must not have top-level response_format");

  let vesperJsonObjectStreamBody;
  await callModelStreaming("vesper", [{ role: "user", content: "Give json" }], undefined, {
    responseFormat: { type: "json_object" },
    fetchImpl: async (_url, init) => {
      vesperJsonObjectStreamBody = JSON.parse(init.body);
      return sseStream([
        { type: "response.output_text.delta", delta: '{"result":true}' },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
      ]);
    },
  });
  assert.deepEqual(vesperJsonObjectStreamBody.text, { format: { type: "json_object" } });
  assert.equal(vesperJsonObjectStreamBody.response_format, undefined);

  // B. Responses API: json_schema with name, strict, schema (non-streaming and streaming)
  const schemaConfig = {
    type: "json_schema",
    json_schema: {
      name: "sentiment_score",
      strict: true,
      schema: {
        type: "object",
        properties: { score: { type: "number" }, label: { type: "string" } },
        required: ["score", "label"],
        additionalProperties: false,
      },
    },
  };

  let vesperJsonSchemaNonStreamBody;
  await callModelWithFallback("vesper", [{ role: "user", content: "Analyze sentiment" }], undefined, {
    responseFormat: schemaConfig,
    fetchImpl: async (_url, init) => {
      vesperJsonSchemaNonStreamBody = JSON.parse(init.body);
      return Response.json({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"score":0.9,"label":"positive"}' }] }],
        usage: { input_tokens: 20, output_tokens: 8 },
      });
    },
  });
  assert.deepEqual(vesperJsonSchemaNonStreamBody.text, {
    format: {
      type: "json_schema",
      name: "sentiment_score",
      strict: true,
      schema: {
        type: "object",
        properties: { score: { type: "number" }, label: { type: "string" } },
        required: ["score", "label"],
        additionalProperties: false,
      },
    },
  });
  assert.equal(vesperJsonSchemaNonStreamBody.response_format, undefined);

  let vesperJsonSchemaStreamBody;
  await callModelStreaming("vesper", [{ role: "user", content: "Analyze sentiment" }], undefined, {
    responseFormat: schemaConfig,
    fetchImpl: async (_url, init) => {
      vesperJsonSchemaStreamBody = JSON.parse(init.body);
      return sseStream([
        { type: "response.output_text.delta", delta: '{"score":0.9,"label":"positive"}' },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 8 } } },
      ]);
    },
  });
  assert.deepEqual(vesperJsonSchemaStreamBody.text, {
    format: {
      type: "json_schema",
      name: "sentiment_score",
      strict: true,
      schema: {
        type: "object",
        properties: { score: { type: "number" }, label: { type: "string" } },
        required: ["score", "label"],
        additionalProperties: false,
      },
    },
  });
  assert.equal(vesperJsonSchemaStreamBody.response_format, undefined);

  // C. Responses API: Unsupported/custom options are preserved, not silently dropped
  const customFormatConfig = {
    type: "json_schema",
    custom_top_option: "important_meta",
    json_schema: {
      name: "custom_schema",
      strict: false,
      schema: { type: "object" },
      custom_inner_option: 42,
    },
  };
  let vesperCustomFormatBody;
  await callModelWithFallback("vesper", [{ role: "user", content: "Custom" }], undefined, {
    responseFormat: customFormatConfig,
    fetchImpl: async (_url, init) => {
      vesperCustomFormatBody = JSON.parse(init.body);
      return Response.json({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }],
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    },
  });
  assert.equal(vesperCustomFormatBody.text.format.custom_top_option, "important_meta");
  assert.equal(vesperCustomFormatBody.text.format.custom_inner_option, 42);
  assert.equal(vesperCustomFormatBody.text.format.strict, false);
  assert.equal(vesperCustomFormatBody.response_format, undefined);

  // D. Chat Completions API (Study / Nova / Nebula): Top-level response_format is preserved unchanged
  let studyJsonObjectNonStreamBody;
  await callModelWithFallback("study", [{ role: "user", content: "Study json" }], undefined, {
    responseFormat: { type: "json_object" },
    fetchImpl: async (_url, init) => {
      studyJsonObjectNonStreamBody = JSON.parse(init.body);
      return Response.json({
        choices: [{ message: { content: '{"answer":42}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
    },
  });
  assert.deepEqual(studyJsonObjectNonStreamBody.response_format, { type: "json_object" });
  assert.equal(studyJsonObjectNonStreamBody.text, undefined, "Chat Completions API must not have text.format");

  let studyJsonSchemaStreamBody;
  await callModelStreaming("study", [{ role: "user", content: "Study schema" }], undefined, {
    responseFormat: schemaConfig,
    fetchImpl: async (_url, init) => {
      studyJsonSchemaStreamBody = JSON.parse(init.body);
      return sseStream([
        { choices: [{ delta: { content: '{"score":100,"label":"A"}' } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 6 } },
      ]);
    },
  });
  assert.deepEqual(studyJsonSchemaStreamBody.response_format, schemaConfig);
  assert.equal(studyJsonSchemaStreamBody.text, undefined, "Chat Completions API streaming must preserve response_format");
});

test("15. Backward-compatible Vulcan transport selection, isolation, and fail-closed policies", async () => {
  const testMessages = [{ role: "user", content: "Vulcan transport test" }];

  // 1. Default transport preserves existing router configuration (OpenRouter host, router key, data_collection: deny, allow_fallbacks: false)
  config.vesperTransport = "router";
  config.chatModels.vesper = "x-ai/grok-4.7";
  config.vesperDataPolicyVerified = false; // Works without direct privacy gate
  let routerRequestUrl = null;
  let routerRequestHeaders = null;
  let routerRequestBody = null;
  await callModelWithFallback("vesper", testMessages, undefined, {
    fetchImpl: async (url, init) => {
      routerRequestUrl = url;
      routerRequestHeaders = init.headers;
      routerRequestBody = JSON.parse(init.body);
      return Response.json({
        choices: [{ message: { content: "Router response OK" } }],
        usage: { prompt_tokens: 15, completion_tokens: 5 },
      });
    },
  });
  assert.equal(routerRequestUrl, `${ROUTER_BASE}/chat/completions`);
  assert.equal(routerRequestHeaders.Authorization, `Bearer ${ROUTER_KEY}`);
  assert.equal(routerRequestBody.model, "x-ai/grok-4.7");
  assert.deepEqual(routerRequestBody.provider, { allow_fallbacks: false, data_collection: "deny" });
  assert.equal(routerRequestBody.store, undefined);

  // 2. Preparing direct-model configuration (CHAT_MODEL_VESPER_DIRECT) does not change router behavior
  config.vesperTransport = "router";
  config.chatModels.vesper = "x-ai/grok-4.7";
  config.chatModels.vesperDirect = "gpt-6.1-terra";
  let preparedRouterBody = null;
  await callModelWithFallback("vesper", testMessages, undefined, {
    fetchImpl: async (_url, init) => {
      preparedRouterBody = JSON.parse(init.body);
      return Response.json({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
  });
  assert.equal(preparedRouterBody.model, "x-ai/grok-4.7", "Router transport continues using CHAT_MODEL_VESPER");
  assert.deepEqual(preparedRouterBody.provider, { allow_fallbacks: false, data_collection: "deny" });

  // 3. Direct transport denied without privacy approval
  config.vesperTransport = "direct";
  config.vesperDataPolicyVerified = false;
  let unapprovedCalls = 0;
  await assert.rejects(
    callModelWithFallback("vesper", testMessages, undefined, {
      fetchImpl: async () => { unapprovedCalls++; return Response.json({}); },
    }),
    (err) => err instanceof InferenceUnavailableError && err.status === 503,
  );
  await assert.rejects(
    callModelStreaming("vesper", testMessages, undefined, {
      fetchImpl: async () => { unapprovedCalls++; return Response.json({}); },
    }),
    (err) => err instanceof InferenceUnavailableError && err.status === 503,
  );
  assert.equal(unapprovedCalls, 0, "No outbound requests made when direct privacy policy is unapproved");

  // 3b. Missing, empty, or whitespace direct model fails closed with zero upstream requests (streaming & non-streaming)
  // even when CHAT_MODEL_VESPER is populated and the direct privacy gate is true
  for (const emptyModel of [undefined, "", "   "]) {
    config.vesperTransport = "direct";
    config.vesperDataPolicyVerified = true;
    config.chatModels.vesper = "x-ai/grok-4.7";
    config.chatModels.vesperDirect = emptyModel;
    let missingModelCalls = 0;
    await assert.rejects(
      callModelWithFallback("vesper", testMessages, undefined, {
        fetchImpl: async () => { missingModelCalls++; return Response.json({}); },
      }),
      (err) => err instanceof InferenceUnavailableError && err.status === 503,
    );
    await assert.rejects(
      callModelStreaming("vesper", testMessages, undefined, {
        fetchImpl: async () => { missingModelCalls++; return Response.json({}); },
      }),
      (err) => err instanceof InferenceUnavailableError && err.status === 503,
    );
    assert.equal(missingModelCalls, 0, `Zero upstream requests when direct model is ${JSON.stringify(emptyModel)}`);
  }

  // 4. Approved direct transport selects direct host, model, key, endpoint, and Responses format
  config.vesperTransport = "direct";
  config.vesperDataPolicyVerified = true;
  config.chatModels.vesperDirect = "gpt-6.1-terra";
  let directRequestUrl = null;
  let directRequestHeaders = null;
  let directRequestBody = null;
  await callModelWithFallback("vesper", testMessages, undefined, {
    fetchImpl: async (url, init) => {
      directRequestUrl = url;
      directRequestHeaders = init.headers;
      directRequestBody = JSON.parse(init.body);
      return Response.json({
        id: "resp_direct_1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Direct response OK" }] }],
        usage: { input_tokens: 20, output_tokens: 10 },
      });
    },
  });
  assert.equal(directRequestUrl, `${DIRECT_BASE}/responses`);
  assert.equal(directRequestHeaders.Authorization, `Bearer ${DIRECT_KEY}`);
  assert.equal(directRequestBody.model, "gpt-6.1-terra");
  assert.equal(directRequestBody.store, false);
  assert.equal(directRequestBody.provider, undefined);
  assert.ok(Array.isArray(directRequestBody.input));

  // 5. Invalid transport selection fails closed with 503
  for (const invalidTransport of ["invalid", "unknown", "legacy", "other"]) {
    config.vesperTransport = invalidTransport;
    let invalidCalls = 0;
    await assert.rejects(
      callModelWithFallback("vesper", testMessages, undefined, {
        fetchImpl: async () => { invalidCalls++; return Response.json({}); },
      }),
      (err) => err instanceof InferenceUnavailableError && err.status === 503,
    );
    await assert.rejects(
      callModelStreaming("vesper", testMessages, undefined, {
        fetchImpl: async () => { invalidCalls++; return Response.json({}); },
      }),
      (err) => err instanceof InferenceUnavailableError && err.status === 503,
    );
    assert.equal(invalidCalls, 0, `Invalid transport ${invalidTransport} made zero outbound calls`);
  }

  // 6. No silent cross-transport fallback
  // When direct fails, it does NOT fall back to router
  config.vesperTransport = "direct";
  config.vesperDataPolicyVerified = true;
  const contactedDirectUrls = [];
  await assert.rejects(
    callModelWithFallback("vesper", testMessages, undefined, {
      maxRetries: 0,
      fetchImpl: async (url) => {
        contactedDirectUrls.push(url);
        return new Response("Direct server error", { status: 500 });
      },
    }),
    (err) => err instanceof InferenceUnavailableError,
  );
  assert.ok(contactedDirectUrls.every((u) => u.startsWith(DIRECT_BASE)), "Direct failure never contacts router");

  // When router fails, it does NOT fall back to direct
  config.vesperTransport = "router";
  const contactedRouterUrls = [];
  await assert.rejects(
    callModelWithFallback("vesper", testMessages, undefined, {
      maxRetries: 0,
      fetchImpl: async (url) => {
        contactedRouterUrls.push(url);
        return new Response("Router server error", { status: 500 });
      },
    }),
    (err) => err instanceof InferenceUnavailableError,
  );
  assert.ok(contactedRouterUrls.every((u) => u.startsWith(ROUTER_BASE)), "Router failure never contacts direct");

  // 7. Existing policy checks remaining effective
  // Router retains data_collection: deny and allow_fallbacks: false
  config.vesperTransport = "router";
  let privacyGuardBody = null;
  await callModelWithFallback("vesper", testMessages, undefined, {
    fetchImpl: async (_url, init) => {
      privacyGuardBody = JSON.parse(init.body);
      return Response.json({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
  });
  assert.equal(privacyGuardBody.provider?.data_collection, "deny");
  assert.equal(privacyGuardBody.provider?.allow_fallbacks, false);
});
