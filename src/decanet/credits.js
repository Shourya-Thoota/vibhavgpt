import { DecanetError } from "./config.js";
import { pool, transaction } from "./db.js";
import { grantPeriod, SUBSCRIBER_CREDITS } from "./pricing.js";

export async function creditBalance(accountId, db = pool) {
  const { rows } = await db.query("SELECT COALESCE(SUM(delta), 0)::int AS balance FROM decanet_credit_ledger WHERE account_id = $1", [accountId]);
  return rows[0].balance;
}

export async function chapterBalance(chapterId, db = pool) {
  const { rows } = await db.query("SELECT COALESCE(SUM(delta), 0)::int AS balance FROM decanet_chapter_ledger WHERE chapter_id = $1", [chapterId]);
  return rows[0].balance;
}

export async function creditHistory(accountId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, delta, kind, note, created_at FROM decanet_credit_ledger WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  return rows.map((row) => ({ id: row.id, delta: row.delta, kind: row.kind, note: row.note, createdAt: row.created_at }));
}

// The VibhavGPT plan a linked account is on right now: "plus", "pro" or null.
// Only a paid status counts, the same rule VibhavGPT itself uses.
export async function vibhavgptTier(vibhavUserId, db = pool) {
  if (!vibhavUserId) return null;
  const { rows } = await db.query("SELECT tier, status FROM subscriptions WHERE user_id = $1 LIMIT 1", [vibhavUserId]);
  const row = rows[0];
  if (!row || !["active", "trialing"].includes(row.status)) return null;
  return SUBSCRIBER_CREDITS[row.tier] ? row.tier : null;
}

// Subscriber credits for the current two-month period, granted once per
// VibhavGPT user (not per DECANet account), so unlinking and relinking
// another account cannot collect them twice. Plus gets one; Pro gets the Plus
// credit plus a second, so upgrading mid-period tops up the difference.
export async function grantSubscriberCredits(account, { now = new Date(), db = pool } = {}) {
  const tier = await vibhavgptTier(account.vibhav_user_id, db);
  if (!tier) return 0;
  const period = grantPeriod(now);
  const grants = [{ reference: `vibhavgpt:${account.vibhav_user_id}:${period.key}:plus`, note: `VibhavGPT ${tier === "pro" ? "Pro" : "Plus"} credit for ${period.key}` }];
  if (tier === "pro") grants.push({ reference: `vibhavgpt:${account.vibhav_user_id}:${period.key}:pro`, note: `VibhavGPT Pro credit for ${period.key}` });
  let granted = 0;
  for (const grant of grants) {
    const result = await db.query(
      `INSERT INTO decanet_credit_ledger (account_id, delta, kind, reference, note) VALUES ($1, 1, 'vibhavgpt_grant', $2, $3) ON CONFLICT (reference) DO NOTHING`,
      [account.id, grant.reference, grant.note],
    );
    granted += result.rowCount;
  }
  return granted;
}

// Moves credits from a chapter's pool to one member (positive) or back from
// the member to the pool (negative). Neither side may go below zero.
export async function moveChapterCredits({ chapterId, memberId, delta, actorId }, db = pool) {
  const amount = Number(delta);
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000) throw new DecanetError(400, "Enter a whole number of credits.");
  return transaction(async (client) => {
    await client.query("SELECT id FROM decanet_chapters WHERE id = $1 FOR UPDATE", [chapterId]);
    await client.query("SELECT id FROM decanet_accounts WHERE id = $1 FOR UPDATE", [memberId]);
    if (amount > 0 && (await chapterBalance(chapterId, client)) < amount) throw new DecanetError(409, "The chapter doesn't have enough credits. Buy more first.");
    if (amount < 0 && (await creditBalance(memberId, client)) < -amount) throw new DecanetError(409, "That member doesn't have that many credits to take back.");
    await client.query(
      `INSERT INTO decanet_chapter_ledger (chapter_id, delta, kind, actor_account_id, member_account_id) VALUES ($1, $2, $3, $4, $5)`,
      [chapterId, -amount, amount > 0 ? "allocation" : "reclaim", actorId, memberId],
    );
    await client.query(
      `INSERT INTO decanet_credit_ledger (account_id, delta, kind, chapter_id, actor_account_id, note) VALUES ($1, $2, $3, $4, $5, $6)`,
      [memberId, amount, amount > 0 ? "chapter_allocation" : "chapter_reclaim", chapterId, actorId, amount > 0 ? "From your chapter" : "Returned to your chapter"],
    );
    return { chapterBalance: await chapterBalance(chapterId, client), memberBalance: await creditBalance(memberId, client) };
  }, db);
}

// Gives every active participant the same number of credits from the pool.
export async function distributeEvenly({ chapterId, perMember, actorId }, db = pool) {
  const each = Number(perMember);
  if (!Number.isSafeInteger(each) || each < 1 || each > 100) throw new DecanetError(400, "Choose between 1 and 100 credits per member.");
  return transaction(async (client) => {
    await client.query("SELECT id FROM decanet_chapters WHERE id = $1 FOR UPDATE", [chapterId]);
    const { rows: members } = await client.query(
      "SELECT account_id FROM decanet_chapter_members WHERE chapter_id = $1 AND role = 'participant' AND status = 'active'",
      [chapterId],
    );
    if (!members.length) throw new DecanetError(409, "There are no active participants to give credits to.");
    const needed = each * members.length;
    if ((await chapterBalance(chapterId, client)) < needed) throw new DecanetError(409, `That needs ${needed} credits, more than the chapter has.`);
    for (const { account_id: memberId } of members) {
      await client.query(
        `INSERT INTO decanet_chapter_ledger (chapter_id, delta, kind, actor_account_id, member_account_id) VALUES ($1, $2, 'allocation', $3, $4)`,
        [chapterId, -each, actorId, memberId],
      );
      await client.query(
        `INSERT INTO decanet_credit_ledger (account_id, delta, kind, chapter_id, actor_account_id, note) VALUES ($1, $2, 'chapter_allocation', $3, $4, 'From your chapter')`,
        [memberId, each, chapterId, actorId],
      );
    }
    return { members: members.length, total: needed, chapterBalance: await chapterBalance(chapterId, client) };
  }, db);
}
