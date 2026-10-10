import assert from "node:assert/strict";
import test from "node:test";

process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
process.env.TURNSTILE_ALLOWED_HOSTNAMES = "vibhavgpt.com";

const { turnstilePlugin } = await import("../src/security/turnstile.js");

function request(path, token) {
  return new Request(`https://api.vibhavgpt.com/api/auth${path}`, {
    method: "POST",
    headers: token ? { "x-captcha-response": token } : {},
  });
}

test("credential sign-up is rejected before auth when the Turnstile token is missing", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("must not verify a missing token"); };
  try {
    const result = await turnstilePlugin.onRequest(request("/sign-up/email"));
    assert.equal(result.response.status, 400);
    assert.deepEqual(await result.response.json(), {
      error: "Please complete the bot check before continuing.",
      code: "TURNSTILE_TOKEN_MISSING",
    });
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});

test("credential sign-in is rejected when Siteverify rejects a token", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }, { status: 200 });
  try {
    const result = await turnstilePlugin.onRequest(request("/sign-in/email", "invalid-token"));
    assert.equal(result.response.status, 400);
    assert.equal((await result.response.json()).code, "TURNSTILE_VERIFICATION_FAILED");
  } finally { global.fetch = originalFetch; }
});

test("a valid Turnstile response permits credential auth and submits the token only to Siteverify", async () => {
  const originalFetch = global.fetch;
  let calledUrl, submitted;
  global.fetch = async (url, options) => {
    calledUrl = url;
    submitted = JSON.parse(options.body);
    return Response.json({ success: true, hostname: "vibhavgpt.com" });
  };
  try {
    const result = await turnstilePlugin.onRequest(request("/sign-in/email", "valid-test-token"));
    assert.equal(result, undefined);
    assert.equal(calledUrl, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(submitted.response, "valid-test-token");
    assert.equal(submitted.secret, process.env.TURNSTILE_SECRET_KEY);
  } finally { global.fetch = originalFetch; }
});

test("second-factor and passkey routes remain outside the Turnstile gate", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("unexpected Siteverify call"); };
  try {
    assert.equal(await turnstilePlugin.onRequest(request("/two-factor/verify-totp")), undefined);
    assert.equal(await turnstilePlugin.onRequest(request("/passkey/verify-authentication")), undefined);
  } finally { global.fetch = originalFetch; }
});
