import { findRoleplay, participantDocument, roleplaySummary, roleplaysForEvent } from "./catalog.js";
import { DecanetError } from "./config.js";
import { pool, transaction } from "./db.js";
import { EVENT_FORMATS, findEvent } from "./events.js";
import { creditBalance } from "./credits.js";
import { gradeWithModel } from "./grading.js";
import { cancelScheduledHangUp, createRealtimeCall, estimateCostCents, hangUpRealtimeCall, sanitizeUsage, scheduleHangUp } from "./realtime.js";

// A call can reconnect a few times (a dropped network, a refreshed tab);
// each reconnect continues the same clock, never restarts it.
const MAX_CONNECTS = 5;
// After time runs out, the browser has this long to send its final transcript
// before the server closes the role-play itself.
const FINISH_GRACE_SECONDS = 120;
const GRADING_STALE_MINUTES = 4;
const MAX_GRADING_TRIES = 3;

const seconds = (from, to = new Date()) => (to.getTime() - new Date(from).getTime()) / 1000;

export async function activeMembership(accountId, db = pool) {
  const { rows } = await db.query(
    `SELECT m.*, c.name AS chapter_name FROM decanet_chapter_members m JOIN decanet_chapters c ON c.id = m.chapter_id WHERE m.account_id = $1 LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

// An advisor's lock overrides the participant's own choice of event.
export function effectiveEvent(account, membership) {
  if (membership?.status === "active" && membership.locked_event) return membership.locked_event;
  return account.event_code;
}

export function sanitizeSegments(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 600).map((segment) => ({
    speaker: segment?.speaker === "judge" ? "judge" : "participant",
    text: String(segment?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 4000),
    t: Math.max(0, Math.min(3600, Math.round(Number(segment?.t) || 0))),
  })).filter((segment) => segment.text);
}

export async function startAttempt(account, roleplayId, db = pool) {
  if (account.role !== "participant") throw new DecanetError(403, "Advisors manage chapters; role-plays are for participants.");
  const roleplay = findRoleplay(roleplayId);
  if (!roleplay) throw new DecanetError(404, "That role-play doesn't exist.");
  const membership = await activeMembership(account.id, db);
  if (roleplay.eventCode !== effectiveEvent(account, membership)) throw new DecanetError(400, "That role-play isn't in your current event.");
  const { rows: active } = await db.query("SELECT id FROM decanet_attempts WHERE account_id = $1 AND status IN ('prep', 'roleplay') LIMIT 1", [account.id]);
  if (active[0]) throw new DecanetError(409, "You already have a role-play in progress. Resume or finish it first.", `active-attempt:${active[0].id}`);
  const chapterId = membership?.status === "active" && membership.role === "participant" ? membership.chapter_id : null;
  return transaction(async (client) => {
    await client.query("SELECT id FROM decanet_accounts WHERE id = $1 FOR UPDATE", [account.id]);
    if ((await creditBalance(account.id, client)) < 1) throw new DecanetError(402, "You're out of credits. Buy more to start a role-play.", "no-credits");
    const { rows } = await client.query(
      `INSERT INTO decanet_attempts (account_id, chapter_id, event_code, roleplay_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [account.id, chapterId, roleplay.eventCode, roleplay.id],
    );
    await client.query(
      `INSERT INTO decanet_credit_ledger (account_id, delta, kind, reference, attempt_id, chapter_id, note) VALUES ($1, -1, 'roleplay', $2, $3, $4, $5)`,
      [account.id, `attempt:${rows[0].id}`, rows[0].id, chapterId, `${roleplay.eventCode} Role-Play #${roleplay.number}: ${roleplay.title}`],
    );
    return rows[0];
  }, db);
}

async function loadAttempt(accountId, attemptId, db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(String(attemptId))) throw new DecanetError(404, "Role-play not found.");
  const { rows } = await db.query("SELECT * FROM decanet_attempts WHERE id = $1 AND account_id = $2 LIMIT 1", [attemptId, accountId]);
  if (!rows[0]) throw new DecanetError(404, "Role-play not found.");
  return rows[0];
}

