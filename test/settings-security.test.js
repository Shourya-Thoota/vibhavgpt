import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_SECTIONS, settingsPath, settingsRoute } from "../frontend/src/settings-routes.js";
import { authenticatorSetupKey } from "../frontend/src/authenticator-setup.js";
import { registerPasskey, signInWithPasskey, passkeyErrorMessage } from "../frontend/src/passkey-auth.js";

test("every Settings section and Usage resolve on direct navigation and history restoration", () => {
  for (const { slug } of SETTINGS_SECTIONS) {
    assert.deepEqual(settingsRoute(settingsPath(slug)), { page: "settings", section: slug, redirect: null });
    assert.equal(settingsRoute(`${settingsPath(slug)}/`).redirect, settingsPath(slug));
  }
  assert.deepEqual(settingsRoute("/app/chat"), { page: "chat" });
  assert.deepEqual(settingsRoute("/app/memory"), { page: "memory" });
  assert.deepEqual(settingsRoute("/app/billing"), { page: "billing" });
  assert.deepEqual(settingsRoute("/app/usage"), { page: "usage" });
  assert.equal(settingsRoute("/app/settings").redirect, "/app/settings/account");
  assert.equal(settingsRoute("/app/settings/unknown").redirect, "/app/settings/account");
  assert.equal(settingsRoute("/app", "?delete-account").section, "delete-account");
  assert.equal(settingsRoute("/app/study"), null);
});

test("manual authenticator key exactly matches the standard QR URI secret", () => {
  assert.equal(authenticatorSetupKey("otpauth://totp/VibhavGPT:test?secret=jbswy3dpehpk3pxp&issuer=VibhavGPT"), "JBSWY3DPEHPK3PXP");
  for (const uri of [undefined, "", "broken", "https://example.com?secret=ABC", "otpauth://hotp/x?secret=ABC", "otpauth://totp/x?secret=unsafe%20key", "otpauth://totp/x"]) assert.equal(authenticatorSetupKey(uri), "");
});

test("default passkey registration does not constrain the authenticator and sends the complete ceremony response", async () => {
  const response = { id: "credential", response: { attestationObject: "attestation", clientDataJSON: "client-data", transports: ["hybrid"] }, clientExtensionResults: { credProps: { rk: true } } };
  const calls = [];
  const result = await registerPasskey({ name: "My phone" }, {
    request: async (path, init) => { calls.push({ path, init }); return calls.length === 1 ? { challenge: "test", rp: { id: "localhost" } } : { id: "saved" }; },
    createCredential: async ({ optionsJSON }) => { assert.equal(optionsJSON.challenge, "test"); return response; },
  });
  assert.equal(result.id, "saved");
  assert.equal(new URL(calls[0].path, "http://localhost").searchParams.has("authenticatorAttachment"), false);
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[1].init.body), { response, name: "My phone" });
});

test("explicit hardware passkeys remain supported while cancellation never submits verification", async () => {
  const calls = [];
  await assert.rejects(registerPasskey({ name: "My key", authenticatorAttachment: "cross-platform" }, {
    request: async path => { calls.push(path); return { challenge: "test" }; },
    createCredential: async () => { throw Object.assign(new Error(), { name: "NotAllowedError" }); },
  }), /passkey wasn't created/);
  assert.match(calls[0], /authenticatorAttachment=cross-platform/);
  assert.equal(calls.length, 1);
  assert.match(passkeyErrorMessage({ code: "SESSION_NOT_FRESH", status: 403 }, "register"), /recent sign-in/);
});

test("passkey sign-in verifies the browser response and retains the pending second-factor result", async () => {
  const response = { id: "credential", response: { authenticatorData: "data" }, clientExtensionResults: {} };
  const calls = [];
  const result = await signInWithPasskey({
    request: async (path, init) => { calls.push({ path, init }); return calls.length === 1 ? { challenge: "login" } : { twoFactorRedirect: true }; },
    authenticate: async ({ optionsJSON }) => { assert.equal(optionsJSON.challenge, "login"); return response; },
  });
  assert.equal(result.twoFactorRedirect, true);
  assert.equal(calls[1].path, "/api/auth/passkey/verify-authentication");
  assert.deepEqual(JSON.parse(calls[1].init.body), { response });
});
