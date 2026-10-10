import { symmetricDecrypt } from "better-auth/crypto";

// Better Auth stores the TOTP secret and backup-code list as separate encrypted
// values. A secret rotation can leave either value unreadable. Keep this check
// deliberately small and side-effect free: callers decide whether an explicit
// recovery action should remove the account's unusable record.
export async function isTwoFactorRecordUsable(row, authSecret) {
  if (!row?.secret || !row?.backupCodes || !authSecret) return false;
  try {
    await symmetricDecrypt({ key: authSecret, data: row.secret });
    await symmetricDecrypt({ key: authSecret, data: row.backupCodes });
    return true;
  } catch {
    // Never return crypto details to the client. The caller only needs to know
    // whether this account's enrollment can still be used.
    return false;
  }
}
