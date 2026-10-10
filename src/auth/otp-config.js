// Keep authentication codes long enough for normal email delivery, while
// retaining short-lived, rate-limited verification.  These values are kept in
// a dependency-free module so their security contract has a direct test.
export const EMAIL_OTP_CONFIG = {
  otpLength: 6,
  expiresIn: 600,
  allowedAttempts: 5,
  // `reuse` requires a recoverable value. Better Auth encrypts this at rest
  // with the application secret, allowing a delayed resend to extend the same
  // code instead of invalidating the email the user already received.
  storeOTP: "encrypted",
  resendStrategy: "reuse",
  sendVerificationOnSignUp: true,
  overrideDefaultEmailVerification: true,
  disableSignUp: true,
};

export const TWO_FACTOR_EMAIL_OTP_CONFIG = {
  digits: 6,
  // This was accidentally 10 seconds. A code delivered by email needs the
  // same ten-minute window communicated in the message template.
  period: 600,
  allowedAttempts: 5,
  storeOTP: "hashed",
};
