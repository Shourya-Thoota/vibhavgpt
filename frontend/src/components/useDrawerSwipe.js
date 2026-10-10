import { useEffect, useRef } from "react";

// How far a finger may wander before we decide what the gesture is, and how
// much more sideways than vertical it has to be to count as a drawer swipe.
const SLOP = 10;
const HORIZONTAL_BIAS = 1.3;
// A flick faster than this (px/ms) settles the drawer in its direction even
// when it has not crossed the halfway point.
const FLICK = 0.35;

// Anything that scrolls sideways or takes text keeps its own horizontal
// gestures: a code block, a wide table, a KaTeX line, the composer.
function ownsHorizontalGesture(node, root) {
  for (let el = node; el && el !== root; el = el.parentElement) {
    if (el.matches?.("input, textarea, select, [contenteditable='true']")) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}

/**
 * Lets the phone drawer follow the finger: a rightward swipe anywhere on the
 * page pulls it open, a leftward swipe on the open drawer or its scrim pushes
 * it closed. Swipes are not limited to the literal left edge because Android's
 * gesture navigation reserves that edge for system Back, both in the browser
 * and in the Capacitor WebView.
 *
 * The drawer is moved by writing its transform directly while the finger is
 * down, rather than through React state, so tracking never waits on a render.
 * On release the element is handed the final transform explicitly and the
 * inline styles are cleared once the class-driven state has caught up.
 */
export function useDrawerSwipe({ enabled, open, setOpen, rootRef }) {
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return undefined;
    let gesture = null;
    let settleTimer;

    const parts = () => ({ drawer: root.querySelector(".sidebar"), scrim: root.querySelector(".scrim-mobile") });

    const paint = (progress) => {
      const { drawer, scrim } = parts();
      if (!drawer) return;
      const width = drawer.offsetWidth;
      drawer.style.transition = "none";
      drawer.style.transform = `translateX(${(progress - 1) * width}px)`;
      if (scrim) {
        scrim.style.transition = "none";
        scrim.style.visibility = "visible";
        scrim.style.opacity = String(progress);
      }
    };

    const release = (nextOpen) => {
      const { drawer, scrim } = parts();
      for (const el of [drawer, scrim]) if (el) el.style.transition = "";
      if (drawer) drawer.style.transform = nextOpen ? "translateX(0)" : "translateX(-102%)";
      if (scrim) scrim.style.opacity = nextOpen ? "1" : "0";
      setOpen(nextOpen);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        for (const el of [drawer, scrim]) el?.style.removeProperty("transform");
        scrim?.style.removeProperty("opacity");
        scrim?.style.removeProperty("visibility");
      }, 320);
    };

    const onStart = (event) => {
      if (event.touches.length !== 1) { gesture = null; return; }
      const touch = event.touches[0];
      const target = event.target;
      if (openRef.current) {
        if (!target.closest?.(".sidebar, .scrim-mobile")) return;
      } else if (ownsHorizontalGesture(target, root)) {
        return;
      }
      gesture = { x: touch.clientX, y: touch.clientY, t: event.timeStamp, locked: false, from: openRef.current, progress: openRef.current ? 1 : 0, dx: 0 };
    };

    const onMove = (event) => {
      if (!gesture) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS;
        const towardChange = gesture.from ? dx < 0 : dx > 0;
        if (!sideways || !towardChange) { gesture = null; return; }
        gesture.locked = true;
        gesture.x = touch.clientX;
        gesture.t = event.timeStamp;
      }
      event.preventDefault();
      const width = parts().drawer?.offsetWidth || 1;
      const moved = touch.clientX - gesture.x;
      gesture.dx = moved;
      gesture.progress = Math.min(1, Math.max(0, (gesture.from ? 1 : 0) + moved / width));
      paint(gesture.progress);
    };

    const onEnd = (event) => {
      const current = gesture;
      gesture = null;
      if (!current?.locked) return;
      const velocity = current.dx / Math.max(1, event.timeStamp - current.t);
      const nextOpen = velocity > FLICK ? true : velocity < -FLICK ? false : current.progress > 0.5;
      release(nextOpen);
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: once a swipe is recognised as the drawer's, vertical
    // scrolling underneath it is suppressed for the rest of that touch.
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      clearTimeout(settleTimer);
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, rootRef, setOpen]);
}
