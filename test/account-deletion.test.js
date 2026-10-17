import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deleteAccountData } from "../src/account/deletion.js";

async function applyMigrations(client) {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  }
}

// Stand-ins for the auth library's tables. Their foreign keys deliberately
// have no ON DELETE CASCADE: deletion must clear them itself.
const AUTH_TABLES = `
  CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL);
  CREATE TABLE "session" (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id));
  CREATE TABLE "account" (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id));
  CREATE TABLE "passkey" (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id));
  CREATE TABLE "twoFactor" (id text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id));
  CREATE TABLE "verification" (id text PRIMARY KEY, identifier text NOT NULL);
`;

async function seed(client, id, email) {
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [id, email]);
  for (const table of ["session", "account", "passkey", "twoFactor"]) {
    await client.query(`INSERT INTO "${table}" (id, "userId") VALUES ($1, $2)`, [`${table}-${id}`, id]);
  }
  await client.query(`INSERT INTO "verification" (id, identifier) VALUES ($1, $2)`, [`otp-${id}`, `sign-in-otp-${email}`]);
  await client.query(`INSERT INTO user_profiles (user_id) VALUES ($1)`, [id]);
  const { rows: [group] } = await client.query(`INSERT INTO conversation_groups (user_id, kind, name) VALUES ($1, 'project', 'Thesis') RETURNING id`, [id]);
  await client.query(`INSERT INTO conversation_groups (user_id, kind, name, parent_id) VALUES ($1, 'folder', 'Drafts', $2)`, [id, group.id]);
  const { rows: [conversation] } = await client.query(`INSERT INTO conversations (user_id, title, model, group_id) VALUES ($1, 'Chat', 'nova', $2) RETURNING id`, [id, group.id]);
  await client.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'hello')`, [conversation.id]);
  await client.query(`INSERT INTO memory_facts (user_id, content, source) VALUES ($1, 'Likes tea', 'chat')`, [id]);
  await client.query(`INSERT INTO image_folders (user_id, name) VALUES ($1, 'Moodboard')`, [id]);
  await client.query(`INSERT INTO voice_live_sessions (user_id, tier, requested_model, actual_model, reserved_seconds) VALUES ($1, 'pro', 'x', 'x', 60)`, [id]);
}

const OWNED = ["user_profiles", "conversations", "conversation_groups", "memory_facts", "image_folders", "voice_live_sessions"];

async function count(client, table, where, value) {
  const { rows: [row] } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where} = $1`, [value]);
  return row.n;
}

test("deleting an account removes everything it owns and nothing else", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  await applyMigrations(client);
  await client.exec(AUTH_TABLES);
  await seed(client, "leaving", "a@b.com");
  await seed(client, "staying", "ba@b.com");

  const result = await deleteAccountData(drizzle(client), "leaving");
  assert.equal(result.userDeleted, true);

  assert.equal(await count(client, `"user"`, "id", "leaving"), 0);
  for (const table of ["session", "account", "passkey", "twoFactor"]) {
    assert.equal(await count(client, `"${table}"`, `"userId"`, "leaving"), 0, table);
    assert.equal(await count(client, `"${table}"`, `"userId"`, "staying"), 1, `${table} of another account is kept`);
  }
  for (const table of OWNED) {
    assert.equal(await count(client, table, "user_id", "leaving"), 0, table);
    assert.equal(await count(client, table, "user_id", "staying") > 0, true, `${table} of another account is kept`);
  }
  assert.equal(await count(client, "messages m JOIN conversations c ON c.id = m.conversation_id", "c.user_id", "leaving"), 0);
  // "a@b.com" must not take "ba@b.com"'s pending code with it.
  assert.equal(await count(client, `"verification"`, "identifier", "sign-in-otp-a@b.com"), 0);
  assert.equal(await count(client, `"verification"`, "identifier", "sign-in-otp-ba@b.com"), 1);
});

