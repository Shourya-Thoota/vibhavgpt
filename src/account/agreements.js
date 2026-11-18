// Eligibility and agreements (legal audit, 2026-11-16).
//
// Every account, however it signed up (email, Google, GitHub, Microsoft, Discord, passkey), answers a neutral age question (month and year
// of birth, not "are you 16?") and accepts the current Terms of Service and Privacy Policy before it can use VibhavGPT. The result is
// recorded on the server: the versions accepted and when, and whether the person is 16 or older. The date of birth is used once, to
// compute that, and never stored. Someone under 16 (the Terms' minimum age) is blocked and cannot answer again; they can still sign out,
// export or delete the account.
//
// Enforced here, on the server (agreementsGate, mounted in front of the routes that do work); the app's screen only asks.
import { Router } from "express";
import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { accountAgreements } from "../db/schema.js";
import { requireSession, loadOptionalSession } from "../middleware/require-session.js";
import { MINIMUM_AGE, PRIVACY_VERSION, TERMS_VERSION } from "../../frontend/src/legal-versions.js";

const noStore = (res) => res.set({ "Cache-Control": "private, no-store", Vary: "Cookie" });

/**
 * Whether someone born in that month and year is at least `minimum` years old now. Conservative: without a day, they are counted as
 * reaching each birthday at the end of their birth month. Returns null for an impossible or future date.
 */
export function oldEnough(birthMonth, birthYear, { now = new Date(), minimum = MINIMUM_AGE } = {}) {
  if (!Number.isInteger(birthMonth) || birthMonth < 1 || birthMonth > 12) return null;
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > now.getUTCFullYear()) return null;
  if (birthYear === now.getUTCFullYear() && birthMonth > now.getUTCMonth() + 1) return null;
  // The first moment they are certainly `minimum`: the start of the month after their birth month, `minimum` years on.
  const certain = Date.UTC(birthYear + minimum, birthMonth, 1);
  return now.getTime() >= certain;
}

export async function loadAgreements(userId, database = db) {
  const [row] = await database.select().from(accountAgreements).where(eq(accountAgreements.userId, userId)).limit(1);
  return row ?? null;
}

/** What the account still has to do: { blocked, required, ageChecked, accepted, termsVersion, privacyVersion }. */
export function agreementStatus(row) {
  const blocked = row?.ageCheck === "under_16";
  const ageChecked = row?.ageCheck === "16_plus";
  const accepted = row?.termsVersion === TERMS_VERSION && row?.privacyVersion === PRIVACY_VERSION && Boolean(row?.acceptedAt);
  return { blocked, ageChecked, accepted, required: !blocked && !(ageChecked && accepted), termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, minimumAge: MINIMUM_AGE };
}

export function createAgreementsRouter({ database = db, session = requireSession, now = () => new Date() } = {}) {
  const router = Router();
  router.use(session);
  router.use(express.json({ limit: "1kb" }));

  router.get("/", async (req, res, next) => {
    try {
      return noStore(res).status(200).json({ agreements: agreementStatus(await loadAgreements(req.authSession.user.id, database)) });
    } catch (error) { return next(error); }
  });

  router.post("/", async (req, res, next) => {
    try {
      const userId = req.authSession.user.id;
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const row = await loadAgreements(userId, database);
      if (row?.ageCheck === "under_16") return noStore(res).status(403).json({ error: `VibhavGPT is only for people ${MINIMUM_AGE} and older.`, code: "age_blocked", agreements: agreementStatus(row) });
      const changes = {};
      if (row?.ageCheck !== "16_plus") {
        const old = oldEnough(Number(body.birthMonth), Number(body.birthYear), { now: now() });
        if (old === null) return noStore(res).status(400).json({ error: "Choose the month and year you were born.", code: "bad_birth_date" });
        changes.ageCheck = old ? "16_plus" : "under_16";
        changes.ageCheckedAt = now();
      }
      if (changes.ageCheck !== "under_16") {
        if (body.acceptTerms !== true) return noStore(res).status(400).json({ error: "Accept the Terms of Service and Privacy Policy to continue.", code: "terms_required" });
        Object.assign(changes, { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, acceptedAt: now() });
      }
      const [saved] = await database.insert(accountAgreements).values({ userId, ...changes })
        .onConflictDoUpdate({ target: accountAgreements.userId, set: { ...changes, updatedAt: now() } }).returning();
      const status = agreementStatus(saved);
      if (status.blocked) return noStore(res).status(403).json({ error: `VibhavGPT is only for people ${MINIMUM_AGE} and older.`, code: "age_blocked", agreements: status });
      return noStore(res).status(200).json({ agreements: status });
    } catch (error) { return next(error); }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") return noStore(res).status(400).json({ error: "Send a small JSON object.", code: "bad_request" });
    return next(error);
  });
  return router;
}

// The routes that do work. Until an account has answered the age question and accepted the current Terms and Privacy Policy, requests
// that change anything there are refused (reading what already exists is not); an account under 16 is refused everything there.
// Without a session the gate steps aside and each route answers 401 as before. If the record can't be read, the request is refused.
export const GATED_PATHS = Object.freeze(["/api/chat", "/api/build", "/api/generation", "/api/uploads", "/api/voice", "/api/memory", "/api/connectors", "/api/skills", "/api/library", "/api/avatars", "/api/profile/picture", "/api/search"]);

export function createAgreementsGate({ database = db, session = loadOptionalSession } = {}) {
  return (req, res, next) => session(req, res, async (error) => {
    if (error) return next(error);
    const userId = req.authSession?.user?.id;
    if (!userId) return next();
    try {
      const status = agreementStatus(await loadAgreements(userId, database));
      if (status.blocked) return noStore(res).status(403).json({ error: `VibhavGPT is only for people ${MINIMUM_AGE} and older.`, code: "age_blocked" });
      const reading = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
      if (status.required && !reading) return noStore(res).status(403).json({ error: "Confirm your age and accept the Terms of Service and Privacy Policy to continue.", code: "agreements_required" });
      return next();
    } catch {
      return noStore(res).status(503).json({ error: "Your account couldn't be checked. Try again in a moment.", code: "agreements_unavailable" });
    }
  });
}
