import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Download, ExternalLink, FileText, Search, Trash2 } from "lucide-react";
import { fetchPrivateFile } from "../api.js";
import { PrivateImage, saveFile } from "./PrivateMedia.jsx";
import { Modal } from "./ui.jsx";
import "./Library.css";

// The Library: documents and pictures VibhavGPT made for the signed-in person (the server lists only theirs). Pictures and files
// are addressed through this app's own owner-only routes, never a public link.

const FILTERS = [
  { value: "all", label: "All" },
  { value: "documents", label: "Documents" },
  { value: "images", label: "Images" },
];

const dateText = (iso) => {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? "" : when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const sizeText = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function docBadge(name = "", mimeType = "") {
  const n = String(name || "").toLowerCase();
  const m = String(mimeType || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "PDF";
  if (m.includes("word") || n.endsWith(".docx") || n.endsWith(".doc")) return "DOCX";
  if (m.includes("sheet") || m.includes("excel") || n.endsWith(".xlsx") || n.endsWith(".csv")) return "SHEET";
  if (m.startsWith("text/") || n.endsWith(".txt") || n.endsWith(".md")) return "TEXT";
  return "DOC";
}

export default function Library({ api, onOpenConversation }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [downloadingId, setDownloadingId] = useState(null);
  const latest = useRef(0);

  // Typing waits for a pause before it searches.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async ({ append = false, after = null } = {}) => {
    const ticket = ++latest.current;
    if (append) setMore(true); else setStatus("loading");
    try {
      const params = new URLSearchParams({ type: filter });
      if (search) params.set("q", search);
      if (after) params.set("cursor", after);
      const result = await api(`/api/library?${params}`, { cache: "no-store" });
      if (ticket !== latest.current) return;
      setItems((current) => (append ? [...current, ...result.items] : result.items));
      setCursor(result.nextCursor ?? null);
      setStatus("ready");
    } catch {
      if (ticket === latest.current) setStatus("error");
    } finally {
      if (ticket === latest.current) setMore(false);
    }
  }, [api, filter, search]);

  useEffect(() => { void load(); }, [load]);

  const handleDownload = async (item) => {
    if (!item?.downloadUrl || downloadingId) return;
    setDownloadingId(item.id);
    try {
      const blob = await fetchPrivateFile(item.downloadUrl);
      await saveFile(blob, item.name);
    } catch (err) {
      alert(err?.message || "Could not download file.");
    } finally {
      setDownloadingId(null);
    }
  };

  async function confirmRemove(event) {
    event?.preventDefault();
    if (!removing || removeBusy) return;
    setRemoveBusy(true); setRemoveError("");
    try {
      await api(`/api/library/${removing.id}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== removing.id));
      if (preview?.id === removing.id) setPreview(null);
      setRemoving(null);
    } catch (error) {
      setRemoveError(error?.message || "Couldn't delete that file. Please try again.");
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <main className="page lib-page">
      <header className="lib-page__head">
        <h1 className="page__title">Library</h1>
        <p className="lib-page__lede">Documents and images VibhavGPT made for you.</p>
      </header>

      <div className="lib-page__tools">
        <div className="lib-page__filters" role="group" aria-label="Show">
          {FILTERS.map((option) => (
            <button key={option.value} type="button" className="lib-page__filter" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>
          ))}
        </div>
        <label className="lib-page__search">
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Search the Library</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or description" maxLength={100} autoComplete="off" />
        </label>
      </div>

      {status === "loading" && <p className="lib-page__note" role="status">Loading your Library…</p>}
      {status === "error" && (
        <div className="lib-page__note lib-page__note--error" role="alert">
          <p>The Library could not be loaded.</p>
          <button type="button" className="btn btn--secondary" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {status === "ready" && items.length === 0 && (
        <p className="lib-page__note">{search || filter !== "all" ? "Nothing matches that." : "Nothing here yet. Documents and images you create in Chat will appear here."}</p>
      )}

      {status === "ready" && items.length > 0 && (
        <ul className="lib-page__grid">
          {items.map((item) => (
            <li key={item.id} className="lib-page__card" data-kind={item.kind}>
              {item.kind === "image" ? (
                <button
                  type="button"
                  className="lib-page__thumb"
                  disabled={!item.available}
                  onClick={() => setPreview(item)}
                  aria-label={`Open preview for ${item.name}`}
                >
                  {item.available && item.previewUrl ? (
                    <PrivateImage
                      src={item.previewUrl}
                      alt={item.prompt ? `Image made from: ${item.prompt}` : item.name}
                      lazy
                      className="lib-page__img"
                    />
                  ) : (
                    <div className="lib-page__missing">
                      <AlertCircle size={22} aria-hidden="true" />
                      <span>No longer stored</span>
                    </div>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="lib-page__thumb lib-page__thumb--doc"
                  onClick={() => setPreview(item)}
                  aria-label={`Open preview for ${item.name}`}
                >
                  <div className="lib-page__doc-header">
                    <span className="lib-page__doc-badge">{docBadge(item.name, item.mimeType)}</span>
                    <FileText size={20} strokeWidth={1.5} aria-hidden="true" />
                  </div>
                  {item.previewText ? (
                    <p className="lib-page__excerpt">{item.previewText}</p>
                  ) : (
                    <div className="lib-page__doc-prompt">
                      <span>{item.prompt || item.name}</span>
                    </div>
                  )}
                </button>
              )}
              <div className="lib-page__meta">
                <strong title={item.name}>{item.name}</strong>
                <span>{dateText(item.createdAt)}{item.sizeBytes ? ` · ${sizeText(item.sizeBytes)}` : ""}</span>
                {item.prompt && <span className="lib-page__prompt" title={item.prompt}>{item.prompt}</span>}
                {!item.available && <span className="lib-page__warn">This file is no longer stored.</span>}
              </div>
              <div className="lib-page__actions">
                {item.available && (
                  <button
                    type="button"
                    className="lib-page__action"
                    disabled={downloadingId === item.id}
                    onClick={() => handleDownload(item)}
                    aria-label={`Download ${item.name}`}
                  >
                    <Download size={16} aria-hidden="true" />
                    <span>{downloadingId === item.id ? "Downloading…" : "Download"}</span>
                  </button>
                )}
                {item.conversation && (
                  <button
                    type="button"
                    className="lib-page__action"
                    onClick={() => onOpenConversation?.(item.conversation.id, item.conversation.mode === "study" ? "study" : "chat")}
                    aria-label={`Open the chat for ${item.name}`}
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                    <span>Open chat</span>
                  </button>
                )}
                <button
                  type="button"
                  className="lib-page__action lib-page__action--danger"
                  onClick={() => { setRemoveError(""); setRemoving(item); }}
                  aria-label={`Delete ${item.name}`}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  <span>Delete</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "ready" && cursor && (
        <div className="lib-page__more"><button type="button" className="btn btn--secondary" disabled={more} onClick={() => void load({ append: true, after: cursor })}>{more ? "Loading…" : "Show more"}</button></div>
      )}

      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name ?? "Asset preview"} size="lg">
        {preview && (
          <div className="lib-page__viewer">
            {preview.kind === "image" ? (
              <div className="lib-page__viewer-img-wrap">
                {preview.available && preview.previewUrl ? (
                  <PrivateImage
                    src={preview.previewUrl}
                    alt={preview.prompt ? `Image made from: ${preview.prompt}` : preview.name}
                    className="lib-page__viewer-img"
                  />
                ) : (
                  <p className="lib-page__warn">This image file is no longer stored.</p>
                )}
              </div>
            ) : (
              <div className="lib-page__viewer-doc">
                <div className="lib-page__viewer-doc-meta">
                  <span className="lib-page__doc-badge">{docBadge(preview.name, preview.mimeType)}</span>
                  <span>{dateText(preview.createdAt)}{preview.sizeBytes ? ` · ${sizeText(preview.sizeBytes)}` : ""}</span>
                </div>
                {preview.previewText ? (
                  <pre className="lib-page__viewer-text-box">{preview.previewText}</pre>
                ) : (
                  <p className="lib-page__viewer-empty">This document does not have an inline text excerpt. Download the file to view its full contents.</p>
                )}
              </div>
            )}
            <div className="ui-modal__actions">
              {preview.available && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={downloadingId === preview.id}
                  onClick={() => handleDownload(preview)}
                >
                  <Download size={16} aria-hidden="true" />
                  {downloadingId === preview.id ? "Downloading…" : "Download"}
                </button>
              )}
              <button type="button" className="btn btn--secondary" onClick={() => setPreview(null)}>Close</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(removing)} onClose={() => !removeBusy && setRemoving(null)} title="Delete this file?" eyebrow="Library" description="It is deleted for good: from your Library and from the chat it came from. The chat's own messages stay. This cannot be undone." onSubmit={confirmRemove}>
        {removing && <p className="lib-page__remove-name">{removing.name}</p>}
        {removeError && <p className="note note--error" role="alert">{removeError}</p>}
        <div className="ui-modal__actions">
          <button type="button" className="btn btn--secondary" disabled={removeBusy} onClick={() => setRemoving(null)}>Cancel</button>
          <button type="submit" className="btn btn--danger" disabled={removeBusy}>{removeBusy ? "Deleting…" : "Delete"}</button>
        </div>
      </Modal>
    </main>
  );
}
