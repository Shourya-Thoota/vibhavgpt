// Better Auth stores sign-in and email-verification OTPs under distinct
// identifiers. Keep route selection small and testable so valid sign-in codes
// are never submitted to the email-verification endpoint.
export function emailOtpVerificationRequest(step, { email, otp }) {
  if (step === "verify-email") {
    return {
      path: "/api/auth/email-otp/verify-email",
      body: { email, otp },
    };
  }

  return {
    path: "/api/auth/sign-in/email-otp",
    body: { email, otp },
  };
}
