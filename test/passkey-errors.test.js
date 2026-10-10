import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { passkeyErrorMessage } from "../frontend/src/passkey-auth.js";

const RAW = /w3\.org|webauthn|See: |Auth cancelled|timed out or was not allowed|sctn-|—|–/i;
const dom = (name, message = "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.") =>
  Object.assign(new Error(message), { name });
const wrapped = (code, cause) => Object.assign(new Error(cause?.message ?? code), { name: "WebAuthnError", code, cause });

test("every passkey failure becomes one plain sentence, never library or spec text", () => {
  const failures = [
    dom("NotAllowedError"),
    wrapped("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", dom("NotAllowedError")),
    wrapped("ERROR_CEREMONY_ABORTED", dom("AbortError")),
    wrapped("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", dom("InvalidStateError")),
    wrapped("ERROR_INVALID_DOMAIN", dom("SecurityError")),
    wrapped("ERROR_INVALID_RP_ID", dom("SecurityError")),
    wrapped("ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT", dom("ConstraintError")),
    wrapped("ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG", dom("NotSupportedError")),
    Object.assign(new Error("Passkey not found"), { code: "PASSKEY_NOT_FOUND", status: 400 }),
    Object.assign(new Error("Challenge not found"), { code: "CHALLENGE_NOT_FOUND", status: 400 }),
    Object.assign(new Error("Unauthorized"), { status: 401 }),
    Object.assign(new Error("Couldn't connect"), { code: "network-error" }),
    new Error("Something nobody planned for: https://example.com/spec"),
  ];
  for (const kind of ["sign-in", "register"]) {
    for (const failure of failures) {
      const message = passkeyErrorMessage(failure, kind);
      assert.ok(message && message.length < 220, `${kind}: ${failure.message}`);
      assert.doesNotMatch(message, RAW, `${kind}: ${message}`);
      assert.doesNotMatch(message, /https?:/, `${kind}: ${message}`);
    }
  }
});

test("a closed prompt or missing passkey is not reported as a cancellation", () => {
  const notAllowed = wrapped("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", dom("NotAllowedError"));
  assert.match(passkeyErrorMessage(notAllowed, "sign-in"), /No passkey was used/);
  assert.match(passkeyErrorMessage(notAllowed, "register"), /The passkey wasn't created/);
  assert.match(passkeyErrorMessage(wrapped("ERROR_CEREMONY_ABORTED", dom("AbortError")), "sign-in"), /cancelled/);
});

test("new passkeys are discoverable, so username-less sign-in can find them", () => {
  const auth = readFileSync(new URL("../src/auth.js", import.meta.url), "utf8");
  assert.match(auth, /residentKey: "required"/);
});

test("the app no longer goes through the wrapper that masked every failure", () => {
  for (const file of ["../frontend/src/App.jsx", "../frontend/src/components/SecurityPanel.jsx", "../frontend/src/passkey-auth.js"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /passkeyAuth|signIn\.passkey|passkey\.addPasskey/);
  }
});
