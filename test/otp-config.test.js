import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_OTP_CONFIG, TWO_FACTOR_EMAIL_OTP_CONFIG } from "../src/auth/otp-config.js";

test("email OTPs keep a usable ten-minute lifetime and safe resend behavior", () => {
  assert.equal(EMAIL_OTP_CONFIG.expiresIn, 600);
  assert.equal(EMAIL_OTP_CONFIG.allowedAttempts, 5);
  assert.equal(EMAIL_OTP_CONFIG.storeOTP, "encrypted");
  assert.equal(EMAIL_OTP_CONFIG.resendStrategy, "reuse");
});

test("two-factor email OTPs do not expire before email delivery", () => {
  assert.equal(TWO_FACTOR_EMAIL_OTP_CONFIG.period, 600);
  assert.equal(TWO_FACTOR_EMAIL_OTP_CONFIG.allowedAttempts, 5);
  assert.equal(TWO_FACTOR_EMAIL_OTP_CONFIG.storeOTP, "hashed");
});
