import { Router } from "express";
import rateLimit from "express-rate-limit";
import { fromNodeHeaders } from "better-auth/node";
import { auth as vibhavAuth } from "../auth.js";
import {
  cleanName, createSession, destroySession, hashPassword, loadDecanetAccount, normalizeEmail, requestPasswordReset, requireDecanetAccount,
  requireRole, resetPassword, sessionCookie, signIn, signUp, validPassword, verifyPassword,
} from "./auth.js";
import { connectJudge, continueToRoleplay, dashboard, finishAttempt, getAttempt, retryGrading, saveNotes, saveTranscript, startAttempt } from "./attempts.js";
import { eventSummary } from "./catalog.js";
import {
  advisorChapter, advisorChapterView, approveMember, chapterPreview, createChapter, deleteChapter, joinChapter, leaveChapter, lockMemberEvent,
  memberAttemptDetail, memberAttempts, membershipOf, participantChapterView, removeMember, rotateCodes, updateChapter,
} from "./chapters.js";
import { DecanetError } from "./config.js";
import { creditBalance, creditHistory, distributeEvenly, grantSubscriberCredits, moveChapterCredits, vibhavgptTier } from "./credits.js";
import { pool } from "./db.js";
import { EVENTS, findEvent } from "./events.js";
import { CHAPTER_TIERS, grantPeriod, INDIVIDUAL_PACKS, SUBSCRIBER_CREDITS } from "./pricing.js";
import { confirmCheckout, createCheckout, purchaseHistory } from "./stripe.js";

export const decanetRouter = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many attempts. Please wait a few minutes." } });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 4, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Please wait before requesting another code." } });
const connectLimiter = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Please wait a moment before reconnecting." } });

const handle = (work) => async (req, res, next) => {
  try {
    const result = await work(req, res);
    if (!res.headersSent) res.json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof DecanetError) return res.status(error.status).json({ error: error.message, code: error.code });
    return next(error);
  }
};

decanetRouter.use(loadDecanetAccount);

async function accountView(account) {
  const tier = await vibhavgptTier(account.vibhav_user_id);
  return {
    id: account.id, email: account.email, name: account.name, role: account.role, eventCode: account.event_code, onboarded: account.onboarded,
    hasPassword: Boolean(account.password_hash), vibhavgpt: { connected: Boolean(account.vibhav_user_id), tier },
  };
}

async function startSession(res, account) {
  res.setHeader("Set-Cookie", sessionCookie(await createSession(account.id)));
  return { account: await accountView(account) };
}

async function vibhavSession(req) {
  return vibhavAuth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
}

// ---- Public ---------------------------------------------------------------

decanetRouter.get("/catalog", handle(async () => ({
  events: EVENTS.map(eventSummary),
  pricing: { individual: INDIVIDUAL_PACKS, chapterTiers: CHAPTER_TIERS, subscriberCredits: SUBSCRIBER_CREDITS },
})));

decanetRouter.get("/me", handle(async (req) => {
  const account = req.decanetAccount;
  if (!account) return { account: null };
  await grantSubscriberCredits(account).catch((error) => console.error("decanet.grant.failed", error?.message));
  return { account: await accountView(account), credits: await creditBalance(account.id), chapter: account.role === "advisor" ? await advisorChapterView(account) : await participantChapterView(account) };
}));

// ---- Accounts ---------------------------------------------------------------

decanetRouter.post("/auth/signup", authLimiter, handle(async (req, res) => startSession(res, await signUp(req.body ?? {}))));
decanetRouter.post("/auth/login", authLimiter, handle(async (req, res) => startSession(res, await signIn(req.body ?? {}))));
decanetRouter.post("/auth/logout", handle(async (req, res) => {
  await destroySession(req.decanetToken);
  res.setHeader("Set-Cookie", sessionCookie(""));
}));
decanetRouter.post("/auth/password/forgot", resetLimiter, handle(async (req) => {
  await requestPasswordReset(req.body?.email);
  return { ok: true };
}));
decanetRouter.post("/auth/password/reset", authLimiter, handle(async (req, res) => {
  const accountId = await resetPassword(req.body ?? {});
  const { rows } = await pool.query("SELECT * FROM decanet_accounts WHERE id = $1", [accountId]);
  return startSession(res, rows[0]);
}));

