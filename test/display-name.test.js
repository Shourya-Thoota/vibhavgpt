import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

// The terms come from test/setup-env.js: "grux" (short), "zorblax" (long)
// and "snarf blat" (two words), all made up. Nothing here calls a real
// moderation endpoint.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { config } = await import("../src/config.js");
const {
  checkDisplayName, reviewDisplayName, safeDisplayName, visibleNameFields, preferredNameFromInstructions,
  withoutBlockedPreferredName, withoutBlockedNameFacts, warnIfNameBlocklistMissing, NAME_NOT_ALLOWED,
} = await import("../src/security/display-name.js");
const { displayNameHooks } = await import("../src/auth/display-name-hooks.js");
const { buildPreferenceSystemPrompt } = await import("../src/chat/prompts.js");
const { buildMemorySystemPrompt } = await import("../src/memory/service.js");
const { buildInstructions } = await import("../src/voice/live-comet.js");
const { auditRows } = await import("../scripts/audit-display-names.js");
const { workspaceNames, NAMELESS_GREETING } = await import("../frontend/src/display-names.js");

const callMeLine = (name) => `<!-- vibhavgpt:personality -->\nHow I like answers written:\n- Call the user ${name} when addressing them by name is natural.\n- Use metric units (kilometres, kilograms, Celsius) unless the user asks otherwise.\n<!-- /vibhavgpt:personality -->`;

// A moderation call that never answers and settles only when its signal
// aborts. reviewDisplayName aborts with AbortSignal.timeout, whose timer is
// unref'd and so never keeps the process alive by itself. A real fetch holds an
// open socket while it waits; this fake holds a timer instead, or the event
// loop empties before the abort fires and the test is cancelled.
function hangingFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init.signal.addEventListener("abort", () => { clearInterval(keepAlive); reject(init.signal.reason); }, { once: true });
  });
}

function withoutModeration(t) {
  const saved = { key: config.moderationApiKey, primary: config.providerKeys.primaryFree };
  config.moderationApiKey = "";
  config.providerKeys.primaryFree = "";
  t.after(() => { config.moderationApiKey = saved.key; config.providerKeys.primaryFree = saved.primary; });
}

test("a placeholder term is blocked in plain, spaced, dotted, leetspeak, repeated-letter and mixed-case forms", () => {
  const blocked = [
    "zorblax", "Zorblax", "ZoRbLaX", "z o r b l a x", "z.o.r.b.l.a.x", "z_o-r.b l a x", "z0rbl4x", "Z0RBL4X",
    "zorrrbllaaax", "ZZOORRBBLLAAXX", "z\u043erblax", "z\u00f3rbl\u00e0x", "zor\u200bblax", "\uff5a\uff4f\uff52\uff42\uff4c\uff41\uff58",
    "Captain Zorblax", "xxzorblaxxx", "TheZorblaxKid",
    "grux", "GRUX", "Mr Grux", "g r u x", "g.r.u.x", "6rux", "gruuux", "grux_99", "grux2000", "Gr\u00fcx",
    "Snarf Blat", "snarfblat", "snarf-blat", "SNARF   BLAT", "snarf.blat",
  ];
  for (const name of blocked) assert.deepEqual(checkDisplayName(name), { allowed: false, reason: "blocked" }, `should block form #${blocked.indexOf(name)}`);
});

