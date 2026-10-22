import { randomBytes, randomInt } from "node:crypto";
import { attemptView } from "./attempts.js";
import { findRoleplay, roleplaySummary } from "./catalog.js";
import { DecanetError } from "./config.js";
import { pool, transaction } from "./db.js";
import { findEvent } from "./events.js";
import { chapterBalance, creditBalance } from "./credits.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateCode(length = 6) {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join("");
}
const generateToken = () => randomBytes(18).toString("base64url");
const cleanText = (value, max) => String(value ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export async function membershipOf(accountId, db = pool) {
  const { rows } = await db.query("SELECT * FROM decanet_chapter_members WHERE account_id = $1 LIMIT 1", [accountId]);
  return rows[0] ?? null;
}

async function chapterById(chapterId, db = pool) {
  const { rows } = await db.query("SELECT * FROM decanet_chapters WHERE id = $1", [chapterId]);
  return rows[0] ?? null;
}

// The chapter an advisor actively manages, or a 403.
export async function advisorChapter(account, db = pool) {
  const membership = await membershipOf(account.id, db);
  if (account.role !== "advisor" || membership?.role !== "advisor" || membership.status !== "active") throw new DecanetError(403, "You need to be an active advisor of a chapter.");
  return chapterById(membership.chapter_id, db);
}

export async function createChapter(account, { name, school, requireApproval = true }, db = pool) {
  if (account.role !== "advisor") throw new DecanetError(403, "Only advisors can start a chapter.");
  if (await membershipOf(account.id, db)) throw new DecanetError(409, "You're already part of a chapter.");
  const chapterName = cleanText(name, 80);
  if (!chapterName) throw new DecanetError(400, "Give your chapter a name.");
  return transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO decanet_chapters (name, school, join_code, advisor_code, invite_token, require_approval, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [chapterName, cleanText(school, 120), generateCode(6), generateCode(8), generateToken(), requireApproval !== false, account.id],
    );
    await client.query(
      `INSERT INTO decanet_chapter_members (chapter_id, account_id, role, status, consented_at, approved_by) VALUES ($1, $2, 'advisor', 'active', now(), $2)`,
      [rows[0].id, account.id],
    );
    return rows[0];
  }, db);
}

export async function chapterPreview(token, db = pool) {
  const { rows } = await db.query("SELECT name, school, require_approval FROM decanet_chapters WHERE invite_token = $1", [String(token ?? "")]);
  if (!rows[0]) throw new DecanetError(404, "This invite link isn't valid anymore. Ask your advisor for a new one.");
  return { name: rows[0].name, school: rows[0].school, requireApproval: rows[0].require_approval };
}

// Joining by participant code, advisor code or invite link. Participants must
// agree to share their results with the chapter's advisors; co-advisors always
// need an existing advisor's approval.
export async function joinChapter(account, { code, token, consent }, db = pool) {
  if (await membershipOf(account.id, db)) throw new DecanetError(409, "You're already in a chapter. Leave it first to join another.");
  const cleanCode = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let chapter = null, asRole = account.role;
  if (token) chapter = (await db.query("SELECT * FROM decanet_chapters WHERE invite_token = $1", [String(token)])).rows[0];
  else if (cleanCode.length === 6) chapter = (await db.query("SELECT * FROM decanet_chapters WHERE join_code = $1", [cleanCode])).rows[0];
  else if (cleanCode.length === 8) chapter = (await db.query("SELECT * FROM decanet_chapters WHERE advisor_code = $1", [cleanCode])).rows[0];
  if (!chapter) throw new DecanetError(404, "We couldn't find a chapter with that code.");
  if (cleanCode.length === 8 && account.role !== "advisor") throw new DecanetError(400, "That's an advisor code. Ask your advisor for the participant code.");
  if (account.role === "advisor" && cleanCode.length !== 8) throw new DecanetError(400, "Advisors join with the chapter's advisor code.");
  if (asRole === "participant" && consent !== true) throw new DecanetError(400, "You need to agree to share your role-play results with your chapter's advisors.");
  const status = asRole === "advisor" || chapter.require_approval ? "pending" : "active";
  await db.query(
    `INSERT INTO decanet_chapter_members (chapter_id, account_id, role, status, consented_at) VALUES ($1, $2, $3, $4, now())`,
    [chapter.id, account.id, asRole, status],
  );
  return { chapterName: chapter.name, status };
}

