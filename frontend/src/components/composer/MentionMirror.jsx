import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { draftSegments } from "../../composer-mentions.js";

// The highlight behind a mention. The text itself is still drawn by the textarea (so the caret, selection and typing are the browser's own);
// this layer sits behind it, draws the same text in the same place in transparent ink, and gives only the mention a soft background. It takes
// every measurement that affects where a letter lands from the textarea as it is right now, at every size, so the two cannot drift apart.
const COPIED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "boxSizing", "whiteSpace", "wordBreak", "overflowWrap", "direction", "textAlign",
];

export default function MentionMirror({ inputRef, text, mentions }) {
  const mirror = useRef(null);

  const sync = useCallback(() => {
    const input = inputRef.current;
    const layer = mirror.current;
    if (!input || !layer) return;
    const computed = getComputedStyle(input);
    for (const property of COPIED) layer.style[property] = computed[property];
    layer.style.left = `${input.offsetLeft}px`;
    layer.style.top = `${input.offsetTop}px`;
    layer.style.width = `${input.offsetWidth}px`;
    layer.style.height = `${input.offsetHeight}px`;
    // A scrollbar on the textarea narrows its text; the layer reserves the same width so lines wrap in the same places.
    const bars = Math.max(0, input.offsetWidth - input.clientWidth - parseFloat(computed.borderLeftWidth || 0) - parseFloat(computed.borderRightWidth || 0));
    layer.style.paddingRight = `${parseFloat(computed.paddingRight || 0) + bars}px`;
    layer.scrollTop = input.scrollTop;
  }, [inputRef]);

  useLayoutEffect(sync);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    input.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    observer?.observe(input);
    return () => {
      input.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      observer?.disconnect();
    };
  }, [inputRef, sync]);

  return (
    <div ref={mirror} className="composer__mirror" aria-hidden="true">
      {draftSegments(text, mentions).map((segment, index) => (segment.mention
        ? <mark key={index} className="composer__mention" data-connector={segment.mention.id}>{segment.text}</mark>
        : <span key={index}>{segment.text}</span>))}
      {"​"}
    </div>
  );
}