// Regression: a term with double letters was missed when its letters were
// spaced, dotted or split by invisible characters, because the joined name
// was compared before repeated letters were collapsed.
test("terms with double letters are blocked in plain, spaced, dotted, zero-width and glued forms", () => {
  const zw = String.fromCharCode(0x200b);
  const shortForms = ["zzoo", "ZZOO", "z z o o", "z.z.o.o", "z_z-o.o", ["z", "z", "o", "o"].join(zw), "zzzooo", "Mr Zzoo Smith"];
  for (const name of shortForms) assert.equal(checkDisplayName(name).reason, "blocked", `short double-letter form #${shortForms.indexOf(name)}`);
  const longForms = [
    "quobbllefrozz", "q u o b b l l e f r o z z", "q.u.o.b.b.l.l.e.f.r.o.z.z", [..."quobbllefrozz"].join(zw),
    "xxquobbllefrozzyy", "Thequobllefrozkid", "qu0bbl3fr0zz",
  ];
  for (const name of longForms) assert.equal(checkDisplayName(name).reason, "blocked", `long double-letter form #${longForms.indexOf(name)}`);
  // Terms under five letters match only as whole words, so the short one
  // inside a longer word is left alone.
  assert.equal(checkDisplayName("Bazzooka").allowed, true);
  for (const name of ["Ozzie", "Anna Zola", "Liz Zollo", "Quoble Frost", "Booker"]) {
    assert.deepEqual(checkDisplayName(name), { allowed: true, reason: "" }, `unrelated name #${["Ozzie", "Anna Zola", "Liz Zollo", "Quoble Frost", "Booker"].indexOf(name)}`);
  }
});

test("ordinary names are not blocked, including names that contain a short term's letters", () => {
  const allowed = [
    "", "Anna Smith", "Priya Patel", "Mohammed Al-Hassan", "Jean-Luc O'Brien", "Zo\u00eb Salda\u00f1a", "Nguy\u1ec5n V\u0103n An",
    "\u674e\u5c0f\u9f99", "\u0410\u043d\u043d\u0430", "Mcgruxley", "Gruxton", "Gru Xavier", "Snarf", "Blat Snarfington", "A. J. Gru", "St. John",
    "Mary-Kate", "D'Angelo", "Avery 2", "Dr. Who",
  ];
  for (const name of allowed) assert.deepEqual(checkDisplayName(name), { allowed: true, reason: "" }, `should allow name #${allowed.indexOf(name)}`);
});

test("basic sanity rules: length, links, email addresses and control characters", () => {
  assert.equal(checkDisplayName("x".repeat(65)).reason, "length");
  assert.equal(checkDisplayName("x".repeat(64)).allowed, true);
  for (const name of ["https://example.test", "visit example.com", "www.example.org", "ftp://files.test"]) assert.equal(checkDisplayName(name).reason, "url", name);
  assert.equal(checkDisplayName("me@example.invalid").reason, "email");
  for (const name of ["a\u0007b", "line\nbreak", "\u202eevil", "tab\there"]) assert.equal(checkDisplayName(name).reason, "control");
  assert.equal(safeDisplayName("  Anna   Smith "), "Anna Smith");
});

test("with no blocklist only the sanity rules apply, and one warning is logged", (t) => {
  const saved = config.nameBlocklist;
  t.after(() => { config.nameBlocklist = saved; });
  config.nameBlocklist = [];
  assert.equal(checkDisplayName("zorblax").allowed, true);
  assert.equal(checkDisplayName("https://example.test").allowed, false);
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  warnIfNameBlocklistMissing(logger);
  warnIfNameBlocklistMissing(logger);
  assert.equal(warnings.length, 1);
  config.nameBlocklist = saved;
  assert.equal(checkDisplayName("zorblax").allowed, false, "the list is re-read when it changes");
});

