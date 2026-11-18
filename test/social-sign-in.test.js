// Slice 8: social sign-in with Google, GitHub, Microsoft and Discord, each switched on only by its own two values, and one trust rule for
// all of them: a social identity is tied to an email only when the provider reports that email as verified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import express from "express";
import { APIError } from "better-auth/api";
import { SOCIAL_PROVIDER_ORDER, guardSocialSignUpEmail, socialProviderSetup } from "../src/auth/social-providers.js";
import { createNativeOAuthRouter } from "../src/auth/native-oauth.js";

// Better Auth's own account-linking code (not re-implemented here), loaded from the installed package.
const { handleOAuthUserInfo } = await import(pathToFileURL(path.resolve("node_modules/better-auth/dist/oauth2/link-account.mjs")).href);

const PROVIDERS = ["google", "github", "microsoft", "discord"];
const creds = (ids) => Object.fromEntries(ids.flatMap((id) => [[`${id}ClientId`, `${id}-client-id`], [`${id}ClientSecret`, `${id}-client-secret`]]));

// ---- Configuration: on only with both values --------------------------------------------------------------------------------------

test("a provider is registered only when both of its values are set, in the sign-in page's order", () => {
  assert.deepEqual(socialProviderSetup({}), { configured: [], providers: undefined }, "nothing set: no social sign-in at all");
  assert.deepEqual(socialProviderSetup(creds(PROVIDERS)).configured, ["google", "github", "microsoft", "discord"]);
  assert.deepEqual(SOCIAL_PROVIDER_ORDER, ["google", "github", "microsoft", "discord"]);
  // Half a pair is not a provider.
  assert.deepEqual(socialProviderSetup({ githubClientId: "id" }).configured, []);
  assert.deepEqual(socialProviderSetup({ ...creds(["discord"]), microsoftClientSecret: "secret" }).configured, ["discord"]);
  // Railway is not built (owner ruling: its verified-email flag has not been observed).
  assert.ok(!SOCIAL_PROVIDER_ORDER.includes("railway"));
  assert.equal(socialProviderSetup({ ...creds(PROVIDERS), railwayClientId: "x", railwayClientSecret: "y" }).providers.railway, undefined);
});

test("Microsoft uses the common tenant (work, school and personal accounts); Discord asks only for its default identify and email", () => {
  const { providers } = socialProviderSetup(creds(PROVIDERS));
  assert.equal(providers.microsoft.tenantId, "common");
  assert.equal(providers.discord.scope, undefined, "no extra scopes");
  assert.equal(providers.discord.disableDefaultScope, undefined, "Discord's defaults are identify and email");
  const discordSource = readFileSync("node_modules/@better-auth/core/dist/social-providers/discord.mjs", "utf8");
  assert.match(discordSource, /\["identify", "email"\]/);
  // No provider is configured to be believed without its own verified flag.
  for (const id of PROVIDERS) assert.equal(providers[id].trusted, undefined);
});

test("the server's own Better Auth options: no trusted providers and no relaxed linking, and the new-account guard is wired in", async () => {
  const { auth } = await import("../src/auth.js");
  const options = auth.options;
  assert.equal(options.account?.accountLinking?.trustedProviders, undefined, "no provider is trusted by name");
  assert.notEqual(options.account?.accountLinking?.requireLocalEmailVerified, false);
  assert.notEqual(options.account?.accountLinking?.allowDifferentEmails, true);
  await assert.rejects(() => options.databaseHooks.user.create.before({ email: "a@example.com", emailVerified: false, name: "A" }, { path: "/callback/:id" }), (error) => error instanceof APIError && error.body?.code === "email_not_verified");
  // The display-name guard still runs after it.
  assert.equal(await options.databaseHooks.user.create.before({ email: "a@example.com", emailVerified: true, name: "Ada" }, { path: "/callback/:id" }), undefined);
});

// ---- Linking, through Better Auth's own code ---------------------------------------------------------------------------------------

