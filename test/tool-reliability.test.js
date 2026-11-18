import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_SLUG_MAP,
  TOOL_ARGUMENT_ALLOWLIST,
  TOOLKIT_METADATA,
  pickToolArguments,
  interpretComposioExecution,
  sanitizeProviderError,
  serviceNameForSlug,
} from "../src/connectors/composio-adapter.js";
import { TOOL_TO_CONNECTOR_MAP, WRITE_MUTATION_TOOLS } from "../src/connectors/service.js";
import { classifyToolFailure, toolFailureContent } from "../src/connectors/tool-failure.js";
import { connectorResultContent, unwrapProviderData, CONNECTOR_RESULT_LIMIT } from "../src/connectors/tool-result.js";
import { CHAT_TOOLS } from "../src/chat/tool-calls.js";
import { liveStatusLabel } from "../frontend/src/live-status.js";
import { failureText, serviceName } from "../frontend/src/components/action-failure-copy.js";

// Fixture provider route, as the other stream tests set it up. No network is used:
// every request goes to the in-test fetch below.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
const { config } = await import("../src/config.js");
config.providerKeys.primaryFree = "";
config.providerKeys.paid = "fixture-key";
config.chatModels.nova = "fixture-nova";
const { callModelStreaming, reasoningDisplay, MODEL_CONFIGS } = await import("../src/chat/providers.js");

// ---- Capability: the connected account's own channel -----------------------

test("YouTube has a channel-identity read, mapped to the documented channel listing", () => {
  assert.equal(TOOL_SLUG_MAP.youtube_get_my_channel, "YOUTUBE_LIST_CHANNELS");
  assert.equal(TOOL_TO_CONNECTOR_MAP.youtube_get_my_channel, "youtube");
  assert.equal(WRITE_MUTATION_TOOLS.has("youtube_get_my_channel"), false, "a read, no approval card");
  assert.ok(TOOLKIT_METADATA.youtube.readActions.includes("youtube_get_my_channel"));
  assert.ok(TOOL_ARGUMENT_ALLOWLIST.youtube_get_my_channel);
  const tool = CHAT_TOOLS.find((entry) => entry.function.name === "youtube_get_my_channel");
  assert.ok(tool, "the model is offered it");
  assert.deepEqual(tool.function.parameters.properties, {}, "the model supplies no arguments");
});

test("the channel read always asks for the connected account's own channel, whatever the model sends", () => {
  assert.deepEqual(pickToolArguments("youtube_get_my_channel", {}), { mine: true, part: "snippet,statistics" });
  assert.deepEqual(
    pickToolArguments("youtube_get_my_channel", { mine: false, id: "UCsomeoneelse", forHandle: "@other", query: "x" }),
    { mine: true, part: "snippet,statistics" },
    "another channel cannot be requested through this action",
  );
});

test("playlists and search keep their own arguments (no regression)", () => {
  assert.deepEqual(pickToolArguments("youtube_list_playlists", { maxResults: 5, mine: true }), { maxResults: 5 });
  assert.deepEqual(pickToolArguments("youtube_search", { q: "lumen", mine: true }), { q: "lumen" });
});

// ---- Execution envelope and failure classes --------------------------------

const envelope = (item) => ({ data: { results: [item] } });

test("a successful channel response is returned as data", () => {
  const out = interpretComposioExecution(envelope({
    response: { successful: true, data: { items: [{ id: "UC_test", snippet: { title: "Test Channel" } }] } },
    log_id: "log_ok",
  }), { slug: "YOUTUBE_LIST_CHANNELS" });
  assert.equal(out.ok, true);
  assert.equal(out.data.items[0].snippet.title, "Test Channel");
  assert.equal(out.logId, "log_ok");
});

