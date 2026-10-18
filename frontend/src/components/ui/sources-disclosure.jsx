import * as React from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { sourceCount } from "../../sources.js";
import { SourceChips } from "./thinking-tool.jsx";
import "./sources-disclosure.css";

// The web sources a finished reply used, with the steps the server recorded
// for it. Shown only when there are sources; the model's thinking has its own
// "Thought for X s" control above the reply.
export function SourcesDisclosure({ sources = [], steps = [] }) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const count = sourceCount(sources);
  if (!count) return null;
  return <div className="sources-disclosure">
    <button type="button" className="sources-disclosure__tag" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      Sources ({count})
      <IconChevronRight size={13} aria-hidden="true" className="sources-disclosure__chevron" data-open={open || undefined} />
    </button>
    {open && <div id={panelId} className="sources-disclosure__panel">
      <SourceChips sources={sources} />
      {steps.length > 0 && <ul className="sources-disclosure__steps" aria-label="What was done for this reply">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ul>}
    </div>}
  </div>;
}
