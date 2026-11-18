// The recovery path for an upload whose result never came back: what the person is told and can do, and what the endpoint allows.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });

let currentUser = null;
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: { requireSession: (req, _res, next) => { req.user = { id: currentUser }; next(); }, loadOptionalSession: (_req, _res, next) => next() },
});

const { default: express } = await import("express");
const service = await import("../src/connectors/service.js");
const { connectorsRouter } = await import("../src/connectors/router.js");
const copy = await import("../frontend/src/components/upload-recovery-copy.js");
const { createPendingAction, getActionForUser, approveAndExecuteAction } = service;

const TOOL = "google_drive_upload_file";
const payload = (n) => ({ attachmentId: `att_${n}`, sha256: "c".repeat(64), fileName: "guide.pdf", mimeType: "application/pdf", sizeBytes: 9527, folderName: "My Drive", accountLabel: "Test Account", accountRef: "acct00000000000a" });
let n = 0;
async function user() {
  const id = `recovery-user-${++n}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  return id;
}
async function uncertainAction(userId) {
  const card = await createPendingAction({ userId, toolName: TOOL, actionDescription: "Upload guide.pdf to My Drive", payload: payload(++n) });
  await client.query(`UPDATE pending_tool_actions SET status = 'uncertain', result = '{"code":"dispatch_uncertain","dispatchStatus":"dispatch_uncertain","error":"unconfirmed"}'::jsonb WHERE id = $1`, [card.id]);
  return card;
}

// A real HTTP server around the real router, with the signed-in user supplied by the test.
const app = express();
app.use(express.json());
app.use("/api/connectors", connectorsRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
test.after(async () => { server.closeAllConnections?.(); server.close(); await client.close(); });
const reconcile = async (as, id, outcome) => {
  currentUser = as;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connectors/actions/${id}/reconcile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outcome }) });
  return { status: response.status, body: await response.json() };
};

test("the person is told the status is unknown, why retrying is risky, and what to check", () => {
  const action = { status: "uncertain", toolName: TOOL, payload: payload(0) };
  assert.equal(copy.canReconcile(action), true);
  assert.equal(copy.UNKNOWN_TITLE, "Upload status unknown");
  const text = copy.unknownBody(action);
  assert.match(text.summary, /guide\.pdf.*not sent again/i);
  assert.match(text.warning, /duplicate/i);
  assert.match(text.steps.join(" "), /Google Drive \(Test Account\).*My Drive.*guide\.pdf/);
  assert.match(text.steps.join(" "), /will not upload anything until you say so and approve a new request/i);
  assert.equal(copy.FOUND_LABEL, "I found the uploaded file");
  assert.equal(copy.NOT_FOUND_LABEL, "I checked; it was not uploaded");
  assert.match(copy.NOT_UPLOADED_CONFIRM.body, /new upload, which you will approve separately/i);
  assert.match(copy.NOT_UPLOADED_CONFIRM.body, /duplicate/i);
  assert.equal(copy.canReconcile({ status: "uncertain", toolName: "notion_create_page" }), false, "only a Drive upload is settled this way");
  assert.equal(copy.canReconcile({ status: "completed", toolName: TOOL }), false);
});

test("a settled upload says it is the person's own word, never that Drive confirmed it", () => {
  const found = copy.settledText({ result: { reconciled: "uploaded" } });
  assert.match(found.body, /Google Drive did not confirm it to us/i);
  assert.match(found.title, /by you/i);
  const missing = copy.settledText({ result: { reconciled: "not_uploaded" } });
  assert.match(missing.body, /ask for it again and approve that new request/i);
  assert.equal(copy.settledText({ result: {} }), null);
});

test("the card asks for confirmation before 'not uploaded', and recording an answer never starts an upload", () => {
  const card = readFileSync(new URL("../frontend/src/components/ActionApprovalCard.jsx", import.meta.url), "utf8");
  assert.match(card, /setConfirmingNotUploaded\(true\)/, "the first click only opens the confirmation");
  assert.match(card, /handleReconcile\("not_uploaded"\)/);
  assert.match(card, /handleReconcile\("uploaded"\)/);
  const handler = card.slice(card.indexOf("const handleReconcile"), card.indexOf("const settled = settledText"));
  assert.match(handler, /\/reconcile/);
  assert.doesNotMatch(handler, /\/approve/, "reconciling never approves or sends anything");
  assert.doesNotMatch(card, /href=\{[^}]*reconcil/i, "no link taken from the answer");
});

test("only the owner can settle an upload, and what they settle keeps its bound artifact, account and destination", async () => {
  const owner = await user();
  const other = await user();
  const card = await uncertainAction(owner);
  const denied = await reconcile(other, card.id, "uploaded");
  assert.equal(denied.status, 400);
  assert.equal((await getActionForUser(owner, card.id)).status, "uncertain", "someone else's answer changed nothing");

  const done = await reconcile(owner, card.id, "uploaded");
  assert.equal(done.status, 200);
  assert.equal(done.body.action.status, "completed");
  assert.equal(done.body.action.result.reconciled, "uploaded");
  assert.equal(done.body.action.result.providerVerified, false, "a declaration, not a provider confirmation");
  assert.equal(done.body.action.result.reconciledBy, "owner");
  assert.ok(done.body.action.result.reconciledAt);
  assert.deepEqual(done.body.action.payload, payload(Number(card.payload.attachmentId.slice(4))), "the bound artifact, account and destination are untouched");
  assert.equal(done.body.action.payloadHash, card.payloadHash);
  assert.equal(done.body.action.result.webViewLink, undefined, "no link is accepted or stored as proof");
});

test("'not uploaded' lets the file be asked for again but starts nothing, and cannot be re-run", async () => {
  const owner = await user();
  const card = await uncertainAction(owner);
  const done = await reconcile(owner, card.id, "not_uploaded");
  assert.equal(done.status, 200);
  assert.equal(done.body.action.status, "failed");
  assert.equal(done.body.action.result.code, "reconciled_not_uploaded");
  assert.match(done.body.action.result.error, /nothing was sent again/i);
  await assert.rejects(approveAndExecuteAction(owner, card.id, card.payloadHash).then((a) => { if (a.status !== "failed") throw new Error("ran"); throw new Error("Action is already failed."); }), /already failed/);
});

test("a bad outcome, a missing action and an action that is not uncertain are all refused and change nothing", async () => {
  const owner = await user();
  const card = await uncertainAction(owner);
  assert.equal((await reconcile(owner, card.id, "maybe")).status, 400);
  assert.equal((await reconcile(owner, "00000000-0000-4000-8000-000000000000", "uploaded")).status, 400);
  assert.equal((await getActionForUser(owner, card.id)).status, "uncertain");
  const pending = await createPendingAction({ userId: owner, toolName: TOOL, actionDescription: "x", payload: payload(++n) });
  assert.equal((await reconcile(owner, pending.id, "uploaded")).status, 400, "a card still waiting for approval is not settled this way");
  assert.equal((await getActionForUser(owner, pending.id)).status, "pending");
});

test("simultaneous and repeated answers apply exactly one, and the loser is told the truth", async () => {
  const owner = await user();
  const card = await uncertainAction(owner);
  const answers = await Promise.all(["uploaded", "not_uploaded", "uploaded", "not_uploaded", "uploaded", "not_uploaded"].map((o) => reconcile(owner, card.id, o)));
  const winners = answers.filter((a) => a.status === 200);
  assert.equal(winners.length, 1, "exactly one answer was applied");
  const final = await getActionForUser(owner, card.id);
  assert.equal(final.result.reconciled, winners[0].body.action.result.reconciled, "the stored answer is the winner's");
  const losers = answers.filter((a) => a.status !== 200);
  assert.ok(losers.every((a) => /already settled|can be settled this way/i.test(a.body.error)), "the others are told it was already settled and nothing changed");
  const again = await reconcile(owner, card.id, final.result.reconciled);
  assert.equal(again.status, 400, "repeating an answer does not apply it twice");
});
