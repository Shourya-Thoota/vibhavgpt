/**
 * Ownership of connected accounts is recorded from the Connect flow itself (src/connectors/account-ownership.js), so a person who connects Gmail,
 * Drive or Calendar is verified without the operator editing a grant list, and still nobody can use anyone else's account. The stand-in gateway
 * behaves like the production one: every caller sees one shared pool of accounts with no owner marker, and "add" always creates a new account
 * that carries the alias it was given. Synthetic users and accounts only; no mailbox is touched and nothing is sent.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

// The shared pool. It starts with an account somebody made outside the app (no alias of ours), already active.
const POOL = [{ id: "gmail_made-outside", status: "active", user_info: { email: "outside@example.org" } }];
let made = 0;
const seen = { calls: [] };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    seen.calls.push({ name, args });
    let envelope = {};
    if (name === "COMPOSIO_MANAGE_CONNECTIONS") {
      const results = {};
      for (const item of args.toolkits || []) {
        let redirect = null;
        if (item.action === "add") {
          const id = `${item.name}_new-${++made}`;
          POOL.push({ id, status: "initiated", ...(item.alias ? { alias: item.alias } : {}), toolkit: item.name });
          redirect = `https://connect.composio.dev/link/ln_${made}`;
        }
        results[item.name] = { accounts: POOL.filter((a) => !a.toolkit || a.toolkit === item.name).map((a) => ({ ...a })), redirect_url: redirect };
      }
      envelope = { data: { results }, successful: true };
    }
    if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") envelope = { successful: true, data: { results: [{ tool_slug: args.tools?.[0]?.tool_slug, response: { successful: true, data: { messages: [] } } }] }, log_id: "log_ok" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
process.env.COMPOSIO_API_KEY = "ck_test_gateway_key_not_a_real_key";
process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS = "{}";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });

const service = await import("../src/connectors/service.js");
const { executeComposioTool } = await import("../src/connectors/composio-adapter.js");
const { checkConnectorStatus, initiateConnectorFlow, getConnectorAccountId, getConnectorsSummary, disconnectUserConnector, isConnectorEnabled, connectUserConnector } = service;
test.after(async () => { server.closeAllConnections?.(); server.close(); await client.close(); });

let n = 0;
async function person() {
  const id = `owner-test-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  return id;
}
/** The person finishes signing in at the provider: the account their link made becomes active. */
const finishSignIn = (accountId) => { POOL.find((a) => a.id === accountId).status = "active"; };
const addedFor = async (userId) => {
  const flow = await initiateConnectorFlow(userId, "gmail", {});
  const add = seen.calls.filter((c) => c.name === "COMPOSIO_MANAGE_CONNECTIONS" && c.args.toolkits?.[0]?.action === "add").at(-1);
  return { flow, alias: add.args.toolkits[0].alias, accountId: POOL.at(-1).id };
};
const execute = (userId, connectedAccountId) => executeComposioTool({ userId, toolSlug: "GMAIL_FETCH_EMAILS", parameters: { query: "x" }, connectedAccountId });
const executes = () => seen.calls.filter((c) => c.name === "COMPOSIO_MULTI_EXECUTE_TOOL").length;
const ownerRows = async (userId) => (await client.query("SELECT alias, account_id FROM connector_account_owners WHERE user_id = $1", [userId])).rows;

test("Connect stores an unguessable alias against the person before the link is made, and passes it to the gateway", async () => {
  const a = await person();
  const { flow, alias } = await addedFor(a);
  assert.match(alias, /^vgc_[0-9a-f]{24}-[0-9a-f]{8}$/);
  assert.ok(flow.redirectUrl.startsWith("https://connect.composio.dev/"));
  assert.deepEqual((await ownerRows(a)).map((r) => r.alias), [alias]);
});

test("a person who connects and signs in is verified automatically, and can use only that account", async () => {
  const a = await person();
  const { accountId } = await addedFor(a);
  finishSignIn(accountId);
  const status = await checkConnectorStatus(a, "gmail");
  assert.equal(status.status, "connected");
  assert.equal(status.accountId, accountId, "the account their own link made, not the one made outside the app");
  assert.equal(await getConnectorAccountId(a, "gmail"), accountId);
  assert.equal(await isConnectorEnabled(a, "gmail"), true);
  const row = (await getConnectorsSummary(a)).find((c) => c.id === "gmail");
  assert.equal(row.status, "connected", "not stuck on Verification required");
  const before = executes();
  await execute(a, accountId);
  assert.equal(executes(), before + 1);
  await assert.rejects(execute(a, "gmail_made-outside"), { code: "account_not_authorized" });
});