// An in-memory store shaped like Better Auth's: users by email, accounts keyed by (issuer, accountId).
function store({ users = [], accounts = [] } = {}) {
  const db = { users: users.map((u) => ({ ...u })), accounts: accounts.map((a) => ({ ...a })), sessions: [] };
  const hooks = { before: async (data, context) => { const { auth } = await import("../src/auth.js"); return auth.options.databaseHooks.user.create.before(data, context); } };
  const internalAdapter = {
    findAccountOwnerByKey: async ({ issuer, accountId }) => {
      const account = db.accounts.find((a) => a.issuer === issuer && a.accountId === accountId);
      if (!account) return null;
      const user = db.users.find((u) => u.id === account.userId);
      return user ? { kind: "owned", user, account } : { kind: "orphaned" };
    },
    findUserByEmail: async (email) => {
      const user = db.users.find((u) => u.email === email);
      return user ? { user, accounts: db.accounts.filter((a) => a.userId === user.id) } : null;
    },
    linkAccount: async (account) => { db.accounts.push({ ...account }); return { ...account }; },
    createUser: async (data) => {
      await hooks.before(data, { path: "/callback/:id" });
      const user = { id: `u${db.users.length + 1}`, ...data };
      db.users.push(user);
      return user;
    },
    createAccount: async (account) => { db.accounts.push({ ...account }); return { ...account }; },
    createSession: async (userId) => { const session = { token: `s${db.sessions.length + 1}`, userId }; db.sessions.push(session); return session; },
    updateUser: async (id, data) => Object.assign(db.users.find((u) => u.id === id), data),
    updateAccount: async (id, data) => { const account = db.accounts.find((a) => (a.id ?? `${a.issuer}:${a.accountId}`) === id) ?? db.accounts.find((a) => a.id === undefined); return account ? Object.assign(account, data) : null; },
  };
  const context = {
    internalAdapter,
    adapter: { transaction: async (fn) => fn({}) },
    trustedProviders: [],
    options: {},
    socialProviders: [],
    logger: { error() {}, warn() {}, info() {} },
    baseURL: "https://api.vibhavgpt.com/api/auth",
  };
  return { db, c: { context } };
}

const identity = (provider, { email = "ada@example.com", verified = true, accountId = `${provider}-123` } = {}) => ({
  userInfo: { id: accountId, email, emailVerified: verified, name: "Ada" },
  account: { providerId: provider, issuer: `https://${provider}.example`, accountId, accessToken: "t" },
  callbackURL: "https://vibhavgpt.com/app",
});

for (const provider of PROVIDERS) {
  test(`${provider}: a returning person whose verified email matches lands on the SAME account`, async () => {
    const { db, c } = store({ users: [{ id: "u-existing", email: "ada@example.com", emailVerified: true, name: "Ada" }] });
    const result = await handleOAuthUserInfo(c, identity(provider));
    assert.ok(!result.error, `no error (${result.error})`);
    assert.equal(result.data.user.id, "u-existing", "the same account, not a new one");
    assert.equal(db.users.length, 1);
    assert.deepEqual(db.accounts.map((a) => [a.providerId, a.userId]), [[provider, "u-existing"]], "the provider is linked to it");
    assert.equal(db.sessions.at(-1).userId, "u-existing");
  });

  test(`${provider}: an email the provider has NOT verified is never linked to the existing account`, async () => {
    const { db, c } = store({ users: [{ id: "u-existing", email: "ada@example.com", emailVerified: true, name: "Ada" }] });
    const result = await handleOAuthUserInfo(c, identity(provider, { verified: false }));
    assert.equal(result.error, "account not linked");
    assert.equal(db.accounts.length, 0);
    assert.equal(db.sessions.length, 0, "no session for anyone");
  });

  test(`${provider}: a new person with a provider-verified email gets a new account; with an unverified email, nothing is created`, async () => {
    const fresh = store();
    const created = await handleOAuthUserInfo(fresh.c, identity(provider, { email: "new@example.com" }));
    assert.equal(created.isRegister, true);
    assert.equal(fresh.db.users.length, 1);
    assert.equal(fresh.db.users[0].emailVerified, true);

    const refused = store();
    await assert.rejects(() => handleOAuthUserInfo(refused.c, identity(provider, { email: "squat@example.com", verified: false })), (error) => error.body?.code === "email_not_verified");
    assert.equal(refused.db.users.length, 0, "no account under an address its owner never confirmed");
    assert.equal(refused.db.sessions.length, 0);
  });
}

test("the existing account's own email must be verified too, before any provider links to it (Better Auth's default, kept)", async () => {
  const { db, c } = store({ users: [{ id: "u-unverified", email: "ada@example.com", emailVerified: false, name: "Ada" }] });
  const result = await handleOAuthUserInfo(c, identity("github"));
  assert.equal(result.error, "account not linked");
  assert.equal(db.sessions.length, 0);
});

