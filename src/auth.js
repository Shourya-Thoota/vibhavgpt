import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { expo } from "@better-auth/expo";
import { generateRandomString } from "better-auth/crypto";
import { config, requireAuthConfig } from "./config.js";
import { turnstilePlugin } from "./security/turnstile.js";
import { pool } from "./db/client.js";
import { sendOtpEmail } from "./email/service.js";
import { EMAIL_OTP_CONFIG, TWO_FACTOR_EMAIL_OTP_CONFIG } from "./auth/otp-config.js";

requireAuthConfig();

const socialProviders =
  config.googleClientId && config.googleClientSecret
    ? {
        google: {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
        },
      }
    : undefined;

const passkeyOrigin = config.passkeyOrigin ?? config.clientOrigins[0];
const passkeyRpId = config.passkeyRpId ?? new URL(passkeyOrigin).hostname;

// Better Auth's two-factor plugin gates credential sign-ins by default, but
// OAuth callbacks are deliberately outside that matcher.  Keep the OAuth
// session from becoming usable until the same 2FA challenge is completed.
const oauthTwoFactorGate = createAuthMiddleware(async (ctx) => {
      if (!ctx.path?.startsWith("/callback/")) return;
      const pending = ctx.context.newSession;
      if (!pending?.user?.twoFactorEnabled) return;

      const maxAge = 600;
      const identifier = `2fa-${generateRandomString(20)}`;
      const expiresAt = new Date(Date.now() + maxAge * 1000);
      await ctx.context.internalAdapter.createVerificationValue({
        value: pending.user.id,
        identifier,
        expiresAt,
      });
      await ctx.context.internalAdapter.createVerificationValue({
        value: "0",
        identifier: `2fa-attempts-${identifier}`,
        expiresAt,
      });

      // Delete the session created internally by the OAuth callback before
      // sending the browser anywhere.  No full session cookie is allowed to
      // survive this branch.
      await ctx.context.internalAdapter.deleteSession(pending.session.token);
      deleteSessionCookie(ctx, true);
      ctx.context.setNewSession(null);

      const twoFactorCookie = ctx.context.createAuthCookie("two_factor", { maxAge });
      await ctx.setSignedCookie(
        twoFactorCookie.name,
        identifier,
        ctx.context.secret,
        twoFactorCookie.attributes,
      );

      const methods = [];
      if (!ctx.context.getPlugin("two-factor")?.options?.totpOptions?.disable) {
        const totp = await ctx.context.adapter.findOne({
          model: "twoFactor",
          where: [{ field: "userId", value: pending.user.id }],
        });
        if (totp && totp.verified !== false) methods.push("totp");
      }
      if (ctx.context.getPlugin("two-factor")?.options?.otpOptions?.sendOTP) methods.push("otp");

      const original = ctx.context.returned;
      // OAuth callbacks normally carry the redirect in the response headers.
      // Some Better Auth adapters expose that redirect only after the hook
      // pipeline, so fall back to our configured frontend origin rather than
      // silently sending a pending challenge to the plain sign-in page.
      const location = original?.headers?.get?.("location") || ctx.context.responseHeaders?.get?.("location") || config.clientOrigins[0];
      if (!location) return;
      const redirect = new URL(location);
      redirect.searchParams.set("twoFactorRequired", "true");
      redirect.searchParams.set("twoFactor", "required");
      redirect.searchParams.set("twoFactorMethods", methods.join(","));
      const redirectLocation = redirect.toString();
      ctx.setHeader("Location", redirectLocation);
      return new Response(null, { status: 302, headers: { Location: redirectLocation } });
});

const oauthTwoFactorPlugin = {
  id: "oauth-two-factor-gate",
  hooks: {
    after: [{
      matcher: (context) => context.path?.startsWith("/callback/"),
      handler: oauthTwoFactorGate,
    }],
  },
};

