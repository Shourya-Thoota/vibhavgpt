// The dispatch claim for an approved upload, exercised against a real PostgreSQL server with separate connections.
//
// The in-process tests for the Drive upload run on a single-connection embedded database, which serialises everything and so cannot show whether the
// protection works across connections. This file does: it needs TEST_DATABASE_URL (a loopback database whose name contains "test" or "isolated"), the same
// setup as the allowance concurrency test, and it fails in CI when that is missing.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

const { drizzle } = await import("drizzle-orm/node-postgres");
const { eq, inArray } = await import("drizzle-orm");
const { pendingToolActions } = await import("../src/db/schema.js");
const service = await import("../src/connectors/service.js");
const { claimActionForDispatch, reconcileUncertainAction, createPendingAction, setConnectorsDbForTest, leaseDispatch, writeClaimed } = service;

const url = process.env.TEST_DATABASE_URL;
const TOOL = "googledrive_upload_artifact";

function assertIsolated(value) {
  const parsed = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  const marked = /test|isolated/i.test(parsed.pathname);
  if (!loopback || !marked) throw new Error(`Safety Guard Abort: TEST_DATABASE_URL must be a loopback database with 'test' or 'isolated' in its name (got ${parsed.hostname}${parsed.pathname}).`);
}

test("the Drive dispatch claim holds across separate PostgreSQL connections", async (t) => {
  if (!url) {
    if (process.env.CI) throw new Error("CI failure: TEST_DATABASE_URL must be set to verify the dispatch claim against real PostgreSQL.");
    t.skip("TEST_DATABASE_URL is not set; this file only means something against a real PostgreSQL server with several connections.");
    return;
  }
  assertIsolated(url);

  const pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 3000 });
  const db = drizzle(pool);
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder: "./drizzle" });
  setConnectorsDbForTest(db);

  const stamp = Date.now();
  const users = { a: `claim_user_a_${stamp}`, b: `claim_user_b_${stamp}` };
  const made = [];
  t.after(async () => {
    try { if (made.length) await db.delete(pendingToolActions).where(inArray(pendingToolActions.id, made)); } finally { await pool.end().catch(() => {}); }
  });

  const card = async (userId, payload) => {
    const c = await createPendingAction({ userId, toolName: TOOL, actionDescription: "upload", payload });
    made.push(c.id);
    return c;
  };
  const statusOf = async (id) => (await db.select().from(pendingToolActions).where(eq(pendingToolActions.id, id)))[0].status;
  const base = { attachmentId: `att_${stamp}`, sha256: "a".repeat(64), fileName: "guide.pdf", accountRef: "acct0000000000aa", folderName: "My Drive" };

  // Prove the pool really uses separate server connections, so the results below are not an artefact of one session.
  const held = await Promise.all(Array.from({ length: 6 }, () => pool.connect()));
  const pids = new Set((await Promise.all(held.map((c) => c.query("SELECT pg_backend_pid() AS pid")))).map((r) => r.rows[0].pid));
  held.forEach((c) => c.release());
  assert.equal(pids.size, 6, "six distinct PostgreSQL backends");

  await t.test("many simultaneous approvals of one card: exactly one gets to dispatch", async () => {
    const one = await card(users.a, { ...base, attachmentId: `one_${stamp}` });
    const row = { id: one.id, toolName: TOOL, payloadHash: one.payloadHash };
    const results = await Promise.all(Array.from({ length: 10 }, () => claimActionForDispatch(users.a, row)));
    assert.equal(results.filter((r) => r.row).length, 1, "one claim");
    assert.equal(await statusOf(one.id), "in_progress");
  });

  await t.test("two cards for the same operation approved at once: exactly one gets to dispatch", async () => {
    const payload = { ...base, attachmentId: `twin_${stamp}` };
    const [x, y] = [await card(users.a, payload), await card(users.a, payload)];
    assert.equal(x.payloadHash, y.payloadHash, "same operation");
    const results = await Promise.all([x, y, x, y, x, y].map((c) => claimActionForDispatch(users.a, { id: c.id, toolName: TOOL, payloadHash: c.payloadHash })));
    assert.equal(results.filter((r) => r.row).length, 1, "one claim among the six attempts");
    assert.ok(results.filter((r) => r.blockedBy === "in_progress").length >= 1, "the other card is told it is in flight");
    const winner = results.find((r) => r.row).row.id;
    assert.equal(await statusOf(winner === x.id ? y.id : x.id), "pending", "the loser is left usable, not failed");
  });

  await t.test("the protection is scoped to the same user and the same operation", async () => {
    const other = { ...base, attachmentId: `scope_${stamp}` };
    const mine = await card(users.a, other);
    const theirs = await card(users.b, other);
    const differentFolder = await card(users.a, { ...other, folderName: "Notes", folderId: "f1" });
    const differentAccount = await card(users.a, { ...other, accountRef: "acct0000000000bb" });
    const differentFile = await card(users.a, { ...other, sha256: "b".repeat(64) });
    const claims = await Promise.all([[users.a, mine], [users.b, theirs], [users.a, differentFolder], [users.a, differentAccount], [users.a, differentFile]]
      .map(([u, c]) => claimActionForDispatch(u, { id: c.id, toolName: TOOL, payloadHash: c.payloadHash })));
    assert.ok(claims.every((c) => c.row), "another person's, another folder's, another account's and another file's cards are not blocked by it");
    const stolen = await claimActionForDispatch(users.b, { id: mine.id, toolName: TOOL, payloadHash: mine.payloadHash });
    assert.equal(stolen.row, null, "a card can only be claimed by its own owner");
  });

  await t.test("a failed pre-dispatch attempt frees the file; a completed one cannot run again", async () => {
    const payload = { ...base, attachmentId: `fail_${stamp}` };
    const [first, second, third] = [await card(users.a, payload), await card(users.a, payload), await card(users.a, payload)];
    const claim1 = await claimActionForDispatch(users.a, { id: first.id, toolName: TOOL, payloadHash: first.payloadHash });
    assert.ok(claim1.row);
    await db.update(pendingToolActions).set({ status: "failed", result: { dispatchStatus: "pre_dispatch_failure" } }).where(eq(pendingToolActions.id, first.id));
    const claim2 = await claimActionForDispatch(users.a, { id: second.id, toolName: TOOL, payloadHash: second.payloadHash });
    assert.ok(claim2.row, "after a failure before anything was sent, the file can be tried again");
    await db.update(pendingToolActions).set({ status: "completed" }).where(eq(pendingToolActions.id, second.id));
    assert.equal((await claimActionForDispatch(users.a, { id: second.id, toolName: TOOL, payloadHash: second.payloadHash })).row, null, "a completed card cannot be claimed again");
    assert.equal((await claimActionForDispatch(users.a, { id: first.id, toolName: TOOL, payloadHash: first.payloadHash })).row, null, "nor a failed one");
    const claim3 = await claimActionForDispatch(users.a, { id: third.id, toolName: TOOL, payloadHash: third.payloadHash });
    assert.equal(claim3.blockedBy, undefined, "a completed twin does not block the claim; the repeat is then recognised as already done before any dispatch");
  });

  await t.test("a slow upload that is still running is never made eligible; a claim that outlived any bounded upload becomes uncertain and needs a person", async () => {
    const payload = { ...base, attachmentId: `slow_${stamp}` };
    const [running, other] = [await card(users.a, payload), await card(users.a, payload)];
    assert.ok((await claimActionForDispatch(users.a, { id: running.id, toolName: TOOL, payloadHash: running.payloadHash })).row);
    // Well past a minute, still inside the window in which a bounded upload could be running: blocked as in flight.
    await pool.query("UPDATE pending_tool_actions SET updated_at = now() - interval '90 seconds' WHERE id = $1", [running.id]);
    assert.equal((await claimActionForDispatch(users.a, { id: other.id, toolName: TOOL, payloadHash: other.payloadHash })).blockedBy, "in_progress");
    // Past every timeout in the hand-off: recorded as unconfirmed, and still not free to repeat.
    await pool.query("UPDATE pending_tool_actions SET updated_at = now() - interval '10 minutes' WHERE id = $1", [running.id]);
    const blocked = await claimActionForDispatch(users.a, { id: other.id, toolName: TOOL, payloadHash: other.payloadHash });
    assert.equal(blocked.blockedBy, "uncertain");
    assert.equal(await statusOf(running.id), "uncertain");
    assert.equal(await statusOf(other.id), "pending");
    // The person says the file is not in their Drive; only then can it be sent again, and only once.
    await reconcileUncertainAction(users.a, running.id, "not_uploaded");
    const [retry, retry2] = await Promise.all([other, other].map((c) => claimActionForDispatch(users.a, { id: c.id, toolName: TOOL, payloadHash: c.payloadHash })));
    assert.equal([retry, retry2].filter((r) => r.row).length, 1);
  });

  await t.test("the lease is taken only while the claim is plainly in flight", async () => {
    const c = await card(users.a, { ...base, attachmentId: `lease_${stamp}` });
    const row = { id: c.id, toolName: TOOL, payloadHash: c.payloadHash };
    assert.equal(await leaseDispatch(c.id, { result: { dispatchStatus: "dispatch_started" } }), null, "not before it is claimed");
    assert.ok((await claimActionForDispatch(users.a, row)).row);
    assert.ok(await leaseDispatch(c.id, { result: { dispatchStatus: "dispatch_started" } }), "while in flight");
    await pool.query("UPDATE pending_tool_actions SET status = 'uncertain', result = '{\"code\":\"claim_abandoned\"}'::jsonb WHERE id = $1", [c.id]);
    assert.equal(await leaseDispatch(c.id, { result: { dispatchStatus: "dispatch_started" } }), null, "a claim marked unconfirmed must not start sending");
    assert.ok(await writeClaimed(c.id, { result: { code: "claim_abandoned", late: true } }), "but a late honest answer may still be recorded");
    await reconcileUncertainAction(users.a, c.id, "not_uploaded");
    assert.equal(await writeClaimed(c.id, { status: "completed", result: { id: "late" } }), null, "a settled action cannot be overwritten by a worker");
    assert.equal(await statusOf(c.id), "failed");
  });

  await t.test("a person's settlement and a still-running worker's answer race: exactly one is applied, never a mixture", async () => {
    for (let round = 0; round < 20; round += 1) {
      const c = await card(users.a, { ...base, attachmentId: `race_${stamp}_${round}` });
      await pool.query("UPDATE pending_tool_actions SET status = 'uncertain', result = '{\"code\":\"claim_abandoned\"}'::jsonb WHERE id = $1", [c.id]);
      const outcomes = await Promise.allSettled([
        reconcileUncertainAction(users.a, c.id, "not_uploaded"),
        writeClaimed(c.id, { status: "completed", executedAt: new Date(), result: { id: "provider_file", dispatchStatus: "dispatched_succeeded" } }).then((r) => { if (!r) throw new Error("fenced"); return r; }),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, `round ${round}: exactly one applied`);
      const [final] = await db.select().from(pendingToolActions).where(eq(pendingToolActions.id, c.id));
      const reconciled = final.result?.reconciled === "not_uploaded";
      const providerWon = final.result?.id === "provider_file";
      assert.ok(reconciled !== providerWon, `round ${round}: one coherent record`);
      assert.equal(final.status, reconciled ? "failed" : "completed");
    }
  });

  await t.test("ten simultaneous settlements of one uncertain upload apply exactly one", async () => {
    const c = await card(users.a, { ...base, attachmentId: `settle_${stamp}` });
    await pool.query("UPDATE pending_tool_actions SET status = 'uncertain' WHERE id = $1", [c.id]);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reconcileUncertainAction(users.a, c.id, i % 2 ? "uploaded" : "not_uploaded")));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => /settled/i.test(String(r.reason.message))));
  });
});