test("isolation: an identity is found by its own issuer and id, so one provider's account id never lands on another provider's account", async () => {
  const { db, c } = store({
    users: [{ id: "u-a", email: "a@example.com", emailVerified: true, name: "A" }, { id: "u-b", email: "b@example.com", emailVerified: true, name: "B" }],
    accounts: [{ providerId: "github", issuer: "https://github.example", accountId: "42", userId: "u-a" }],
  });
  // A Discord identity that happens to share GitHub's account id, for a different person.
  const result = await handleOAuthUserInfo(c, identity("discord", { email: "b@example.com", accountId: "42" }));
  assert.equal(result.data.user.id, "u-b", "it lands on its own person's account");
  assert.equal(db.sessions.at(-1).userId, "u-b");
  // And a returning GitHub identity still lands on its owner, even if it now presents another person's email.
  const again = await handleOAuthUserInfo(c, identity("github", { email: "b@example.com", accountId: "42" }));
  assert.equal(again.data.user.id, "u-a");
});

test("the new-account guard only applies to social sign-ins; email sign-up keeps its own verification flow", () => {
  assert.throws(() => guardSocialSignUpEmail({ emailVerified: false }, { path: "/callback/:id" }), (error) => error.body?.code === "email_not_verified");
  assert.throws(() => guardSocialSignUpEmail({}, { path: "/callback/github" }));
  assert.doesNotThrow(() => guardSocialSignUpEmail({ emailVerified: true }, { path: "/callback/:id" }));
  assert.doesNotThrow(() => guardSocialSignUpEmail({ emailVerified: false }, { path: "/sign-up/email" }));
  assert.doesNotThrow(() => guardSocialSignUpEmail({ emailVerified: false }, undefined));
});

test("Turnstile is enforced exactly where it was: the email sign-up and sign-in routes, not social callbacks (parity with Google)", () => {
  const source = readFileSync("src/security/turnstile.js", "utf8");
  assert.match(source, /const protectedPaths = new Set\(\["\/sign-up\/email", "\/sign-in\/email"\]\);/);
  assert.doesNotMatch(source, /callback|social/);
});

// ---- The phone apps' bridge, and the sign-in page's list ---------------------------------------------------------------------------

function fakeAuth() {
  const calls = [];
  const store = new Map();
  return {
    calls,
    auth: {
      $context: Promise.resolve({ internalAdapter: { createVerificationValue: async (record) => store.set(record.identifier, record), consumeVerificationValue: async () => null } }),
      api: { signInSocial: async ({ body }) => { calls.push(body); return { url: `https://${body.provider}.example/authorize?state=s` }; } },
    },
  };
}

test("the phone apps can start any configured provider, keep Google's path, and get a plain refusal for one that is not set up", async () => {
  const fake = fakeAuth();
  const app = express();
  app.use("/api/native-auth", createNativeOAuthRouter({ auth: fake.auth, authBaseUrl: "https://api.vibhavgpt.com", limiter: (_q, _s, next) => next(), providers: ["google", "github", "discord"] }));
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const verifierHash = createHash("sha256").update("v".repeat(43)).digest("base64url");
  const post = (provider) => fetch(`${origin}/api/native-auth/${provider}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifierHash }) });
  try {
    for (const provider of ["google", "github", "discord"]) {
      const response = await post(provider);
      assert.equal(response.status, 200, provider);
      assert.match((await response.json()).url, /expo-authorization-proxy/);
      assert.equal(fake.calls.at(-1).provider, provider);
      assert.match(fake.calls.at(-1).callbackURL, /\/api\/native-auth\/finish\?handoff=/, "the same return-into-app path Google uses");
    }
    for (const provider of ["microsoft", "railway", "evil"]) {
      const response = await post(provider);
      assert.equal(response.status, 404, provider);
      assert.equal((await response.json()).code, "provider_not_available");
    }
    assert.equal(fake.calls.length, 3, "nothing was started for a provider that is not set up");
  } finally {
    server.close();
  }
});

test("the sign-in page lists exactly the configured providers, from the server, and offers no button otherwise", () => {
  const server = readFileSync("src/server.js", "utf8");
  assert.match(server, /app\.get\("\/api\/sign-in-options", \(_req, res\) => \{\s*res\.set\("Cache-Control", "no-store"\);\s*res\.json\(\{ socialProviders: configuredSocialProviders \}\);/);
  assert.match(server, /console\.info\(JSON\.stringify\(\{ event: "auth_providers", configured: configuredSocialProviders \}\)\);/, "the boot line names them (names only)");
  const app = readFileSync("frontend/src/App.jsx", "utf8");
  assert.match(app, /api\("\/api\/sign-in-options"\)/);
  assert.match(app, /SOCIAL_SIGN_IN\.filter\(\(provider\) => socialProviders\.includes\(provider\.id\)\)/);
  assert.match(app, /useState\(\[\]\);\s*useEffect\(\(\) => \{\s*let cancelled = false;\s*api\("\/api\/sign-in-options"\)/, "none until the server answers");
});
