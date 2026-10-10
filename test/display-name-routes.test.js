import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// The profile route and the sign-in email against an in-memory database.
// Placeholder terms come from test/setup-env.js; no email is really sent.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
await client.exec('CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL DEFAULT \'\', email text NOT NULL)');
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
// Each request below carries its session already; the auth library is not
// started on the stand-in pool.
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { config } = await import("../src/config.js");
config.moderationApiKey = "";
config.providerKeys.primaryFree = "";
const { default: express } = await import("express");
const { profileRouter } = await import("../src/profile/router.js");
const { sendOtpEmail } = await import("../src/email/service.js");

const callMe = (name) => `My own notes.\n\n<!-- vibhavgpt:personality -->\nHow I like answers written:\n- Call the user ${name} when addressing them by name is natural.\n<!-- /vibhavgpt:personality -->`;

async function patchPreferences(t, userId, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/profile", profileRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profile/preferences`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const storedInstructions = async (userId) => (await client.query("SELECT custom_instructions FROM user_profiles WHERE user_id = $1", [userId])).rows[0]?.custom_instructions;

test("the survey's Call me name is refused with 400 when blocked and saved when good", async (t) => {
  for (const name of ["Zorblax", "s n a r f b l a t", "visit example.com"]) {
    const refused = await patchPreferences(t, "member-a", { customInstructions: callMe(name) });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { code: "name-not-allowed", error: "Please choose a different name." });
  }
  assert.equal(await storedInstructions("member-a"), undefined, "nothing is saved");
  const ok = await patchPreferences(t, "member-a", { customInstructions: callMe("Annie") });
  assert.equal(ok.status, 200);
  assert.match(await storedInstructions("member-a"), /Call the user Annie/);
});

test("an unchanged stored Call me name does not block saving other settings", async (t) => {
  await client.query("INSERT INTO user_profiles (user_id, custom_instructions) VALUES ($1, $2)", ["member-b", callMe("Zorblax")]);
  const ok = await patchPreferences(t, "member-b", { responseStyle: "concise" });
  assert.equal(ok.status, 200);
  const changed = await patchPreferences(t, "member-b", { customInstructions: callMe("g.r.u.x") });
  assert.equal(changed.status, 400, "a new blocked name is still refused");
});

test("a sign-in email greets a blocked stored name as there", async (t) => {
  await client.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)', ["member-c", "Zorblax Person", "c@example.invalid", "member-d", "Anna Smith", "d@example.invalid"]);
  const saved = { key: config.resendApiKey, fetch: globalThis.fetch };
  config.resendApiKey = "placeholder-mail-key";
  const sent = [];
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "message" }), { status: 200 }); };
  t.after(() => { config.resendApiKey = saved.key; globalThis.fetch = saved.fetch; });
  await sendOtpEmail({ email: "c@example.invalid", otp: "123456", type: "sign-in" });
  await sendOtpEmail({ email: "d@example.invalid", otp: "123456", type: "sign-in" });
  assert.match(sent[0].text, /^Hi there,/);
  assert.match(sent[0].html, /Hi there,/);
  assert.doesNotMatch(`${sent[0].text}${sent[0].html}`, /zorblax/i);
  assert.match(sent[1].text, /^Hi Anna,/);
});
