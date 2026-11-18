/**
 * The connector entry points that could attach, change or revoke a person's connection, and what Settings and chat say about a connection that is not
 * verified for the person. Synthetic users and accounts, a stand-in gateway, and the real router over HTTP on 127.0.0.1; nothing real is touched.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const gatewayCalls = [];
const gateway = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const args = rpc.params?.arguments ?? {};
    gatewayCalls.push({ name: rpc.params?.name, toolkits: args.toolkits, tool: args.tools?.[0]?.tool_slug, account: args.tools?.[0]?.account });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: {} } }) }] } }));
  });
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${gateway.address().port}/mcp`;
process.env.COMPOSIO_API_KEY = "ck_test_gateway_key_not_a_real_key";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });
let signedInAs = null;
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (req, _res, next) => { req.user = { id: signedInAs, name: "Test", email: "t@example.com" }; next(); }, loadOptionalSession: (_req, _res, next) => next() },
});

const { default: express } = await import("express");
const service = await import("../src/connectors/service.js");
const { connectorsRouter } = await import("../src/connectors/router.js");
const { executeToolCall } = await import("../src/chat/router.js");
const { connectUserConnector, getConnectorsSummary, isConnectorEnabled, disconnectUserConnector } = service;

const app = express();
app.use(express.json());
app.use("/api/connectors", connectorsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
test.after(async () => { server.closeAllConnections?.(); server.close(); gateway.closeAllConnections?.(); gateway.close(); await client.close(); });
const call = async (as, method, path, body) => {
  signedInAs = as;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connectors${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const grants = (value) => { process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS = JSON.stringify(value); };
let n = 0;
async function person() {
  const id = `contain-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  return id;
}
const rowOf = async (userId, provider = "gmail") => (await client.query("SELECT status, enabled, metadata FROM user_connectors WHERE user_id = $1 AND provider = $2", [userId, provider])).rows[0] ?? null;
const attach = (userId, accountId, extra = {}) => connectUserConnector(userId, "gmail", { accessToken: `comp_live_${accountId}`, scopes: [], metadata: { id: accountId, accountId, email: "someone@example.org", accountName: "Someone", ...extra } });
const reset = () => { gatewayCalls.length = 0; };

test("the provider webhook is closed: a forged event cannot attach, change or disconnect anyone's connector", async () => {
  grants({});
  const victim = await person();
  await attach(victim, "gmail_victim-acct");
  reset();
  const forgedConnect = await call(null, "POST", "/webhook", { type: "connection.created", data: { user_id: victim, app_name: "googledrive", connection_id: "gmail_other-acct" } });
  assert.equal(forgedConnect.status, 404);
  assert.equal(await rowOf(victim, "googledrive"), null, "no connector was attached");
  const forgedDelete = await call(null, "POST", "/webhook", { type: "connection.deleted", data: { user_id: victim, app_name: "gmail" } });
  assert.equal(forgedDelete.status, 404);
  assert.equal((await rowOf(victim)).status, "connected", "nothing was disconnected");
  assert.equal(gatewayCalls.length, 0);
});

test("the self-attesting connect route is closed: a caller cannot store an account id, connection id or address of their choosing", async () => {
  grants({});
  const a = await person();
  const result = await call(a, "POST", "/gmail/connect", { connectionId: "gmail_acct-of-someone-else", metadata: { accountId: "gmail_acct-of-someone-else", id: "gmail_acct-of-someone-else", email: "victim@example.org", ownershipVerified: true } });
  assert.equal(result.status, 410);
  assert.equal(await rowOf(a), null, "nothing was stored");
});

test("disconnecting never revokes an id the caller or an event supplied; it revokes only the account this server verified as theirs", async () => {
  const a = await person();
  grants({ [a]: ["gmail_acct-of-a"] });
  // A planted connection id and a planted 'verified' flag, as a forged event or request body could have left them.
  await attach(a, "gmail_acct-of-a", { connectionId: "gmail_acct-of-someone-else", ownershipVerified: false });
  reset();
  await disconnectUserConnector(a, "gmail");
  assert.ok(!JSON.stringify(gatewayCalls).includes("gmail_acct-of-someone-else"), "the planted id was never sent upstream");
  assert.equal(gatewayCalls.filter((c) => c.name === "COMPOSIO_MANAGE_CONNECTIONS").length, 0, "no revoke without verified ownership");

  const b = await person();
  grants({ [b]: ["gmail_acct-of-b"] });
  await attach(b, "gmail_acct-of-b", { connectionId: "gmail_acct-of-someone-else", ownershipVerified: true });
  reset();
  await disconnectUserConnector(b, "gmail");
  const revokes = gatewayCalls.filter((c) => c.name === "COMPOSIO_MANAGE_CONNECTIONS");
  assert.equal(revokes.length, 1);
  assert.deepEqual(revokes[0].toolkits.map((t) => t.account_id), ["gmail_acct-of-b"], "only their own verified account");

  const c = await person();
  grants({});
  await attach(c, "gmail_acct-of-b", { ownershipVerified: true });
  reset();
  await disconnectUserConnector(c, "gmail");
  assert.equal(gatewayCalls.filter((x) => x.name === "COMPOSIO_MANAGE_CONNECTIONS").length, 0, "a flag alone is not enough: the account must also be granted to them");
});

test("Settings tells the truth: an unverified connection is not 'connected', is not enabled, and shows nothing about whose account it is", async () => {
  const a = await person();
  grants({});
  await attach(a, "gmail_acct-of-someone-else", { email: "stranger@example.org", accountName: "Stranger" });
  const gmail = (await getConnectorsSummary(a)).find((c) => c.id === "gmail");
  assert.equal(gmail.status, "verification_required");
  assert.equal(gmail.enabled, false);
  assert.match(gmail.blockerNotice, /secure verification/i);
  assert.match(gmail.blockerNotice, /Reconnect this account to confirm it's yours/);
  assert.deepEqual(gmail.metadata, {}, "no address, name or alias of the account");
  assert.ok(!JSON.stringify(gmail).includes("stranger@example.org") && !JSON.stringify(gmail).includes("gmail_acct-of-someone-else"));

  grants({ [a]: ["gmail_acct-of-someone-else"] });
  const granted = (await getConnectorsSummary(a)).find((c) => c.id === "gmail");
  assert.equal(granted.status, "connected");
  assert.equal(granted.enabled, true);
});

test("an unverified connection is not offered to the model, and asking for it names the real reason without running anything", async () => {
  const a = await person();
  grants({});
  await attach(a, "gmail_acct-of-someone-else");
  assert.equal(await isConnectorEnabled(a, "gmail"), false, "so its tools are not offered and no AI request is spent discovering this");
  reset();
  const read = await executeToolCall({ name: "search_emails", arguments: { query: "x" } }, "search my email", { userId: a });
  assert.equal(read.kind, "connector_notice");
  assert.match(read.content, /needs secure verification/i);
  const write = await executeToolCall({ name: "gmail_send_email", arguments: { to: "x@example.org", subject: "s", body: "b" } }, "mail x@example.org and send", { userId: a });
  assert.equal(write.kind, "connector_notice");
  assert.match(write.content, /needs secure verification/i);
  assert.equal(gatewayCalls.length, 0, "nothing reached the gateway");
});

test("the Settings and Extensions rows say 'Verification required' and offer no Connect or Manage for it", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../frontend/src/components/ConnectorsSettings.jsx", "../frontend/src/components/extensions/Extensions.jsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /verification_required/, file);
    assert.match(source, /Verification required/, file);
  }
});
