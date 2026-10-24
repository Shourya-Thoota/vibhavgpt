import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Survey completion lives on the account: the route and the /api/me fields
// against an in-memory database, then the client's choice of whether to show it.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const client = new PGlite();
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, {
  namedExports: { db, pool: { query: (sql, params) => client.query(sql, params) } },
});
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});

const { default: express } = await import("express");
const { profileRouter, surveyStatus } = await import("../src/profile/router.js");

async function patchOnboarding(t, userId, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/profile", profileRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profile/onboarding`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const answers = {
  onboarding_completed: true, preferred_name: "Annie", role: ["study", "not-a-role"], expertise: "expert",
  personality: { concise_detailed: 15 }, units: "metric", primary_capability: "study", sky: "light", theme: "nebula",
};

test("finishing the survey marks the account done and keeps the answers, minus the name", async (t) => {
  assert.equal((await surveyStatus("member-a")).surveyCompleted, false, "a new account has not done it");
  const saved = await patchOnboarding(t, "member-a", { completed: true, answers });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.surveyCompleted, true);
  assert.ok(saved.body.surveyCompletedAt);
  assert.deepEqual(saved.body.onboarding.role, ["study"], "answers are re-validated");
  assert.equal(saved.body.onboarding.theme, "nebula");
  assert.equal("preferred_name" in saved.body.onboarding, false, "the name stays in the reviewed instructions");
  const [row] = (await client.query("SELECT onboarding_completed, onboarding_answers FROM user_profiles WHERE user_id = 'member-a'")).rows;
  assert.equal(row.onboarding_completed, true);
  assert.equal(JSON.stringify(row.onboarding_answers).includes("Annie"), false);

  // What /api/me adds to the user: any later session, on any device, sees it.
  const me = await surveyStatus("member-a");
  assert.equal(me.surveyCompleted, true);
  assert.equal(me.onboarding.primary_capability, "study");
});

test("a skip marks it done without answers, and never erases earlier ones or the first date", async (t) => {
  const skipped = await patchOnboarding(t, "member-b", { completed: true });
  assert.equal(skipped.status, 200);
  assert.deepEqual({ done: skipped.body.surveyCompleted, answers: skipped.body.onboarding }, { done: true, answers: null });

  const first = (await patchOnboarding(t, "member-a", { completed: true })).body;
  assert.equal(first.onboarding.theme, "nebula", "a skip after answering keeps the answers");
  const again = (await patchOnboarding(t, "member-a", { completed: true, answers: { ...answers, theme: "deep-space" } })).body;
  assert.equal(again.onboarding.theme, "deep-space", "Settings tweaks update them");
  assert.equal(again.surveyCompletedAt, first.surveyCompletedAt, "the first completion time is kept");
});

test("the route only records completion, and only for a signed-in account", async (t) => {
  for (const body of [{}, { completed: false }, { completed: "yes" }]) {
    assert.equal((await patchOnboarding(t, "member-c", body)).status, 400);
  }
  assert.equal((await surveyStatus("member-c")).surveyCompleted, false);
  assert.equal((await patchOnboarding(t, null, { completed: true })).status, 401);
});

test("/api/me carries the survey fields on the user", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /const survey = await surveyStatus\(session\.user\.id\);/);
  assert.match(server, /user: \{ \.\.\.session\.user, \.\.\.names, hasPassword: [^}]*, \.\.\.survey \}/);
});

/* --- The client ---------------------------------------------------------- */

function withStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

test("a new device or a fresh sign-in follows the account, not this browser", async (t) => {
  t.after(() => { delete globalThis.localStorage; });
  const { onboardingForUser } = await import("../frontend/src/onboarding.js");

  withStorage();
  assert.equal(onboardingForUser({ id: "u1", surveyCompleted: true, onboarding: null }).onboarding_completed, true, "done on another device: no prompt");
  const restored = onboardingForUser({ id: "u1", surveyCompleted: true, onboarding: { theme: "nebula", sky: "light", primary_capability: "study" } });
  assert.deepEqual([restored.theme, restored.sky, restored.primary_capability], ["nebula", "light", "study"], "answers come back too");
  assert.equal(onboardingForUser({ id: "u1", surveyCompleted: false, onboarding: null }).onboarding_completed, false, "a new account is asked");

  withStorage({ "vibhavgpt-onboarding:u2": JSON.stringify({ onboarding_completed: true, preferred_name: "Annie" }) });
  const legacy = onboardingForUser({ id: "u2", surveyCompleted: false, onboarding: null });
  assert.equal(legacy.onboarding_completed, true, "this browser's older record still counts until the account hears");
  assert.equal(onboardingForUser({ id: "u2", surveyCompleted: true, onboarding: { theme: "nebula" } }).preferred_name, "Annie", "the local name is kept");
});

test("the workspace opens the survey from the account and saves before closing it", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /useState\(\(\) => writeOnboarding\(user\.id, onboardingForUser\(user\)\)\)/);
  assert.match(app, /const \[surveyOpen, setSurveyOpen\] = useState\(\(\) => !onboarding\.onboarding_completed\);/);
  assert.match(app, /pathname === "\/onboarding" && onboardingForUser\(user\)\.onboarding_completed/, "the route guard asks the account too");
  const finish = app.slice(app.indexOf("const finishSurvey = useCallback"), app.indexOf("const rerunSurvey"));
  assert.ok(finish.indexOf("await saveSurveyStatus({ ...record") < finish.indexOf("leaveSurvey({ ...record"), "finish saves, then closes");
  assert.ok(finish.indexOf("await saveSurveyStatus()") < finish.indexOf("leaveSurvey({ ...onboarding"), "skip saves, then closes");
  assert.match(app, /api\("\/api\/profile\/onboarding", \{\s*method: "PATCH"/);
  assert.match(app, /if \(user\.surveyCompleted !== true && readOnboarding\(user\.id\)\.onboarding_completed\) void saveSurveyStatus\(\)/, "older browsers sync up once");
});
