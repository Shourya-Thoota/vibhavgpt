import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Migrations 0026 and 0027 rewrite the stored legacy "qwen" model key to
// "lumen". They run on an in-memory database with every earlier migration
// applied, so they meet the same schema they will meet in production.
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const sql = (tag) => readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
const KEY_MIGRATIONS = ["0026_qwen_key_to_lumen", "0027_qwen_usage_events_to_lumen"];

async function databaseBefore(t, tag) {
  const client = new PGlite();
  t.after(() => client.close());
  for (const entry of journal.entries) {
    if (entry.tag === tag) break;
    await client.exec(await sql(entry.tag));
  }
  return client;
}

async function seed(client) {
  const profiles = [["u-qwen", "qwen", "qwen"], ["u-mixed", "nova", "qwen"], ["u-other", "nebula", "vesper"], ["u-empty", null, null]];
  for (const [id, preferred, lastUsed] of profiles) {
    await client.query("INSERT INTO user_profiles (user_id, preferred_model, last_used_model) VALUES ($1, $2, $3)", [id, preferred, lastUsed]);
  }
  for (const [user, model] of [["u-qwen", "qwen"], ["u-qwen", "nova"], ["u-other", "spark"], ["u-other", "lumen"]]) {
    await client.query("INSERT INTO conversations (user_id, title, model) VALUES ($1, 'Chat', $2)", [user, model]);
  }
  for (const [user, model] of [["u-qwen", "qwen"], ["u-qwen", "qwen"], ["u-other", "nova"], ["u-other", "__image__"]]) {
    await client.query("INSERT INTO usage_events (user_id, model) VALUES ($1, $2)", [user, model]);
  }
}

async function snapshot(client) {
  const profiles = (await client.query("SELECT user_id, preferred_model, last_used_model, updated_at FROM user_profiles ORDER BY user_id")).rows;
  const conversations = (await client.query("SELECT user_id, model, updated_at FROM conversations ORDER BY user_id, model")).rows;
  const usage = (await client.query("SELECT model, count(*)::int AS n FROM usage_events GROUP BY model ORDER BY model")).rows;
  return { profiles, conversations, usage };
}

test("the two key migrations follow 0025 in the journal, in order, with their files present", () => {
  const tags = journal.entries.map((entry) => entry.tag);
  const at = tags.indexOf("0025_drop_google_play_tables");
  assert.deepEqual(tags.slice(at, at + 3), ["0025_drop_google_play_tables", ...KEY_MIGRATIONS]);
  // Drizzle applies only migrations newer than the newest one already applied,
  // so each new entry must be newer than every entry before it.
  for (const tag of KEY_MIGRATIONS) {
    const position = tags.indexOf(tag);
    const newestBefore = Math.max(...journal.entries.slice(0, position).map((entry) => entry.when));
    assert.ok(journal.entries[position].when > newestBefore, `${tag} is newer than every earlier migration`);
  }
  // The journal's idx stopped matching array position long ago; new entries
  // continue it by one, as 0025 did.
  for (const tag of KEY_MIGRATIONS) {
    const position = tags.indexOf(tag);
    assert.equal(journal.entries[position].idx, journal.entries[position - 1].idx + 1, `${tag} has the next idx`);
  }
  for (const entry of journal.entries) assert.ok(existsSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url)), `${entry.tag}.sql exists`);
});

test("0026 rewrites qwen to lumen in model preferences and conversations only", async (t) => {
  const client = await databaseBefore(t, "0026_qwen_key_to_lumen");
  await seed(client);
  const before = await snapshot(client);
  await client.exec(await sql("0026_qwen_key_to_lumen"));
  const after = await snapshot(client);

  assert.deepEqual(after.profiles.map(({ user_id, preferred_model, last_used_model }) => [user_id, preferred_model, last_used_model]), [
    ["u-empty", null, null],
    ["u-mixed", "nova", "lumen"],
    ["u-other", "nebula", "vesper"],
    ["u-qwen", "lumen", "lumen"],
  ]);
  assert.deepEqual(after.conversations.map(({ user_id, model }) => [user_id, model]), [
    ["u-other", "lumen"], ["u-other", "spark"], ["u-qwen", "lumen"], ["u-qwen", "nova"],
  ]);
  assert.deepEqual(after.usage, before.usage, "usage_events is left for 0027");
  assert.deepEqual(after.profiles.map((row) => row.updated_at), before.profiles.map((row) => row.updated_at), "updated_at is not touched");

  await client.exec(await sql("0026_qwen_key_to_lumen"));
  assert.deepEqual(await snapshot(client), after, "a second run changes nothing");
});

test("0027 rewrites qwen to lumen in usage_events and nothing else", async (t) => {
  const client = await databaseBefore(t, "0026_qwen_key_to_lumen");
  await seed(client);
  await client.exec(await sql("0026_qwen_key_to_lumen"));
  const before = await snapshot(client);
  await client.exec(await sql("0027_qwen_usage_events_to_lumen"));
  const after = await snapshot(client);

  assert.deepEqual(after.usage, [{ model: "__image__", n: 1 }, { model: "lumen", n: 2 }, { model: "nova", n: 1 }]);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.conversations, before.conversations);

  await client.exec(await sql("0027_qwen_usage_events_to_lumen"));
  assert.deepEqual(await snapshot(client), after, "a second run changes nothing");
});

test("on a database with no qwen rows both migrations change nothing", async (t) => {
  const client = await databaseBefore(t, "0026_qwen_key_to_lumen");
  await client.query("INSERT INTO user_profiles (user_id, preferred_model, last_used_model) VALUES ('u', 'nova', 'lumen')");
  await client.query("INSERT INTO conversations (user_id, title, model) VALUES ('u', 'Chat', 'nebula')");
  await client.query("INSERT INTO usage_events (user_id, model) VALUES ('u', 'vesper')");
  const before = await snapshot(client);
  for (const tag of KEY_MIGRATIONS) await client.exec(await sql(tag));
  assert.deepEqual(await snapshot(client), before);
});

test("the qwen alias is gone from the code now that the migrations are live", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  for (const path of ["../src/chat/router.js", "../src/chat/providers.js", "../frontend/src/token-quotas.js", "../frontend/src/App.jsx"]) {
    assert.doesNotMatch(await read(path), /qwen/i, path);
  }
});