// Applies any transition that time alone has caused, so a participant who
// left and came back sees the role-play where the clock says it is.
export async function advance(attempt, { now = new Date(), db = pool, grade = runGrading } = {}) {
  const format = EVENT_FORMATS[findEvent(attempt.event_code).format];
  if (attempt.status === "prep" && seconds(attempt.prep_started_at, now) >= format.prepSeconds) {
    const { rows } = await db.query(
      `UPDATE decanet_attempts SET status = 'roleplay', prep_ended_at = prep_started_at + make_interval(secs => $2), updated_at = now()
       WHERE id = $1 AND status = 'prep' RETURNING *`,
      [attempt.id, format.prepSeconds],
    );
    attempt = rows[0] ?? attempt;
  }
  if (attempt.status === "roleplay" && attempt.roleplay_started_at && seconds(attempt.roleplay_started_at, now) >= format.roleplaySeconds + FINISH_GRACE_SECONDS) {
    const { rows } = await db.query(
      `UPDATE decanet_attempts SET status = 'grading', ended_at = roleplay_started_at + make_interval(secs => $2), updated_at = now()
       WHERE id = $1 AND status = 'roleplay' RETURNING *`,
      [attempt.id, format.roleplaySeconds],
    );
    if (rows[0]) {
      attempt = rows[0];
      if (attempt.realtime_call_id) void hangUpRealtimeCall(attempt.realtime_call_id);
    }
  }
  if (attempt.status === "grading") {
    const stale = !attempt.grading_started_at || attempt.grading_error || seconds(attempt.grading_started_at, now) > GRADING_STALE_MINUTES * 60;
    if (stale && attempt.grading_tries < MAX_GRADING_TRIES) void grade(attempt.id, { db });
  }
  return attempt;
}

export function attemptView(attempt, { now = new Date(), includeJudge = false } = {}) {
  const roleplay = findRoleplay(attempt.roleplay_id);
  const format = EVENT_FORMATS[roleplay.format];
  const view = {
    id: attempt.id,
    status: attempt.status,
    roleplay: roleplaySummary(roleplay),
    eventCode: attempt.event_code,
    kind: format.team ? "Case Study" : "Role-Play",
    notes: attempt.notes,
    prepSeconds: format.prepSeconds,
    roleplaySeconds: format.roleplaySeconds,
    warnAtRemaining: format.warnAtRemaining,
    questionsAtRemaining: format.questionsAtRemaining,
    createdAt: attempt.created_at,
    endedAt: attempt.ended_at,
  };
  if (attempt.status === "prep") {
    view.prepRemaining = Math.max(0, Math.round(format.prepSeconds - seconds(attempt.prep_started_at, now)));
    // The packet exists only during prep, as in a real competition.
    view.document = participantDocument(roleplay);
  }
  if (attempt.status === "roleplay") {
    view.roleplayStarted = Boolean(attempt.roleplay_started_at);
    view.roleplayRemaining = attempt.roleplay_started_at ? Math.max(0, Math.round(format.roleplaySeconds - seconds(attempt.roleplay_started_at, now))) : format.roleplaySeconds;
    view.transcript = attempt.transcript ?? [];
  }
  if (attempt.status === "grading") {
    view.gradingFailed = Boolean(attempt.grading_error) && attempt.grading_tries >= MAX_GRADING_TRIES;
  }
  if (attempt.status === "graded" || includeJudge) {
    view.result = attempt.result;
    view.score = attempt.score;
    view.transcript = attempt.transcript ?? [];
    view.document = participantDocument(roleplay);
    view.judge = { name: roleplay.judge.name, role: roleplay.judge.role, characterization: roleplay.characterization, questions: roleplay.questions };
    view.durationSeconds = attempt.roleplay_started_at && attempt.ended_at ? Math.round(seconds(attempt.roleplay_started_at, new Date(attempt.ended_at))) : 0;
  }
  return view;
}

export async function getAttempt(account, attemptId, db = pool) {
  const attempt = await advance(await loadAttempt(account.id, attemptId, db), { db });
  return attemptView(attempt);
}

export async function saveNotes(account, attemptId, notes, db = pool) {
  const attempt = await advance(await loadAttempt(account.id, attemptId, db), { db });
  if (attempt.status !== "prep") throw new DecanetError(409, "Prep time is over. Your notes are locked.", "prep-over");
  await db.query("UPDATE decanet_attempts SET notes = $2, updated_at = now() WHERE id = $1", [attempt.id, String(notes ?? "").slice(0, 20_000)]);
}

