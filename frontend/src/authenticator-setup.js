// Use the same standard secret encoded in the QR URI. Never log or persist it.
export function authenticatorSetupKey(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== "otpauth:" || url.hostname !== "totp") return "";
    const secret = (url.searchParams.get("secret") ?? "").toUpperCase();
    return /^[A-Z2-7]+=*$/.test(secret) ? secret : "";
  } catch { return ""; }
}
