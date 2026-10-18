import * as React from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { liveStatusLabel, thoughtLabel } from "../../live-status.js";
import { thinkingSteps } from "../../thinking-steps.js";
import "./thinking-tool.css";
import "./reasoning-trace.css";

// The waiting reply's status, with a live seconds counter while thinking.
export function LiveStatusLabel({ phase, attempt, maxAttempts, startedAt }) {
  const [now, setNow] = React.useState(() => Date.now());
  const counting = phase !== "attachments" && phase !== "searching" && phase !== "retrying";
  React.useEffect(() => {
    if (!counting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting, startedAt]);
  return <span aria-live="polite">{liveStatusLabel({ phase, attempt, maxAttempts, seconds: startedAt ? (now - startedAt) / 1000 : 0 })}</span>;
}

// The thinking itself, as titled steps: each titled phase gets a small
// numbered badge, and its text sits under it. Untitled thinking is shown as
// plain paragraphs. No HTML is rendered from the model's text.
function ThinkingSteps({ text }) {
  const steps = thinkingSteps(text);
  const paragraphs = (step) => step.paragraphs.map((parts, index) => (
    <p key={index} className="reasoning-trace__para">
      {parts.map((part, partIndex) => (part.strong ? <strong key={partIndex}>{part.text}</strong> : <React.Fragment key={partIndex}>{part.text}</React.Fragment>))}
    </p>
  ));
  if (!steps.some((step) => step.title)) return <>{steps.map((step, index) => <React.Fragment key={index}>{paragraphs(step)}</React.Fragment>)}</>;
  let number = 0;
  return <ol className="reasoning-trace__steps">
    {steps.map((step, index) => (
      <li key={index} className="reasoning-trace__step">
        {step.title && <div className="reasoning-trace__step-head">
          <span className="reasoning-trace__badge" aria-hidden="true">{(number += 1)}</span>
          <span className="reasoning-trace__step-title">{step.title}</span>
        </div>}
        {paragraphs(step)}
      </li>
    ))}
  </ol>;
}

// The orb from the live thinking pill, at rest.
const restingOrb = <span className="thinking-tool__orb" aria-hidden="true"><i /><i /><i /></span>;

// The model's own thinking. It stays open while the model thinks, then folds
// into a "Thought for X s" pill, the same orb pill as the live one. Thinking
// is never saved, so a reloaded reply shows only how long it thought.
export function ReasoningTrace({ text = "", live = false, seconds = null }) {
  const [open, setOpen] = React.useState(false);
  const bodyRef = React.useRef(null);
  const contentId = React.useId();
  const hasText = Boolean(text.trim());
  React.useEffect(() => {
    if (live && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, live]);
  if (live) {
    if (!hasText) return null;
    return <div className="reasoning-trace" data-live="">
      <div ref={bodyRef} className="reasoning-trace__body" aria-label="Model thinking"><ThinkingSteps text={text} /></div>
    </div>;
  }
  if (seconds === null && !hasText) return null;
  const label = seconds === null ? "Thought" : thoughtLabel(seconds);
  if (!hasText) return <div className="reasoning-trace"><button type="button" className="thinking-tool__toggle" disabled>{restingOrb}<span>{label}</span></button></div>;
  return <div className="reasoning-trace">
    <button type="button" className="thinking-tool__toggle" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
      {restingOrb}
      <span>{label}</span>
      <IconChevronRight size={14} aria-hidden="true" className={open ? "thinking-tool__chevron thinking-tool__chevron--open" : "thinking-tool__chevron"} />
    </button>
    {open && <div id={contentId} className="reasoning-trace__body"><ThinkingSteps text={text} /></div>}
  </div>;
}