// Is the browser signed in to VibhavGPT? (Its session cookie reaches this
// API because DECANet and VibhavGPT share the vibhavgpt.com site.)
decanetRouter.get("/auth/vibhavgpt", handle(async (req) => {
  const session = await vibhavSession(req);
  return session ? { signedIn: true, name: session.user.name, email: session.user.email } : { signedIn: false };
}));

// Sign in with VibhavGPT, or connect it to the DECANet account already signed in.
decanetRouter.post("/auth/vibhavgpt", authLimiter, handle(async (req, res) => {
  const session = await vibhavSession(req);
  if (!session) throw new DecanetError(401, "Sign in to VibhavGPT first.", "vibhavgpt-signin-required");
  const vibhavUserId = session.user.id;
  const { rows: linked } = await pool.query("SELECT * FROM decanet_accounts WHERE vibhav_user_id = $1", [vibhavUserId]);
  const current = req.decanetAccount;
  if (current) {
    if (linked[0] && linked[0].id !== current.id) throw new DecanetError(409, "That VibhavGPT account is already connected to a different DECANet account.");
    await pool.query("UPDATE decanet_accounts SET vibhav_user_id = $2, updated_at = now() WHERE id = $1", [current.id, vibhavUserId]);
    const account = { ...current, vibhav_user_id: vibhavUserId };
    await grantSubscriberCredits(account).catch(() => {});
    return { account: await accountView(account), connected: true };
  }
  if (linked[0]) return startSession(res, linked[0]);
  // A new DECANet account from VibhavGPT. An existing password account with the
  // same email is never taken over automatically: its owner signs in and
  // connects VibhavGPT from Settings.
  const email = String(session.user.email ?? "").trim();
  try {
    const { rows } = await pool.query(
      `INSERT INTO decanet_accounts (email, email_normalized, name, role, vibhav_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, normalizeEmail(email), cleanName(session.user.name) || email.split("@")[0], req.body?.role === "advisor" ? "advisor" : "participant", vibhavUserId],
    );
    await grantSubscriberCredits(rows[0]).catch(() => {});
    return startSession(res, rows[0]);
  } catch (error) {
    if (error.code === "23505") throw new DecanetError(409, "A DECANet account already uses this email. Sign in with your password, then connect VibhavGPT in Settings.", "email-in-use");
    throw error;
  }
}));

decanetRouter.delete("/auth/vibhavgpt", requireDecanetAccount, handle(async (req) => {
  if (!req.decanetAccount.password_hash) throw new DecanetError(409, "Add a password first, so you can still sign in after disconnecting.");
  await pool.query("UPDATE decanet_accounts SET vibhav_user_id = NULL, updated_at = now() WHERE id = $1", [req.decanetAccount.id]);
  return { account: await accountView({ ...req.decanetAccount, vibhav_user_id: null }) };
}));

decanetRouter.post("/account/password", requireDecanetAccount, authLimiter, handle(async (req) => {
  const account = req.decanetAccount;
  if (account.password_hash && !(await verifyPassword(String(req.body?.current ?? ""), account.password_hash))) throw new DecanetError(401, "Your current password isn't right.");
  if (!validPassword(req.body?.password)) throw new DecanetError(400, "Use a password of at least 8 characters.");
  await pool.query("UPDATE decanet_accounts SET password_hash = $2, updated_at = now() WHERE id = $1", [account.id, await hashPassword(req.body.password)]);
  await pool.query("DELETE FROM decanet_sessions WHERE account_id = $1 AND token_hash <> encode(sha256(convert_to($2, 'UTF8')), 'hex')", [account.id, req.decanetToken ?? ""]);
}));

decanetRouter.patch("/account", requireDecanetAccount, handle(async (req) => {
  const account = req.decanetAccount;
  const updates = {};
  if (req.body?.name !== undefined) {
    updates.name = cleanName(req.body.name);
    if (!updates.name) throw new DecanetError(400, "Enter your name.");
  }
  if (req.body?.role !== undefined) {
    if (!["participant", "advisor"].includes(req.body.role)) throw new DecanetError(400, "Choose participant or advisor.");
    if (req.body.role !== account.role && (await membershipOf(account.id))) throw new DecanetError(409, "Leave your chapter before switching account type.");
    updates.role = req.body.role;
  }
  if (req.body?.eventCode !== undefined) {
    const event = findEvent(req.body.eventCode);
    if (!event) throw new DecanetError(400, "Choose a valid event.");
    const membership = await membershipOf(account.id);
    if (membership?.status === "active" && membership.locked_event && membership.locked_event !== event.code) throw new DecanetError(409, "Your advisor has locked your event.");
    updates.event_code = event.code;
  }
  if (req.body?.onboarded === true) updates.onboarded = true;
  const keys = Object.keys(updates);
  if (keys.length) {
    await pool.query(
      `UPDATE decanet_accounts SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
      [account.id, ...keys.map((key) => updates[key])],
    );
  }
  return { account: await accountView({ ...account, ...updates }) };
}));

