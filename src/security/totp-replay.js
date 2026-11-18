// Authenticator (TOTP) codes are single-use (security audit, 2026-11-16). An authenticator code stays valid for its time step and the
// steps either side, so without this the same six digits could be sent again within about 90 seconds (a code read over a shoulder, or
// captured and replayed). Once a code has been accepted for a sign-in or session, the same code for the same sign-in is refused until it
// could no longer be valid anyway. Failed attempts do not use a code up (a typo can be corrected); the 5-attempt cap and the auth rate
// limit still apply. Kept in this process's memory: the API runs as one instance; with several, this would move to the database.
import { createHash } from "node:crypto";

export const TOTP_REPLAY_WINDOW_MS = 90_000;

// Who is signing in: the two-factor challenge cookie (or, when verifying while signed in, the session cookie), else the client address.
export function totpReplayIdentity(cookieHeader = "", ip = "") {
  const cookies = String(cookieHeader).split(/;\s*/);
  const pick = (pattern) => cookies.find((c) => pattern.test(c.split("=")[0] ?? ""));
  const identity = pick(/(^|\.)two_factor$/) ?? pick(/(^|\.)session_token$/) ?? `ip:${ip}`;
  return createHash("sha256").update(identity).digest("hex");
}

export function createTotpReplayGuard({ now = () => Date.now(), windowMs = TOTP_REPLAY_WINDOW_MS, maxEntries = 50_000 } = {}) {
  const used = new Map();
  const sweep = () => { const t = now(); for (const [key, until] of used) if (until <= t) used.delete(key); };
  const keyFor = (identity, code) => `${identity}:${String(code ?? "").trim()}`;
  return {
    /** Whether this code was already accepted for this sign-in and could still be valid. */
    wasUsed(identity, code) {
      const until = used.get(keyFor(identity, code));
      return until !== undefined && until > now();
    },
    /** Record an accepted code. */
    markUsed(identity, code) {
      if (used.size >= maxEntries) sweep();
      if (used.size >= maxEntries) used.delete(used.keys().next().value);
      used.set(keyFor(identity, code), now() + windowMs);
    },
    size: () => used.size,
  };
}
