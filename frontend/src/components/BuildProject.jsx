// Build's project card (owner request, 2026-11-15): the project Tecton saved for this conversation, its files, real downloads, its versions,
// and a live Preview (BuildPreview.jsx: bundled in this browser and run in a sandboxed iframe that cannot reach this page or the network).
import { lazy, Suspense, useEffect, useState } from "react";
import { Code2, Download, Eye, FileText, History, X } from "lucide-react";
import { API_BASE, api } from "../api.js";

const BuildPreview = lazy(() => import("./BuildPreview.jsx"));

const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
const fileUrl = (projectId, revision, filePath, view = false) => `${API_BASE}/api/build/projects/${encodeURIComponent(projectId)}/revisions/${revision}/file?path=${encodeURIComponent(filePath)}${view ? "&view=1" : ""}`;

export default function BuildProject({ conversationId, refreshKey = 0 }) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [tab, setTab] = useState("files");

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) { setProject(null); return undefined; }
    api(`/api/build/conversations/${encodeURIComponent(conversationId)}/project`)
      .then((result) => { if (!cancelled) { setProject(result.project); setError(""); } })
      .catch(() => { if (!cancelled) setError("The project couldn't be loaded."); });
    return () => { cancelled = true; };
  }, [conversationId, refreshKey]);

  async function view(file) {
    setViewing({ path: file.path, text: null });
    try {
      const response = await fetch(fileUrl(project.id, project.current.revision, file.path, true), { credentials: "include" });
      if (!response.ok) throw new Error();
      const text = await response.text();
      setViewing({ path: file.path, text });
    } catch {
      setViewing({ path: file.path, text: null, failed: true });
    }
  }

  async function restore(revision) {
    setRestoring(true);
    try {
      await api(`/api/build/projects/${encodeURIComponent(project.id)}/restore`, { method: "POST", body: JSON.stringify({ revision }) });
      const result = await api(`/api/build/conversations/${encodeURIComponent(conversationId)}/project`);
      setProject(result.project);
    } catch (err) {
      setError(err.message || "That version couldn't be restored.");
    } finally {
      setRestoring(false);
    }
  }

  if (error && !project) return <p className="build-project__error" role="status">{error}</p>;
  if (!project?.current) return null;
  const { current } = project;
  const zipUrl = `${API_BASE}/api/build/projects/${encodeURIComponent(project.id)}/revisions/${current.revision}/zip`;
  return (
    <section className="build-project" aria-label="Project files">
      <header className="build-project__head">
        <div>
          <strong>{project.title}</strong>
          <small>Version {current.revision}{current.restoredFrom ? ` (restored from ${current.restoredFrom})` : ""} · {current.files.length} {current.files.length === 1 ? "file" : "files"} · {kb(current.totalBytes)}</small>
        </div>
        <a className="btn btn--primary build-project__zip" href={zipUrl} download>
          <Download size={16} aria-hidden="true" /> Download ZIP
        </a>
      </header>
      <div className="build-project__tabs" role="tablist" aria-label="Project view">
        <button type="button" role="tab" id="build-tab-files" aria-controls="build-panel-files" aria-selected={tab === "files"} onClick={() => setTab("files")}><Code2 size={14} aria-hidden="true" /> Files</button>
        <button type="button" role="tab" id="build-tab-preview" aria-controls="build-panel-preview" aria-selected={tab === "preview"} onClick={() => setTab("preview")}><Eye size={14} aria-hidden="true" /> Preview</button>
      </div>
      {tab === "preview" && (
        <div role="tabpanel" id="build-panel-preview" aria-labelledby="build-tab-preview">
          <Suspense fallback={<p className="build-preview__status" role="status">Loading the preview…</p>}>
            <BuildPreview project={{ revision: current.revision, kind: current.kind ?? project.kind, entry: current.entry }} projectId={project.id} title={project.title} />
          </Suspense>
        </div>
      )}
      {tab === "files" && <div role="tabpanel" id="build-panel-files" aria-labelledby="build-tab-files">
      <p className="build-project__note">{(current.kind ?? project.kind) === "model"
        ? <>Model saved. Open Preview to turn it in 3D here, or download {current.entry} for your slicer or 3D app; check it there before printing.</>
        : <>Files created. Open Preview to run them in an isolated sandbox here, or download the ZIP and open {current.entry}.</>}</p>
      <ul className="build-project__files" aria-label="Files">
        {current.files.map((file) => (
          <li key={file.path}>
            <FileText size={14} aria-hidden="true" />
            <span className="build-project__path">{file.path}{file.path === current.entry ? <em> · entry</em> : null}</span>
            <small>{kb(file.bytes)}</small>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => view(file)}>View</button>
            <a className="btn btn--ghost btn--sm" href={fileUrl(project.id, current.revision, file.path)} download aria-label={`Download ${file.path}`}>Download</a>
          </li>
        ))}
      </ul>
      {project.revisions.length > 1 && (
        <details className="build-project__versions">
          <summary><History size={14} aria-hidden="true" /> Versions ({project.revisions.length})</summary>
          <ol>
            {[...project.revisions].reverse().map((entry) => (
              <li key={entry.revision}>
                <span>Version {entry.revision} · {entry.files} files{entry.restoredFrom ? ` · restored from ${entry.restoredFrom}` : ""}</span>
                {entry.revision !== current.revision && (
                  <button type="button" className="btn btn--ghost btn--sm" disabled={restoring} onClick={() => restore(entry.revision)}>Restore</button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      </div>}
      {error && <p className="build-project__error" role="alert">{error}</p>}
      {viewing && (
        <div className="build-project__viewer" role="dialog" aria-label={`Source of ${viewing.path}`}>
          <div className="build-project__viewer-head">
            <strong>{viewing.path}</strong>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setViewing(null)} aria-label="Close source"><X size={16} aria-hidden="true" /></button>
          </div>
          {viewing.failed ? <p>That file couldn&apos;t be loaded.</p> : viewing.text === null ? <p>Loading…</p> : <pre><code>{viewing.text}</code></pre>}
        </div>
      )}
    </section>
  );
}
