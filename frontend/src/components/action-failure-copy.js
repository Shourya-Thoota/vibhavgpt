// The words an approval card uses for a failed connector action. Plain
// functions so they can be tested without rendering the card.

export function serviceName(toolName) {
  const tool = String(toolName || "");
  if (tool.startsWith("google_drive")) return "Google Drive";
  if (tool === "gmail_send_email" || tool === "draft_email" || tool.startsWith("gmail")) return "Gmail";
  if (tool.startsWith("github")) return "GitHub";
  if (tool.startsWith("notion")) return "Notion";
  if (tool.startsWith("slack")) return "Slack";
  if (tool.startsWith("microsoft")) return "Microsoft 365";
  if (tool.startsWith("youtube")) return "YouTube";
  return "Connector";
}

export function failureText(action) {
  const specific = operationFailureText(action);
  if (specific) return specific;
  const raw = String(action?.result?.error || "");
  if (/^\d+ out of \d+ tools failed$/i.test(raw.trim())) {
    // Name the service this action was for; only Drive uploads create "the file".
    const service = serviceName(action?.toolName);
    if (service === "Google Drive") {
      return "Google Drive rejected the upload before it confirmed a file. This approval cannot be run again. Ask again if you still want the file created.";
    }
    return `${service === "Connector" ? "The service" : service} rejected the request before it confirmed a result. This approval cannot be run again. Ask again if you still want it done.`;
  }
  return raw || "This approval failed. Nothing further will be sent. Ask again if you still want it done.";
}

/** What kind of operation an action is, so a card can describe it in its own words. */
export function operationKind(action) {
  const tool = String(action?.toolName || "");
  if (tool === "gmail_send_email") return "email_send";
  if (tool === "draft_email") return "email_draft";
  if (tool.startsWith("google_drive")) return "file_upload";
  return "other";
}

// Provider tool names and internal aliases are for developer logs, never for the person reading the card.
const RAW_TOOL_NAME = /\b[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]{2,}){1,}\b/g;
const INTERNAL_ALIAS = /\b[a-z0-9]+_[a-z]+-[a-z]+\b/g;
export function scrubInternalNames(text) {
  return String(text || "").replace(RAW_TOOL_NAME, "that action").replace(INTERNAL_ALIAS, "the connected account").replace(/\s+/g, " ").trim();
}

/** The heading of a card whose action failed (a definite failure, not an unknown outcome). */
export function failureTitle(action) {
  if (action?.status === "expired") return "Approval expired";
  switch (operationKind(action)) {
    case "email_send": return "Email was not sent";
    case "email_draft": return "Draft was not created";
    case "file_upload": return "Upload was not confirmed";
    default: return "Action was not completed";
  }
}

/** The heading and text of a card whose outcome is unknown after the request may have reached the provider. */
export function unknownOutcomeText(action) {
  switch (operationKind(action)) {
    case "email_send":
      return { title: "Email status unknown", body: "We couldn't confirm whether the email was sent. It was not sent again. Check your Gmail Sent folder before asking again, so it isn't sent twice." };
    case "email_draft":
      return { title: "Draft status unknown", body: "We couldn't confirm whether the draft was saved. It was not created again. Check your Gmail Drafts before asking again, so there isn't a duplicate." };
    default:
      return { title: "Outcome unknown", body: "The service may already have done this. It was not sent again." };
  }
}

const NEXT_STEP = {
  email_send: "Nothing was sent. You can ask again in a moment.",
  email_draft: "Nothing was saved. You can ask again in a moment.",
};

/** What the person reads under a failed card. Plain words, no tool names; says "nothing was sent" only when the record shows it ran nothing. */
export function operationFailureText(action) {
  const kind = operationKind(action);
  const result = action?.result || {};
  const before = result.dispatchStatus === "pre_dispatch_failure";
  if ((kind === "email_send" || kind === "email_draft") && result.code === "tool_unavailable") {
    return `Gmail can't do this right now: that email action isn't available. ${NEXT_STEP[kind]}`;
  }
  if (kind === "email_send" || kind === "email_draft") {
    const reason = scrubInternalNames(result.error) || "Gmail did not complete this.";
    return before ? `${reason} ${NEXT_STEP[kind]}` : `${reason} Check your Gmail before asking again.`;
  }
  return null;
}
