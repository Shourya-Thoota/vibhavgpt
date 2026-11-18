// The live preview inside Build's project card (owner request, 2026-11-15; build-preview.js has the isolation rules). When Preview is
// opened it asks the API to bundle the saved version's files (the app's policy does not allow a bundler in the page: WebAssembly is not
// permitted, and the policy is not loosened for this), then runs the result in a sandboxed iframe: allow-scripts only, never
// allow-same-origin, so the code has an opaque origin and cannot reach this page, its cookies or storage; its own policy blocks all network.
// Errors from inside the preview are shown under it. Closing Preview removes the iframe, which stops the code.
import { useEffect, useRef, useState } from "react";
import { RotateCw, Square } from "lucide-react";
import { API_BASE } from "../api.js";
import { PreviewError, withPreviewRuntime } from "../build-preview.js";

let runtimeText = null;
async function loadRuntime() {
  runtimeText ??= fetch("/preview/runtime.js", { credentials: "omit" }).then((response) => {
    if (!response.ok) throw new PreviewError("The preview's React runtime couldn't be loaded.");
    return response.text();
  }).catch((error) => { runtimeText = null; throw error; });
  return runtimeText;
}

export default function BuildPreview({ project, projectId, title }) {
  const [state, setState] = useState({ status: "building", html: "", error: "" });
  const [errors, setErrors] = useState([]);
  const [run, setRun] = useState(0);
  const frameRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "building", html: "", error: "" });
    setErrors([]);
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/build/projects/${encodeURIComponent(projectId)}/revisions/${project.revision}/preview`, { credentials: "include" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new PreviewError(body.error || "The preview couldn't be built. Download the ZIP to run the project yourself.");
        const html = body.runtime ? withPreviewRuntime(body.html, await loadRuntime()) : body.html;
        if (!cancelled) setState({ status: "ready", html, error: "" });
      } catch (error) {
        if (!cancelled) setState({ status: "failed", html: "", error: error instanceof PreviewError ? error.message : "The preview couldn't be built. Download the ZIP to run the project yourself." });
      }
    })();
    return () => { cancelled = true; };
  }, [project.revision, project.kind, project.entry, run, projectId]);

  // Errors reported from inside the preview: only from this preview's own frame, kept short, at most 20.
  useEffect(() => {
    const onMessage = (event) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      if (event.data?.vgPreview !== "error") return;
      setErrors((current) => (current.length >= 20 ? current : [...current, String(event.data.message ?? "").slice(0, 500)]));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="build-preview">
      <div className="build-preview__bar">
        <span className="build-preview__status" role="status">
          {state.status === "building" ? "Building the preview…" : state.status === "failed" ? "Preview unavailable" : project.kind === "model" ? `Showing version ${project.revision} in 3D, in a sandbox` : `Running version ${project.revision} in a sandbox`}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRun((value) => value + 1)} disabled={state.status === "building"}>
          <RotateCw size={14} aria-hidden="true" /> Reload
        </button>
      </div>
      {state.status === "failed" && <p className="build-preview__error" role="alert">{state.error}</p>}
      {state.status === "ready" && (
        <iframe
          ref={frameRef}
          key={run}
          className="build-preview__frame"
          title={`Live preview of ${title}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={state.html}
        />
      )}
      {errors.length > 0 && (
        <div className="build-preview__errors" role="log" aria-label="Errors from the preview">
          <strong>From the preview</strong>
          <ul>{errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
        </div>
      )}
      <p className="build-preview__note">
        <Square size={11} aria-hidden="true" /> Runs in an isolated sandbox in this browser: it can&apos;t reach your account or the network. It shows how the code behaves here, not that it was tested.
      </p>
    </div>
  );
}