test("the moderation layer can add a block, and a failure or timeout never blocks", async (t) => {
  const saved = config.moderationApiKey;
  config.moderationApiKey = "placeholder-key";
  t.after(() => { config.moderationApiKey = saved; });
  const reply = (content, ok = true) => async () => ({ ok, json: async () => ({ choices: [{ message: { content } }] }) });
  const sent = [];
  const recording = async (url, init) => { sent.push(JSON.parse(init.body)); return reply('{"allowed":false}')(); };
  assert.deepEqual(await reviewDisplayName("Quiet Name", { fetchImpl: recording }), { allowed: false, reason: "review" });
  assert.match(sent[0].messages[0].content, /display names/);
  assert.deepEqual(await reviewDisplayName("Anna", { fetchImpl: reply('{"allowed":true}') }), { allowed: true, reason: "" });
  assert.deepEqual(await reviewDisplayName("Anna", { fetchImpl: reply("not json") }), { allowed: true, reason: "" });
  assert.deepEqual(await reviewDisplayName("Anna", { fetchImpl: reply('{"allowed":false}', false) }), { allowed: true, reason: "" });
  assert.deepEqual(await reviewDisplayName("Anna", { fetchImpl: async () => { throw new Error("offline"); } }), { allowed: true, reason: "" });
  assert.deepEqual(await reviewDisplayName("Anna", { fetchImpl: hangingFetch, timeoutMs: 20 }), { allowed: true, reason: "" });
  let called = false;
  assert.equal((await reviewDisplayName("zorblax", { fetchImpl: async () => { called = true; } })).allowed, false);
  assert.equal(called, false, "a name the blocklist catches needs no second opinion");
});

test("the check never logs the name", async (t) => {
  const saved = config.moderationApiKey;
  config.moderationApiKey = "placeholder-key";
  const logged = [];
  const originals = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  }
  t.after(() => { Object.assign(console, originals); config.moderationApiKey = saved; });
  const names = ["Zorblax The Great", "Unique Person Name", "g.r.u.x"];
  for (const name of names) {
    checkDisplayName(name);
    safeDisplayName(name);
    await reviewDisplayName(name, { fetchImpl: async () => { throw new Error(`failed for ${name}`); } });
    await reviewDisplayName(name, { fetchImpl: hangingFetch, timeoutMs: 10 });
  }
  auditRows(names.map((name, index) => ({ id: `user-${index}`, name, custom_instructions: callMeLine(name) })));
  Object.assign(console, originals);
  assert.ok(logged.length > 0, "the failures were logged");
  for (const line of logged) for (const name of names) assert.ok(!line.toLowerCase().includes(name.toLowerCase()), "a log line contains a name");
});

// A real auth instance on an in-memory store with the production hooks. The
// Google provider's token check and profile lookup are replaced, so social
// sign-in runs end to end without any network call.
const TEST_PASSWORD = "password-for-tests";