test("the legacy Google Play tables are dropped, and deletion no longer refers to them", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  await applyMigrations(client);
  for (const table of ["google_play_purchases", "google_play_accounts", "google_play_notifications"]) {
    const { rows: [row] } = await client.query(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
    assert.equal(row.name, null, `${table} should not exist after migrations`);
  }
  // The drop is idempotent: running it again on a database without the tables is a no-op.
  await client.exec(await readFile(new URL("../drizzle/0025_drop_google_play_tables.sql", import.meta.url), "utf8"));
  const source = await readFile(new URL("../src/account/deletion.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /googlePlay|google_play/);
  const schema = await readFile(new URL("../src/db/schema.js", import.meta.url), "utf8");
  assert.doesNotMatch(schema, /googlePlay|google_play/);
});

test("a failed deletion rolls back and leaves the account whole", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  await applyMigrations(client);
  await client.exec(AUTH_TABLES);
  await seed(client, "leaving", "a@b.com");
  // A table that still points at the user and is not cleared stops the
  // final delete; nothing before it may stick.
  await client.exec(`CREATE TABLE blocker ("userId" text REFERENCES "user"(id)); INSERT INTO blocker VALUES ('leaving');`);
  await assert.rejects(deleteAccountData(drizzle(client), "leaving"));
  assert.equal(await count(client, `"user"`, "id", "leaving"), 1);
  assert.equal(await count(client, "conversations", "user_id", "leaving"), 1);
  assert.equal(await count(client, `"session"`, `"userId"`, "leaving"), 1);
});

// Deletion is refused, and nothing deleted, while a plan could still renew or
// charge. The route is mounted on its own app with a stub session and file
// remover; the payment provider is never called.
async function loadAccountModules() {
  process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
  const { config } = await import("../src/config.js");
  config.databaseUrl ||= process.env.DATABASE_URL;
  // The route module loads the auth library, which needs a secret to start.
  config.authSecret ||= "test-only-auth-secret-not-used-for-anything-real";
  const { deleteAccountHandler } = await import("../src/account/router.js");
  const { deletionBlock, WEB_PLAN_BLOCK, OTHER_PLAN_BLOCK } = await import("../src/account/deletion.js");
  return { deleteAccountHandler, deletionBlock, WEB_PLAN_BLOCK, OTHER_PLAN_BLOCK };
}

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 10 * DAY);
const past = () => new Date(Date.now() - DAY);

