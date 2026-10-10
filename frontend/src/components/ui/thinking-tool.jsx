import * as React from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { IconChevronRight } from "@tabler/icons-react";
import { ResourceLink } from "../PrivateMedia.jsx";
import "./thinking-tool.css";

function groupSources(sources) {
  const groups = new Map();
  const seen = new Set();
  for (const source of sources) {
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol) || seen.has(url.href)) continue;
      seen.add(url.href);
      const host = url.hostname.replace(/^www\./, "");
      if (!groups.has(host)) groups.set(host, { host, favicon: `${url.origin}/favicon.ico`, sources: [] });
      groups.get(host).sources.push(source);
    } catch { /* Ignore malformed source URLs. */ }
  }
  return [...groups.values()];
}

export const ThinkingTool = React.memo(function ThinkingTool({
  state = "thinking", content, sources = [], defaultOpen = false,
  expanded, onToggleExpand, className,
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const contentId = React.useId();
  const controlled = expanded !== undefined;
  const isOpen = controlled ? Boolean(expanded) : internalOpen;
  const expandable = Boolean(content?.trim() || sources.length);
  const thinking = state === "thinking";
  const sourceGroups = groupSources(sources);
  return <div className={twMerge(clsx("thinking-tool", className))}>
    <button type="button" className="thinking-tool__toggle" disabled={!expandable}
      aria-expanded={expandable ? isOpen : undefined} aria-controls={expandable ? contentId : undefined}
      onClick={() => { if (controlled) onToggleExpand?.(); else setInternalOpen((value) => !value); }}>
      <span className="thinking-tool__orb" data-active={thinking || undefined} aria-hidden="true"><i /><i /><i /></span>
      <span className={thinking ? "an-thinking-shimmer" : undefined}>{thinking ? "Thinking...." : "Thought"}</span>
      {expandable && <IconChevronRight size={14} aria-hidden="true" className={clsx("thinking-tool__chevron", isOpen && "thinking-tool__chevron--open")} />}
    </button>
    {expandable && isOpen && <div id={contentId} className="thinking-tool__content">
      {sourceGroups.length > 0 && <div className="thinking-tool__sources" aria-label="Web sources consulted">
        {sourceGroups.map((group) => <details className="source-chip" key={group.host}>
          <summary><img src={group.favicon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /><span>{group.host}</span>{group.sources.length > 1 && <span className="source-chip__count">+{group.sources.length - 1}</span>}</summary>
          <div className="source-chip__preview">
            {group.sources.map((source) => <ResourceLink key={source.url} href={source.url}><strong>{source.title || group.host}</strong><small>{group.host}</small></ResourceLink>)}
          </div>
        </details>)}
      </div>}
      {content && <p>{content}</p>}
    </div>}
  </div>;
});