test("provider rejections are classified into distinct failure types", () => {
  const rejected = (message) => interpretComposioExecution(envelope({ response: { successful: false, error: message }, log_id: "log_x" }), { slug: "YOUTUBE_LIST_CHANNELS" });

  // Bad arguments: carries the schema_rejected code from the interpreter.
  const schema = rejected("Invalid request data provided: missing required parameter");
  assert.equal(schema.ok, false);
  assert.equal(schema.code, "schema_rejected");
  assert.equal(classifyToolFailure({ code: schema.code, message: schema.message }), "bad_arguments");

  // Authorization expired, and missing permission, are different things.
  assert.equal(classifyToolFailure(new Error("401 Unauthorized: invalid_grant, token has been expired or revoked")), "authorization_expired");
  assert.equal(classifyToolFailure(new Error("403 Request had insufficient authentication scopes")), "permission");
  assert.equal(classifyToolFailure(new Error("Forbidden: caller lacks permission")), "permission");

  // Timeout and unidentifiable provider failure.
  assert.equal(classifyToolFailure(new Error("Request timed out after 30000 ms")), "timeout");
  assert.equal(classifyToolFailure(Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" })), "timeout");
  assert.equal(classifyToolFailure(new Error("Internal error from upstream")), "provider_failure");
  assert.equal(classifyToolFailure(Object.assign(new Error("odd"), { code: "provider_rejected" })), "provider_failure");
});

test("failures reconnecting cannot fix are never reported as an account problem", () => {
  // A usage limit is its own category now (not the generic bucket), and is still never an account problem.
  for (const message of ["403 quotaExceeded: The request cannot be completed because you have exceeded your quota", "429 rate limit reached"]) {
    const category = classifyToolFailure(new Error(message));
    assert.equal(category, "quota", message);
    assert.ok(!["permission", "authorization_expired"].includes(category), "reconnecting cannot fix a usage limit");
  }
  assert.equal(classifyToolFailure(new Error("Composio MCP error (401): bad consumer key")), "provider_failure", "the platform key, not the user's sign-in");
  assert.equal(classifyToolFailure(new Error("Composio tool execution failed (403): denied")), "provider_failure");
});

test("a batch summary with no specific error classifies as a plain provider failure", () => {
  const out = interpretComposioExecution({ error: "1 out of 1 tools failed", data: { results: [] } }, { slug: "YOUTUBE_LIST_CHANNELS" });
  assert.equal(out.ok, false);
  // Known gap kept visible: the batch text is rewritten with a Drive-specific
  // sentence by sanitizeProviderError. It must at least classify as a plain
  // provider failure, never as a permission or expiry problem.
  assert.equal(classifyToolFailure({ code: out.code, message: out.message }), "provider_failure");
});

test("what the model is told for each failure is true, names the service, and leaks no provider text", () => {
  for (const category of ["permission", "authorization_expired", "bad_arguments", "timeout", "quota", "provider_failure"]) {
    const text = toolFailureContent(category, "YouTube");
    assert.match(text, /YouTube/);
    assert.match(text, /do not say the account has no such data/i, `${category} forbids claiming the data is absent`);
    assert.doesNotMatch(text, /composio|openrouter|ya29|ck_|Bearer/i);
  }
  assert.match(toolFailureContent("authorization_expired", "YouTube"), /reconnect/i);
  assert.match(toolFailureContent("permission", "YouTube"), /reconnect/i);
  assert.doesNotMatch(toolFailureContent("timeout", "YouTube"), /reconnect/i, "a timeout is not fixed by reconnecting");
  assert.doesNotMatch(toolFailureContent("bad_arguments", "YouTube"), /reconnect/i, "malformed requests are not the user's connection");
  assert.doesNotMatch(toolFailureContent("provider_failure", "YouTube"), /reconnect/i);
});

// ---- Streaming: raw thinking is activity only, summaries only when verified --

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks) => new Response(chunks.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
const stop = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };

async function stream(chunks) {
  const thought = [];
  const reply = [];
  let signals = 0;
  const { data } = await callModelStreaming("nova", [{ role: "user", content: "hi" }], undefined, {
    onDelta: (text) => { reply.push(text); return true; },
    onReasoning: (text) => thought.push(text),
    onThinking: () => { signals += 1; },
    fetchImpl: async (url) => (String(url).includes("/generation") ? new Response("{}", { status: 404 }) : sse([...chunks, stop])),
  });
  return { thought: thought.join(""), reply: reply.join(""), signals, data };
}

test("every raw form of thinking is activity only: never text, so never shown twice", async () => {
  const { thought, signals, reply, data } = await stream([
    // The same words as a string and again inside details, then every other raw form.
    { choices: [{ delta: { reasoning: "Checking the units. ", reasoning_details: [{ type: "reasoning.text", text: "Checking the units. " }] } }] },
    { choices: [{ delta: { reasoning_content: "RAW-CONTENT", thought: "RAW-THOUGHT", thinking: "RAW-THINKING" } }] },
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "OPAQUE" }] } }] },
    { choices: [{ delta: { content: "Ten." } }] },
  ]);
  assert.equal(thought, "", "no reasoning text is relayed on a route with no verified summary");
  assert.equal(signals, 3, "one activity signal per thinking chunk");
  assert.equal(reply, "Ten.");
  assert.doesNotMatch(JSON.stringify(data), /Checking the units|RAW-|OPAQUE/, "none of it is in the saved message either");
});

test("a reasoning.summary is also withheld unless its route is verified for display", async () => {
  const { thought, signals } = await stream([
    { choices: [{ delta: { reasoning_details: [{ type: "reasoning.summary", summary: "Summary text." }] } }] },
    { choices: [{ delta: { content: "A" } }] },
  ]);
  assert.equal(thought, "", "reasoning_details is not assumed to be a safe summary");
  assert.equal(signals, 1);
});

