import assert from "node:assert/strict";
import test from "node:test";
import { buildOtpEmail } from "../src/email/service.js";

test("password-reset email includes branded CTA, personalized greeting, and required footer", () => {
  const message = buildOtpEmail({ name: "Ada Lovelace", otp: "123456", type: "forget-password" });
  assert.equal(message.subject, "Reset your VibhavGPT password");
  assert.match(message.html, /Hi Ada,/);
  assert.match(message.html, /Reset password/);
  assert.match(message.html, /reset-password=true/);
  assert.match(message.html, /we will never ask for your password by email/i);
  assert.match(message.html, /Pansophy LLC, 938 Campbell Blvd, 14228/);
  assert.match(message.html, /© 2026 Pansophy LLC/);
  assert.match(message.html, /role="presentation"/);
  assert.match(message.html, /https:\/\/vibhavgpt\.com\/brand\/vibhavgpt-icon-64\.png/);
  assert.doesNotMatch(message.html, />V<\/td>/);
});

test("every active OTP email type gets its own subject and the shared safe layout", () => {
  for (const type of ["email-verification", "sign-in", "forget-password", "change-email", "two-factor"]) {
    const message = buildOtpEmail({ name: "Test User", otp: "654321", type });
    assert.match(message.subject, /VibhavGPT/);
    assert.match(message.html, /654321/);
    assert.match(message.html, /Contact support/);
    assert.match(message.html, /Privacy Policy/);
  }
});
