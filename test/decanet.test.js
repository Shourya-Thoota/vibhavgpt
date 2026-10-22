import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// DECANet against an in-memory database with every real migration applied.
// The judge, the grader and the payment provider are all fakes here.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
const { CATALOG, findRoleplay, participantDocument, ratingFor, roleplaysForEvent, rubricFor } = await import("../src/decanet/catalog.js");
const { EVENTS, EVENT_FORMATS } = await import("../src/decanet/events.js");
const { chapterQuote, grantPeriod, individualQuote } = await import("../src/decanet/pricing.js");
const { analyzeDelivery, buildResult, gradeWithModel, gradingSchema } = await import("../src/decanet/grading.js");
const { estimateCostCents, judgeInstructions, sessionConfig } = await import("../src/decanet/realtime.js");
const { hashPassword, sessionCookie, signIn, signUp, verifyPassword, createSession, accountForSession } = await import("../src/decanet/auth.js");
const { creditBalance, chapterBalance, distributeEvenly, grantSubscriberCredits, moveChapterCredits } = await import("../src/decanet/credits.js");
const { advance, attemptView, connectJudge, continueToRoleplay, dashboard, finishAttempt, getAttempt, runGrading, saveNotes, startAttempt } = await import("../src/decanet/attempts.js");
const { advisorChapterView, approveMember, createChapter, joinChapter, lockMemberEvent, memberAttemptDetail, memberAttempts } = await import("../src/decanet/chapters.js");
const { applyCheckoutSession, createCheckout, isDecanetCheckoutEvent } = await import("../src/decanet/stripe.js");

// The role-play bank is private; the public repository has an empty stand-in
// (public-sync.json), so the tests that need real role-plays skip there.
const needsBank = CATALOG.size ? {} : { skip: "DECANet's role-play bank is private" };

// A node-postgres-shaped wrapper around PGlite: query() plus connect().
async function database(t) {
  const client = new PGlite();
  t.after(() => client.close());
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  const query = async (text, params) => {
    const result = await client.query(text, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), client };
}

async function account(db, { email, role = "participant", event = "PBM", credits = 0 } = {}) {
  const created = await signUp({ email, password: "correct horse", name: email.split("@")[0], role }, db);
  if (event) await db.query("UPDATE decanet_accounts SET event_code = $2 WHERE id = $1", [created.id, event]);
  if (credits) await db.query("INSERT INTO decanet_credit_ledger (account_id, delta, kind) VALUES ($1, $2, 'test')", [created.id, credits]);
  return (await db.query("SELECT * FROM decanet_accounts WHERE id = $1", [created.id])).rows[0];
}

const fakeGrade = async ({ roleplay }) => buildResult(roleplay, {
  performance_indicators: roleplay.performanceIndicators.map((_, index) => ({ index, score: 99, evidence: "e", feedback: "f", improvement: "i" })),
  century_skills: [{ key: "communication", score: 5, feedback: "clear" }],
  judge_questions: [], strengths: ["s"], improvements: ["i"], delivery: { filler_feedback: "", pacing_feedback: "", professionalism_feedback: "" }, summary: "ok",
}, analyzeDelivery([], 60));

test("every DECA role-play event has five original role-plays on five different instructional areas", needsBank, () => {
  assert.equal(EVENTS.length, 28);
  assert.equal(CATALOG.size, 140);
  const judges = new Set();
  for (const event of EVENTS) {
    const roleplays = roleplaysForEvent(event.code);
    assert.equal(roleplays.length, 5, event.code);
    assert.equal(new Set(roleplays.map((roleplay) => roleplay.instructionalArea)).size, 5, `${event.code} areas`);
    for (const roleplay of roleplays) {
      assert.equal(roleplay.performanceIndicators.length, EVENT_FORMATS[event.format].piCount, roleplay.id);
      assert.equal(roleplay.questions.length, 2, roleplay.id);
      assert.ok(!judges.has(roleplay.judge.name), `${roleplay.judge.name} judges only once`);
      judges.add(roleplay.judge.name);
      assert.match(roleplay.judge.voice, /^(coral|shimmer|sage|marin|ash|echo|verse|cedar|ballad)$/);
      assert.match(roleplay.situation[0], /^You are to assume the roles? of/);
      assert.doesNotMatch(JSON.stringify(roleplay), /—|–/, "no em or en dashes");
      assert.equal(rubricFor(roleplay).total, 100, "every rubric totals 100");
    }
  }
});