function authWith(t, googleProfile) {
  withoutModeration(t);
  const store = { user: [], session: [], account: [], verification: [] };
  const baseURL = "http://localhost:3000";
  const auth = betterAuth({
    baseURL,
    basePath: "/api/auth",
    secret: "placeholder-secret-for-tests-only-0123456789",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    socialProviders: {
      google: {
        clientId: "placeholder-client",
        clientSecret: "placeholder-client-key",
        verifyIdToken: async () => true,
        getUserInfo: async () => {
          const profile = googleProfile();
          return { user: { ...profile, emailVerified: true }, data: { sub: profile.id } };
        },
      },
    },
    databaseHooks: displayNameHooks,
  });
  const call = async (path, body, cookie) => {
    const response = await auth.handler(new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  return { store, call };
}

test("sign-up returns 400 for a blocked name and succeeds for a good one", async (t) => {
  const { store, call } = authWith(t, () => ({}));
  for (const name of ["Zorblax", "g r u x", "visit example.com"]) {
    const refused = await call("/sign-up/email", { name, email: `refused${store.user.length}@example.invalid`, password: TEST_PASSWORD });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { code: NAME_NOT_ALLOWED.code, message: "Please choose a different name." });
  }
  assert.equal(store.user.length, 0, "no account is created");
  const ok = await call("/sign-up/email", { name: "Anna Smith", email: "anna@example.invalid", password: TEST_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(store.user[0].name, "Anna Smith");
});

test("update-user returns 400 for a blocked name and succeeds for a good one", async (t) => {
  const { store, call } = authWith(t, () => ({}));
  const { cookie } = await call("/sign-up/email", { name: "Anna Smith", email: "anna@example.invalid", password: TEST_PASSWORD });
  const refused = await call("/update-user", { name: "SNARF BLAT" }, cookie);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { code: NAME_NOT_ALLOWED.code, message: "Please choose a different name." });
  assert.equal(store.user[0].name, "Anna Smith", "the stored name is unchanged");
  const ok = await call("/update-user", { name: "Anna Jones" }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(store.user[0].name, "Anna Jones");
});

test("a social sign-in with a blocked name stores no name and still signs in", async (t) => {
  let profile = { id: "google-1", name: "Zorblax", email: "first@example.invalid" };
  const { store, call } = authWith(t, () => profile);
  const blocked = await call("/sign-in/social", { provider: "google", idToken: { token: "placeholder-id-token" } });
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body?.token, "a session is issued");
  assert.equal(store.user[0].name, "");
  assert.equal(store.session.length, 1);
  profile = { id: "google-2", name: "Priya Patel", email: "second@example.invalid" };
  const good = await call("/sign-in/social", { provider: "google", idToken: { token: "placeholder-id-token" } });
  assert.equal(good.status, 200);
  assert.equal(store.user[1].name, "Priya Patel");
});

test("the production auth config uses these hooks", () => {
  const source = readFileSync(new URL("../src/auth.js", import.meta.url), "utf8");
  assert.match(source, /databaseHooks: displayNameHooks/);
});

test("the server withholds a blocked stored name from the signed-in user", () => {
  assert.deepEqual(visibleNameFields({ name: "Zorblax" }, ""), { name: "", nameWithheld: true, preferredNameWithheld: false });
  assert.deepEqual(visibleNameFields({ name: "Anna Smith" }, callMeLine("g.r.u.x")), { name: "Anna Smith", nameWithheld: false, preferredNameWithheld: true });
  assert.deepEqual(visibleNameFields({ name: "Anna Smith" }, callMeLine("Annie")), { name: "Anna Smith", nameWithheld: false, preferredNameWithheld: false });
  assert.equal(preferredNameFromInstructions(callMeLine("Annie")), "Annie");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const me = server.slice(server.indexOf('app.get("/api/me"'), server.indexOf('app.use("/api/chat"'));
  assert.ok(/visibleNameFields\(session\.user, profile\.rows\[0\]\?\.custom_instructions\)/.test(me), "/api/me filters the names");
  assert.ok(/\.\.\.session\.user, \.\.\.names/.test(me), "/api/me sends the filtered names");
  assert.ok(/warnIfNameBlocklistMissing\(\);\n\s*const server = app\.listen/.test(server), "the warning runs at startup");
});

test("the greeting, sidebar and Settings show the fallback for a blocked stored name", () => {
  const email = "member.one@example.invalid";
  const withheld = workspaceNames({ email, name: "", nameWithheld: true, preferredNameWithheld: true }, { preferred_name: "Zorblax" });
  assert.deepEqual(withheld, { displayName: "member.one", greetingName: "", surveyName: "", settingsName: "member.one", settingsCallMe: "member.one" });
  const accountOnly = workspaceNames({ email, name: "", nameWithheld: true }, { preferred_name: "Annie" });
  assert.equal(accountOnly.greetingName, "Annie", "a good survey name still greets");
  const callMeOnly = workspaceNames({ email, name: "Anna Smith", preferredNameWithheld: true }, { preferred_name: "Zorblax" });
  assert.deepEqual([callMeOnly.greetingName, callMeOnly.settingsCallMe, callMeOnly.surveyName], ["Anna", "member.one", "Anna"]);
  const nameless = workspaceNames({ email, name: "" }, { preferred_name: "" });
  assert.deepEqual([nameless.greetingName, nameless.settingsName, nameless.settingsCallMe], ["member.one", "Not set", "Not answered"], "accounts without a name keep today's behaviour");
  assert.equal(NAMELESS_GREETING, "Ready when you are.");

  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /<RevealWords text=\{mode !== "study" && !userName \? NAMELESS_GREETING : greeting\} \/>/);
  assert.match(app, /const names = workspaceNames\(user, onboarding\);\n\s*const \{ displayName \} = names;\n\s*const firstName = names\.greetingName;/);
  assert.match(app, /<SettingsRow label="Name"><span className="settings-value">\{names\.settingsName\}<\/span>/);
  assert.match(app, /<SettingsRow label="Call me"><span className="settings-value">\{names\.settingsCallMe\}<\/span>/);
  assert.match(app, /preferred_name: names\.surveyName/);
  assert.doesNotMatch(app, /user\.name|onboarding\.preferred_name/, "no screen reads a stored name directly");
  // The sidebar reads the session user, whose name the server already withheld.
  const sidebar = readFileSync(new URL("../frontend/src/components/Sidebar.jsx", import.meta.url), "utf8");
  assert.match(sidebar, /const displayName = user\.name\?\.trim\(\) \|\| user\.email\.split\("@"\)\[0\];/);
});

test("a refused survey name is dropped locally and its message shown", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const finish = app.slice(app.indexOf("const finishSurvey"), app.indexOf("const skipSurvey"));
  assert.match(finish, /error\?\.code !== "name-not-allowed"/);
  assert.match(finish, /writeOnboarding\(user\.id, \{ \.\.\.saved, preferred_name: "" \}\)/);
  assert.match(finish, /setSurveyToast\(error\.message\)/);
});

