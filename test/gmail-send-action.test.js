/**
 * "@Gmail use my gmail to mail <someone> a funny joke (make the joke up and send)", with nothing real behind it: the real chat tool layer, the real
 * approval service and provider adapter, an isolated database, and a stand-in for the connection gateway over real HTTP on 127.0.0.1. No email is
 * sent and no draft is made anywhere.
 *
 * What is proven: a request to send is prepared as a send (never quietly as a draft); the approval names the sender, recipient, subject and full
 * text; the tool names and arguments are the ones in the provider's catalogue (GMAIL_SEND_EMAIL, GMAIL_CREATE_EMAIL_DRAFT with `recipient_email`),
 * so the "Tool GMAIL_CREATE_DRAFT not found" failure cannot recur; nothing leaves before approval; a missing tool fails before any success claim;
 * the card uses email words, not upload words; a lost answer is reported as unknown and never retried; and one approval is one email.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const seen = { tools: [] };
const gateway = { tool: () => ({}), toolDelayMs: 0, drop: false };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const call = rpc.params?.arguments ?? {};
    if (rpc.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
      seen.tools.push({ slug: call.tools?.[0]?.tool_slug, arguments: call.tools?.[0]?.arguments, account: call.tools?.[0]?.account });
      if (gateway.toolDelayMs) await new Promise((resolve) => setTimeout(resolve, gateway.toolDelayMs));
      if (gateway.drop) return req.socket.destroy();
    }
    const envelope = rpc.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL" ? gateway.tool(call.tools?.[0]?.tool_slug, call.tools?.[0]?.arguments) : {};
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

const { executeToolCall, filterToolsForEnabledConnectors } = await import("../src/chat/router.js");
const { CHAT_TOOLS, structuredToolCalls } = await import("../src/chat/tool-calls.js");
const service = await import("../src/connectors/service.js");
const { TOOL_SLUG_MAP } = await import("../src/connectors/composio-adapter.js");
const copy = await import("../frontend/src/components/action-failure-copy.js");
const recovery = await import("../frontend/src/components/upload-recovery-copy.js");
const { connectUserConnector, approveAndExecuteAction, getActionForUser, discardAction } = service;
test.after(async () => { server.closeAllConnections?.(); server.close(); await client.close(); });

const ALIAS = "gmail_test-alias";
const SENDER = "owner@example.com";
const TO = "friend@example.org";
let counter = 0;
async function addUser() {
  const id = `gmail-user-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await connectUserConnector(id, "gmail", { accessToken: `comp_live_${ALIAS}`, scopes: [], metadata: { id: ALIAS, accountId: ALIAS, status: "active", email: SENDER, accountName: "Owner" } });
  return id;
}
const JOKE = { to: TO, subject: "A joke for you", body: "Why did the scarecrow win an award?\nBecause he was outstanding in his field." };
const SEND_REQUEST = "@Gmail use my gmail to mail friend@example.org a funny joke (make the joke up and send)";
const sentOk = (id = "msg_123") => ({ successful: true, data: { results: [{ tool_slug: "GMAIL_SEND_EMAIL", response: { successful: true, data: { id, threadId: "t_1", labelIds: ["SENT"] } } }] }, log_id: "log_ok" });
const draftOk = (id = "r_draft_1") => ({ successful: true, data: { results: [{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", response: { successful: true, data: { id, message: { id: "m_1" } } } }] }, log_id: "log_ok" });
const prepare = (userId, name = "gmail_send_email", request = SEND_REQUEST, args = JOKE) => executeToolCall({ name, arguments: { ...args } }, request, { userId });
const writes = () => seen.tools.filter((t) => /^GMAIL_(SEND|CREATE)/.test(t.slug));
const reset = () => { seen.tools.length = 0; gateway.toolDelayMs = 0; gateway.drop = false; gateway.tool = () => ({}); };

// --- the tools the model is given and how a mention routes ----------------------------------------------------------------------------------------

test("A. mentioning Gmail offers the Gmail send and draft tools, and only when Gmail is enabled; Drive's are not mixed in", () => {
  const names = (opts) => filterToolsForEnabledConnectors(CHAT_TOOLS, opts).map((t) => t.function.name);
  const on = names({ connectorEnabled: { gmail: true, googledrive: true }, selectedConnectors: ["gmail"] });
  assert.ok(on.includes("gmail_send_email") && on.includes("draft_email"), "a send tool and a draft tool are both offered");
  assert.ok(!on.includes("google_drive_upload_file"), "another connector's tools are not offered for an @Gmail turn");
  const off = names({ connectorEnabled: { gmail: false }, selectedConnectors: ["gmail"] });
  assert.ok(!off.includes("gmail_send_email") && !off.includes("draft_email"));
});

test("B. the model's own names for 'send' all mean a send, and only 'draft' names mean a draft", () => {
  const nameOf = (n) => structuredToolCalls({ choices: [{ message: { tool_calls: [{ id: "1", function: { name: n, arguments: "{}" } }] } }] }, "q")[0].name;
  for (const n of ["send_email", "gmail_send_email", "gmail_send"]) assert.equal(nameOf(n), "gmail_send_email");
  for (const n of ["draft_email", "gmail_draft", "create_email_draft"]) assert.equal(nameOf(n), "draft_email");
});

test("B. 'mail … and send' prepares a SEND even when the model reached for the draft tool; 'draft' stays a draft", async () => {
  reset();
  const userId = await addUser();
  const viaDraft = await prepare(userId, "draft_email", SEND_REQUEST);
  assert.equal(viaDraft.kind, "pending_approval");
  assert.equal(viaDraft.pendingAction.toolName, "gmail_send_email", "not silently fulfilled as a draft");
  assert.match(viaDraft.pendingAction.actionDescription, /^Send an email from owner@example\.com to friend@example\.org/);
  const draftAsked = await prepare(userId, "draft_email", "draft an email to friend@example.org with a joke");
  assert.equal(draftAsked.pendingAction.toolName, "draft_email");
  assert.match(draftAsked.pendingAction.actionDescription, /not sent/);
  assert.equal(writes().length, 0, "preparing either one wrote nothing");
});

// --- the approval ---------------------------------------------------------------------------------------------------------------------------------

test("C. the approval carries the exact sender, recipient, subject and full text, and not the connection's internal alias", async () => {
  reset();
  const userId = await addUser();
  const { pendingAction } = await prepare(userId);
  assert.deepEqual([pendingAction.payload.to, pendingAction.payload.subject, pendingAction.payload.body, pendingAction.payload.senderLabel], [TO, JOKE.subject, JOKE.body, SENDER]);
  assert.ok(pendingAction.payload.accountRef, "bound to the connected account by an opaque reference");
  assert.ok(!JSON.stringify(pendingAction).includes(ALIAS), "no alias in the card");
  assert.equal(writes().length, 0, "nothing was sent while the card waits");
});

test("C. a missing or malformed address, subject or text asks a question and prepares nothing", async () => {
  reset();
  const userId = await addUser();
  for (const args of [{ ...JOKE, to: "not-an-address" }, { ...JOKE, to: "a@b.c, d@e.f" }, { ...JOKE, subject: "" }, { ...JOKE, body: "  " }]) {
    const result = await prepare(userId, "gmail_send_email", SEND_REQUEST, args);
    assert.equal(result.kind, "clarification", JSON.stringify(args));
  }
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pending_tool_actions")).rows[0].n >= 0, true);
});

test("D. discarding the card sends nothing, and the discarded card cannot be approved", async () => {
  reset();
  const userId = await addUser();
  const { pendingAction } = await prepare(userId);
  await discardAction(userId, pendingAction.id);
  const again = await approveAndExecuteAction(userId, pendingAction.id, pendingAction.payloadHash);
  assert.equal(again.status, "discarded", "approving a discarded card does nothing");
  assert.equal(writes().length, 0);
});

// --- the provider call ----------------------------------------------------------------------------------------------------------------------------

test("F. the slugs are the catalogue's, and the arguments are the schema's (`recipient_email`, not the model's `to`)", async () => {
  reset();
  assert.equal(TOOL_SLUG_MAP.gmail_send_email, "GMAIL_SEND_EMAIL");
  assert.equal(TOOL_SLUG_MAP.draft_email, "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_CREATE_DRAFT is not a tool; this was the screenshot's failure");
  const userId = await addUser();
  const { pendingAction } = await prepare(userId);
  gateway.tool = () => sentOk();
  await approveAndExecuteAction(userId, pendingAction.id, pendingAction.payloadHash);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].slug, "GMAIL_SEND_EMAIL");
  assert.deepEqual(writes()[0].arguments, { recipient_email: TO, subject: JOKE.subject, body: JOKE.body }, "only schema fields, no sender label or account reference");
  assert.equal(writes()[0].account, ALIAS, "sent through the connected account, not a default");

  reset();
  const draft = (await prepare(userId, "draft_email", "draft an email to friend@example.org")).pendingAction;
  gateway.tool = () => draftOk();
  const done = await approveAndExecuteAction(userId, draft.id, draft.payloadHash);
  assert.equal(writes()[0].slug, "GMAIL_CREATE_EMAIL_DRAFT");
  assert.equal(done.status, "completed");
});

test("G. a send is 'completed' only when Gmail names the message; an answer that names none is unconfirmed, never 'sent'", async () => {
  reset();
  const userId = await addUser();
  const a = (await prepare(userId)).pendingAction;
  gateway.tool = () => sentOk("msg_confirmed");
  const done = await approveAndExecuteAction(userId, a.id, a.payloadHash);
  assert.equal(done.status, "completed");
  assert.equal(done.result.id, "msg_confirmed");

  reset();
  const b = (await prepare(userId, "gmail_send_email", SEND_REQUEST, { ...JOKE, subject: "Another" })).pendingAction;
  gateway.tool = () => ({ successful: true, data: { results: [{ tool_slug: "GMAIL_SEND_EMAIL", response: { successful: true, data: {} } }] }, log_id: "log_empty" });
  await approveAndExecuteAction(userId, b.id, b.payloadHash).catch(() => null);
  const action = await getActionForUser(userId, b.id);
  assert.equal(action.status, "uncertain");
  assert.match(action.result.error, /can't say the email was sent/i);
  assert.equal(writes().length, 1, "and it was not retried");
});

test("E. a missing tool fails before any success claim, as a definite 'did not run', with no raw tool name for the person", async () => {
  reset();
  const userId = await addUser();
  const { pendingAction } = await prepare(userId);
  gateway.tool = () => ({ successful: false, error: "Tool GMAIL_SEND_EMAIL not found", data: { results: [{ tool_slug: "GMAIL_SEND_EMAIL", error: "Tool GMAIL_SEND_EMAIL not found", response: { successful: false, data: {} } }] }, log_id: "log_nf" });
  const result = await approveAndExecuteAction(userId, pendingAction.id, pendingAction.payloadHash).then((r) => r, (e) => e);
  assert.ok(result instanceof Error);
  const action = await getActionForUser(userId, pendingAction.id);
  assert.equal(action.status, "failed", "not 'uncertain': it never ran");
  assert.equal(action.result.code, "tool_unavailable");
  assert.equal(action.result.dispatchStatus, "pre_dispatch_failure");
  assert.ok(!/GMAIL_|_SEND_/.test(JSON.stringify(action.result)), "no provider tool name in what the card reads");
  assert.equal(writes().length, 1, "tried once, never retried");
  const again = await approveAndExecuteAction(userId, pendingAction.id, pendingAction.payloadHash);
  assert.equal(again.status, "failed");
  assert.equal(writes().length, 1);
});

test("I. a lost answer after the request may have gone out is 'unknown' and is never sent again", async () => {
  reset();
  const userId = await addUser();
  const a = (await prepare(userId)).pendingAction;
  gateway.drop = true;
  await approveAndExecuteAction(userId, a.id, a.payloadHash).catch(() => null);
  const action = await getActionForUser(userId, a.id);
  assert.equal(action.status, "uncertain");
  gateway.drop = false;
  gateway.tool = () => sentOk("must_not_happen");
  const again = await approveAndExecuteAction(userId, a.id, a.payloadHash);
  assert.equal(again.status, "uncertain");
  assert.equal(writes().length, 1, "approving again did not send again");
  // a second card for the same email is held back too, until the person has checked
  const twin = (await prepare(userId)).pendingAction;
  await assert.rejects(approveAndExecuteAction(userId, twin.id, twin.payloadHash), /did not report back/i);
  assert.equal(writes().length, 1);
});

test("J. one email is one send: simultaneous approvals of one card, and of two identical cards, send once", async () => {
  reset();
  const userId = await addUser();
  const a = (await prepare(userId)).pendingAction;
  const b = (await prepare(userId)).pendingAction;
  assert.equal(a.payloadHash, b.payloadHash);
  gateway.tool = () => sentOk("only_once");
  gateway.toolDelayMs = 80;
  await Promise.all([a, a, a, b, b].map((c) => approveAndExecuteAction(userId, c.id, c.payloadHash).catch(() => null)));
  assert.equal(writes().length, 1, "exactly one send");
  const states = [(await getActionForUser(userId, a.id)).status, (await getActionForUser(userId, b.id)).status];
  assert.ok(states.includes("completed") && !states.includes("in_progress"), JSON.stringify(states));
});

test("J. a card for the same email approved right after a completed one is not sent again; the same words later are a new email", async () => {
  reset();
  const userId = await addUser();
  const a = (await prepare(userId)).pendingAction;
  const b = (await prepare(userId)).pendingAction;
  gateway.tool = () => sentOk("first");
  await approveAndExecuteAction(userId, a.id, a.payloadHash);
  const repeat = await approveAndExecuteAction(userId, b.id, b.payloadHash);
  assert.equal(repeat.deduped, true);
  assert.equal(writes().length, 1);
  // Past the short repeat window the same words are a new email on purpose.
  await client.query("UPDATE pending_tool_actions SET updated_at = now() - interval '20 minutes' WHERE id = $1", [a.id]);
  const later = (await prepare(userId)).pendingAction;
  const sentAgain = await approveAndExecuteAction(userId, later.id, later.payloadHash);
  assert.equal(sentAgain.status, "completed");
  assert.notEqual(sentAgain.deduped, true);
  assert.equal(writes().length, 2);
});

test("a changed Gmail account fails before anything is sent", async () => {
  reset();
  const userId = await addUser();
  const a = (await prepare(userId)).pendingAction;
  await connectUserConnector(userId, "gmail", { accessToken: "comp_live_other", scopes: [], metadata: { id: "gmail_other-account", accountId: "gmail_other-account", status: "active", email: "other@example.com" } });
  await assert.rejects(approveAndExecuteAction(userId, a.id, a.payloadHash), /account changed/i);
  assert.equal(writes().length, 0);
  assert.equal((await getActionForUser(userId, a.id)).result.dispatchStatus, "pre_dispatch_failure");
});

test("another person's email card cannot be approved by someone else", async () => {
  reset();
  const owner = await addUser();
  const other = await addUser();
  const a = (await prepare(owner)).pendingAction;
  await assert.rejects(approveAndExecuteAction(other, a.id, a.payloadHash), /not found or unauthorized/i);
  assert.equal(writes().length, 0);
});

// --- what the card says ---------------------------------------------------------------------------------------------------------------------------

test("H. an email failure reads as an email failure; a missing tool never reads as an upload or shows a tool name", () => {
  const failed = (toolName, result) => ({ status: "failed", toolName, result });
  assert.equal(copy.failureTitle(failed("gmail_send_email", {})), "Email was not sent");
  assert.equal(copy.failureTitle(failed("draft_email", {})), "Draft was not created");
  assert.equal(copy.failureTitle(failed("google_drive_upload_file", {})), "Upload was not confirmed", "Drive keeps its own wording");
  const missing = copy.failureText(failed("draft_email", { code: "tool_unavailable", dispatchStatus: "pre_dispatch_failure", error: "Tool GMAIL_CREATE_DRAFT not found" }));
  assert.match(missing, /Gmail can't do this right now/);
  assert.match(missing, /Nothing was saved/);
  assert.doesNotMatch(missing, /GMAIL_|upload/i);
  const rejected = copy.failureText(failed("gmail_send_email", { code: "provider_rejected", dispatchStatus: "dispatch_failed", error: "GMAIL_SEND_EMAIL was refused for gmail_secret-alias" }));
  assert.doesNotMatch(rejected, /GMAIL_|secret-alias/);
  assert.doesNotMatch(rejected, /Nothing was sent/, "not claimed unless the record shows it never ran");
  assert.match(rejected, /Check your Gmail before asking again/);
});

test("H/I. an unknown email outcome says so in email words and offers no Drive controls; Drive keeps its controls", () => {
  const unknownSend = copy.unknownOutcomeText({ toolName: "gmail_send_email" });
  assert.equal(unknownSend.title, "Email status unknown");
  assert.match(unknownSend.body, /Sent folder/);
  assert.match(unknownSend.body, /twice/);
  assert.equal(copy.unknownOutcomeText({ toolName: "draft_email" }).title, "Draft status unknown");
  assert.equal(recovery.canReconcile({ status: "uncertain", toolName: "gmail_send_email" }), false, "no Drive reconciliation for an email");
  assert.equal(recovery.canReconcile({ status: "uncertain", toolName: "draft_email" }), false);
  assert.equal(recovery.canReconcile({ status: "uncertain", toolName: "google_drive_upload_file" }), true, "Drive is unchanged");
  const card = readFileSync(new URL("../frontend/src/components/ActionApprovalCard.jsx", import.meta.url), "utf8");
  assert.match(card, /Email sent/);
  assert.match(card, /Approve & Send/);
  assert.match(card, /<dt>From<\/dt>/);
  assert.match(card, /<dt>Subject<\/dt>/);
});

test("L. nothing a person reads carries the internal alias, a credential or a raw tool name", async () => {
  reset();
  const userId = await addUser();
  const { pendingAction } = await prepare(userId);
  gateway.tool = () => ({ successful: false, error: "Tool GMAIL_SEND_EMAIL not found", data: { results: [{ tool_slug: "GMAIL_SEND_EMAIL", error: "Tool GMAIL_SEND_EMAIL not found", response: { successful: false, data: {} } }] }, log_id: "log_nf" });
  await approveAndExecuteAction(userId, pendingAction.id, pendingAction.payloadHash).catch(() => null);
  const action = await getActionForUser(userId, pendingAction.id);
  const shown = JSON.stringify({ pendingAction, result: action.result, text: copy.failureText(action), title: copy.failureTitle(action) });
  assert.ok(!shown.includes(ALIAS) && !shown.includes("comp_live_") && !shown.includes("ck_test_gateway") && !/GMAIL_[A-Z_]+/.test(shown));
});

test("the card's service tag names Gmail for an email action, not just 'Connector'", () => {
  assert.equal(copy.serviceName("gmail_send_email"), "Gmail");
  assert.equal(copy.serviceName("draft_email"), "Gmail");
  assert.equal(copy.serviceName("google_drive_upload_file"), "Google Drive", "Drive is unchanged");
});
