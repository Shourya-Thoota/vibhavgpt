/**
 * Extensions end to end: the chat router's real tool execution, the real provider adapter, a real isolated database, and a stand-in for the
 * provider's gateway reached over real HTTP. Nothing here touches a real account or the network beyond 127.0.0.1.
 *
 * The existing connector tests replace the adapter's executeComposioTool, so the request builder and the response parser were never run
 * together. These tests do, and they are written around a failure seen in production: a connected YouTube account whose channel and
 * playlist reads are rejected, after which the assistant says "try again in a moment" with no reason and no next step.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

// ---- The stand-in gateway ---------------------------------------------------------------------------------------------------------------
const received = [];
const gateway = { handle: () => ({}) };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const rpc = JSON.parse(body || "{}");
    const call = rpc.params?.arguments ?? {};
    received.push({ url: req.url, tool: rpc.params?.name, arguments: call });
    const envelope = gateway.handle(rpc.params?.name, call);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
process.env.COMPOSIO_API_KEY = "ck_test_gateway_key_not_a_real_key";
test.after(() => { server.closeAllConnections?.(); server.close(); });

const { createIsolatedAuthFixture } = await import("./helpers/auth-test-harness.js");
const { connectUserConnector, getConnectorsSummary } = await import("../src/connectors/service.js");
const { executeToolCall } = await import("../src/chat/router.js");

const ACCOUNT = "youtube_test-account";
const CHANNEL = { name: "youtube_get_my_channel", arguments: {} };
const PLAYLISTS = { name: "youtube_list_playlists", arguments: {} };
const executions = () => received.filter((r) => r.tool === "COMPOSIO_MULTI_EXECUTE_TOOL");
const reset = () => { received.length = 0; };

const ok = (data) => ({ successful: true, data: { results: [{ tool_slug: "X", index: 0, response: { successful: true, data } }] }, log_id: "log_ok" });
// A failed execution, the way the gateway wraps it: a batch summary on top, the real reason inside the item.
const failed = (inner) => ({ successful: false, error: "1 out of 1 tools failed", data: { results: [{ tool_slug: "X", index: 0, response: { successful: false, ...inner } }] }, log_id: "log_fail" });
const live = (accounts) => ({ successful: true, data: { results: { youtube: { accounts } } } });

async function connectedUser(email, { accountId = ACCOUNT } = {}) {
  const fixture = await createIsolatedAuthFixture({ email });
  await connectUserConnector(fixture.user.id, "youtube", {
    accessToken: `comp_live_${accountId}`,
    scopes: [],
    metadata: {
      id: accountId, accountId, status: "active", accountName: accountId,
      // What the provider returned for the account at connect time: a raw channel response, not a name or an email.
      user_info: { kind: "youtube#channelListResponse", etag: "etag-secret-ish", items: [{ id: "UC_internal_id", snippet: { title: "Fixture Channel" } }] },
    },
  });
  return fixture.user.id;
}

function captureLogs(t) {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(String(line)));
  return lines;
}

// ---- 1. Success reaches the model, through the real adapter -----------------------------------------------------------------------------

test("a successful read reaches the model, runs once, and uses the account that was verified", async () => {
  const userId = await connectedUser("e2e-success@example.com");
  reset();
  gateway.handle = () => ok({ items: [{ id: "UC1", snippet: { title: "Fixture Channel" }, statistics: { subscriberCount: "12" } }] });
  const result = await executeToolCall(CHANNEL, "what is my channel called?", { userId });
  assert.equal(result.kind, "youtube");
  assert.match(result.content, /Fixture Channel/);
  assert.equal(executions().length, 1, "one call, not a retry loop");
  const sent = executions()[0].arguments.tools[0];
  assert.equal(sent.tool_slug, "YOUTUBE_LIST_CHANNELS");
  assert.deepEqual(sent.arguments, { mine: true, part: "snippet,statistics" });
  assert.equal(sent.account, ACCOUNT, "the call names the connected account that was verified, as the Drive approval path already does");
  assert.ok(executions()[0].url.includes(`user_id=${userId}`), "and is scoped to the signed-in user");
});

test("good data is never altered by the wording filters: vendor-like words in a title survive", async () => {
  const userId = await connectedUser("e2e-words@example.com");
  reset();
  gateway.handle = () => ok({ items: [{ id: "UC2", snippet: { title: "Composio Tutorials by OpenAI fans" } }] });
  const result = await executeToolCall(CHANNEL, "name?", { userId });
  assert.match(result.content, /Composio Tutorials by OpenAI fans/, "a real result is the user's data, not ours to rewrite");
});

// ---- 2. Real reasons are found wherever the gateway puts them ---------------------------------------------------------------------------

const REASONS = [
  ["permission (error object, Google style)", failed({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } }), "permission", /current permissions/],
  ["sign-in expired (message under data)", failed({ data: { message: "Token has been expired or revoked.", status_code: 401 } }), "authorization_expired", /expired or was revoked/],
  ["not connected at the provider", failed({ data: { message: "No connected account found for toolkit youtube" } }), "authorization_expired", /reconnect/i],
  ["bad arguments (message under data)", failed({ data: { message: "Invalid request data provided: missing required parameter part" } }), "bad_arguments", /malformed/],
  ["quota (error object)", failed({ error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] } }), "quota", /usage limit/i],
  ["rate limit (status only)", failed({ data: { status_code: 429 } }), "quota", /usage limit/i],
  ["provider outage (status only)", failed({ data: { status_code: 503 } }), "provider_failure", /failed while reading/],
];

for (const [label, envelope, category, said] of REASONS) {
  test(`reason found and reported distinctly: ${label}`, async (t) => {
    const userId = await connectedUser(`e2e-${category}-${label.length}@example.com`);
    const logs = captureLogs(t);
    reset();
    gateway.handle = (tool) => (tool === "COMPOSIO_MANAGE_CONNECTIONS" ? live([{ id: ACCOUNT, status: "active", is_default: true }]) : envelope);
    const result = await executeToolCall(CHANNEL, "q", { userId });
    assert.equal(result.kind, "connector_error");
    assert.equal(result.failure, category, label);
    assert.match(result.content, said);
    assert.equal(executions().length, 1, "no repeated provider call");
    const logged = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "connector_read_failed");
    assert.equal(logged.failure, category);
    for (const line of logs) assert.doesNotMatch(line, /insufficient authentication|expired or revoked|No connected account|exceeded your quota|Invalid request data/, "provider wording stays out of the logs");
  });
}

test("a quota failure is not blamed on the account and does not send the user to reconnect", async () => {
  const userId = await connectedUser("e2e-quota-words@example.com");
  reset();
  gateway.handle = () => failed({ error: { code: 403, errors: [{ reason: "quotaExceeded" }], message: "quota" } });
  const result = await executeToolCall(CHANNEL, "q", { userId });
  assert.doesNotMatch(result.content, /tell the user to reconnect/i, "no instruction to reconnect");
  assert.match(result.content, /reconnecting will not help/i, "and it says outright that reconnecting is not the fix");
  assert.match(result.content, /not a problem with the user's account/i);
});

// ---- 3. A deterministic failure is never presented as temporary --------------------------------------------------------------------------

test("a failure with no readable reason says so honestly: no promise that waiting will fix it, and a reference to give support", async () => {
  const userId = await connectedUser("e2e-unknown@example.com");
  reset();
  gateway.handle = (tool) => (tool === "COMPOSIO_MANAGE_CONNECTIONS" ? live([{ id: ACCOUNT, status: "active", is_default: true }]) : { successful: false, error: "1 out of 1 tools failed", data: { results: [] }, log_id: "log_x" });
  const result = await executeToolCall(CHANNEL, "q", { userId, requestId: "req-ref-123" });
  assert.equal(result.failure, "provider_failure");
  assert.doesNotMatch(result.content, /try again in a moment|can try again/i, "we do not know that a retry helps");
  assert.match(result.content, /could not identify the cause/i);
  assert.match(result.content, /req-ref-123/, "our own request reference, which support can look up");
  assert.doesNotMatch(result.content, /log_x/, "the provider's id is not shown");
  assert.equal(executions().length, 1);
});

test("the log records what shape the provider's failure had, without any of its text", async (t) => {
  const userId = await connectedUser("e2e-shape@example.com");
  const logs = captureLogs(t);
  reset();
  gateway.handle = () => failed({ error: { code: 400, message: "private-channel-title is not allowed", errors: [{ reason: "badRequest" }] } });
  await executeToolCall(CHANNEL, "q", { userId });
  const logged = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "connector_read_failed");
  assert.ok(logged.envelope, "an envelope description is logged");
  assert.equal(logged.envelope.reasonFound, true);
  assert.equal(logged.httpStatus, 400);
  assert.equal(logged.reason, "badRequest", "only a known Google reason token, never free text");
  for (const line of logs) assert.doesNotMatch(line, /private-channel-title/);
});

// ---- 4. The status stays true ------------------------------------------------------------------------------------------------------------

test("when the provider says the account is not connected, the connection stops claiming to be", async () => {
  const userId = await connectedUser("e2e-status@example.com");
  reset();
  gateway.handle = (tool) => (tool === "COMPOSIO_MANAGE_CONNECTIONS" ? live([]) : failed({ data: { message: "No connected account found for toolkit youtube" } }));
  const result = await executeToolCall(CHANNEL, "q", { userId });
  assert.match(result.content, /reconnect/i);
  const youtube = (await getConnectorsSummary(userId)).find((c) => c.id === "youtube");
  assert.equal(youtube.status, "needs_reconnect");
  assert.match(youtube.blockerNotice, /reconnect/i);
  // The next request does not call the provider again for a connection already known to be gone.
  reset();
  const again = await executeToolCall(CHANNEL, "q", { userId });
  assert.equal(executions().length, 0);
  assert.match(again.content, /reconnect|not connected/i);
});

test("an unexplained failure on an account the provider still lists as active does not change the connection", async () => {
  const userId = await connectedUser("e2e-keeps@example.com");
  reset();
  gateway.handle = (tool) => (tool === "COMPOSIO_MANAGE_CONNECTIONS" ? live([{ id: ACCOUNT, status: "active", is_default: true }]) : failed({ data: { status_code: 503 } }));
  await executeToolCall(CHANNEL, "q", { userId });
  const youtube = (await getConnectorsSummary(userId)).find((c) => c.id === "youtube");
  assert.equal(youtube.status, "connected");
});

// ---- 5. What the browser is shown ---------------------------------------------------------------------------------------------------------

test("the connector list shows the channel's own name, never the internal account alias or the provider's raw payload", async () => {
  const userId = await connectedUser("e2e-display@example.com", { accountId: "youtube_instep-graip" });
  const youtube = (await getConnectorsSummary(userId)).find((c) => c.id === "youtube");
  assert.equal(youtube.metadata.accountLabel, "Fixture Channel");
  const shown = JSON.stringify(youtube);
  assert.doesNotMatch(shown, /instep-graip/, "the alias is internal");
  assert.doesNotMatch(shown, /youtube#channelListResponse|etag-secret-ish|UC_internal_id/, "no raw provider payload reaches the browser");
});

// ---- 6. Capability limits are stated, not discovered by failing ----------------------------------------------------------------------------

test("YouTube's tools say what they cannot do, so the model does not call one that cannot answer", async () => {
  const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
  const channel = CHAT_TOOLS.find((tool) => tool.function.name === "youtube_get_my_channel").function.description;
  assert.match(channel, /cannot list videos|does not list videos|not .*videos/i);
});
