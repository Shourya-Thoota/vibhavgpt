import { config } from "../config.js";
import { Sentry } from "../sentry.js";

const protectedPaths = new Set(["/sign-up/email", "/sign-in/email"]);
const siteVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function response(status, error, code) {
  return {
    response: new Response(JSON.stringify({ error, code }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  };
}

function reportFailure({ path, reason, errorCodes, hostname, status }) {
  Sentry.captureMessage("Turnstile verification failed", {
    level: "warning",
    extra: { path, reason, errorCodes, hostname, status },
  });
}

function firstForwardedIp(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
}

export const turnstilePlugin = {
  id: "vibhavgpt-turnstile",
  async onRequest(request) {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    if (!protectedPaths.has(path)) return undefined;

    const token = request.headers.get("x-captcha-response");
    if (!token) {
      reportFailure({ path, reason: "missing-token" });
      return response(400, "Please complete the bot check before continuing.", "TURNSTILE_TOKEN_MISSING");
    }
    if (!config.turnstileSecretKey) {
      reportFailure({ path, reason: "missing-server-configuration" });
      return response(503, "Bot protection is temporarily unavailable. Please try again shortly.", "TURNSTILE_UNAVAILABLE");
    }

    try {
      const payload = {
        secret: config.turnstileSecretKey,
        response: token,
      };
      const remoteIp = firstForwardedIp(request);
      if (remoteIp) payload.remoteip = remoteIp;
      const verification = await fetch(siteVerifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await verification.json().catch(() => null);
      const hostnameAllowed =
        config.turnstileAllowedHostnames.length === 0 ||
        config.turnstileAllowedHostnames.includes(result?.hostname);
      if (!verification.ok || !result?.success || !hostnameAllowed) {
        reportFailure({
          path,
          reason: !hostnameAllowed ? "unexpected-hostname" : "verification-rejected",
          errorCodes: result?.["error-codes"],
          hostname: result?.hostname,
          status: verification.status,
        });
        return response(400, "Bot check failed or expired. Please try again.", "TURNSTILE_VERIFICATION_FAILED");
      }
    } catch (error) {
      reportFailure({ path, reason: "siteverify-unavailable", status: error?.name });
      return response(503, "Bot protection is temporarily unavailable. Please try again shortly.", "TURNSTILE_UNAVAILABLE");
    }
    return undefined;
  },
};