decanetRouter.delete("/account", requireDecanetAccount, handle(async (req, res) => {
  if (req.body?.confirm !== "DELETE") throw new DecanetError(400, "Type DELETE to confirm.");
  const membership = await membershipOf(req.decanetAccount.id);
  if (membership?.role === "advisor" && membership.status === "active") await leaveChapter(req.decanetAccount);
  await pool.query("DELETE FROM decanet_accounts WHERE id = $1", [req.decanetAccount.id]);
  res.setHeader("Set-Cookie", sessionCookie(""));
}));

// ---- Practice ---------------------------------------------------------------

decanetRouter.get("/dashboard", requireDecanetAccount, handle(async (req) => ({ ...(await dashboard(req.decanetAccount)), credits: await creditBalance(req.decanetAccount.id) })));
decanetRouter.post("/attempts", requireDecanetAccount, requireRole("participant"), handle(async (req) => {
  const attempt = await startAttempt(req.decanetAccount, req.body?.roleplayId);
  return getAttempt(req.decanetAccount, attempt.id);
}));
decanetRouter.get("/attempts/:id", requireDecanetAccount, handle(async (req) => getAttempt(req.decanetAccount, req.params.id)));
decanetRouter.put("/attempts/:id/notes", requireDecanetAccount, handle(async (req) => saveNotes(req.decanetAccount, req.params.id, req.body?.notes)));
decanetRouter.post("/attempts/:id/continue", requireDecanetAccount, handle(async (req) => continueToRoleplay(req.decanetAccount, req.params.id, req.body?.notes)));
decanetRouter.post("/attempts/:id/connect", requireDecanetAccount, connectLimiter, handle(async (req) => connectJudge(req.decanetAccount, req.params.id, req.body?.sdp)));
decanetRouter.put("/attempts/:id/transcript", requireDecanetAccount, handle(async (req) => saveTranscript(req.decanetAccount, req.params.id, req.body?.segments)));
decanetRouter.post("/attempts/:id/finish", requireDecanetAccount, handle(async (req) => finishAttempt(req.decanetAccount, req.params.id, req.body ?? {})));
decanetRouter.post("/attempts/:id/retry-grading", requireDecanetAccount, handle(async (req) => retryGrading(req.decanetAccount, req.params.id)));

// ---- Credits ----------------------------------------------------------------

