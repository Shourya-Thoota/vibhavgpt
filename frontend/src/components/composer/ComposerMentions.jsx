import { useEffect, useMemo, useRef } from "react";
import { ServiceLogo } from "../extensions/ServiceLogo.jsx";
import { PLAIN_SERVICE_NAMES } from "../extensions/connector-directory.js";

export const PLAIN_CONNECTOR_NAMES = PLAIN_SERVICE_NAMES;

export function connectorDisplayName(connector) {
  if (!connector) return "";
  return PLAIN_CONNECTOR_NAMES[connector.id] || connector.name || connector.id;
}

export { detectMentionTrigger } from "../../composer-mentions.js";

function connectorStatusLabel(connector) {
  if (connector.status !== "connected") return "Disconnected";
  if (!connector.enabled) return "Disabled";
  return "Connected";
}

export function filterConnectorsForPicker(connectors, query, selectedIds) {
  const q = query.trim().toLowerCase();
  return connectors
    .filter((c) => c.catalogVisible !== false)
    .filter((c) => !selectedIds.has(c.id))
    .filter((c) => {
      if (!q) return true;
      const name = connectorDisplayName(c).toLowerCase();
      return name.includes(q) || c.id.toLowerCase().includes(q);
    })
    .sort((a, b) => connectorDisplayName(a).localeCompare(connectorDisplayName(b)));
}

export function filterSkillsForPicker(skills, query, selectedIds) {
  const q = query.trim().toLowerCase();
  return skills
    .filter((s) => !selectedIds.has(s.id))
    .filter((s) => {
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ComposerMentionsPopover({
  kind,
  query,
  connectors = [],
  skills = [],
  selectedConnectorIds = new Set(),
  selectedSkillIds = new Set(),
  highlightIndex = 0,
  onHighlight,
  onSelectConnector,
  onSelectSkill,
  onConnectConnector,
  onClose,
  loading = false,
}) {
  const listRef = useRef(null);

  const items = useMemo(() => {
    if (kind === "connector") {
      return filterConnectorsForPicker(connectors, query, selectedConnectorIds);
    }
    if (kind === "skill") {
      return filterSkillsForPicker(skills, query, selectedSkillIds);
    }
    return [];
  }, [kind, query, connectors, skills, selectedConnectorIds, selectedSkillIds]);

  useEffect(() => {
    const node = listRef.current?.querySelector("[data-active='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, items.length]);

  const safeHighlight = items.length ? Math.min(highlightIndex, items.length - 1) : 0;

  const title = kind === "connector" ? "Connectors" : "Skills";
  const emptyLabel = kind === "connector" ? "No matching connectors" : "No matching skills";

  return (
    <div className="composer-mentions-popover" role="listbox" aria-label={title} ref={listRef}>
      <div className="composer-mentions-popover__head">
        <span>{title}</span>
        <button type="button" className="composer-mentions-popover__close" onClick={onClose} aria-label="Close">
          Esc
        </button>
      </div>
      {loading ? (
        <p className="composer-mentions-popover__empty">Loading…</p>
      ) : items.length === 0 ? (
        <p className="composer-mentions-popover__empty">{emptyLabel}</p>
      ) : (
        <ul className="composer-mentions-popover__list">
          {items.map((item, index) => {
            const active = index === safeHighlight;
            if (kind === "connector") {
              const disconnected = item.status !== "connected";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active || undefined}
                    className="composer-mentions-popover__row"
                    onMouseEnter={() => onHighlight?.(index)}
                    onClick={() => {
                      if (disconnected) onConnectConnector?.(item);
                      else onSelectConnector?.(item);
                    }}
                  >
                    <ServiceLogo serviceId={item.id} size={22} className="composer-mentions-popover__logo" />
                    <span className="composer-mentions-popover__text">
                      <span className="composer-mentions-popover__name">{connectorDisplayName(item)}</span>
                      <span className="composer-mentions-popover__meta">{connectorStatusLabel(item)}</span>
                    </span>
                    {disconnected ? (
                      <span className="composer-mentions-popover__action">Connect</span>
                    ) : null}
                  </button>
                </li>
              );
            }
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active || undefined}
                  className="composer-mentions-popover__row"
                  onMouseEnter={() => onHighlight?.(index)}
                  onClick={() => onSelectSkill?.(item)}
                >
                  <span className="composer-mentions-popover__skill-mark" aria-hidden="true">/</span>
                  <span className="composer-mentions-popover__text">
                    <span className="composer-mentions-popover__name">{item.name}</span>
                    <span className="composer-mentions-popover__meta">
                      {item.enabled ? "Enabled" : "Disabled"}
                      {item.description ? ` · ${item.description}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ComposerMentionChips({ connectors = [], skills = [], onRemoveConnector, onRemoveSkill }) {
  if (!connectors.length && !skills.length) return null;
  return (
    <div className="composer-mentions-chips" aria-label="Selected connectors and skills">
      {connectors.map((entry) => (
        <span className="composer-mentions-chip" key={`c-${entry.id}`}>
          <ServiceLogo serviceId={entry.id} size={16} />
          <span>{entry.name}</span>
          <button type="button" aria-label={`Remove ${entry.name}`} onClick={() => onRemoveConnector?.(entry.id)}>
            ×
          </button>
        </span>
      ))}
      {skills.map((entry) => (
        <span className="composer-mentions-chip composer-mentions-chip--skill" key={`s-${entry.id}`}>
          <span className="composer-mentions-chip__slash">/</span>
          <span>{entry.name}</span>
          <button type="button" aria-label={`Remove skill ${entry.name}`} onClick={() => onRemoveSkill?.(entry.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
