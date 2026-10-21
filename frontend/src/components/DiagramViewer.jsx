import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Modal } from "./ui.jsx";
import { mermaidThemeVariables, MERMAID_CONFIG } from "../diagrams.js";
import "../diagrams.css";

// A ```mermaid block in a reply, drawn as an SVG diagram. Mermaid loads only
// when a reply has a diagram. While the reply is still arriving the block is
// a placeholder; once it has arrived, syntax mermaid can't read is shown as
// the ordinary code block instead, and the source always stays in the reply
// itself, so any model can read and change it in a later turn.
export default function DiagramViewer({ source, settled = true, fallback = null }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [state, setState] = useState({ status: "pending", svg: "" });
  const [theme, setTheme] = useState(() => (typeof document === "undefined" ? "" : document.documentElement.getAttribute("data-theme") ?? ""));
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Redraw in the new colours when the sky changes.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.getAttribute("data-theme") ?? ""));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!settled) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ ...MERMAID_CONFIG, themeVariables: mermaidThemeVariables(document) });
        if (!(await mermaid.parse(source, { suppressErrors: true }))) throw new Error("invalid");
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setState({ status: "ready", svg });
      } catch {
        // Mermaid can leave its error graphic behind; nothing of it is shown.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setState({ status: "error", svg: "" });
      }
    })();
    return () => { cancelled = true; };
  }, [source, settled, theme, id]);

  if (!settled) return <div className="diagram-viewer diagram-viewer--pending" role="status">Drawing your diagram...</div>;
  if (state.status === "error") return fallback;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <figure className="diagram-viewer" data-status={state.status}>
      <div className="diagram-viewer__toolbar">
        <span className="diagram-viewer__label">Diagram</span>
        <button type="button" className="diagram-viewer__action" onClick={copy}>
          {copied ? <Check size={14} strokeWidth={2.3} /> : <Copy size={14} strokeWidth={1.9} />} {copied ? "Copied" : "Copy source"}
        </button>
        <button type="button" className="diagram-viewer__action" disabled={state.status !== "ready"} onClick={() => { setZoom(1); setFullscreen(true); }}>
          <Maximize2 size={14} strokeWidth={1.9} /> Full screen
        </button>
      </div>
      {state.status === "ready"
        ? <SvgFrame className="diagram-viewer__canvas" svg={state.svg} />
        : <div className="diagram-viewer__canvas diagram-viewer__canvas--loading" role="status">Drawing your diagram...</div>}
      <Modal open={fullscreen} onClose={() => setFullscreen(false)} title="Diagram" size="lg">
        <div className="diagram-viewer__zoom" role="group" aria-label="Zoom">
          <button type="button" className="diagram-viewer__action" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><Minus size={14} /></button>
          <span className="diagram-viewer__zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="diagram-viewer__action" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><Plus size={14} /></button>
          <button type="button" className="diagram-viewer__action" onClick={() => setZoom(1)}><RotateCcw size={14} /> Reset</button>
        </div>
        <div className="diagram-viewer__stage">
          <SvgFrame className="diagram-viewer__zoomed" svg={state.svg} style={{ scale: String(zoom) }} />
        </div>
      </Modal>
    </figure>
  );
}

// Mermaid's own sanitised output (securityLevel "strict") placed in the page.
function SvgFrame({ svg, className, style }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.innerHTML = svg; }, [svg]);
  return <div ref={ref} className={className} style={style} />;
}