test("a route marked displayable shows its summary once, and still never the raw text beside it", async (t) => {
  const entry = MODEL_CONFIGS.nova.chain[0];
  entry.displayableReasoningSummary = true;
  t.after(() => { delete entry.displayableReasoningSummary; });
  const { thought, signals } = await stream([
    { choices: [{ delta: { reasoning: "RAW-STRING ", reasoning_details: [{ type: "reasoning.text", text: "RAW-DETAIL " }, { type: "reasoning.summary", summary: "Checking units. " }] } }] },
    { choices: [{ delta: { reasoning: "RAW-AGAIN", reasoning_details: [{ type: "reasoning.summary", summary: "Then the sum." }] } }] },
    { choices: [{ delta: { content: "Ten." } }] },
  ]);
  assert.equal(thought, "Checking units. Then the sum.");
  assert.equal(signals, 0, "chunks whose summary was shown need no separate signal");
});

test("each wire field is classified by its contract, and only a verified route's summaries are shown", () => {
  const verified = { displayableReasoningSummary: true };
  const unverified = {};
  for (const field of ["chat.reasoning", "chat.reasoning_content", "chat.reasoning_details.text", "chat.reasoning_details.encrypted", "responses.reasoning_text"]) {
    assert.equal(reasoningDisplay(verified, field), "activity", `${field} is never shown, even on a verified route`);
    assert.equal(reasoningDisplay(unverified, field), "activity", field);
  }
  for (const field of ["chat.reasoning_details.summary", "responses.reasoning_summary_text"]) {
    assert.equal(reasoningDisplay(unverified, field), "activity", `${field} needs a verified route`);
    assert.equal(reasoningDisplay(verified, field), "show", field);
  }
  for (const key of ["lumen", "nova", "nebula", "vesper"]) {
    for (const entry of MODEL_CONFIGS[key].chain) assert.notEqual(entry.displayableReasoningSummary, true, `${key}: no route is verified for summary display today`);
  }
});

// ---- Error attribution and redaction ----------------------------------------

test("a batch failure is attributed to the service it came from, never to Google Drive by default", () => {
  const batch = "1 out of 1 tools failed";
  assert.equal(sanitizeProviderError(batch, { service: "YouTube" }), "YouTube rejected the request before it confirmed a result.");
  assert.equal(sanitizeProviderError(batch, { service: "GitHub" }), "GitHub rejected the request before it confirmed a result.");
  assert.equal(sanitizeProviderError(batch), "The service rejected the request before it confirmed a result.", "unknown service: no service is named");
  assert.equal(sanitizeProviderError(batch, { service: "Google Drive" }), "Google Drive rejected the upload before it confirmed a file.", "Drive keeps its exact wording");
  for (const [slug, service] of [["YOUTUBE_LIST_CHANNELS", "YouTube"], ["GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", "Google Drive"], ["GITHUB_CREATE_ISSUE", "GitHub"], ["youtube_get_my_channel", "YouTube"]]) {
    assert.equal(serviceNameForSlug(slug), service, slug);
  }
  assert.equal(serviceNameForSlug("TOTALLY_UNKNOWN_TOOL"), null);
  assert.equal(serviceNameForSlug("constructor_x"), null, "inherited object keys are not services");
  assert.equal(serviceNameForSlug(undefined), null);
});

test("the batch summary reaches the model-facing message with the right service for each slug", () => {
  const rejected = (slug) => interpretComposioExecution({ error: "1 out of 1 tools failed", data: { results: [] } }, { slug });
  assert.match(rejected("YOUTUBE_LIST_CHANNELS").message, /^YouTube rejected the request/);
  assert.doesNotMatch(rejected("YOUTUBE_LIST_CHANNELS").message, /Drive/);
  assert.match(rejected("GOOGLEDRIVE_CREATE_FILE_FROM_TEXT").message, /^Google Drive rejected the upload/);
});

test("the approval card names the right service for a batch failure, and Drive keeps its wording", () => {
  const batch = (toolName) => failureText({ toolName, result: { error: "1 out of 1 tools failed" } });
  assert.equal(batch("google_drive_upload_file"), "Google Drive rejected the upload before it confirmed a file. This approval cannot be run again. Ask again if you still want the file created.");
  assert.match(batch("youtube_get_my_channel"), /^YouTube rejected the request before it confirmed a result\./);
  assert.match(batch("github_create_issue"), /^GitHub rejected the request/);
  assert.match(batch("something_unmapped"), /^The service rejected the request/);
  for (const toolName of ["youtube_get_my_channel", "github_create_issue", "something_unmapped", undefined]) {
    assert.doesNotMatch(batch(toolName), /Drive|the file created/, `${toolName}: no Drive wording for another service`);
  }
  assert.equal(failureText({ result: { error: "Specific provider reason." } }), "Specific provider reason.", "a specific reason is shown as it is");
  assert.doesNotMatch(failureText({}), /Drive|the file created/, "the empty fallback is not Drive wording");
  assert.equal(serviceName("youtube_get_my_channel"), "YouTube");
});