export async function leaveChapter(account, db = pool) {
  const membership = await membershipOf(account.id, db);
  if (!membership) return;
  if (membership.role === "advisor" && membership.status === "active") {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM decanet_chapter_members WHERE chapter_id = $1 AND role = 'advisor' AND status = 'active'", [membership.chapter_id]);
    if (rows[0].n <= 1) throw new DecanetError(409, "You're the only advisor. Add another advisor before leaving, or delete the chapter.");
  }
  await db.query("DELETE FROM decanet_chapter_members WHERE account_id = $1", [account.id]);
}

export async function deleteChapter(account, db = pool) {
  const chapter = await advisorChapter(account, db);
  if ((await chapterBalance(chapter.id, db)) > 0) throw new DecanetError(409, "Distribute the chapter's remaining credits before deleting it.");
  await db.query("DELETE FROM decanet_chapters WHERE id = $1", [chapter.id]);
}

export async function participantChapterView(account, db = pool) {
  const membership = await membershipOf(account.id, db);
  if (!membership) return null;
  const chapter = await chapterById(membership.chapter_id, db);
  return { name: chapter.name, school: chapter.school, status: membership.status, role: membership.role, lockedEvent: membership.locked_event };
}

export async function advisorChapterView(account, db = pool) {
  const membership = await membershipOf(account.id, db);
  if (!membership) return null;
  const chapter = await chapterById(membership.chapter_id, db);
  if (membership.status !== "active") return { name: chapter.name, school: chapter.school, status: membership.status, role: "advisor" };
  const { rows: members } = await db.query(
    `SELECT a.id, a.name, a.email, a.event_code, m.role, m.status, m.locked_event, m.created_at,
       COALESCE((SELECT SUM(delta) FROM decanet_credit_ledger l WHERE l.account_id = a.id), 0)::int AS credits,
       (SELECT count(*) FROM decanet_attempts t WHERE t.account_id = a.id AND t.chapter_id = m.chapter_id AND t.status = 'graded')::int AS completed,
       (SELECT round(avg(score)) FROM decanet_attempts t WHERE t.account_id = a.id AND t.chapter_id = m.chapter_id AND t.status = 'graded')::int AS average,
       (SELECT max(created_at) FROM decanet_attempts t WHERE t.account_id = a.id AND t.chapter_id = m.chapter_id) AS last_activity
     FROM decanet_chapter_members m JOIN decanet_accounts a ON a.id = m.account_id
     WHERE m.chapter_id = $1 ORDER BY m.status DESC, m.role, a.name`,
    [chapter.id],
  );
  return {
    id: chapter.id, name: chapter.name, school: chapter.school, status: "active", role: "advisor",
    joinCode: chapter.join_code, advisorCode: chapter.advisor_code, inviteToken: chapter.invite_token, requireApproval: chapter.require_approval,
    credits: await chapterBalance(chapter.id, db),
    members: members.map((row) => ({
      id: row.id, name: row.name, email: row.email, role: row.role, status: row.status,
      eventCode: row.locked_event ?? row.event_code, lockedEvent: row.locked_event,
      credits: row.credits, completed: row.completed, average: row.average, lastActivity: row.last_activity, joinedAt: row.created_at,
      self: row.id === account.id,
    })),
  };
}

export async function updateChapter(account, { name, school, requireApproval }, db = pool) {
  const chapter = await advisorChapter(account, db);
  await db.query(
    `UPDATE decanet_chapters SET name = COALESCE(NULLIF($2, ''), name), school = COALESCE($3, school), require_approval = COALESCE($4, require_approval), updated_at = now() WHERE id = $1`,
    [chapter.id, cleanText(name, 80), school === undefined ? null : cleanText(school, 120), typeof requireApproval === "boolean" ? requireApproval : null],
  );
}

