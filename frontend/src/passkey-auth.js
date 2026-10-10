import { Capacitor } from "@capacitor/core";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api.js";

// Passkey sign-in and registration run the WebAuthn ceremony here rather than
// through the auth library's client wrapper. That wrapper reports every
// failure of the browser step as "Auth cancelled" and passes the browser's
// own error text through on registration, so a missing passkey, a closed
// prompt, an unsupported WebView and a real cancellation all looked alike.
// Here every failure keeps its real cause and becomes one plain sentence.

export const passkeysSupported = () =>
  typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

// Whether this device has a built-in authenticator (Windows Hello, Touch ID,
// Face ID, an Android screen lock). Unknown counts as available, so a browser
// that can't answer is never blocked from trying.
export async function devicePasskeysAvailable() {
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return true;
  }
}

class PasskeyError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PasskeyError";
    this.cause = cause;
  }
}

const inApp = () => Capacitor.isNativePlatform();

// The browser's reason, whether it arrives as a WebAuthnError wrapping a
// DOMException or as the DOMException itself.
function browserReason(error) {
  const code = error?.code;
  const name = error?.cause?.name ?? error?.name;
  return { code, name };
}

// Turns any passkey failure into one plain sentence. Never returns library
// or specification text.
export function passkeyErrorMessage(error, kind) {
  const signIn = kind === "sign-in";
  // Errors from our own API (the verify step) carry the server's code.
  switch (error?.code) {
    case "network-error":
      return "Couldn't reach VibhavGPT. Check your connection and try again.";
    case "PASSKEY_NOT_FOUND":
      return "That passkey isn't linked to a VibhavGPT account any more. Sign in another way, then add a new passkey in Settings.";
    case "CHALLENGE_NOT_FOUND":
      return "The passkey request expired. Try again.";
    case "PREVIOUSLY_REGISTERED":
      return "This device already has a passkey for your account.";
    case "AUTHENTICATION_FAILED":
      return "VibhavGPT couldn't verify that passkey. Try again, or sign in another way.";
    case "FAILED_TO_VERIFY_REGISTRATION":
      return "VibhavGPT couldn't verify the new passkey. Try again.";
    case "USER_NOT_FOUND":
      return "That passkey's account no longer exists. Create an account or sign in another way.";
    case "UNABLE_TO_CREATE_SESSION":
      return "Your passkey was accepted, but VibhavGPT couldn't start your session. Try again.";
    case "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY":
    case "SESSION_REQUIRED":
    case "UNAUTHORIZED":
      return "Your session has expired. Sign in again, then add the passkey.";
    case "SESSION_NOT_FRESH":
      return "Please sign in again before adding a passkey. Your account needs a recent sign-in for this change.";
    default:
      break;
  }
  if (error?.status === 401) {
    return signIn ? "VibhavGPT couldn't verify that passkey. Try again, or sign in another way." : "Your session has expired. Sign in again, then add the passkey.";
  }
  if (Number.isInteger(error?.status)) {
    return signIn ? "Passkey sign-in didn't work. Try again, or sign in another way." : "The passkey couldn't be added. Try again.";
  }

  const { code, name } = browserReason(error);
  if (code === "ERROR_CEREMONY_ABORTED" || name === "AbortError") {
    return signIn ? "Passkey sign-in was cancelled." : "Adding the passkey was cancelled.";
  }
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return "This device already has a passkey for your account.";
  }
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID" || name === "SecurityError") {
    return "Passkeys only work at vibhavgpt.com. Open VibhavGPT there and try again.";
  }
  if (code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT") {
    return "This security key can't store a passkey. Try your device's built-in passkeys, or a different key.";
  }
  if (code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT") {
    return "This authenticator can't confirm it's you with a PIN or biometrics. Try another one.";
  }
  if (code === "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG" || name === "NotSupportedError") {
    return "This device doesn't support the kind of passkey VibhavGPT uses.";
  }
  if (name === "NotAllowedError" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY") {
    // The Android app shows VibhavGPT in a system WebView, which turns down
    // passkey requests unless the app itself enables them.
    if (inApp()) {
      return signIn
        ? "Passkeys don't work inside the Android app yet. Sign in here with your password, an email code or your linked account, or use your passkey at vibhavgpt.com in a browser."
        : "Passkeys can't be added inside the Android app yet. Open vibhavgpt.com in a browser to add one.";
    }
    return signIn
      ? "No passkey was used. The prompt was closed or timed out, or this device has no passkey for VibhavGPT. Try again, or sign in another way."
      : "The passkey wasn't created. The prompt was closed or timed out, or this device couldn't make one. Try again with Device or phone, or choose a passkey security key.";
  }
  return signIn
    ? "Passkey sign-in didn't work. Try again, or sign in another way."
    : "The passkey couldn't be added. Try again.";
}

// Signs in with a discoverable passkey. Resolves to the server's answer
// (a session, or a two-step requirement); throws a PasskeyError whose
// message is safe to show.
export async function signInWithPasskey({ request = api, authenticate = startAuthentication } = {}) {
  let response;
  try {
    const options = await request("/api/auth/passkey/generate-authenticate-options", { cache: "no-store" });
    response = await authenticate({ optionsJSON: options });
  } catch (error) {
    throw new PasskeyError(passkeyErrorMessage(error, "sign-in"), error);
  }
  try {
    return await request("/api/auth/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response }) });
  } catch (error) {
    throw new PasskeyError(passkeyErrorMessage(error, "sign-in"), error);
  }
}

// Adds a passkey to the signed-in account.
export async function registerPasskey({ name, authenticatorAttachment }, { request = api, createCredential = startRegistration } = {}) {
  let response;
  try {
    const query = new URLSearchParams({ ...(authenticatorAttachment ? { authenticatorAttachment } : {}), ...(name ? { name } : {}) });
    const options = await request(`/api/auth/passkey/generate-register-options?${query}`, { cache: "no-store" });
    response = await createCredential({ optionsJSON: options });
  } catch (error) {
    throw new PasskeyError(passkeyErrorMessage(error, "register"), error);
  }
  try {
    return await request("/api/auth/passkey/verify-registration", { method: "POST", body: JSON.stringify({ response, name }) });
  } catch (error) {
    throw new PasskeyError(passkeyErrorMessage(error, "register"), error);
  }
}
