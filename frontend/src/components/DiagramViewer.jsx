import { useEffect, useId, useRef, useState } from "react";
import { Check, Code, Copy, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Modal } from "./ui.jsx";
import { mermaidThemeVariables, MERMAID_CONFIG } from "../diagrams.js";
import "../diagrams.css";

// How close to the visible area a diagram must come before mermaid loads and
// draws it, so a long chat full of diagrams only draws the ones being read.
export const NEAR_VIEW_MARGIN = "600px";
export const DIAGRAM_FAILED_NOTE = "Couldn't draw this diagram; showing its source.";

// The sky and the accent colour on <html>. Diagrams are drawn in resolved
// colours, so they are redrawn when either changes.
export const APPEARANCE_ATTRIBUTES = ["data-theme", "data-accent"];
export const appearanceKey = (doc = globalThis.document) =>
  APPEARANCE_ATTRIBUTES.map((name) => doc?.documentElement?.getAttribute(name) ?? "").join("|");

export function watchAppearance(onChange, { doc = globalThis.document, Observer = globalThis.MutationObserver } = {}) {
  if (!doc?.documentElement || typeof Observer !== "function") return () => {};
  const observer = new Observer(() => onChange(appearanceKey(doc)));
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES });
  return () => observer.disconnect();
}

// The nearest ancestor that scrolls (the chat thread), so the margin is
// measured against what the reader can actually see.
export function scrollRoot(node, view = globalThis.window) {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    const overflowY = view?.getComputedStyle?.(parent)?.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

// Calls onNear once, when the node comes within NEAR_VIEW_MARGIN of the
// visible area (at once where IntersectionObserver is missing). Returns the
// disconnect, for unmounting.
export function watchNearView(node, onNear, { Observer = globalThis.IntersectionObserver, root = null } = {}) {
  if (!node || typeof Observer !== "function") {
    onNear();
    return () => {};
  }
  const observer = new Observer((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    onNear();
  }, { root, rootMargin: NEAR_VIEW_MARGIN });
  observer.observe(node);
  return () => observer.disconnect();
}

// One attempt at drawing: load mermaid, check the syntax, render. Anything
// mermaid can't draw throws, after its leftover error graphic is cleared.
// Nothing here retries; a new attempt needs new source or new colours.
export async function drawDiagram({ id, source, doc = globalThis.document, load = () => import("mermaid") }) {
  try {
    const { default: mermaid } = await load();
    mermaid.initialize({ ...MERMAID_CONFIG, themeVariables: mermaidThemeVariables(doc) });
    if (!(await mermaid.parse(source, { suppressErrors: true }))) throw new Error("invalid");
    const { svg } = await mermaid.render(id, source);
    return svg;
  } catch (error) {
    // Mermaid can leave its error graphic behind; nothing of it is shown.
    doc?.getElementById?.(id)?.remove();
    doc?.getElementById?.(`d${id}`)?.remove();
    throw error;
  }
}

// A ```mermaid block in a reply, drawn as an SVG diagram. Mermaid loads only
// when a reply has a diagram, and draws it only once it is close to view.
// While the reply is still arriving the block is a placeholder; once it has
// arrived, syntax mermaid can't read is shown as the ordinary code block with
// a note, and the source always stays in the reply itself, so any model can
// read and change it in a later turn.
export default function DiagramViewer({ source, settled = true, fallback = null }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const holderRef = useRef(null);
  const [state, setState] = useState({ status: "pending", svg: "" });
  const [appearance, setAppearance] = useState(() => appearanceKey());
  const [near, setNear] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Redraw in the new colours when the sky or the accent changes.
  useEffect(() => watchAppearance(setAppearance), []);

  // Wait until the diagram is close to view; the watcher goes with the reply.
  useEffect(() => {
    if (!settled || near) return undefined;
    const node = holderRef.current;
    return watchNearView(node, () => setNear(true), { root: scrollRoot(node) });
  }, [settled, near]);

  useEffect(() => {
    if (!settled || !near) return undefined;
    let cancelled = false;
    drawDiagram({ id, source })
      .then((svg) => { if (!cancelled) setState({ status: "ready", svg }); })
      .catch(() => { if (!cancelled) setState({ status: "error", svg: "" }); });
    return () => { cancelled = true; };
  }, [source, settled, near, appearance, id]);

  if (!settled) return <div className="diagram-viewer diagram-viewer--pending" role="status">Drawing your diagram...</div>;
  if (state.status === "error") return <DiagramFailed fallback={fallback} />;

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
    <figure ref={holderRef} className="diagram-viewer" data-status={state.status}>
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
      {state.status === "ready" && <DiagramSource shown={showSource} onToggle={() => setShowSource((shown) => !shown)} fallback={fallback} />}
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

// Under a drawn diagram: the original block, with its own Copy button, on request.
export function DiagramSource({ shown, onToggle, fallback }) {
  return (
    <>
      <div className="diagram-viewer__source-bar">
        <button type="button" className="diagram-viewer__action" aria-expanded={shown} onClick={onToggle}>
          <Code size={14} strokeWidth={1.9} /> {shown ? "Hide source" : "Show source"}
        </button>
      </div>
      {shown && <div className="diagram-viewer__source">{fallback}</div>}
    </>
  );
}

// A diagram mermaid couldn't draw: a short note, then the ordinary code block.
export function DiagramFailed({ fallback }) {
  return (
    <div className="diagram-viewer-failed">
      <p className="diagram-viewer-failed__note" role="note">{DIAGRAM_FAILED_NOTE}</p>
      {fallback}
    </div>
  );
}

// Mermaid's own sanitised output (securityLevel "strict") placed in the page.
function SvgFrame({ svg, className, style }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.innerHTML = svg; }, [svg]);
  return <div ref={ref} className={className} style={style} />;
}
