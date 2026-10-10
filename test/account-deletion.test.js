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

test("billing cancellation finds the subscription without relying on search", async () => {
  process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
  const { config } = await import("../src/config.js");
  config.databaseUrl ||= process.env.DATABASE_URL;
  const { cancelActiveSubscriptionsForUser } = await import("../src/billing/service.js");
  const cancelled = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id) => ({ id, status: "active" }),
      list: async ({ customer }) => ({ data: [{ id: `${customer}-old`, status: "canceled" }, { id: `${customer}-live`, status: "trialing" }] }),
      search: async () => { throw new Error("Search is not available on this account."); },
      cancel: async (id) => { cancelled.push(id); },
    },
  };
  const ids = await cancelActiveSubscriptionsForUser("user-1", { subscriptionId: "sub_1", customerIds: ["cus_1", null, "cus_1"] }, stripe);
  assert.deepEqual(ids.sort(), ["cus_1-live", "sub_1"]);
  assert.deepEqual(cancelled.sort(), ["cus_1-live", "sub_1"]);
});
