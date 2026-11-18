// Independent abuse protection for chat requests.
//
// Two per-user limits, both about how fast and how many at once, neither about how much a
// user may use:
//   * a burst limit: at most `burstMax` chat requests in any sliding `burstWindowMs`;
//   * a concurrency limit: at most `maxConcurrent` chat requests in flight at one time.
// They are separate from the credit balance and from every allowance. There is deliberately no
// daily or hourly window here: a person who stays within these limits is never stopped by them.
//
// One HTTP request counts once. The guard runs before the chat handler, so the model calls the
// handler makes (the first reply, each tool step, a final answer, a rewrite, a retry on another
// route) are inside one request and are never counted again.
//
// State is in this process's memory. On a single instance that is exact; if the API is ever scaled
// to several instances each enforces the limits on its own, so a user's effective ceiling is the
// limit times the instance count (see docs/credits-policy.md). It stores no message text or
// content, only counts and timestamps keyed by the verified account.

import { config } from "../config.js";
import { accessError, accessPayload } from "../../frontend/src/access-status.js";

export const CHAT_ABUSE_CODES = Object.freeze({ BURST: "chat_rate_limited", BUSY: "chat_busy" });

const MESSAGES = Object.freeze({
  [CHAT_ABUSE_CODES.BURST]: "You're sending messages very quickly. Please wait a moment and try again.",
  [CHAT_ABUSE_CODES.BUSY]: "You already have the maximum number of replies in progress. Wait for one to finish, then send your message.",
});

export function createChatAbuseGuard({ settings = () => config.chatAbuse, now = () => Date.now(), sweepMs = 60_000, log = (line) => console.warn(line) } = {}) {
  const users = new Map(); // account id -> { starts: request start times in the window, active: requests in flight }

  const limits = () => {
    const { burstMax = 0, burstWindowMs = 0, maxConcurrent = 0 } = settings() ?? {};
    return { burstMax, burstWindowMs, maxConcurrent, burstOn: burstMax > 0 && burstWindowMs > 0, concurrencyOn: maxConcurrent > 0 };
  };

  // The window is (t - windowMs, t]: a request exactly windowMs old has left it.
  function prune(entry, t, windowMs) {
    const cutoff = t - windowMs;
    let drop = 0;
    while (drop < entry.starts.length && entry.starts[drop] <= cutoff) drop += 1;
    if (drop) entry.starts.splice(0, drop);
  }

  /** Decide one request. Synchronous, so two simultaneous requests cannot both pass a limit. */
  function admit(userId) {
    const l = limits();
    const t = now();
    const entry = users.get(userId) ?? { starts: [], active: 0 };
    if (l.burstOn) prune(entry, t, l.burstWindowMs);
    else entry.starts.length = 0;

    if (l.burstOn && entry.starts.length >= l.burstMax) {
      const retryAfterMs = entry.starts[0] + l.burstWindowMs - t;
      return { ok: false, code: CHAT_ABUSE_CODES.BURST, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), retryAfterMs, limit: l.burstMax, at: t };
    }
    if (l.concurrencyOn && entry.active >= l.maxConcurrent) {
      return { ok: false, code: CHAT_ABUSE_CODES.BUSY, retryAfterSeconds: null, retryAfterMs: null, limit: l.maxConcurrent, at: t };
    }
    // Only an admitted request counts: a refused attempt does not extend its own lockout.
    if (l.burstOn) entry.starts.push(t);
    entry.active += 1;
    users.set(userId, entry);
    let released = false;
    return {
      ok: true,
      // Idempotent: a response can both finish and close, and must free its slot exactly once.
      release() {
        if (released) return;
        released = true;
        const current = users.get(userId);
        if (current && current.active > 0) current.active -= 1;
      },
    };
  }

  function deny(res, decision) {
    const burst = decision.code === CHAT_ABUSE_CODES.BURST;
    const error = accessError("rate", {
      feature: "Chat",
      publicMessage: MESSAGES[decision.code],
      code: decision.code,
      status: 429,
      resetAt: burst ? new Date(decision.at + decision.retryAfterMs) : undefined,
      detail: { kind: burst ? "burst" : "concurrent" },
    });
    // Code and limit only: no account id, no message text.
    log(JSON.stringify({ event: "chat_abuse_limited", code: decision.code, limit: decision.limit }));
    res.set("Cache-Control", "no-store");
    if (burst) res.set("Retry-After", String(decision.retryAfterSeconds));
    return res.status(429).json({ ...accessPayload(error), status: 429 });
  }

  function middleware(req, res, next) {
    const userId = req.authSession?.user?.id;
    if (!userId) return next(); // the session guard has already refused anonymous requests
    const decision = admit(userId);
    if (!decision.ok) return deny(res, decision);
    res.once("close", decision.release);
    res.once("finish", decision.release);
    return next();
  }

  // Forget accounts that have nothing in flight and nothing in the window.
  function sweep() {
    const l = limits();
    const t = now();
    for (const [userId, entry] of users) {
      if (l.burstOn) prune(entry, t, l.burstWindowMs);
      if (!entry.active && !entry.starts.length) users.delete(userId);
    }
  }
  const timer = setInterval(sweep, sweepMs);
  timer.unref?.();

  return {
    middleware,
    admit,
    sweep,
    snapshot: (userId) => { const e = users.get(userId); return { active: e?.active ?? 0, inWindow: e?.starts.length ?? 0 }; },
    size: () => users.size,
    reset: () => users.clear(),
    stop: () => clearInterval(timer),
  };
}