async function withDeletionApp(t, subscription) {
  const { default: express } = await import("express");
  const { deleteAccountHandler } = await loadAccountModules();
  const client = new PGlite();
  t.after(() => client.close());
  await applyMigrations(client);
  await client.exec(AUTH_TABLES);
  await seed(client, "leaving", "a@b.com");
  if (subscription) {
    const s = { tier: "pro", status: "active", billingSource: "stripe", cancelAtPeriodEnd: false, currentPeriodEndsAt: future(), ...subscription };
    await client.query(
      `INSERT INTO subscriptions (user_id, subscription_id, tier, status, billing_source, cancel_at_period_end, current_period_ends_at)
       VALUES ('leaving', 'sub_test', $1, $2, $3, $4, $5)`,
      [s.tier, s.status, s.billingSource, s.cancelAtPeriodEnd, s.currentPeriodEndsAt],
    );
  }
  const removedUploads = [];
  const app = express();
  app.use((req, _res, next) => { req.authSession = { user: { id: "leaving" } }; next(); });
  app.delete("/api/account", deleteAccountHandler({ database: drizzle(client), deleteUploads: async (id) => { removedUploads.push(id); } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/account`, { method: "DELETE" });
  const body = response.status === 204 ? null : await response.json();
  return { client, response, body, removedUploads };
}

async function assertNothingDeleted(client, removedUploads) {
  assert.equal(await count(client, `"user"`, "id", "leaving"), 1);
  assert.equal(await count(client, "conversations", "user_id", "leaving"), 1);
  assert.equal(await count(client, "subscriptions", "user_id", "leaving"), 1);
  assert.equal(await count(client, `"session"`, `"userId"`, "leaving"), 1);
  assert.deepEqual(removedUploads, [], "stored files are kept too");
}

async function assertEverythingDeleted(client, removedUploads) {
  assert.equal(await count(client, `"user"`, "id", "leaving"), 0);
  assert.equal(await count(client, "conversations", "user_id", "leaving"), 0);
  assert.equal(await count(client, "subscriptions", "user_id", "leaving"), 0);
  assert.equal(await count(client, `"session"`, `"userId"`, "leaving"), 0);
  assert.deepEqual(removedUploads, ["leaving"]);
}

test("an active, renewing web plan blocks deletion with 409 and deletes nothing", async (t) => {
  const { WEB_PLAN_BLOCK } = await loadAccountModules();
  for (const status of ["active", "trialing"]) {
    const { client, response, body, removedUploads } = await withDeletionApp(t, { status });
    assert.equal(response.status, 409, status);
    assert.deepEqual(body, { error: WEB_PLAN_BLOCK, code: "active-subscription" });
    await assertNothingDeleted(client, removedUploads);
  }
});

test("a web plan that is past due or unpaid also blocks deletion", async (t) => {
  for (const status of ["past_due", "unpaid"]) {
    const { client, response, body, removedUploads } = await withDeletionApp(t, { status });
    assert.equal(response.status, 409, status);
    assert.equal(body.code, "active-subscription");
    await assertNothingDeleted(client, removedUploads);
  }
});

test("a web plan already canceled for the period end does not block deletion", async (t) => {
  const { client, response, removedUploads } = await withDeletionApp(t, { status: "active", cancelAtPeriodEnd: true, currentPeriodEndsAt: future() });
  assert.equal(response.status, 204);
  await assertEverythingDeleted(client, removedUploads);
});

test("no plan, a free plan, an ended period or a canceled plan never blocks deletion", async (t) => {
  for (const subscription of [null, { tier: "free" }, { currentPeriodEndsAt: past() }, { status: "canceled" }]) {
    const { client, response, removedUploads } = await withDeletionApp(t, subscription);
    assert.equal(response.status, 204, JSON.stringify(subscription));
    await assertEverythingDeleted(client, removedUploads);
  }
});

test("a paid plan bought outside the web blocks deletion with its own message", async (t) => {
  const { OTHER_PLAN_BLOCK } = await loadAccountModules();
  const { client, response, body, removedUploads } = await withDeletionApp(t, { billingSource: "google_play", cancelAtPeriodEnd: true });
  assert.equal(response.status, 409);
  assert.deepEqual(body, { error: OTHER_PLAN_BLOCK, code: "active-subscription" });
  await assertNothingDeleted(client, removedUploads);
});

test("the blocked messages name no provider and claim no cancellation", async () => {
  const { deletionBlock, WEB_PLAN_BLOCK, OTHER_PLAN_BLOCK } = await loadAccountModules();
  assert.equal(WEB_PLAN_BLOCK, "You have an active plan. Cancel it in Plan and billing, then delete your account. Nothing was deleted.");
  assert.equal(OTHER_PLAN_BLOCK, "Your plan was bought outside the web, so it can't be canceled here. Cancel it where you bought it, then delete your account. Nothing was deleted.");
  for (const text of [WEB_PLAN_BLOCK, OTHER_PLAN_BLOCK]) {
    assert.ok(!text.includes(String.fromCharCode(0x2014)), "no em dash");
    assert.doesNotMatch(text, /was canceled|stripe|google|play store|app store/i);
  }
  // No period end on record counts as a period still running.
  assert.equal(deletionBlock({ tier: "plus", status: "active", billingSource: "stripe", cancelAtPeriodEnd: false, currentPeriodEndsAt: null })?.code, "active-subscription");
  assert.equal(deletionBlock(undefined), null);
});

test("canceling a web plan stores cancelAtPeriodEnd locally, without waiting for the webhook", async (t) => {
  await loadAccountModules();
  const { cancelSubscriptionForUser } = await import("../src/billing/service.js");
  const client = new PGlite();
  t.after(() => client.close());
  await applyMigrations(client);
  const periodEnd = Math.floor(future().getTime() / 1000);
  await client.query(
    `INSERT INTO subscriptions (user_id, customer_id, subscription_id, tier, status, billing_source, cancel_at_period_end, current_period_ends_at)
     VALUES ('member', 'cus_member', 'sub_member', 'pro', 'active', 'stripe', false, to_timestamp($1))`,
    [periodEnd],
  );
  const updates = [];
  const stripe = { subscriptions: { update: async (id, params) => {
    updates.push([id, params]);
    return { id, customer: "cus_member", status: "active", cancel_at_period_end: true, current_period_start: periodEnd - 30 * 86400, current_period_end: periodEnd };
  } } };
  const result = await cancelSubscriptionForUser("member", { stripe, executor: drizzle(client) });
  assert.deepEqual(updates, [["sub_member", { cancel_at_period_end: true }]]);
  assert.equal(result.cancelAtPeriodEnd, true);
  const { rows: [row] } = await client.query(`SELECT cancel_at_period_end, status, tier FROM subscriptions WHERE user_id = 'member'`);
  assert.deepEqual(row, { cancel_at_period_end: true, status: "active", tier: "pro" });
});
