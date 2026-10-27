// A synthetic environment for tests that load real application code. Import it FIRST in the test
// file (before anything that reads the configuration), so the application never sees a real value:
//   - every inherited credential-shaped variable is removed from this test process, so no database,
//     email, payment, monitoring or model request can be made with a real key;
//   - the database URL and auth secret are then SET to placeholders, not defaulted (a default would
//     keep a real value that happened to be in the shell);
//   - the server is told not to listen on its real port or start background jobs on import.
// The helpers below add the two checks tests rely on: nothing leaves the machine except to the one
// local test origin, and the database is never reached.
const CREDENTIAL_NAME = /(KEY|SECRET|TOKEN|PASSWORD|DSN|CREDENTIALS?)$|^DATABASE_URL$/i;
for (const name of Object.keys(process.env)) if (CREDENTIAL_NAME.test(name)) delete process.env[name];
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET = "test-only-auth-secret-not-used-for-anything-real";
process.env.START_SERVER = "false";

// Lets fetch reach only `allowedOrigin` (the exact local test server). Any other destination throws
// at once and is recorded; it is never forwarded. Call restore() to put the real fetch back.
export function blockOutbound(allowedOrigin) {
  const realFetch = globalThis.fetch;
  const blocked = [];
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* not a URL */ }
    if (origin !== allowedOrigin) { blocked.push(url); throw new Error(`blocked outbound request in a test: ${origin ?? "unparseable destination"}`); }
    return realFetch(input, init);
  };
  return { blocked, restore() { globalThis.fetch = realFetch; } };
}

// Replaces the shared database pool's entry points for one test. By default any call throws and is
// counted, so a test that claims "no database activity" can assert the count is zero. Pass `answer`
// to let a specific, expected query be answered with synthetic rows; it is still counted.
export async function databaseSpy(t, { answer } = {}) {
  const { pool } = await import("../src/db/client.js");
  const calls = { query: 0, connect: 0 };
  t.mock.method(pool, "query", async (...args) => {
    calls.query += 1;
    if (answer) return answer(...args);
    throw new Error("blocked database query in a test");
  });
  t.mock.method(pool, "connect", async () => { calls.connect += 1; throw new Error("blocked database connection in a test"); });
  return { calls, total: () => calls.query + calls.connect };
}
