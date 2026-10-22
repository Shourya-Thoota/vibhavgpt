import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { decanetConfig, DecanetError } from "./config.js";
import { pool } from "./db.js";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = "decanet_session";
const SESSION_DAYS = 30;

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function validEmail(email) {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email);
}

export function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash || typeof password !== "string") return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function createSession(accountId, db = pool) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO decanet_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), accountId],
  );
  return token;
}

export async function destroySession(token, db = pool) {
  if (token) await db.query("DELETE FROM decanet_sessions WHERE token_hash = $1", [sha256(token)]);
}

// The session cookie lives on the API host. DECANet and the API are both
// under vibhavgpt.com, so it is same-site and SameSite=Lax cookies reach the
// API from the DECANet page.
export function sessionCookie(token, { secure = process.env.NODE_ENV === "production" } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/api/decanet", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function accountForSession(token, db = pool) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT a.* FROM decanet_sessions s JOIN decanet_accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > now() LIMIT 1`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function loadDecanetAccount(req, _res, next) {
  try {
    req.decanetToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    req.decanetAccount = await accountForSession(req.decanetToken);
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireDecanetAccount(req, res, next) {
  if (!req.decanetAccount) return res.status(401).json({ error: "Please sign in to DECANet.", code: "signin-required" });
  return next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.decanetAccount?.role !== role) return res.status(403).json({ error: role === "advisor" ? "Only advisors can do that." : "Only participants can do that." });
    return next();
  };
}

export function cleanName(name) {
  return String(name ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export async function signUp({ email, password, name, role }, db = pool) {
  const normalized = normalizeEmail(email);
  const displayName = cleanName(name);
  if (!validEmail(normalized)) throw new DecanetError(400, "Enter a valid email address.");
  if (!validPassword(password)) throw new DecanetError(400, "Use a password of at least 8 characters.");
  if (!displayName) throw new DecanetError(400, "Enter your name.");
  const safeRole = role === "advisor" ? "advisor" : "participant";
  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await db.query(
      `INSERT INTO decanet_accounts (email, email_normalized, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(email).trim(), normalized, passwordHash, displayName, safeRole],
    );
    return rows[0];
  } catch (error) {
    if (error.code === "23505") throw new DecanetError(409, "An account with this email already exists. Sign in instead.");
    throw error;
  }
}

export async function signIn({ email, password }, db = pool) {
  const { rows } = await db.query("SELECT * FROM decanet_accounts WHERE email_normalized = $1 LIMIT 1", [normalizeEmail(email)]);
  const account = rows[0];
  // A hash is always computed, so a missing account takes as long as a wrong password.
  const ok = await verifyPassword(String(password ?? ""), account?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
  if (!account || !account.password_hash || !ok) throw new DecanetError(401, "That email and password don't match.");
  return account;
}

// Password reset: a six-digit code by email, valid 15 minutes, five tries.
export async function requestPasswordReset(email, { send = sendResetEmail, db = pool } = {}) {
  const { rows } = await db.query("SELECT id, email, name FROM decanet_accounts WHERE email_normalized = $1 AND password_hash IS NOT NULL LIMIT 1", [normalizeEmail(email)]);
  const account = rows[0];
  if (!account) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query("UPDATE decanet_password_resets SET used_at = now() WHERE account_id = $1 AND used_at IS NULL", [account.id]);
  await db.query("INSERT INTO decanet_password_resets (account_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [account.id, sha256(code)]);
  await send({ to: account.email, name: account.name, code });
}

export async function resetPassword({ email, code, password }, db = pool) {
  if (!validPassword(password)) throw new DecanetError(400, "Use a password of at least 8 characters.");
  const invalid = new DecanetError(400, "That code is invalid or has expired.");
  const { rows } = await db.query(
    `SELECT r.id, r.code_hash, r.attempts, a.id AS account_id FROM decanet_password_resets r JOIN decanet_accounts a ON a.id = r.account_id
     WHERE a.email_normalized = $1 AND r.used_at IS NULL AND r.expires_at > now() ORDER BY r.created_at DESC LIMIT 1`,
    [normalizeEmail(email)],
  );
  const reset = rows[0];
  if (!reset || reset.attempts >= 5) throw invalid;
  if (sha256(String(code ?? "").trim()) !== reset.code_hash) {
    await db.query("UPDATE decanet_password_resets SET attempts = attempts + 1 WHERE id = $1", [reset.id]);
    throw invalid;
  }
  await db.query("UPDATE decanet_password_resets SET used_at = now() WHERE id = $1", [reset.id]);
  await db.query("UPDATE decanet_accounts SET password_hash = $2, updated_at = now() WHERE id = $1", [reset.account_id, await hashPassword(password)]);
  await db.query("DELETE FROM decanet_sessions WHERE account_id = $1", [reset.account_id]);
  return reset.account_id;
}

export async function sendResetEmail({ to, name, code }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new DecanetError(503, "Email is not configured yet.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: decanetConfig.emailFrom,
      to: [to],
      subject: `Your DECANet reset code: ${code}`,
      text: `Hi ${name || "there"},\n\nYour DECANet password reset code is ${code}. It expires in 15 minutes.\n\nIf you didn't ask to reset your password, you can ignore this email.\n\nDECANet by VibhavGPT`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new DecanetError(502, "We couldn't send the email. Please try again.");
}
