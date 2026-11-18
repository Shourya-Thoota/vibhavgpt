// Who owns which connected account, recorded in PostgreSQL (connector_account_owners, drizzle/0049).
//
// The production gateway is reached with one shared consumer key and lists every caller the same accounts, with no marker saying whose they
// are, so the list itself never proves ownership. Ownership is established by the Connect flow instead:
//   1. When a person presses Connect, each app gets a fresh, unguessable alias, stored here against that person before anything is sent.
//   2. The alias is passed to the gateway's "add", which always creates a new account (and a new auth link) carrying it.
//   3. When an account carrying one of *this person's* aliases is later listed, its id is recorded as theirs.
// An account carrying no alias of ours (one created outside the app), or another person's alias, is never attached to anyone. One account has
// at most one owner (a unique index), and a row can only be claimed once. Every check on a tool call reads the recorded owner.
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectorAccountOwners } from "../db/schema.js";

let activeDb = db;
export function setOwnershipDbForTest(client) {
  activeDb = client;
}

// The alias matches the gateway's own alias shape ("youtube_instep-graip"), so the UI's alias filter hides it like any other internal reference.
const ALIAS_PATTERN = /^vgc_[0-9a-f]{24}-[0-9a-f]{8}$/;
// A Connect press is claimable for a day: long enough to finish signing in, short enough that an abandoned alias does not linger as a claim.
const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export function newConnectAlias() {
  return `vgc_${randomBytes(12).toString("hex")}-${randomBytes(4).toString("hex")}`;
}

export function isConnectAlias(value) {
  return typeof value === "string" && ALIAS_PATTERN.test(value);
}

/** Records one fresh alias per app for this person's Connect press. Returns { app: alias }. Throws if it cannot be stored, so no link is made. */
export async function recordConnectAliases(userId, toolkit, apps) {
  if (!userId || typeof userId !== "string") throw new Error("A signed-in user is required to connect an account.");
  const rows = apps.map((app) => ({ alias: newConnectAlias(), userId, toolkit: String(toolkit), app: String(app) }));
  if (rows.length) await activeDb.insert(connectorAccountOwners).values(rows);
  return Object.fromEntries(rows.map((row) => [row.app, row.alias]));
}

/**
 * Records as this person's every listed account that carries one of their unclaimed, recent aliases. Accounts with no alias of ours, another
 * person's alias, or an alias already claimed by another account are left alone. Never throws: a failure records nothing (fails closed).
 */
export async function claimAccountsByAlias(userId, accounts) {
  if (!userId || !Array.isArray(accounts)) return 0;
  const byAlias = new Map();
  for (const account of accounts) {
    if (account && typeof account.id === "string" && account.id && isConnectAlias(account.alias)) byAlias.set(account.alias, account.id);
  }
  if (!byAlias.size) return 0;
  let claimed = 0;
  try {
    const rows = await activeDb
      .select()
      .from(connectorAccountOwners)
      .where(and(
        eq(connectorAccountOwners.userId, userId),
        inArray(connectorAccountOwners.alias, [...byAlias.keys()]),
        isNull(connectorAccountOwners.accountId),
        gt(connectorAccountOwners.createdAt, new Date(Date.now() - CLAIM_WINDOW_MS)),
      ));
    for (const row of rows) {
      try {
        const updated = await activeDb
          .update(connectorAccountOwners)
          .set({ accountId: byAlias.get(row.alias), claimedAt: new Date() })
          .where(and(eq(connectorAccountOwners.alias, row.alias), eq(connectorAccountOwners.userId, userId), isNull(connectorAccountOwners.accountId)))
          .returning({ alias: connectorAccountOwners.alias });
        claimed += updated.length;
      } catch {
        // The account is already recorded for someone (the unique index): nothing changes.
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "connector_ownership_claim_failed", reason: String(err?.message || err).slice(0, 120) }));
  }
  return claimed;
}

/** The connected account ids recorded as this person's. A lookup that fails returns an empty set, so nothing is treated as theirs. */
export async function ownedAccountIds(userId) {
  if (!userId) return new Set();
  try {
    const rows = await activeDb
      .select({ accountId: connectorAccountOwners.accountId })
      .from(connectorAccountOwners)
      .where(and(eq(connectorAccountOwners.userId, userId), isNotNull(connectorAccountOwners.accountId)));
    return new Set(rows.map((row) => row.accountId));
  } catch (err) {
    console.warn(JSON.stringify({ event: "connector_ownership_lookup_failed", reason: String(err?.message || err).slice(0, 120) }));
    return new Set();
  }
}

/** Forgets that this person owns this account (after they disconnect it). Another person's row is never touched. */
export async function releaseOwnedAccount(userId, accountId) {
  if (!userId || !accountId) return;
  await activeDb
    .delete(connectorAccountOwners)
    .where(and(eq(connectorAccountOwners.userId, userId), eq(connectorAccountOwners.accountId, accountId)));
}