export async function continueToRoleplay(account, attemptId, notes, db = pool) {
  const attempt = await advance(await loadAttempt(account.id, attemptId, db), { db });
  if (attempt.status === "prep") {
    await db.query(
      `UPDATE decanet_attempts SET status = 'roleplay', prep_ended_at = now(), notes = COALESCE($2, notes), updated_at = now() WHERE id = $1 AND status = 'prep'`,
      [attempt.id, typeof notes === "string" ? notes.slice(0, 20_000) : null],
    );
  }
  return getAttempt(account, attemptId, db);
}

export async function connectJudge(account, attemptId, offerSdp, { db = pool, createCall = createRealtimeCall, hangUp = hangUpRealtimeCall } = {}) {
  const attempt = await advance(await loadAttempt(account.id, attemptId, db), { db });
  if (attempt.status !== "roleplay") throw new DecanetError(409, attempt.status === "prep" ? "Finish prep first." : "This role-play is over.");
  if (attempt.realtime_connects >= MAX_CONNECTS) throw new DecanetError(429, "This role-play has reconnected too many times. Finish it to get your score.", "too-many-connects");
  const format = EVENT_FORMATS[findEvent(attempt.event_code).format];
  const remaining = attempt.roleplay_started_at ? format.roleplaySeconds - seconds(attempt.roleplay_started_at) : format.roleplaySeconds;
  if (remaining < 10) throw new DecanetError(409, "Time is up for this role-play.", "time-up");
  const roleplay = findRoleplay(attempt.roleplay_id);
  const { sdp, callId } = await createCall(roleplay, offerSdp, { priorTranscript: attempt.transcript ?? [] });
  const { rows } = await db.query(
    `UPDATE decanet_attempts SET roleplay_started_at = COALESCE(roleplay_started_at, now()), realtime_call_id = $2, realtime_connects = realtime_connects + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [attempt.id, callId],
  );
  if (attempt.realtime_call_id && attempt.realtime_call_id !== callId) {
    cancelScheduledHangUp(attempt.realtime_call_id);
    void hangUp(attempt.realtime_call_id);
  }
  const roleplayRemaining = Math.max(0, Math.round(format.roleplaySeconds - seconds(rows[0].roleplay_started_at)));
  scheduleHangUp(callId, roleplayRemaining + 20, hangUp);
  return { sdp, roleplayRemaining, resumed: (attempt.transcript ?? []).length > 0 };
}

export async function saveTranscript(account, attemptId, segments, db = pool) {
  const clean = sanitizeSegments(segments);
  if (!clean) throw new DecanetError(400, "Invalid transcript.");
  await db.query("UPDATE decanet_attempts SET transcript = $2::jsonb, updated_at = now() WHERE id = $1 AND account_id = $3 AND status = 'roleplay'", [attemptId, JSON.stringify(clean), account.id]);
}

export async function finishAttempt(account, attemptId, { segments, usage } = {}, { db = pool, grade = runGrading } = {}) {
  let attempt = await advance(await loadAttempt(account.id, attemptId, db), { db, grade });
  if (attempt.status === "prep" || attempt.status === "roleplay") {
    const clean = sanitizeSegments(segments);
    const safeUsage = sanitizeUsage(usage);
    const { rows } = await db.query(
      `UPDATE decanet_attempts SET status = 'grading', prep_ended_at = COALESCE(prep_ended_at, now()), ended_at = now(),
         transcript = COALESCE($2::jsonb, transcript), realtime_usage = $3::jsonb, updated_at = now()
       WHERE id = $1 AND status IN ('prep', 'roleplay') RETURNING *`,
      [attempt.id, clean ? JSON.stringify(clean) : null, JSON.stringify(safeUsage)],
    );
    if (rows[0]) {
      attempt = rows[0];
      console.info("decanet.roleplay.finished", { attemptId: attempt.id, roleplay: attempt.roleplay_id, connects: attempt.realtime_connects, estimatedCents: estimateCostCents(safeUsage), usage: safeUsage });
      if (attempt.realtime_call_id) {
        cancelScheduledHangUp(attempt.realtime_call_id);
        void hangUpRealtimeCall(attempt.realtime_call_id);
      }
      void grade(attempt.id, { db });
    }
  }
  return attemptView(attempt);
}

export async function retryGrading(account, attemptId, { db = pool, grade = runGrading } = {}) {
  const attempt = await loadAttempt(account.id, attemptId, db);
  if (attempt.status !== "grading") return attemptView(attempt);
  await db.query("UPDATE decanet_attempts SET grading_tries = LEAST(grading_tries, $2 - 1), grading_error = COALESCE(grading_error, 'retry') WHERE id = $1", [attempt.id, MAX_GRADING_TRIES]);
  void grade(attempt.id, { db });
  return attemptView({ ...attempt, grading_error: null });
}

// Claims the attempt for grading (so two requests never grade it twice),
// scores it and stores the result. Failures are recorded and retried.
export async function runGrading(attemptId, { db = pool, gradeImpl = gradeWithModel } = {}) {
  const { rows } = await db.query(
    `UPDATE decanet_attempts SET grading_started_at = now(), grading_tries = grading_tries + 1, grading_error = NULL, updated_at = now()
     WHERE id = $1 AND status = 'grading' AND grading_tries < $2
       AND (grading_started_at IS NULL OR grading_error IS NOT NULL OR grading_started_at < now() - make_interval(mins => $3))
     RETURNING *`,
    [attemptId, MAX_GRADING_TRIES, GRADING_STALE_MINUTES],
  );
  const attempt = rows[0];
  if (!attempt) return null;
  try {
    const roleplay = findRoleplay(attempt.roleplay_id);
    const durationSeconds = attempt.roleplay_started_at && attempt.ended_at ? seconds(attempt.roleplay_started_at, new Date(attempt.ended_at)) : 0;
    const result = await gradeImpl({ roleplay, notes: attempt.notes, segments: attempt.transcript ?? [], durationSeconds });
    await db.query(
      `UPDATE decanet_attempts SET status = 'graded', result = $2::jsonb, score = $3, graded_at = now(), updated_at = now() WHERE id = $1 AND status = 'grading'`,
      [attempt.id, JSON.stringify(result), result.total],
    );
    return result;
  } catch (error) {
    console.error("decanet.grading.error", { attemptId: attempt.id, message: String(error?.message ?? "").slice(0, 200) });
    await db.query("UPDATE decanet_attempts SET grading_error = $2, updated_at = now() WHERE id = $1", [attempt.id, String(error?.message ?? "error").slice(0, 300)]).catch(() => {});
    return null;
  }
}

export async function dashboard(account, db = pool) {
  const membership = await activeMembership(account.id, db);
  const eventCode = effectiveEvent(account, membership);
  const { rows: attempts } = await db.query(
    `SELECT id, roleplay_id, status, score, result->>'max' AS max, created_at FROM decanet_attempts WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [account.id],
  );
  const roleplays = roleplaysForEvent(eventCode).map((roleplay) => {
    const mine = attempts.filter((attempt) => attempt.roleplay_id === roleplay.id);
    const graded = mine.filter((attempt) => attempt.status === "graded");
    return { ...roleplaySummary(roleplay), completed: graded.length > 0, attempts: mine.length, bestScore: graded.length ? Math.max(...graded.map((attempt) => attempt.score)) : null };
  });
  const active = attempts.find((attempt) => attempt.status === "prep" || attempt.status === "roleplay") ?? null;
  return {
    eventCode,
    eventLocked: Boolean(membership?.status === "active" && membership.locked_event),
    roleplays,
    active: active ? { id: active.id, roleplay: roleplaySummary(findRoleplay(active.roleplay_id)), status: active.status } : null,
    history: attempts.map((attempt) => {
      const roleplay = findRoleplay(attempt.roleplay_id);
      return { id: attempt.id, status: attempt.status, score: attempt.score, max: attempt.max ? Number(attempt.max) : null, createdAt: attempt.created_at, roleplay: roleplay ? { ...roleplaySummary(roleplay), eventCode: roleplay.eventCode } : null };
    }),
  };
}
