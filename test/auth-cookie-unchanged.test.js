import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The session cookie stays exactly as it is: host-only on the API, with no
// cross-subdomain domain, so it is never sent to any other vibhavgpt.com host
// and every session already issued keeps working. Runs the real auth
// configuration with a production-style https base URL; the session lookup is
// stubbed, so no database is reached.
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";
process.env.BETTER_AUTH_URL = "https://api.example.test";

const { auth } = await import("../src/auth.js");
const { serializeSignedCookie } = await import("better-call");
const context = await auth.$context;
const source = readFileSync(new URL("../src/auth.js", import.meta.url), "utf8");

test("no cross-subdomain cookie or cookie domain is configured", () => {
  assert.equal(auth.options.advanced, undefined, "no advanced cookie settings");
  for (const setting of ["crossSubDomainCookies", "cookiePrefix", "defaultCookieAttributes", "useSecureCookies", "domain:"]) {
    assert.equal(source.includes(setting), false, `src/auth.js does not set ${setting}`);
  }
});

test("the session cookie keeps its name and host-only attributes", () => {
  const { name, attributes } = context.authCookies.sessionToken;
  assert.equal(name, "__Secure-better-auth.session_token");
  assert.deepEqual(attributes, { secure: true, sameSite: "lax", path: "/", httpOnly: true, maxAge: 604800 });
  assert.equal("domain" in attributes, false, "host-only: no Domain attribute");
});

test("an existing session cookie still loads, and a forged one does not", async (t) => {
  const findSession = context.internalAdapter.findSession;
  t.after(() => { context.internalAdapter.findSession = findSession; });
  const now = new Date();
  // A session issued just now (so no refresh write is due), found by its token.
  context.internalAdapter.findSession = async (token) => (token === "existing-session-token"
    ? {
      session: { id: "session-1", token, userId: "user-1", expiresAt: new Date(now.getTime() + 604800_000 - 60_000), createdAt: now, updatedAt: now },
      user: { id: "user-1", email: "person@example.com", name: "Person", emailVerified: true, createdAt: now, updatedAt: now },
    }
    : null);
  const { name } = context.authCookies.sessionToken;
  const cookie = (await serializeSignedCookie(name, "existing-session-token", context.secret)).split(";")[0];
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.equal(session?.user?.id, "user-1");
  assert.equal(session?.session?.id, "session-1");
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: `${name}=existing-session-token.forged` }) }), null);
});
