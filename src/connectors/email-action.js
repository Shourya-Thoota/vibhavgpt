// Preparing a Gmail send or draft for approval. Nothing here talks to Gmail: it checks what the person asked for, names the sender, and builds the exact
// payload that the approval card shows and that the approval is bound to. The send or the draft happens only after the person approves that card.

import { accountReference } from "./account-reference.js";
import { getConnectorAccountId, getEnabledConnectorGrant, publicConnectorMetadata } from "./service.js";

export const EMAIL_TOOLS = Object.freeze(new Set(["gmail_send_email", "draft_email"]));

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;

/** "send it" / "mail X" asks for a send; the word "draft" asks for a draft. Anything else is left to the tool the model chose. */
export function emailIntent(requestText) {
  const text = String(requestText ?? "");
  if (/\bdrafts?\b/i.test(text)) return "draft";
  if (/\b(?:send|mail)\b/i.test(text)) return "send";
  return null;
}

/**
 * Returns { ok: true, payload, description } or { ok: false, message }. The payload carries the sender's display name and an opaque reference to the
 * connected account, never the connection's internal alias.
 */
export async function prepareEmailAction({ userId, toolName, args = {} }, deps = {}) {
  const to = String(args.to ?? args.recipient_email ?? "").trim();
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!ADDRESS.test(to)) return { ok: false, message: "I need one full email address to send this to (like name@example.com). Which address should I use?" };
  if (!subject) return { ok: false, message: "I need a subject line for this email. What should it say?" };
  if (!body) return { ok: false, message: "I need the message text for this email. What should it say?" };
  if (subject.length > MAX_SUBJECT) return { ok: false, message: `The subject is too long (over ${MAX_SUBJECT} characters). Please shorten it.` };
  if (body.length > MAX_BODY) return { ok: false, message: `The message is too long (over ${MAX_BODY.toLocaleString("en-US")} characters). Please shorten it.` };

  const grant = await (deps.getEnabledConnectorGrant ?? getEnabledConnectorGrant)(userId, "gmail");
  const accountId = await (deps.getConnectorAccountId ?? getConnectorAccountId)(userId, "gmail").catch(() => null);
  if (!accountId) return { ok: false, message: "Gmail isn't connected to an account that is verified for you, so I haven't prepared anything and nothing was sent. Reconnect Gmail in Extensions, or ask the owner to verify the connection." };
  const publicAccount = publicConnectorMetadata(grant?.metadata);
  const sender = String(publicAccount.email || publicAccount.accountLabel || "").slice(0, 120) || null;

  const verb = toolName === "gmail_send_email" ? "Send" : "Create a Gmail draft of";
  const description = toolName === "gmail_send_email"
    ? `Send an email from ${sender || "your connected Gmail account"} to ${to}: “${subject}”`
    : `${verb} an email to ${to}: “${subject}” (in ${sender || "your connected Gmail account"}, not sent)`;
  return {
    ok: true,
    description,
    payload: { to, subject, body, ...(sender ? { senderLabel: sender } : {}), ...(accountId ? { accountRef: accountReference(accountId) } : {}) },
  };
}
