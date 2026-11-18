/**
 * Connector reads through the real executeToolCall. The provider is a labeled
 * boundary double: nothing here reaches a real YouTube account or any network.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const adapterHref = new URL("../src/connectors/composio-adapter.js", import.meta.url).href;
const adapter = await import(adapterHref);
const providerCalls = [];
const provider = { respond: async () => ({ data: {} }) };
// youtube_search is left out of the map: the fixture for a capability with no live mapping.
const { youtube_search: _unmapped, ...slugMapWithoutSearch } = adapter.TOOL_SLUG_MAP;
mock.module(adapterHref, {
  namedExports: {
    COMPOSIO_TOOLKITS: adapter.COMPOSIO_TOOLKITS,
    TOOLKIT_METADATA: adapter.TOOLKIT_METADATA,
    TOOL_SLUG_MAP: slugMapWithoutSearch,
    COMPOSIO_AUTH_TRUSTED_HOSTS: adapter.COMPOSIO_AUTH_TRUSTED_HOSTS,
    uploadComposioFile: adapter.uploadComposioFile,
    checkComposioFilesAccess: adapter.checkComposioFilesAccess,
    accountBelongsToUser: adapter.accountBelongsToUser,
    accountGrantedToUser: adapter.accountGrantedToUser,
    isComposioConfigured: adapter.isComposioConfigured,
    computePayloadHash: adapter.computePayloadHash,
    isTrustedComposioRedirectUrl: adapter.isTrustedComposioRedirectUrl,
    listAllComposioConnections: adapter.listAllComposioConnections,
    initiateComposioConnection: adapter.initiateComposioConnection,
    checkComposioAccountStatus: adapter.checkComposioAccountStatus,
    revokeComposioConnection: adapter.revokeComposioConnection,
    sanitizeProviderError: adapter.sanitizeProviderError,
    interpretComposioExecution: adapter.interpretComposioExecution,
    executeComposioTool: async (args) => {
      providerCalls.push({ toolSlug: args.toolSlug, userId: args.userId, boundary: "provider-double" });
      return provider.respond(args);
    },
  },
});

const { createIsolatedAuthFixture } = await import("./helpers/auth-test-harness.js");
const { connectUserConnector } = await import("../src/connectors/service.js");
const { executeToolCall } = await import("../src/chat/router.js");

const CHANNEL = { name: "youtube_get_my_channel", arguments: {} };
const fail = (message, fields = {}) => async () => { throw Object.assign(new Error(message), fields); };

async function connectedUser(email) {
  const fixture = await createIsolatedAuthFixture({ email });
  await connectUserConnector(fixture.user.id, "youtube", { accessToken: "tok_youtube_test", scopes: [], metadata: { accountId: "acct_fixture_connector_read_failures_1" } });
  return fixture.user.id;
}

test("success: the provider's channel data reaches the model, for the signed-in user", async () => {
  const userId = await connectedUser("yt-success@example.com");
  providerCalls.length = 0;
  provider.respond = async () => ({ data: { items: [{ id: "UC_fixture", snippet: { title: "Fixture Channel" } }] } });
  const result = await executeToolCall(CHANNEL, "what's my YouTube channel's name?", { userId });
  assert.equal(result.kind, "youtube");
  assert.match(result.content, /Fixture Channel/);
  assert.deepEqual(providerCalls, [{ toolSlug: "youtube_get_my_channel", userId, boundary: "provider-double" }]);
});

test("each failure reaches the model as its own reason, with no provider text in it or in the log", async (t) => {
  const userId = await connectedUser("yt-failures@example.com");
  const logs = [];
  t.mock.method(console, "warn", (line) => logs.push(String(line)));
  const SECRET = "ya29.SECRETTOKENVALUE and private-channel-title";
  const cases = [
    ["authorization_expired", fail(`401 Unauthorized: invalid_grant ${SECRET}`, { logId: "log_a" }), /expired or was revoked/],
    ["permission", fail(`403 insufficient authentication scopes ${SECRET}`, { logId: "log_b" }), /current permissions/],
    ["bad_arguments", fail(`Invalid request data ${SECRET}`, { code: "schema_rejected", logId: "log_c" }), /rejected this request as malformed/],
    ["timeout", fail("This operation was aborted", { name: "AbortError" }), /did not respond in time/],
    ["provider_failure", fail(`Composio MCP error (500): ${SECRET}`, { logId: "log_d" }), /failed while reading/],
  ];
  for (const [failure, respond, said] of cases) {
    provider.respond = respond;
    const result = await executeToolCall(CHANNEL, "what's my YouTube channel's name?", { userId, requestId: `req-${failure}` });
    assert.equal(result.kind, "connector_error", failure);
    assert.equal(result.failure, failure);
    assert.match(result.content, said, failure);
    assert.doesNotMatch(result.content, /SECRETTOKEN|private-channel-title|Composio/, `${failure}: nothing raw reaches the model`);
  }
  const events = logs.filter((line) => line.includes("connector_read_failed")).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.failure), cases.map(([failure]) => failure));
  assert.equal(events[0].logId, "log_a", "the provider's log id is kept for diagnosis");
  assert.deepEqual(events.map((event) => event.requestId), cases.map(([failure]) => `req-${failure}`), "each failure can be tied to the chat request it happened in, so its usage accounting can be checked separately");
  assert.doesNotMatch(logs.join("\n"), /SECRETTOKEN|private-channel-title|tok_youtube_test/, "no credential or account data in the log");
});

test("not connected: the user is told, and the provider is never called", async () => {
  const fixture = await createIsolatedAuthFixture({ email: "yt-unconnected@example.com" });
  providerCalls.length = 0;
  const result = await executeToolCall(CHANNEL, "what's my YouTube channel's name?", { userId: fixture.user.id });
  assert.equal(result.kind, "connector_notice");
  assert.match(result.content, /YouTube/);
  assert.deepEqual(providerCalls, []);
});

test("missing capability: a tool with no live mapping says so, and the provider is never called", async () => {
  const userId = await connectedUser("yt-unmapped@example.com");
  providerCalls.length = 0;
  const result = await executeToolCall({ name: "youtube_search", arguments: { q: "x" } }, "search", { userId });
  assert.equal(result.kind, "connector_notice");
  assert.match(result.content, /not mapped for live execution/);
  assert.deepEqual(providerCalls, []);
});