export async function rotateCodes(account, db = pool) {
  const chapter = await advisorChapter(account, db);
  await db.query("UPDATE decanet_chapters SET join_code = $2, advisor_code = $3, invite_token = $4, updated_at = now() WHERE id = $1", [chapter.id, generateCode(6), generateCode(8), generateToken()]);
}

async function memberOfChapter(chapterId, memberId, db) {
  const { rows } = await db.query("SELECT * FROM decanet_chapter_members WHERE chapter_id = $1 AND account_id = $2", [chapterId, memberId]);
  if (!rows[0]) throw new DecanetError(404, "That person isn't in your chapter.");
  return rows[0];
}

export async function approveMember(account, memberId, db = pool) {
  const chapter = await advisorChapter(account, db);
  await memberOfChapter(chapter.id, memberId, db);
  await db.query("UPDATE decanet_chapter_members SET status = 'active', approved_by = $3, updated_at = now() WHERE chapter_id = $1 AND account_id = $2", [chapter.id, memberId, account.id]);
}

export async function removeMember(account, memberId, db = pool) {
  const chapter = await advisorChapter(account, db);
  if (memberId === account.id) throw new DecanetError(400, "Use Leave chapter to remove yourself.");
  await memberOfChapter(chapter.id, memberId, db);
  await db.query("DELETE FROM decanet_chapter_members WHERE chapter_id = $1 AND account_id = $2", [chapter.id, memberId]);
}

// Locking an event also switches the participant to it, so their dashboard
// shows the advisor's choice right away.
export async function lockMemberEvent(account, memberId, eventCode, db = pool) {
  const chapter = await advisorChapter(account, db);
  const member = await memberOfChapter(chapter.id, memberId, db);
  if (member.role !== "participant") throw new DecanetError(400, "Only participants can be locked to an event.");
  const event = eventCode ? findEvent(eventCode) : null;
  if (eventCode && !event) throw new DecanetError(400, "Choose a valid event.");
  await db.query("UPDATE decanet_chapter_members SET locked_event = $3, updated_at = now() WHERE chapter_id = $1 AND account_id = $2", [chapter.id, memberId, event?.code ?? null]);
  if (event) await db.query("UPDATE decanet_accounts SET event_code = $2, updated_at = now() WHERE id = $1", [memberId, event.code]);
}

// Only attempts made while the participant belonged to this chapter (and so
// under their consent to share) are visible to its advisors.
export async function memberAttempts(account, memberId, db = pool) {
  const chapter = await advisorChapter(account, db);
  const member = await memberOfChapter(chapter.id, memberId, db);
  const { rows } = await db.query(
    `SELECT id, roleplay_id, status, score, result->>'max' AS max, created_at FROM decanet_attempts WHERE account_id = $1 AND chapter_id = $2 ORDER BY created_at DESC LIMIT 200`,
    [memberId, chapter.id],
  );
  const { rows: people } = await db.query("SELECT name, email FROM decanet_accounts WHERE id = $1", [memberId]);
  return {
    member: { id: memberId, name: people[0]?.name, email: people[0]?.email, lockedEvent: member.locked_event, credits: await creditBalance(memberId, db) },
    attempts: rows.map((row) => {
      const roleplay = findRoleplay(row.roleplay_id);
      return { id: row.id, status: row.status, score: row.score, max: row.max ? Number(row.max) : null, createdAt: row.created_at, roleplay: roleplay ? { ...roleplaySummary(roleplay), eventCode: roleplay.eventCode } : null };
    }),
  };
}

export async function memberAttemptDetail(account, attemptId, db = pool) {
  const chapter = await advisorChapter(account, db);
  if (!/^[0-9a-f-]{36}$/i.test(String(attemptId))) throw new DecanetError(404, "Role-play not found.");
  const { rows } = await db.query(
    `SELECT t.*, a.name AS member_name FROM decanet_attempts t JOIN decanet_accounts a ON a.id = t.account_id
     WHERE t.id = $1 AND t.chapter_id = $2 AND t.status = 'graded'`,
    [attemptId, chapter.id],
  );
  if (!rows[0]) throw new DecanetError(404, "Role-play not found.");
  return { ...attemptView(rows[0]), memberName: rows[0].member_name, notes: rows[0].notes };
}
