import test from "node:test";
import assert from "node:assert/strict";
import { symmetricEncrypt } from "better-auth/crypto";
import { isTwoFactorRecordUsable } from "../src/security/two-factor-recovery.js";

const currentSecret = "current-auth-secret-that-is-long-enough-for-tests";
const previousSecret = "previous-auth-secret-that-is-long-enough-for-tests";

test("two-factor recovery detects a record encrypted by the current secret", async () => {
  const row = {
    secret: await symmetricEncrypt({ key: currentSecret, data: "totp-seed" }),
    backupCodes: await symmetricEncrypt({ key: currentSecret, data: JSON.stringify(["backup-code"]) }),
  };
  assert.equal(await isTwoFactorRecordUsable(row, currentSecret), true);
});

test("two-factor recovery treats legacy data as unusable without the previous secret", async () => {
  const row = {
    secret: await symmetricEncrypt({ key: previousSecret, data: "totp-seed" }),
    backupCodes: await symmetricEncrypt({ key: previousSecret, data: JSON.stringify(["backup-code"]) }),
  };
  assert.equal(await isTwoFactorRecordUsable(row, currentSecret), false);
});

test("two-factor recovery never treats a partial enrollment as healthy", async () => {
  const row = {
    secret: await symmetricEncrypt({ key: currentSecret, data: "totp-seed" }),
    backupCodes: "not-encrypted-by-the-current-secret",
  };
  assert.equal(await isTwoFactorRecordUsable(row, currentSecret), false);
});