test("the assistant prompt, memory and voice instructions drop a blocked name", () => {
  const blockedInstructions = `Be brief.\n\n${callMeLine("Zorblax")}`;
  const chat = buildPreferenceSystemPrompt({ customInstructions: blockedInstructions });
  assert.doesNotMatch(chat, /zorblax/i);
  assert.match(chat, /Be brief\./);
  assert.match(chat, /Use metric units/);
  assert.match(buildPreferenceSystemPrompt({ customInstructions: callMeLine("Annie") }), /Call the user Annie/);
  assert.equal(withoutBlockedPreferredName("Be brief."), "Be brief.");

  const facts = [{ content: "User's preferred name is Zorblax." }, { content: "User likes green tea." }];
  assert.deepEqual(withoutBlockedNameFacts(facts), [facts[1]]);
  const memory = buildMemorySystemPrompt("Base prompt.", facts);
  assert.doesNotMatch(memory, /zorblax/i);
  assert.match(memory, /green tea/);

  const voice = buildInstructions({ name: "g r u x", facts, responseStyle: "balanced", customInstructions: blockedInstructions });
  assert.doesNotMatch(voice, /zorblax|g r u x|caller's name/i);
  assert.match(voice, /green tea/);
  assert.match(buildInstructions({ name: "Anna", facts: [], responseStyle: "balanced", customInstructions: "" }), /The caller's name is Anna\./);
});

test("the audit script reports counts and user IDs only", () => {
  const rows = [
    { id: "u1", name: "Anna Smith", custom_instructions: callMeLine("Annie") },
    { id: "u2", name: "Zorblax", custom_instructions: "" },
    { id: "u3", name: "Priya", custom_instructions: callMeLine("g.r.u.x") },
    { id: "u4", name: "visit example.com", custom_instructions: null },
  ];
  assert.deepEqual(auditRows(rows), { checked: 4, flagged: { accountName: ["u2", "u4"], preferredName: ["u3"] }, reasons: { blocked: 2, url: 1 } });
  const source = readFileSync(new URL("../scripts/audit-display-names.js", import.meta.url), "utf8");
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE)\b/);
  for (const line of source.split("\n").filter((l) => /console\.(log|error|warn)/.test(l))) assert.doesNotMatch(line, /\.name\b|custom_instructions/);
});