test("the participant's packet has the whole situation but nothing from the judge's side", needsBank, () => {
  const roleplay = findRoleplay("PBM-1");
  const packet = participantDocument(roleplay);
  const text = JSON.stringify(packet);
  assert.equal(packet.performanceIndicators.length, 5);
  assert.equal(packet.centurySkills.length, 5);
  assert.match(packet.situation.at(-1), /The store manager will begin the role-play by greeting you/);
  assert.match(packet.instructions.join(" "), /up to 10 minutes to review/);
  assert.ok(!text.includes(roleplay.judge.name), "no judge name");
  assert.ok(!text.includes(roleplay.characterization), "no characterization");
  for (const question of roleplay.questions) assert.ok(!text.includes(question), "no judge questions");
  assert.match(participantDocument(findRoleplay("MTDM-2")).instructions.join(" "), /up to 30 minutes .* up to 15 minutes/s, "case studies keep DECA's team timing");
});

test("prices: $2.50 or $10 for five, and chapter volume brackets", () => {
  assert.deepEqual(individualQuote("single"), { pack: "single", credits: 1, cents: 250 });
  assert.deepEqual(individualQuote("five"), { pack: "five", credits: 5, cents: 1000 });
  assert.equal(individualQuote("nine"), null);
  assert.deepEqual([1, 49, 50, 99, 100, 249, 250, 1000].map((n) => chapterQuote(n).centsPerCredit), [200, 200, 180, 180, 175, 175, 150, 150]);
  assert.equal(chapterQuote(120).cents, 21000);
  assert.equal(chapterQuote(0), null);
  assert.equal(chapterQuote(2.5), null);
  assert.equal(grantPeriod(new Date("2026-10-21T12:00:00Z")).key, "2026-5");
  assert.equal(grantPeriod(new Date("2026-01-01T00:00:00Z")).key, grantPeriod(new Date("2026-02-28T23:59:00Z")).key);
});