test("provider errors are still redacted and bounded", () => {
  const secrets = ["ck_abcdefghijklmnop", "sk_live1234567890", "ya29.A0ARrdaMsecretvalue", "Bearer abcdefghijklmnopqrst"];
  for (const secret of secrets) {
    const out = sanitizeProviderError(`upstream said no: ${secret} for the request`, { service: "YouTube" });
    assert.ok(out.includes("[redacted]"), secret);
    assert.ok(!out.includes(secret.split(/[ .]/).at(-1)), `${secret} is gone`);
  }
  assert.equal(sanitizeProviderError("a\n\n   b\t c"), "a b c", "whitespace is flattened");
  assert.equal(sanitizeProviderError("x".repeat(1000)).length, 300);
  assert.equal(sanitizeProviderError(""), "The action failed.");
});

// ---- How the channel answer reaches the model --------------------------------

const CHANNEL_ITEMS = { kind: "youtube#channelListResponse", items: [{ id: "UC_fixture", snippet: { title: "Fixture Channel", customUrl: "@fixturechannel" }, statistics: { subscriberCount: "42" } }] };

test("the channel title reaches the model whether the provider's data is an object or a JSON string", () => {
  // Object data: interpretComposioExecution returns it as it is.
  const asObject = interpretComposioExecution(envelope({ response: { successful: true, data: CHANNEL_ITEMS } }), { slug: "YOUTUBE_LIST_CHANNELS" });
  assert.equal(asObject.ok, true);
  const objectContent = connectorResultContent(asObject.data, "YouTube");
  assert.match(objectContent, /"title": "Fixture Channel"/);

  // String data, as the Composio docs type `data`: the envelope is returned, and
  // the model still reads real JSON, not JSON escaped inside a string.
  const asString = interpretComposioExecution(envelope({ response: { successful: true, data: JSON.stringify(CHANNEL_ITEMS) } }), { slug: "YOUTUBE_LIST_CHANNELS" });
  assert.equal(asString.ok, true);
  assert.equal(typeof asString.data.data, "string", "the interpreter does not parse it");
  const stringContent = connectorResultContent(asString.data, "YouTube");
  assert.match(stringContent, /"title": "Fixture Channel"/);
  assert.doesNotMatch(stringContent, /\\"title\\"/, "not double-escaped");
});

test("tool results other than JSON strings are passed through untouched, and large ones are capped", () => {
  assert.equal(connectorResultContent("plain text", "YouTube"), "plain text");
  assert.deepEqual(unwrapProviderData({ data: "not json {" }), { data: "not json {" });
  assert.deepEqual(unwrapProviderData({ data: "42" }), { data: "42" }, "a bare number string is not unwrapped");
  assert.deepEqual(unwrapProviderData({ data: { a: 1 } }), { data: { a: 1 } });
  assert.deepEqual(unwrapProviderData([1, 2]), [1, 2]);
  assert.equal(connectorResultContent({ big: "z".repeat(50_000) }, "YouTube").length, CONNECTOR_RESULT_LIMIT);
  assert.equal(connectorResultContent("", "YouTube"), "YouTube returned an empty result.");
});


// ---- Activity labels follow real steps --------------------------------------

test("connector labels name the service and the step that was reported, nothing more", () => {
  assert.equal(liveStatusLabel({ phase: "connector_reading", service: "YouTube" }), "Reading from YouTube...");
  assert.equal(liveStatusLabel({ phase: "connector_done", service: "YouTube" }), "Got a response from YouTube. Writing the reply...");
  assert.equal(liveStatusLabel({ phase: "connector_failed", service: "YouTube" }), "Could not read from YouTube. Writing the reply...");
  // No service name: no claim about any service is made.
  for (const phase of ["connector_reading", "connector_done", "connector_failed"]) {
    assert.match(liveStatusLabel({ phase, seconds: 2 }), /^Thinking\.\.\./, phase);
  }
  for (const phase of ["connector_reading", "connector_done", "connector_failed"]) {
    assert.doesNotMatch(liveStatusLabel({ phase, service: "YouTube" }), /connected|completed|—/i, "no unsupported state words or em dashes");
  }
});
