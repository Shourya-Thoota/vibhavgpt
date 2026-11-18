import * as React from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { sourcesByNumber } from "../../citations.js";
import "./sources-disclosure.css";

const publishedLabel = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return "";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

// The page's address without the scheme, so a reader sees exactly where a link goes before following it.
const shownAddress = (href) => {
  try { const url = new URL(href); return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`; } catch { return ""; }
};

function SourceRow({ source }) {
  const date = publishedLabel(source.publishedDate);
  return <li value={source.n} className="sources-list__item">
    <span className="sources-list__number" aria-hidden="true">{source.n}</span>
    <a className="sources-list__link" href={source.href} target="_blank" rel="noopener noreferrer" title={source.href}>
      <span className="sources-list__title">{source.title}</span>
      <span className="sources-list__meta">{source.domain}{date ? ` · ${date}` : " · date not stated"}</span>
      <span className="sources-list__address">{shownAddress(source.href)}</span>
    </a>
  </li>;
}

// The web sources a finished reply used, numbered as the reply cites them ([n] in the text is n here), with the steps the server
// recorded for it. Shown only when there are sources; the model's thinking has its own "Thought for X s" control above the reply.
// The sources the reply cites come first and the list starts open when there are any, as a researched answer's Sources section; the
// pages the search found but the reply did not cite follow under "Also searched". Replies saved before citations were tracked list every
// source together. Each row is the page's title, site, date and address from the saved source: nothing is fetched from the source's site.
export function SourcesDisclosure({ sources = [], steps = [] }) {
  const numbered = React.useMemo(() => [...sourcesByNumber(sources).values()].sort((a, b) => a.n - b.n), [sources]);
  const tracked = numbered.some((source) => typeof source.cited === "boolean");
  const cited = tracked ? numbered.filter((source) => source.cited) : numbered;
  const others = tracked ? numbered.filter((source) => !source.cited) : [];
  const [open, setOpen] = React.useState(tracked && cited.length > 0);
  const panelId = React.useId();
  const count = numbered.length;
  if (!count) return null;
  return <div className="sources-disclosure">
    <button type="button" className="sources-disclosure__tag" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      Sources ({count})
      <IconChevronRight size={13} aria-hidden="true" className="sources-disclosure__chevron" data-open={open || undefined} />
    </button>
    {open && <div id={panelId} className="sources-disclosure__panel">
      {cited.length > 0 && <ol className="sources-list" aria-label={tracked ? "Sources cited in this reply" : "Web sources, numbered as the reply cites them"}>
        {cited.map((source) => <SourceRow key={source.n} source={source} />)}
      </ol>}
      {others.length > 0 && <>
        <p className="sources-list__group">{cited.length ? "Also searched" : "Searched, not cited"}</p>
        <ol className="sources-list sources-list--other" aria-label="Pages the search found that this reply does not cite">
          {others.map((source) => <SourceRow key={source.n} source={source} />)}
        </ol>
      </>}
      {steps.length > 0 && <ul className="sources-disclosure__steps" aria-label="What was done for this reply">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ul>}
    </div>}
  </div>;
}
