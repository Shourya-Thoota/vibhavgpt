/**
 * Approved actions end to end: the real approval service, the real provider adapter, an isolated database, and a stand-in for the
 * provider's gateway over real HTTP on 127.0.0.1. Nothing reaches a real account.
 *
 * What is proven: the exact arguments the user approved are what the provider receives, once, for the account that was connected; a
 * concurrent double approval, a discarded action and a tampered one never produce a second or an unapproved write; and a failed write
 * is reported in the product's words and is not retried on its own.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const received = [];
const gateway = { handle: () => ({}), delayMs: 0 };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const rpc = JSON.parse(body || "{}");
    const call = rpc.params?.arguments ?? {};
    received.push({ url: req.url, tool: rpc.params?.name, arguments: call });
    if (gateway.delayMs) await new Promise((resolve) => setTimeout(resolve, gateway.delayMs));
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
const { connectUserConnector, createPendingAction, approveAndExecuteAction, discardAction, getActionForUser } = await import("../src/connectors/service.js");
const { TOOL_SLUG_MAP } = await import("../src/connectors/composio-adapter.js");

const ACCOUNT = "googledocs_test-account";
const executions = () => received.filter((r) => r.tool === "COMPOSIO_MULTI_EXECUTE_TOOL");
const reset = () => { received.length = 0; gateway.delayMs = 0; };
const created = () => ({ successful: true, data: { results: [{ tool_slug: "GOOGLEDOCS_CREATE_DOCUMENT", response: { successful: true, data: { id: "doc_123", title: "Roadmap" } } }] }, log_id: "log_ok" });

async function userWithDocs(email) {
  const fixture = await createIsolatedAuthFixture({ email });
  await connectUserConnector(fixture.user.id, "googledocs", { accessToken: `comp_live_${ACCOUNT}`, scopes: [], metadata: { id: ACCOUNT, accountId: ACCOUNT, status: "active" } });
  return fixture.user.id;
}
const approvedPayload = { title: "Roadmap", content: "Q1: ship the thing.\nQ2: measure it." };
const propose = (userId, payload = approvedPayload) => createPendingAction({ userId, toolName: "google_docs_create_document", actionDescription: "Create Google Doc 'Roadmap'", payload });

test("an approved write sends exactly the approved arguments, once, for the connected account", async () => {
  const userId = await userWithDocs("act-exact@example.com");
  reset();
  gateway.handle = created;
  const pending = await propose(userId);
  const done = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(done.status, "completed");
  assert.equal(executions().length, 1, "one write");
  const sent = executions()[0].arguments.tools[0];
  assert.equal(sent.tool_slug, TOOL_SLUG_MAP.google_docs_create_document);
  assert.equal(sent.arguments.title, approvedPayload.title, "the approved title, unchanged");
  assert.equal(sent.arguments.markdown_text, approvedPayload.content, "the approved text, unchanged");
  assert.equal(sent.account, ACCOUNT, "the account that was connected, not whichever the provider treats as default");
  assert.ok(executions()[0].url.includes(`user_id=${userId}`));
});

test("approving the same action twice at once writes once", async () => {
  const userId = await userWithDocs("act-double@example.com");
  reset();
  gateway.handle = created;
  gateway.delayMs = 150; // the second approval arrives while the first is still in flight
  const pending = await propose(userId);
  const [a, b] = await Promise.all([
    approveAndExecuteAction(userId, pending.id, pending.payloadHash),
    approveAndExecuteAction(userId, pending.id, pending.payloadHash),
  ]);
  assert.equal(executions().length, 1, "no duplicate write");
  assert.ok([a, b].every((result) => ["completed", "in_progress"].includes(result.status)), "neither approval is told it failed");
  reset();
  const later = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(later.status, "completed");
  assert.equal(executions().length, 0, "approving again after completion does nothing");
});

test("a discarded action is never executed, even if it is approved afterwards", async () => {
  const userId = await userWithDocs("act-discard@example.com");
  reset();
  gateway.handle = created;
  const pending = await propose(userId);
  await discardAction(userId, pending.id);
  const after = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(after.status, "discarded");
  assert.equal(executions().length, 0, "nothing reached the provider");
  assert.equal((await getActionForUser(userId, pending.id)).status, "discarded");
});

test("an approval whose payload does not match what was proposed is refused and writes nothing", async () => {
  const userId = await userWithDocs("act-tamper@example.com");
  reset();
  gateway.handle = created;
  const pending = await propose(userId);
  await assert.rejects(approveAndExecuteAction(userId, pending.id, "0".repeat(64)), /payload mismatch|tampered/i);
  assert.equal(executions().length, 0);
  assert.equal((await getActionForUser(userId, pending.id)).status, "pending", "still waiting for a real approval");
});

test("another user cannot approve this user's action", async () => {
  const owner = await userWithDocs("act-owner@example.com");
  const stranger = await userWithDocs("act-stranger@example.com");
  reset();
  gateway.handle = created;
  const pending = await propose(owner);
  await assert.rejects(approveAndExecuteAction(stranger, pending.id, pending.payloadHash), /not found or unauthorized/i);
  assert.equal(executions().length, 0);
});

test("a failed write is reported in the product's words, is not retried, and cannot be run again by approving again", async () => {
  const userId = await userWithDocs("act-fail@example.com");
  reset();
  gateway.handle = () => ({ successful: false, error: "1 out of 1 tools failed", data: { results: [{ response: { successful: false, data: { message: "Composio could not reach the docs API with ck_abcdefgh12345678" } } }] }, log_id: "log_f" });
  const pending = await propose(userId);
  await assert.rejects(approveAndExecuteAction(userId, pending.id, pending.payloadHash), (error) => {
    assert.match(error.message, /External execution failed/);
    assert.doesNotMatch(error.message, /composio|ck_abcdefgh/i, "no vendor name and no key in what the user is told");
    return true;
  });
  assert.equal(executions().length, 1, "one attempt, no automatic retry");
  const stored = await getActionForUser(userId, pending.id);
  assert.ok(["failed", "uncertain"].includes(stored.status));
  assert.doesNotMatch(JSON.stringify(stored.result ?? {}), /composio|ck_abcdefgh/i, "and none in the stored record");
  reset();
  await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(executions().length, 0, "approving a failed action again does not dispatch a second write");
});

test("an action for a connector the user turned off is blocked before anything is sent", async () => {
  const userId = await userWithDocs("act-disabled@example.com");
  await connectUserConnector(userId, "googledocs", { accessToken: `comp_live_${ACCOUNT}`, scopes: [], enabled: false, metadata: { id: ACCOUNT, accountId: ACCOUNT, status: "active" } });
  reset();
  gateway.handle = created;
  const pending = await propose(userId);
  await assert.rejects(approveAndExecuteAction(userId, pending.id, pending.payloadHash), /disabled by user/i);
  assert.equal(executions().length, 0);
});
