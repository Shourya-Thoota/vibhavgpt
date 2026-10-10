import assert from "node:assert/strict";
import test from "node:test";
import { emailOtpVerificationRequest } from "../frontend/src/auth-code-endpoint.js";

test("sign-in OTPs use Better Auth's sign-in endpoint", () => {
  const request = emailOtpVerificationRequest("sign-in-otp", { email: "ada@example.com", otp: "123456" });
  assert.equal(request.path, "/api/auth/sign-in/email-otp");
  assert.deepEqual(request.body, { email: "ada@example.com", otp: "123456" });
});

test("email verification OTPs use Better Auth's verification endpoint", () => {
  const request = emailOtpVerificationRequest("verify-email", { email: "ada@example.com", otp: "123456" });
  assert.equal(request.path, "/api/auth/email-otp/verify-email");
  assert.deepEqual(request.body, { email: "ada@example.com", otp: "123456" });
});
