import { config } from "../config.js";
import { safeDisplayName } from "../security/display-name.js";

const APP_URL = "https://vibhavgpt.com";
const SUPPORT_URL = "mailto:support@pansophy.com";
const PRIVACY_URL = `${APP_URL}/privacy`;
const BRAND_LOGO_URL = `${APP_URL}/brand/vibhavgpt-icon-64.png`;

const EMAIL_COPY = {
  "email-verification": { subject: "Verify your VibhavGPT email", eyebrow: "EMAIL VERIFICATION", title: "Verify your email", lead: "Use this code to verify your email address and finish setting up VibhavGPT.", action: "Verify email", actionUrl: APP_URL },
  "sign-in": { subject: "Your VibhavGPT sign-in code", eyebrow: "SIGN-IN CODE", title: "Sign in securely", lead: "Use this code to sign in to your VibhavGPT account.", action: "Open VibhavGPT", actionUrl: APP_URL },
  "forget-password": { subject: "Reset your VibhavGPT password", eyebrow: "PASSWORD RESET", title: "Reset your password", lead: "Use this code to reset your VibhavGPT password. It expires in 10 minutes.", action: "Reset password", actionUrl: `${APP_URL}/?reset-password=true` },
  "change-email": { subject: "Confirm your new VibhavGPT email", eyebrow: "EMAIL CHANGE", title: "Confirm your new email", lead: "Use this code to confirm the new email address for your VibhavGPT account.", action: "Confirm email", actionUrl: APP_URL },
  "two-factor": { subject: "Your VibhavGPT security code", eyebrow: "TWO-STEP VERIFICATION", title: "Confirm it’s you", lead: "Use this security code to finish signing in to VibhavGPT.", action: "Continue sign-in", actionUrl: APP_URL },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  }[character]));
}

function displayName(name) {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  return clean ? clean.split(" ")[0] : "there";
}

function plainText({ name, otp, copy }) {
  return [
    `Hi ${displayName(name)},`, "", copy.lead, "", `Your code: ${otp}`, "",
    "This code expires in 10 minutes. If you did not request this, you can safely ignore this email.",
    "We will never ask for your password by email.", "",
    `Need help? support@pansophy.com (${SUPPORT_URL})`, `Privacy: ${PRIVACY_URL}`,
    "Pansophy LLC, 938 Campbell Blvd, 14228", "© 2026 Pansophy LLC",
  ].join("\n");
}

// Email clients remain conservative CSS environments. This intentionally uses
// nested tables, inline styles, an HTML-button fallback, and system fonts so it
// renders consistently in Gmail, Outlook, and Apple Mail.
export function buildOtpEmail({ name, otp, type }) {
  const copy = EMAIL_COPY[type] ?? EMAIL_COPY["two-factor"];
  const safeName = escapeHtml(displayName(name));
  const safeOtp = escapeHtml(otp);
  const safeAction = escapeHtml(copy.action);
  const safeActionUrl = escapeHtml(copy.actionUrl);
  const safeTitle = escapeHtml(copy.title);
  const safeLead = escapeHtml(copy.lead);
  return {
    subject: copy.subject,
    text: plainText({ name, otp, copy }),
    html: `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f5f1e8;color:#25231f;font-family:Inter,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f1e8;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fffdf8;border:1px solid #ded6c9;border-radius:14px;overflow:hidden;">
<tr><td style="padding:28px 32px 24px;background:#f0f5ff;border-bottom:1px solid #d9e4fb;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:36px;height:36px;"><img src="${BRAND_LOGO_URL}" width="36" height="36" alt="VibhavGPT" style="display:block;width:36px;height:36px;border:0;outline:none;text-decoration:none;"></td><td style="padding-left:11px;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:26px;color:#1f2937;">VibhavGPT</td></tr></table></td></tr>
<tr><td style="padding:34px 32px 30px;"><p style="margin:0 0 12px;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.4px;color:#2563eb;">${copy.eyebrow}</p><h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:38px;font-weight:400;color:#25231f;">${safeTitle}</h1><p style="margin:0 0 20px;font-size:16px;line-height:25px;color:#5f5a50;">Hi ${safeName},</p><p style="margin:0 0 24px;font-size:16px;line-height:25px;color:#5f5a50;">${safeLead}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background:#f5f1e8;border:1px solid #ded6c9;border-radius:10px;"><tr><td align="center" style="padding:18px 16px 17px;"><p style="margin:0 0 7px;font-size:11px;line-height:15px;letter-spacing:1.2px;font-weight:700;color:#756f64;">YOUR SIX-DIGIT CODE</p><p style="margin:0;font-family:Consolas,'SFMono-Regular',Menlo,monospace;font-size:31px;line-height:36px;letter-spacing:7px;font-weight:700;color:#25231f;">${safeOtp}</p></td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr><td align="center" bgcolor="#2563eb" style="border-radius:8px;"><a href="${safeActionUrl}" style="display:inline-block;padding:13px 20px;font-size:15px;line-height:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${safeAction}</a></td></tr></table><p style="margin:0;font-size:13px;line-height:20px;color:#756f64;">This code expires in 10 minutes. If you did not request this, you can safely ignore this email.</p></td></tr>
<tr><td style="padding:22px 32px 26px;background:#faf7f0;border-top:1px solid #e8e1d5;"><p style="margin:0 0 10px;font-size:12px;line-height:18px;color:#756f64;">Please do not reply to this email. Need help? <a href="${SUPPORT_URL}" style="color:#2563eb;text-decoration:underline;">Contact support</a>.</p><p style="margin:0 0 10px;font-size:12px;line-height:18px;color:#756f64;">For your security, we will never ask for your password by email. Read our <a href="${PRIVACY_URL}" style="color:#2563eb;text-decoration:underline;">Privacy Policy</a>.</p><p style="margin:0;font-size:12px;line-height:18px;color:#938b7e;">Pansophy LLC, 938 Campbell Blvd, 14228<br>© 2026 Pansophy LLC</p></td></tr>
</table></td></tr></table></body></html>`,
  };
}

async function lookupRecipientName(email) {
  try {
    const { pool } = await import("../db/client.js");
    const result = await pool.query('SELECT name FROM "user" WHERE lower(email) = lower($1) LIMIT 1', [email]);
    // A withheld name becomes "there" in the greeting line.
    return safeDisplayName(result.rows[0]?.name);
  } catch {
    // Delivery must remain available if non-essential personalization fails.
    return "";
  }
}

export async function sendOtpEmail({ email, otp, type }) {
  if (!config.resendApiKey) throw new Error("Email verification is not available yet. Please try again shortly.");
  const message = buildOtpEmail({ name: await lookupRecipientName(email), otp, type });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.emailFrom, to: [email], subject: message.subject, text: message.text, html: message.html }),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    console.error("OTP email delivery failed", { status: response.status, type, from: config.emailFrom, providerMessage: details?.message ?? null });
    throw new Error("We couldn't send your code. Please try again.");
  }
}
