import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useSession } from "../session.jsx";

const ORDER = ["Principles of Business Administration", "Individual Series", "Personal Financial Literacy", "Team Decision Making"];

export function EventPicker({ value, onChange }) {
  const { catalog } = useSession();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const events = (catalog?.events ?? []).filter((event) => !needle || `${event.code} ${event.name} ${event.cluster}`.toLowerCase().includes(needle));
    return ORDER.map((label) => ({ label, events: events.filter((event) => event.formatLabel === label) })).filter((group) => group.events.length);
  }, [catalog, query]);
  if (!catalog) return <div className="spinner" />;
  return (
    <div className="stack">
      <div style={{ position: "relative" }}>
        <Search size={17} style={{ position: "absolute", left: 12, top: 12, color: "var(--muted)" }} />
        <input className="input" style={{ paddingLeft: 38 }} placeholder="Search events (e.g. Marketing, HRM)" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search events" />
      </div>
      {groups.map((group) => (
        <div className="event-group" key={group.label}>
          <h4>{group.label}{group.label === "Team Decision Making" && " · 30 min prep, 15 min presentation"}</h4>
          <div className="event-list">
            {group.events.map((event) => (
              <button type="button" key={event.code} className="event-option" aria-pressed={value === event.code} onClick={() => onChange(event.code)}>
                <span className="event-option__code">{event.code}</span>
                <span><span className="event-option__name">{event.name}</span><br /><span className="tiny muted">{event.cluster}</span></span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="muted">No events match "{query}".</p>}
    </div>
  );
}
