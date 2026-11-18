import { AlertCircle, BarChart3, Clock, Sparkles } from "lucide-react";
import { Banner } from "../ui.jsx";
import "./workspace-notice.css";

/**
 * WorkspaceNotice
 * Standardized, restrained, accent-tinted alert component for plan limits,
 * quota exhaustion, rolling throttles, and capability requirements.
 *
 * Reserves its own layout space in document flow above workspace controls.
 */
export default function WorkspaceNotice({
  access,
  tier = "free",
  onAction,
  onDismiss,
}) {
  if (!access) return null;

  const {
    reason,
    feature = "This feature",
    message,
    resetAt,
    window: timeWindow,
    action,
    cta,
    requiredPlan,
  } = access;

  // Format verified reset date/time without inventing countdowns
  let formattedReset = null;
  if (resetAt) {
    try {
      const date = new Date(resetAt);
      if (!Number.isNaN(date.getTime())) {
        formattedReset = timeWindow === "rolling"
          ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      }
    } catch {
      formattedReset = null;
    }
  }

  const isProUser = String(tier).toLowerCase() === "pro";
  const featureLower = String(feature).toLowerCase();
  const isImageFeature = featureLower.includes("image");
  // AI credits run out for one of three reasons, and each is said as what it is.
  const isCredits = reason === "quota" && feature === "AI credits";

  let title = "";
  let explanation = "";
  let primaryAction = action || "plans";
  let primaryLabel = cta || "See plans";
  let tone = "info"; // info | warning | error
  let Icon = Sparkles;

  if (reason === "plan") {
    tone = "info";
    Icon = Sparkles;
    if (isImageFeature) {
      title = "Image creation requires Plus or Pro";
      explanation = "Create pictures, customize styles, and choose shapes with an active Plus or Pro plan.";
    } else {
      const required = requiredPlan || (feature === "Vulcan" ? "Pro" : "Plus or Pro");
      title = `${feature} requires ${required}`;
      explanation = `${feature} isn't included with your current plan. Upgrade to unlock this model and higher allowances.`;
    }

    if (isProUser) {
      primaryAction = "usage";
      primaryLabel = "View usage";
    } else {
      primaryAction = "plans";
      primaryLabel = "See plans";
    }
  } else if (isCredits) {
    tone = "warning";
    Icon = BarChart3;
    const kind = access.detail?.resetKind;
    const at = resetAt ? new Date(resetAt) : null;
    const stamp = at && !Number.isNaN(at.getTime())
      ? at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    title = access.requestTooLarge
      ? "This request needs more AI credits"
      : timeWindow === "month" ? "Monthly AI credits used" : "This week's AI credits used";
    const timing = !stamp ? ""
      : kind === "monthly-reset" ? ` Your monthly allowance resets ${stamp}.`
        : kind === "next-allocation" ? ` Your next allocation arrives ${stamp}.`
          : ` They reset ${stamp}.`;
    // Image & document credits are a separate balance, and say so here, so nobody buys them to keep chatting.
    explanation = `${message}${access.requestTooLarge && stamp ? ` More credits are available ${stamp}.` : access.requestTooLarge ? "" : timing} Image & document credits don't pay for Chat or Study.`;
    primaryAction = "usage";
    primaryLabel = "View AI credits";
  } else if (reason === "quota") {
    tone = "warning";
    Icon = timeWindow === "rolling" ? Clock : BarChart3;

    if (timeWindow === "rolling") {
      title = `${feature} 5-hour limit reached`;
      explanation = formattedReset
        ? `Usage frees up starting around ${formattedReset} as earlier activity leaves the 5-hour window.`
        : "Usage frees up gradually as earlier requests leave the rolling 5-hour window.";
    } else if (timeWindow === "monthly" || isImageFeature) {
      title = isImageFeature
        ? "Monthly image allowance reached"
        : `Monthly ${featureLower} allowance reached`;
      explanation = formattedReset
        ? `Your allowance will reset on ${formattedReset}.`
        : "You have used your monthly allowance for this billing period.";
    } else {
      title = "Usage allowance reached";
      explanation = message || "You have reached your allowance for this feature.";
    }

    if (isProUser) {
      primaryAction = "usage";
      primaryLabel = "View usage";
    } else {
      primaryAction = timeWindow === "rolling" ? "usage" : "plans";
      primaryLabel = timeWindow === "rolling" ? "View usage" : "See plans";
    }
  } else if (reason === "rate") {
    // A security rate limit on how fast or how many at once. It is not an allowance: nothing was
    // used up, and it clears by waiting or by letting a reply in progress finish.
    tone = "warning";
    Icon = Clock;
    const concurrent = access.detail?.kind === "concurrent";
    title = concurrent ? "Replies already in progress" : "Sending too quickly";
    explanation = message || "Please wait a moment and try again.";
    primaryAction = "retry";
    primaryLabel = cta || "Try again";
  } else if (reason === "credits") {
    tone = "warning";
    Icon = Sparkles;
    title = "More image & document credits needed";
    const renews = resetAt && !Number.isNaN(new Date(resetAt).getTime())
      ? ` Renews ${new Date(resetAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
      : "";
    explanation = `${message || `You need more image & document credits to continue using ${featureLower}.`}${renews}`;
    primaryAction = "credits";
    primaryLabel = "View image & document credits";
  } else if (reason === "storage") {
    tone = "warning";
    Icon = AlertCircle;
    title = "File storage limit reached";
    explanation = message || "Delete older files or conversations to free up storage space.";
    primaryAction = "storage";
    primaryLabel = "Manage files";
  } else if (reason === "service" || reason === "network") {
    tone = "error";
    Icon = AlertCircle;
    title = reason === "network" ? "Connection issue" : "Temporarily unavailable";
    explanation = message || (reason === "network"
      ? "Couldn't connect to server. Check your connection and try again."
      : "This service is temporarily unavailable. Please try again shortly.");
    primaryAction = "retry";
    primaryLabel = "Try again";
  } else {
    tone = "info";
    Icon = AlertCircle;
    title = `${feature} notice`;
    explanation = message || "Action required to proceed with this feature.";
    primaryAction = action || "usage";
    primaryLabel = cta || "Learn more";
  }

  const handlePrimaryClick = () => {
    if (onAction) onAction(primaryAction);
  };

  return (
    <div className="workspace-notices-container" role="region" aria-label="Workspace notices">
      <Banner
        tone={tone}
        icon={Icon}
        title={title}
        className="workspace-notice"
        classNames={{ icon: "workspace-notice__icon", body: "workspace-notice__content", title: "workspace-notice__title", text: "workspace-notice__explanation", actions: "workspace-notice__actions", dismiss: "workspace-notice__dismiss" }}
        live="status"
        onDismiss={onDismiss}
        dismissLabel="Dismiss notice"
        action={(
          <button
            type="button"
            className={`btn ${primaryAction === "retry" ? "btn--secondary" : "btn--primary"} workspace-notice__cta ${primaryAction === "retry" ? "workspace-notice__cta--secondary" : "workspace-notice__cta--primary"}`}
            onClick={handlePrimaryClick}
          >
            {primaryLabel}
          </button>
        )}
      >
        {explanation}
      </Banner>
    </div>
  );
}
