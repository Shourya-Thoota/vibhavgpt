import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ScanSearch, Wand2 } from "lucide-react";
import { Segmented } from "./ui.jsx";
import "../writing-tools.css";

// Writing Tools in Study mode: Clever AI's Detector and Humanizer, embedded
// as sandboxed frames with their own attribution showing. Clever's loader
// script is never run on this page; the one thing it does that the frames
// need, reporting the widget's height so nothing is clipped, is handled here.
export const WIDGET_ORIGIN = "https://widgets.cleverhumanizer.ai";
export const WIDGETS = [
  { tab: "detector", id: "95f9d2d141d74ec580880c266b813f7b", title: "AI Detector" },
  { tab: "humanizer", id: "1e5f37671c4f49c696409a6a12345c5f", title: "AI Humanizer" },
];
export const embedUrl = (id) => `${WIDGET_ORIGIN}/embed/${id}?theme=light`;
const INITIAL_HEIGHT = 600;

function WidgetFrame({ widget, visible }) {
  const frame = useRef(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  useEffect(() => {
    const node = frame.current;
    if (!node) return undefined;
    // A random channel per frame, so only this frame's messages are accepted.
    const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
    const init = () => node.contentWindow?.postMessage({ type: "clever:init", channel, scheme: "light" }, WIDGET_ORIGIN);
    const receive = (event) => {
      if (event.source !== node.contentWindow || event.origin !== WIDGET_ORIGIN || event.data?.channel !== channel || event.data?.type !== "clever:resize") return;
      const next = event.data.height;
      if (Number.isFinite(next) && next >= 100 && next <= 20000) setHeight(next);
    };
    node.addEventListener("load", init);
    window.addEventListener("message", receive);
    return () => {
      node.removeEventListener("load", init);
      window.removeEventListener("message", receive);
    };
  }, []);
  // Both frames stay mounted; the hidden one is only display:none, so
  // switching tabs never reloads a frame or loses what was typed in it.
  return (
    <div className="writing-tools-widget-wrapper" style={{ display: visible ? "block" : "none" }} data-tab={widget.tab}>
      <iframe
        ref={frame}
        src={embedUrl(widget.id)}
        title={widget.title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="clipboard-write"
        referrerPolicy="origin"
        style={{ width: "100%", height: `${height}px`, border: "none", display: "block" }}
      />
    </div>
  );
}

export default function StudyWritingTools({ onBack }) {
  const [tab, setTab] = useState("detector");
  return (
    <section className="writing-tools" aria-label="Writing Tools">
      <header className="writing-tools__header">
        {onBack && <button type="button" className="btn btn--secondary writing-tools__back" onClick={onBack}><ArrowLeft size={15} />Back to Study</button>}
        <p className="writing-tools__eyebrow">VibhavGPT Writing Tools</p>
        <h2 className="writing-tools__title">{tab === "detector" ? "AI Detector" : "AI Humanizer"}</h2>
        <Segmented label="Writing tool" value={tab} onChange={setTab} options={[
          { value: "detector", label: "AI Detector", icon: <ScanSearch size={15} /> },
          { value: "humanizer", label: "AI Humanizer", icon: <Wand2 size={15} /> },
        ]} />
      </header>
      {WIDGETS.map((widget) => <WidgetFrame key={widget.tab} widget={widget} visible={tab === widget.tab} />)}
      <p className="writing-tools__notice">Writing tools run via Clever AI. Text processed through these tools is handled according to provider guidelines and does not affect your VibhavGPT chat history.</p>
    </section>
  );
}