decanetRouter.get("/credits", requireDecanetAccount, handle(async (req) => {
  const account = req.decanetAccount;
  const tier = await vibhavgptTier(account.vibhav_user_id);
  return {
    balance: await creditBalance(account.id), history: await creditHistory(account.id), purchases: await purchaseHistory(account),
    subscriber: { tier, creditsPerPeriod: tier ? SUBSCRIBER_CREDITS[tier] : 0, nextGrantAt: grantPeriod().endsAt },
  };
}));
decanetRouter.post("/checkout", requireDecanetAccount, handle(async (req) => {
  const kind = req.body?.kind === "chapter" ? "chapter" : "individual";
  const chapter = kind === "chapter" ? await advisorChapter(req.decanetAccount) : null;
  return createCheckout({ account: req.decanetAccount, kind, pack: req.body?.pack, quantity: req.body?.quantity, chapterId: chapter?.id });
}));
decanetRouter.post("/checkout/confirm", requireDecanetAccount, handle(async (req) => confirmCheckout(req.decanetAccount, req.body?.sessionId)));

// ---- Chapters ---------------------------------------------------------------

decanetRouter.get("/chapter", requireDecanetAccount, handle(async (req) => ({
  chapter: req.decanetAccount.role === "advisor" ? await advisorChapterView(req.decanetAccount) : await participantChapterView(req.decanetAccount),
})));
decanetRouter.post("/chapter", requireDecanetAccount, requireRole("advisor"), handle(async (req) => {
  await createChapter(req.decanetAccount, req.body ?? {});
  return { chapter: await advisorChapterView(req.decanetAccount) };
}));
decanetRouter.patch("/chapter", requireDecanetAccount, handle(async (req) => updateChapter(req.decanetAccount, req.body ?? {})));
decanetRouter.delete("/chapter", requireDecanetAccount, handle(async (req) => deleteChapter(req.decanetAccount)));
decanetRouter.post("/chapter/rotate-codes", requireDecanetAccount, handle(async (req) => rotateCodes(req.decanetAccount)));
decanetRouter.post("/chapter/join", requireDecanetAccount, authLimiter, handle(async (req) => joinChapter(req.decanetAccount, { code: req.body?.code, consent: req.body?.consent })));
decanetRouter.get("/chapter/invite/:token", handle(async (req) => chapterPreview(req.params.token)));
decanetRouter.post("/chapter/invite/:token/join", requireDecanetAccount, handle(async (req) => joinChapter(req.decanetAccount, { token: req.params.token, consent: req.body?.consent })));
decanetRouter.post("/chapter/leave", requireDecanetAccount, handle(async (req) => leaveChapter(req.decanetAccount)));
decanetRouter.post("/chapter/members/:id/approve", requireDecanetAccount, handle(async (req) => approveMember(req.decanetAccount, req.params.id)));
decanetRouter.delete("/chapter/members/:id", requireDecanetAccount, handle(async (req) => removeMember(req.decanetAccount, req.params.id)));
decanetRouter.patch("/chapter/members/:id", requireDecanetAccount, handle(async (req) => lockMemberEvent(req.decanetAccount, req.params.id, req.body?.lockedEvent ?? null)));
decanetRouter.post("/chapter/members/:id/credits", requireDecanetAccount, handle(async (req) => {
  const chapter = await advisorChapter(req.decanetAccount);
  const member = await membershipOf(req.params.id);
  if (member?.chapter_id !== chapter.id || member.status !== "active") throw new DecanetError(404, "That person isn't an active member of your chapter.");
  return moveChapterCredits({ chapterId: chapter.id, memberId: req.params.id, delta: req.body?.delta, actorId: req.decanetAccount.id });
}));
decanetRouter.post("/chapter/credits/distribute", requireDecanetAccount, handle(async (req) => {
  const chapter = await advisorChapter(req.decanetAccount);
  return distributeEvenly({ chapterId: chapter.id, perMember: req.body?.perMember, actorId: req.decanetAccount.id });
}));
decanetRouter.get("/chapter/members/:id/attempts", requireDecanetAccount, handle(async (req) => memberAttempts(req.decanetAccount, req.params.id)));
decanetRouter.get("/chapter/attempts/:id", requireDecanetAccount, handle(async (req) => memberAttemptDetail(req.decanetAccount, req.params.id)));
