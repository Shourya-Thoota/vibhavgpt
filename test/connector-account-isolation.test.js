/**
 * Which connected accounts a signed-in person may use. The production gateway is reached with one shared consumer key, and (checked with a read-only
 * probe of two user ids that do not exist) it shows every caller the same accounts, with no marker saying whose they are. So an account that carries no
 * owner marker must never be attached to a user, and nothing may be run against an account that was not granted to that user. This file uses synthetic
 * users and accounts and a stand-in gateway that behaves like that; no mailbox is touched and nothing is sent.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

// The pool the gateway shows to every caller, whoever they are: two people's accounts, none carrying an owner marker.
const POOL = [
  { id: "gmail_acct-of-b", status: "active", user_info: { email: "b@example.org", name: "Person B" } },
  { id: "gmail_acct-of-a", status: "active", user_info: { email: "a@example.org", name: "Person A" } },
];
const seen = { calls: [] };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    seen.calls.push({ name, userIdParam: new URL(req.url, "http://x").searchParams.get("user_id"), tool: args.tools?.[0]?.tool_slug, account: args.tools?.[0]?.account });
    let envelope = {};
    if (name === "COMPOSIO_MANAGE_CONNECTIONS") envelope = { data: { results: { gmail: { accounts: POOL.map((a) => ({ ...a })), redirect_url: null } } }, successful: true };
    if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") envelope = { successful: true, data: { results: [{ tool_slug: args.tools?.[0]?.tool_slug, response: { successful: true, data: { id: "msg_x" } } }] }, log_id: "log_ok" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
process.env.COMPOSIO_API_KEY = "ck_test_gateway_key_not_a_real_key";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (_req, _res, next) => next(), loadOptionalSession: (_req, _res, next) => next() },
});

const service = await import("../src/connectors/service.js");
const { executeComposioTool } = await import("../src/connectors/composio-adapter.js");
const { executeToolCall } = await import("../src/chat/router.js");
const { prepareEmailAction } = await import("../src/connectors/email-action.js");
const { checkConnectorStatus, initiateConnectorFlow, getConnectorAccountId, connectUserConnector } = service;
test.after(async () => { server.closeAllConnections?.(); server.close(); await client.close(); });

const grants = (value) => { process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS = JSON.stringify(value); };
let n = 0;
async function person() {
  const id = `isolation-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  return id;
}
const reset = () => { seen.calls.length = 0; };
const writes = () => seen.calls.filter((c) => c.name === "COMPOSIO_MULTI_EXECUTE_TOOL");
const stored = async (userId) => (await client.query("SELECT metadata FROM user_connectors WHERE user_id = $1 AND provider = 'gmail'", [userId])).rows[0]?.metadata ?? null;

test("a person with no grant is not attached to an account just because the gateway lists one", async () => {
  grants({});
  reset();
  const a = await person();
  const status = await checkConnectorStatus(a, "gmail");
  assert.notEqual(status.status, "connected", "the gateway's account list is not proof of ownership");
  assert.equal(await getConnectorAccountId(a, "gmail"), null);
  assert.equal(await stored(a), null, "nothing was stored for them");
});

test("a person who presses Connect is not handed the gateway's already-active account", async () => {
  grants({});
  reset();
  const a = await person();
  const flow = await initiateConnectorFlow(a, "gmail");
  assert.equal(flow.connected, false);
  assert.equal(await getConnectorAccountId(a, "gmail"), null);
});

test("with grants, each person gets only their own granted account, whatever order the gateway lists them", async () => {
  const a = await person();
  const b = await person();
  grants({ [a]: ["gmail_acct-of-a"], [b]: ["gmail_acct-of-b"] });
  await checkConnectorStatus(a, "gmail");
  await checkConnectorStatus(b, "gmail");
  assert.equal(await getConnectorAccountId(a, "gmail"), "gmail_acct-of-a");
  assert.equal(await getConnectorAccountId(b, "gmail"), "gmail_acct-of-b");
});

test("a stored connection that points at an account the person was not granted is treated as not connected, and nothing runs on it", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  // The state the owner's screenshot shows: this person's record holds someone else's account.
  await connectUserConnector(a, "gmail", { accessToken: "comp_live_gmail_acct-of-b", scopes: [], metadata: { id: "gmail_acct-of-b", accountId: "gmail_acct-of-b", email: "b@example.org" } });
  assert.equal(await getConnectorAccountId(a, "gmail"), null, "not usable");
  reset();
  await assert.rejects(executeComposioTool({ userId: a, toolSlug: "gmail_send_email", parameters: { recipient_email: "x@example.org", subject: "s", body: "b" }, connectedAccountId: "gmail_acct-of-b" }), /not authorized|isn't verified/i);
  assert.equal(writes().length, 0, "nothing reached the gateway");
});

test("preparing an email on a foreign or unverified account is refused before any card exists", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  await connectUserConnector(a, "gmail", { accessToken: "comp_live_gmail_acct-of-b", scopes: [], metadata: { id: "gmail_acct-of-b", accountId: "gmail_acct-of-b", email: "b@example.org" } });
  reset();
  const prepared = await executeToolCall({ name: "gmail_send_email", arguments: { to: "x@example.org", subject: "s", body: "b" } }, "mail x@example.org and send", { userId: a });
  assert.notEqual(prepared.kind, "pending_approval", "no approval card is offered for an account that is not theirs");
  assert.equal(writes().length, 0);
  const direct = await prepareEmailAction({ userId: a, toolName: "gmail_send_email", args: { to: "x@example.org", subject: "s", body: "b" } });
  assert.equal(direct.ok, false);
});

test("a granted account works end to end, and the sender shown is the account that executes", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  await checkConnectorStatus(a, "gmail");
  const prepared = await executeToolCall({ name: "gmail_send_email", arguments: { to: "x@example.org", subject: "s", body: "b" } }, "mail x@example.org and send", { userId: a });
  assert.equal(prepared.kind, "pending_approval");
  assert.equal(prepared.pendingAction.payload.senderLabel, "a@example.org");
  reset();
  await service.approveAndExecuteAction(a, prepared.pendingAction.id, prepared.pendingAction.payloadHash);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].account, "gmail_acct-of-a", "executed on the account whose address the card showed");
});

test("a person cannot run anything with no account named, because the gateway would choose its own default", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  reset();
  await assert.rejects(executeComposioTool({ userId: a, toolSlug: "gmail_send_email", parameters: { recipient_email: "x@example.org", subject: "s", body: "b" }, connectedAccountId: null }), /not authorized|isn't verified/i);
  assert.equal(writes().length, 0);
});

test("changing which account is granted invalidates a card prepared earlier, before anything is sent", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  await checkConnectorStatus(a, "gmail");
  const prepared = await executeToolCall({ name: "gmail_send_email", arguments: { to: "x@example.org", subject: "s", body: "b" } }, "mail x@example.org and send", { userId: a });
  grants({});
  reset();
  await assert.rejects(service.approveAndExecuteAction(a, prepared.pendingAction.id, prepared.pendingAction.payloadHash), /changed|isn't verified|not authorized/i);
  assert.equal(writes().length, 0);
});

test("the grant list is read as written: another person's grant gives nothing, and an empty or malformed list grants nothing", async () => {
  const a = await person();
  const b = await person();
  for (const value of ["{}", "not json", JSON.stringify({ [b]: ["gmail_acct-of-a"] }), JSON.stringify({ [a]: [] })]) {
    process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS = value;
    await checkConnectorStatus(a, "gmail");
    assert.equal(await getConnectorAccountId(a, "gmail"), null, value);
  }
});