test("delivery analysis counts real fillers and the score is rebuilt from the rubric", needsBank, async () => {
  const delivery = analyzeDelivery([
    { speaker: "participant", text: "Um, so I think, like, we should, uh, basically offer a refund. You know, it's kind of fair." },
    { speaker: "judge", text: "Um, okay, like what?" },
    { speaker: "participant", text: "I would like to offer them a discount." },
  ], 120);
  assert.equal(delivery.fillers.um, 1, "the judge's fillers don't count");
  assert.equal(delivery.fillers.uh, 1);
  assert.equal(delivery.fillers.like, 1, "'would like to' is not a filler");
  assert.equal(delivery.fillers["you know"], 1);
  assert.equal(delivery.fillers.basically, 1);
  const roleplay = findRoleplay("PBM-1");
  const result = await fakeGrade({ roleplay });
  assert.equal(result.max, 100);
  assert.ok(result.performanceIndicators.every((entry) => entry.score === 14 && entry.rating === "Exceeds Expectations"), "scores clamp to the maximum");
  assert.equal(result.skills.find((skill) => skill.key === "communication").score, 5);
  assert.equal(result.skills.find((skill) => skill.key === "creativity").score, 0, "missing skills score zero");
  assert.equal(result.total, 70 + 5);
  assert.equal(ratingFor(7, 10), "Meets Expectations");
  assert.equal(gradingSchema(7).properties.performance_indicators.minItems, 7);
  const silent = await gradeWithModel({ roleplay, notes: "", segments: [{ speaker: "participant", text: "hello" }], durationSeconds: 30 }, { fetchImpl: () => assert.fail("no model call") });
  assert.equal(silent.total, 0);
  assert.match(silent.summary, /couldn't hear enough/);
});

test("the judge speaks only on cue, in a fixed voice, briefly, and a 10-minute role-play stays well under $0.85", needsBank, () => {
  const roleplay = findRoleplay("SEM-2");
  const session = sessionConfig(roleplay);
  assert.equal(session.audio.input.turn_detection.create_response, false, "the browser cues every judge turn");
  assert.equal(session.audio.output.voice, roleplay.judge.voice);
  assert.equal(session.max_output_tokens, 450);
  assert.match(session.audio.input.transcription.prompt, /Um, so, uh/, "transcription keeps fillers");
  const instructions = judgeInstructions(roleplay, { priorTranscript: [{ speaker: "participant", text: "Our suite package" }] });
  assert.match(instructions, new RegExp(`You are ${roleplay.judge.name}`));
  assert.ok(roleplay.questions.every((question) => instructions.includes(question)));
  assert.match(instructions, /Participant: Our suite package/, "a reconnect continues the conversation");
  // About 8 minutes of participant audio, 2 of judge audio, a growing cached context.
  const cents = estimateCostCents({ audioIn: 9000, audioInCached: 60000, audioOut: 2400, textIn: 30000, textInCached: 60000, textOut: 900, transcriptionSeconds: 480, responses: 8 });
  assert.ok(cents < 85, `estimated ${cents} cents`);
});

test("passwords and sessions", async (t) => {
  const db = await database(t);
  const hash = await hashPassword("correct horse");
  assert.ok(await verifyPassword("correct horse", hash));
  assert.ok(!(await verifyPassword("wrong horse", hash)));
  const created = await signUp({ email: "Ada@Example.com", password: "correct horse", name: "Ada", role: "participant" }, db);
  await assert.rejects(signUp({ email: "ada@example.com", password: "another one", name: "Ada 2" }, db), /already exists/);
  await assert.rejects(signIn({ email: "ada@example.com", password: "nope nope" }, db), /don't match/);
  assert.equal((await signIn({ email: "ADA@example.com", password: "correct horse" }, db)).id, created.id);
  const token = await createSession(created.id, db);
  assert.equal((await accountForSession(token, db)).id, created.id);
  assert.match(sessionCookie(token, { secure: true }), /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
});

test("subscriber credits: Plus 1 and Pro 2 every two months, once per VibhavGPT user", async (t) => {
  const db = await database(t);
  const member = await account(db, { email: "sub@example.com" });
  await db.query("UPDATE decanet_accounts SET vibhav_user_id = 'vg-1' WHERE id = $1", [member.id]);
  const linked = { ...member, vibhav_user_id: "vg-1" };
  await db.query("INSERT INTO subscriptions (user_id, tier, status) VALUES ('vg-1', 'plus', 'active')");
  const october = new Date("2026-10-05T00:00:00Z");
  assert.equal(await grantSubscriberCredits(linked, { now: october, db }), 1);
  assert.equal(await grantSubscriberCredits(linked, { now: october, db }), 0, "once per period");
  await db.query("UPDATE subscriptions SET tier = 'pro' WHERE user_id = 'vg-1'");
  assert.equal(await grantSubscriberCredits(linked, { now: october, db }), 1, "upgrading tops up to two");
  assert.equal(await grantSubscriberCredits(linked, { now: new Date("2026-09-20T00:00:00Z"), db }), 0, "September and October are one period");
  assert.equal(await grantSubscriberCredits(linked, { now: new Date("2027-01-02T00:00:00Z"), db }), 2, "a new period");
  await db.query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = 'vg-1'");
  assert.equal(await grantSubscriberCredits(linked, { now: new Date("2027-03-02T00:00:00Z"), db }), 0, "only paid plans");
  assert.equal(await creditBalance(member.id, db), 4);
});

test("a role-play costs one credit, its packet disappears after prep, and it is graded once", needsBank, async (t) => {
  const db = await database(t);
  const broke = await account(db, { email: "broke@example.com" });
  await assert.rejects(startAttempt(broke, "PBM-2", db), /out of credits/);
  const member = await account(db, { email: "go@example.com", credits: 2 });
  await assert.rejects(startAttempt(member, "PMK-1", db), /isn't in your current event/);
  const attempt = await startAttempt(member, "PBM-2", db);
  assert.equal(await creditBalance(member.id, db), 1);
  await assert.rejects(startAttempt(member, "PBM-3", db), /already have a role-play in progress/);

  const prep = await getAttempt(member, attempt.id, db);
  assert.equal(prep.status, "prep");
  assert.equal(prep.document.performanceIndicators.length, 5);
  await saveNotes(member, attempt.id, "Open with empathy", db);

  // Prep time runs out while the participant is away.
  await db.query("UPDATE decanet_attempts SET prep_started_at = now() - interval '11 minutes' WHERE id = $1", [attempt.id]);
  const later = await getAttempt(member, attempt.id, db);
  assert.equal(later.status, "roleplay");
  assert.equal(later.document, undefined, "the packet is put away");
  assert.equal(later.notes, "Open with empathy", "notes stay");
  await assert.rejects(saveNotes(member, attempt.id, "more", db), /Prep time is over/);

  const calls = [];
  const createCall = async (roleplay, sdp, options) => { calls.push({ roleplay: roleplay.id, options }); return { sdp: "v=answer", callId: `rtc_${calls.length}` }; };
  const connected = await connectJudge(member, attempt.id, "v=offer", { db, createCall, hangUp: async () => true });
  assert.equal(connected.sdp, "v=answer");
  assert.ok(connected.roleplayRemaining > 590);
  assert.equal(calls[0].roleplay, "PBM-2");

  let graded = 0;
  const grade = (id, options) => { graded += 1; return runGrading(id, { ...options, gradeImpl: fakeGrade }); };
  const segments = [{ speaker: "judge", text: "Hi, I'm Alicia.", t: 1 }, { speaker: "participant", text: "Thanks for meeting with me.", t: 5 }];
  const finished = await finishAttempt(member, attempt.id, { segments, usage: { audioIn: 100 } }, { db, grade });
  assert.equal(finished.status, "grading");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const done = await getAttempt(member, attempt.id, db);
  assert.equal(done.status, "graded");
  assert.equal(done.score, 75);
  assert.equal(done.judge.name, findRoleplay("PBM-2").judge.name, "the judge is revealed afterwards");
  assert.deepEqual(done.transcript.map((segment) => segment.speaker), ["judge", "participant"]);
  assert.equal(await runGrading(attempt.id, { db, gradeImpl: fakeGrade }), null, "never graded twice");
  assert.equal(graded, 1);

  const board = await dashboard(member, db);
  assert.equal(board.roleplays.find((entry) => entry.id === "PBM-2").completed, true);
  assert.equal(board.roleplays.find((entry) => entry.id === "PBM-2").bestScore, 75);
  assert.equal(board.roleplays.filter((entry) => entry.completed).length, 1);
  assert.equal(board.active, null);
});

test("an abandoned role-play closes itself after its time and still gets graded", needsBank, async (t) => {
  const db = await database(t);
  const member = await account(db, { email: "away@example.com", credits: 1 });
  const attempt = await startAttempt(member, "PBM-4", db);
  await continueToRoleplay(member, attempt.id, "notes", db);
  await db.query("UPDATE decanet_attempts SET roleplay_started_at = now() - interval '13 minutes', transcript = '[{\"speaker\":\"participant\",\"text\":\"hi\",\"t\":3}]' WHERE id = $1", [attempt.id]);
  const grades = [];
  const row = (await db.query("SELECT * FROM decanet_attempts WHERE id = $1", [attempt.id])).rows[0];
  const advanced = await advance(row, { db, grade: (id) => grades.push(id) });
  assert.equal(advanced.status, "grading");
  assert.deepEqual(grades, [attempt.id]);
  assert.equal(attemptView(advanced).status, "grading");
});

test("purchases grant exactly once, from our own record, and route by metadata", async (t) => {
  const db = await database(t);
  const buyer = await account(db, { email: "buy@example.com" });
  const created = [];
  const stripe = { checkout: { sessions: { create: async (params) => { created.push(params); return { id: "cs_test_aaaaaaaaaaaa", url: "https://checkout.test/x" }; } } } };
  const { url } = await createCheckout({ account: buyer, kind: "individual", pack: "five" }, { stripe, db });
  assert.equal(url, "https://checkout.test/x");
  assert.equal(created[0].line_items[0].price_data.unit_amount, 1000);
  assert.equal(created[0].metadata.app, "decanet");
  assert.equal(created[0].metadata.userId, undefined, "VibhavGPT's own credit handler ignores it");
  const session = { id: "cs_test_aaaaaaaaaaaa", payment_status: "paid", amount_total: 1000, metadata: { app: "decanet", credits: "500" } };
  assert.ok(isDecanetCheckoutEvent({ type: "checkout.session.completed", data: { object: session } }));
  assert.equal(await applyCheckoutSession({ ...session, payment_status: "unpaid" }, db), false);
  assert.equal(await applyCheckoutSession(session, db), true);
  assert.equal(await applyCheckoutSession(session, db), false, "a replayed event grants nothing");
  assert.equal(await creditBalance(buyer.id, db), 5, "credits come from our record, not metadata");
});

test("chapters: codes, consent, approval, event locks, credit pools and shared results", needsBank, async (t) => {
  const db = await database(t);
  const advisor = await account(db, { email: "adv@example.com", role: "advisor", event: null });
  const student = await account(db, { email: "stu@example.com" });
  const outsider = await account(db, { email: "out@example.com", role: "advisor", event: null });
  await assert.rejects(createChapter(student, { name: "X" }, db), /Only advisors/);
  const chapter = await createChapter(advisor, { name: "Lincoln High DECA", school: "Lincoln High", requireApproval: true }, db);
  assert.match(chapter.join_code, /^[A-Z2-9]{6}$/);

  await assert.rejects(joinChapter(student, { code: chapter.join_code, consent: false }, db), /agree to share/);
  assert.equal((await joinChapter(student, { code: chapter.join_code.toLowerCase(), consent: true }, db)).status, "pending");
  await assert.rejects(joinChapter(outsider, { code: chapter.join_code }, db), /advisor code/);
  assert.equal((await joinChapter(outsider, { code: chapter.advisor_code }, db)).status, "pending", "co-advisors need approval");
  await approveMember(advisor, student.id, db);

  await lockMemberEvent(advisor, student.id, "HRM", db);
  const locked = (await db.query("SELECT * FROM decanet_accounts WHERE id = $1", [student.id])).rows[0];
  assert.equal(locked.event_code, "HRM");
  assert.equal((await dashboard(locked, db)).eventLocked, true);

  await db.query("INSERT INTO decanet_chapter_ledger (chapter_id, delta, kind) VALUES ($1, 10, 'test')", [chapter.id]);
  assert.deepEqual(await distributeEvenly({ chapterId: chapter.id, perMember: 3, actorId: advisor.id }, db), { members: 1, total: 3, chapterBalance: 7 });
  await assert.rejects(moveChapterCredits({ chapterId: chapter.id, memberId: student.id, delta: 8, actorId: advisor.id }, db), /doesn't have enough/);
  assert.deepEqual(await moveChapterCredits({ chapterId: chapter.id, memberId: student.id, delta: -2, actorId: advisor.id }, db), { chapterBalance: 9, memberBalance: 1 });
  assert.equal(await chapterBalance(chapter.id, db), 9);

  const attempt = await startAttempt(locked, "HRM-1", db);
  await finishAttempt(locked, attempt.id, { segments: [] }, { db, grade: (id, options) => runGrading(id, { ...options, gradeImpl: fakeGrade }) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const shared = await memberAttempts(advisor, student.id, db);
  assert.equal(shared.attempts.length, 1);
  assert.equal(shared.attempts[0].score, 75);
  assert.equal((await memberAttemptDetail(advisor, attempt.id, db)).result.total, 75);
  await assert.rejects(memberAttempts(outsider, student.id, db), /active advisor/, "a pending co-advisor sees nothing");

  const view = await advisorChapterView(advisor, db);
  assert.equal(view.credits, 9);
  assert.equal(view.members.find((member) => member.id === student.id).completed, 1);
});
