import * as React from "react";
import { ChevronRight } from "lucide-react";
import "./image-prompt-disclosure.css";

// The prompt an image reply was generated from, stored on message metadata.
// Shown only when imagePrompt exists; collapsed by default, text only.
export function ImagePromptDisclosure({ prompt }) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) return null;

  return (
    <div className="image-prompt-disclosure">
      <button
        type="button"
        className="image-prompt-disclosure__tag"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Prompt used</span>
        <ChevronRight size={13} aria-hidden="true" className="image-prompt-disclosure__chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div id={panelId} className="image-prompt-disclosure__panel" role="region" aria-label="Prompt used">
          <p className="image-prompt-disclosure__text">{text}</p>
        </div>
      )}
    </div>
  );
}