test("another person sees the same pool but is never attached to, or allowed to run on, someone else's account", async () => {
  const a = await person();
  const b = await person();
  const { accountId } = await addedFor(a);
  finishSignIn(accountId);
  await checkConnectorStatus(a, "gmail");
  const forB = await checkConnectorStatus(b, "gmail");
  assert.notEqual(forB.status, "connected");
  assert.equal(await getConnectorAccountId(b, "gmail"), null);
  const before = executes();
  await assert.rejects(execute(b, accountId), { code: "account_not_authorized" });
  assert.equal(executes(), before, "nothing reached the gateway");
  // Even a stored row naming A's account does not make it B's.
  await connectUserConnector(b, "gmail", { accessToken: "comp_live_x", metadata: { accountId, ownershipVerified: true } });
  assert.equal(await getConnectorAccountId(b, "gmail"), null);
  assert.equal((await getConnectorsSummary(b)).find((c) => c.id === "gmail").status, "verification_required");
});

test("two people connecting at the same time each get only their own new account", async () => {
  const a = await person();
  const b = await person();
  const forA = await addedFor(a);
  const forB = await addedFor(b);
  finishSignIn(forB.accountId);
  finishSignIn(forA.accountId);
  assert.equal((await checkConnectorStatus(b, "gmail")).accountId, forB.accountId);
  assert.equal((await checkConnectorStatus(a, "gmail")).accountId, forA.accountId);
  assert.deepEqual((await ownerRows(a)).map((r) => r.account_id), [forA.accountId]);
  assert.deepEqual((await ownerRows(b)).map((r) => r.account_id), [forB.accountId]);
});

test("an account carrying an alias nobody was given, or someone else's alias, is never recorded for the person checking", async () => {
  const a = await person();
  const b = await person();
  const { alias: aliasOfB, accountId: accountOfB } = await addedFor(b);
  POOL.push({ id: "gmail_forged", status: "active", alias: "vgc_000000000000000000000000-00000000" });
  finishSignIn(accountOfB);
  // A checks first, while the pool shows B's alias and a well-formed alias that was never stored.
  const forA = await checkConnectorStatus(a, "gmail");
  assert.notEqual(forA.status, "connected");
  assert.deepEqual(await ownerRows(a), []);
  const rowOfB = (await ownerRows(b)).find((r) => r.alias === aliasOfB);
  assert.equal(rowOfB.account_id, accountOfB, "B's account is recorded for B (by B's own Connect press), never for A");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM connector_account_owners WHERE account_id = 'gmail_forged'")).rows[0].n, 0);
  assert.equal((await checkConnectorStatus(b, "gmail")).accountId, accountOfB);
});

test("a connection stuck on Verification required is fixed by reconnecting", async () => {
  const a = await person();
  await connectUserConnector(a, "gmail", { accessToken: "comp_live_old", metadata: { accountId: "gmail_made-outside", ownershipVerified: true } });
  assert.equal((await getConnectorsSummary(a)).find((c) => c.id === "gmail").status, "verification_required");
  const { accountId } = await addedFor(a);
  finishSignIn(accountId);
  await checkConnectorStatus(a, "gmail");
  const row = (await getConnectorsSummary(a)).find((c) => c.id === "gmail");
  assert.equal(row.status, "connected");
  assert.equal(await getConnectorAccountId(a, "gmail"), accountId);
});

test("disconnecting lets go of the account: it is no longer theirs and nothing runs on it", async () => {
  const a = await person();
  const { accountId } = await addedFor(a);
  finishSignIn(accountId);
  await checkConnectorStatus(a, "gmail");
  await disconnectUserConnector(a, "gmail");
  assert.deepEqual((await ownerRows(a)).filter((r) => r.account_id), []);
  assert.equal(await getConnectorAccountId(a, "gmail"), null);
  await assert.rejects(execute(a, accountId), { code: "account_not_authorized" });
});

test("one account has at most one owner, even if two rows somehow named it", async () => {
  const a = await person();
  const b = await person();
  await client.query(`INSERT INTO connector_account_owners (alias, user_id, toolkit, app, account_id) VALUES ('vgc_x1', $1, 'gmail', 'gmail', 'gmail_shared-id')`, [a]);
  await assert.rejects(
    client.query(`INSERT INTO connector_account_owners (alias, user_id, toolkit, app, account_id) VALUES ('vgc_x2', $1, 'gmail', 'gmail', 'gmail_shared-id')`, [b]),
  );
});
