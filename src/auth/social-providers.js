import { APIError } from "better-auth/api";
import { config } from "../config.js";

// Social sign-in (Slice 8). A provider is registered, offered by the sign-in page and accepted by the app's sign-in bridge only while
// both of its values are set; with neither, it does not exist anywhere (no route, no button). Order is the sign-in page's order.
//
// The one trust rule, for every provider (owner ruling): a social identity is tied to an email only when the provider itself reports
// that email as verified.
//   - Linking to an existing account: Better Auth's default, kept as is. It links only when the provider says the email is verified and
//     the account's own email is verified too. No provider is listed as "trusted", so no provider is believed without that flag.
//   - A new account: refused when the provider did not verify the email (guardSocialSignUpEmail below). Otherwise someone could create
//     an account under another person's address and keep their sign-in attached to it after the owner verifies the address.
// Railway is not offered: its discovery document advertises an email_verified claim, but it has not been observed on a real sign-in,
// so it is not built (docs/auth/social-setup.md).
export const SOCIAL_PROVIDER_ORDER = Object.freeze(["google", "github", "microsoft", "discord"]);
export const SOCIAL_PROVIDER_LABELS = Object.freeze({ google: "Google", github: "GitHub", microsoft: "Microsoft", discord: "Discord" });

/** The providers whose two values are both set, in the sign-in page's order, and their Better Auth options. */
export function socialProviderSetup(cfg = config) {
  const definitions = {
    google: cfg.googleClientId && cfg.googleClientSecret && { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret },
    github: cfg.githubClientId && cfg.githubClientSecret && { clientId: cfg.githubClientId, clientSecret: cfg.githubClientSecret },
    // "common": work or school accounts and personal Microsoft accounts.
    microsoft: cfg.microsoftClientId && cfg.microsoftClientSecret && { clientId: cfg.microsoftClientId, clientSecret: cfg.microsoftClientSecret, tenantId: "common" },
    // Discord's default scopes are exactly identify and email; nothing more is asked for.
    discord: cfg.discordClientId && cfg.discordClientSecret && { clientId: cfg.discordClientId, clientSecret: cfg.discordClientSecret },
  };
  const configured = SOCIAL_PROVIDER_ORDER.filter((id) => definitions[id]);
  const providers = Object.fromEntries(configured.map((id) => [id, definitions[id]]));
  return { configured, providers: configured.length ? providers : undefined };
}

export const SOCIAL_EMAIL_NOT_VERIFIED = Object.freeze({
  code: "email_not_verified",
  message: "That sign-in service has not verified your email address, so an account can't be created from it. Verify your email with that service, or sign up with your email.",
});

/**
 * Database hook: a new account made by a social sign-in must carry an email the provider verified. Other sign-ups (email code, passkey)
 * are untouched. The refusal reaches the sign-in screen as ?error=email_not_verified, and nothing is created.
 */
export function guardSocialSignUpEmail(data, context) {
  if (!String(context?.path ?? "").startsWith("/callback/")) return;
  if (data?.emailVerified === true) return;
  throw new APIError("FORBIDDEN", SOCIAL_EMAIL_NOT_VERIFIED);
}