// Passwordless sign-in methods are intentionally not gated by Better Auth's
// two-factor plugin by default. Apply the same pending-challenge design used
// for OAuth before a passkey-created session can be used.
const passkeyTwoFactorGate = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/passkey/verify-authentication") return;
  const pending = ctx.context.newSession;
  if (!pending?.user?.twoFactorEnabled) return;

  const maxAge = 600;
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  await ctx.context.internalAdapter.createVerificationValue({
    value: pending.user.id,
    identifier,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: "0",
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });

  await ctx.context.internalAdapter.deleteSession(pending.session.token);
  deleteSessionCookie(ctx, true);
  ctx.context.setNewSession(null);

  const twoFactorCookie = ctx.context.createAuthCookie("two_factor", { maxAge });
  await ctx.setSignedCookie(
    twoFactorCookie.name,
    identifier,
    ctx.context.secret,
    twoFactorCookie.attributes,
  );

  const methods = [];
  if (!ctx.context.getPlugin("two-factor")?.options?.totpOptions?.disable) {
    const totp = await ctx.context.adapter.findOne({
      model: "twoFactor",
      where: [{ field: "userId", value: pending.user.id }],
    });
    if (totp && totp.verified !== false) methods.push("totp");
  }
  if (ctx.context.getPlugin("two-factor")?.options?.otpOptions?.sendOTP) {
    methods.push("otp");
  }
  return ctx.json({ twoFactorRedirect: true, twoFactorMethods: methods });
});

const passkeyTwoFactorPlugin = {
  id: "passkey-two-factor-gate",
  hooks: {
    after: [
      {
        matcher: (context) => context.path === "/passkey/verify-authentication",
        handler: passkeyTwoFactorGate,
      },
    ],
  },
};

export const auth = betterAuth({
  baseURL: config.authBaseUrl,
  basePath: "/api/auth",
  secret: config.authSecret,
  database: pool,
  trustedOrigins: config.authTrustedOrigins,
  // Without this, an OAuth failure whose state cannot be read (so no
  // errorCallbackURL is known) lands on api.vibhavgpt.com/api/auth/error,
  // which bounces to the API root and 404s. Send it to the sign-in screen,
  // which shows the `error` query parameter.
  onAPIError: {
    errorURL: `${config.clientOrigins[0]}/app`,
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // A reset can be requested from a device an attacker may control.  End
    // every existing session after the password changes so a stolen session
    // cannot remain usable.
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    // The email OTP flow should create the session before the client can
    // transition into the authenticated workspace.
    autoSignInAfterVerification: true,
  },
  // Railway's ingress may provide a multi-hop forwarded-IP chain that Better
  // Auth cannot safely resolve on its own. Express applies the auth/OTP limits
  // below using Railway's trusted proxy configuration instead.
  rateLimit: {
    enabled: false,
  },
  plugins: [
    // Keeps Better Auth's session cookies in Expo SecureStore on native
    // clients, while preserving the existing browser cookie behavior.
    expo(),
    // This runs before Better Auth handles credential routes. It deliberately
    // does not apply to OAuth, passkeys, or the second-factor challenge.
    turnstilePlugin,
    emailOTP({
      ...EMAIL_OTP_CONFIG,
      sendVerificationOTP: sendOtpEmail,
    }),
    twoFactor({
      issuer: "VibhavGPT",
      allowPasswordless: true,
      otpOptions: {
        ...TWO_FACTOR_EMAIL_OTP_CONFIG,
        sendOTP: ({ user, otp }) => sendOtpEmail({ email: user.email, otp, type: "two-factor" }),
      },
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
    }),
    passkey({
      rpID: passkeyRpId,
      rpName: "VibhavGPT",
      origin: passkeyOrigin,
      // Sign-in starts without an email (the browser offers this site's
      // passkeys), which only finds discoverable credentials. "preferred"
      // let some authenticators save a passkey that could never be used to
      // sign in, so new passkeys must be discoverable.
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    }),
    oauthTwoFactorPlugin,
    passkeyTwoFactorPlugin,
  ],
  socialProviders,
});

