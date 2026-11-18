import { useEffect, useId, useRef, useState } from "react";
import { MessageSquare, Search, GraduationCap, X } from "lucide-react";
import "./ChatSearch.css";

// Search across a person's own past chats and study sessions (their titles and what was said in them).
//
// - The words go to this app's own server in a POST body, once typing pauses, and nowhere else. They are never put in the address
//   bar, in storage or in any log, and are forgotten when the window closes.
// - Results are plain segments from the server ({ text, match }), drawn as text with <mark> around the match: nothing is ever
//   inserted as HTML.
// - Choosing a result opens that chat (or study session) and closes this window.

const DEBOUNCE_MS = 250;
const MIN_LENGTH = 2;

const dateLabel = (iso) => {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const sameYear = when.getFullYear() === new Date().getFullYear();
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
};

function Highlighted({ segments, fallback = "" }) {
  if (!segments?.length) return fallback;
  return segments.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>));
}

export default function ChatSearch({ open, onClose, onOpenResult, api, scope = "chat" }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | done | error | broad
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const listId = useId();
  const trimmed = query.trim();

  // Opening starts clean, and closing forgets everything that was typed.
  useEffect(() => {
    if (!open) { setQuery(""); setResults([]); setStatus("idle"); setActive(0); return undefined; }
    const previous = document.activeElement;
    inputRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [open]);

  // Searching: after typing pauses, and only for a search long enough to mean something. A newer search cancels an older one, so a
  // slow answer to "lis" can never replace the answer to "lisbon".
  useEffect(() => {
    if (!open) return undefined;
    if (trimmed.length < MIN_LENGTH) { setResults([]); setStatus("idle"); return undefined; }
    setStatus("loading");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api("/api/chat/search", { method: "POST", body: JSON.stringify({ q: trimmed, scope }), signal: controller.signal, cache: "no-store" })
        .then((data) => { setResults(Array.isArray(data?.results) ? data.results : []); setActive(0); setStatus("done"); })
        .catch((error) => {
          if (controller.signal.aborted || error?.name === "AbortError") return;
          setResults([]);
          setStatus(error?.code === "too_broad" ? "broad" : "error");
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, trimmed, api]);

  if (!open) return null;

  const choose = (result) => { if (result) onOpenResult(result.id, ["study", "build"].includes(result.mode) ? result.mode : "chat"); };
  const onKeyDown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (results.length ? (index + 1) % results.length : 0)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (results.length ? (index - 1 + results.length) % results.length : 0)); return; }
    if (event.key === "Enter" && results[active]) { event.preventDefault(); choose(results[active]); return; }
    if (event.key === "Tab") {
      const focusable = panelRef.current?.querySelectorAll("input, button:not([disabled])");
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };

  const message = trimmed.length < MIN_LENGTH ? "Type at least two letters to search your chats and study sessions."
    : status === "loading" ? "Searching…"
    : status === "error" ? "Search is not available right now. Try again in a moment."
    : status === "broad" ? "That search is too broad. Try a more specific word."
    : status === "done" && !results.length ? `No chats or study sessions match “${trimmed}”.` : "";

  return (
    <div className="chat-search__scrim" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panelRef} className="chat-search" role="dialog" aria-modal="true" aria-label={scope === "build" ? "Search builds" : "Search chats"} onKeyDown={onKeyDown}>
        <div className="chat-search__bar">
          <Search size={18} strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            className="chat-search__input"
            type="text"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-label="Search your chats and study sessions"
            placeholder={scope === "build" ? "Search your builds" : "Search your chats and study sessions"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="chat-search__close" aria-label="Close search" onClick={onClose}><X size={18} strokeWidth={1.8} /></button>
        </div>
        <div className="chat-search__body">
          <ul id={listId} className="chat-search__list" role="listbox" aria-label="Matching chats" hidden={!results.length}>
            {results.map((result, index) => (
              <li
                key={result.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active || undefined}
                className="chat-search__item"
                onMouseMove={() => index !== active && setActive(index)}
                onClick={() => choose(result)}
              >
                <span className="chat-search__icon" aria-hidden="true">{result.mode === "study" ? <GraduationCap size={16} strokeWidth={1.7} /> : <MessageSquare size={16} strokeWidth={1.7} />}</span>
                <span className="chat-search__copy">
                  <span className="chat-search__title"><Highlighted segments={result.titleSegments} fallback={result.title} /></span>
                  {result.snippet?.length > 0 && <span className="chat-search__snippet"><Highlighted segments={result.snippet} /></span>}
                </span>
                <span className="chat-search__meta">
                  <time dateTime={result.date}>{dateLabel(result.date)}</time>
                  {result.mode === "study" && <span>Study</span>}
                </span>
              </li>
            ))}
          </ul>
          {message && <p className="chat-search__note" data-state={status}>{message}</p>}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{status === "done" ? (results.length ? `${results.length} ${results.length === 1 ? "result" : "results"}` : "No results") : ""}</p>
      </div>
    </div>
  );
}
