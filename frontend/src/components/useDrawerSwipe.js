import { useEffect, useRef } from "react";
import { createSpring, createVelocityTracker, project, rubberband, prefersReducedMotion, SPRINGS } from "../motion/spring.js";

// How far a finger may wander before we decide what the gesture is, and how
// much more sideways than vertical it has to be to count as a drawer swipe.
const SLOP = 10;
const HORIZONTAL_BIAS = 1.3;

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
 * Fluid-interface rules (the Apple Design skill):
 * - The drawer tracks the finger 1:1 from where it was grabbed, by writing
 *   its transform directly, never through React state.
 * - Past the open edge it resists progressively instead of stopping hard.
 * - On release, the last ~90ms of samples give the velocity; the drawer's
 *   resting place is projected from it (like a scroll view decelerating),
 *   and the nearer of open or closed to that projection wins.
 * - A spring carries the finger's velocity into the settle, so there is no
 *   seam between dragging and animating; a flung drawer gets a little give.
 * - Touching the drawer while it is still settling catches it where it is,
 *   on screen, and the new drag continues from there.
 * Without a finger, opening and closing stay the CSS transitions on the
 * drawer's state class, so the menu button, Escape and the scrim behave as
 * before.
 */
export function useDrawerSwipe({ enabled, open, setOpen, rootRef }) {
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return undefined;
    let gesture = null;
    const velocity = createVelocityTracker();

    const parts = () => ({ drawer: root.querySelector(".sidebar"), scrim: root.querySelector(".scrim-mobile") });
    const width = () => parts().drawer?.offsetWidth || 1;

    // x is the drawer's left edge offset: -width is closed (the stylesheet's
    // translateX(-100%)), 0 is open.
    const paint = (x) => {
      const { drawer, scrim } = parts();
      if (!drawer) return;
      drawer.style.transition = "none";
      drawer.style.transform = `translateX(${x}px)`;
      if (scrim) {
        scrim.style.transition = "none";
        scrim.style.visibility = "visible";
        scrim.style.opacity = String(Math.min(1, Math.max(0, 1 + x / width())));
      }
    };
    // Once settled, hand control back to the state classes (which now agree).
    const handBack = () => {
      const { drawer, scrim } = parts();
      for (const el of [drawer, scrim]) { el?.style.removeProperty("transition"); el?.style.removeProperty("transform"); }
      scrim?.style.removeProperty("opacity");
      scrim?.style.removeProperty("visibility");
    };
    const spring = createSpring({ onUpdate: paint, onRest: handBack });

    // Where the drawer actually is on screen right now.
    const visibleX = () => {
      const drawer = parts().drawer;
      if (!drawer) return openRef.current ? 0 : -width();
      if (spring.running) return spring.value;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(drawer).transform === "none" ? undefined : getComputedStyle(drawer).transform);
      return matrix.m41;
    };

    const onStart = (event) => {
      if (event.touches.length !== 1) { gesture = null; return; }
      const touch = event.touches[0];
      const target = event.target;
      const moving = spring.running;
      if (openRef.current || moving) {
        if (!moving && !target.closest?.(".sidebar, .scrim-mobile")) return;
      } else if (ownsHorizontalGesture(target, root)) {
        return;
      }
      // A drawer that is still settling is caught where it is.
      const startX = visibleX();
      if (moving) { spring.stop(); paint(startX); }
      gesture = { x: touch.clientX, y: touch.clientY, startX, locked: moving, caught: moving };
      velocity.reset();
      velocity.add(touch.clientX, event.timeStamp);
    };

    const onMove = (event) => {
      if (!gesture) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS;
        const towardChange = openRef.current ? dx < 0 : dx > 0;
        if (!sideways || !towardChange) { gesture = null; return; }
        gesture.locked = true;
        // Track from here, so the drawer does not jump by the slop distance.
        gesture.x = touch.clientX;
      }
      event.preventDefault();
      velocity.add(touch.clientX, event.timeStamp);
      const w = width();
      let x = gesture.startX + (touch.clientX - gesture.x);
      if (x > 0) x = rubberband(x, w);
      else if (x < -w) x = -w + rubberband(x + w, w);
      gesture.lastX = x;
      paint(x);
    };

    const onEnd = () => {
      const current = gesture;
      gesture = null;
      if (!current?.locked) {
        // A caught drawer that was simply let go finishes where it was going.
        if (current?.caught) settle(visibleX(), 0);
        return;
      }
      settle(current.lastX ?? current.startX, velocity.velocity);
    };

    function settle(x, v) {
      const w = width();
      const projected = Math.min(w, Math.max(-2 * w, x + project(v)));
      const nextOpen = projected > -w / 2;
      const target = nextOpen ? 0 : -w;
      setOpen(nextOpen);
      if (prefersReducedMotion()) { spring.set(target); paint(target); handBack(); return; }
      spring.set(x);
      spring.to(target, { velocity: v, ...(Math.abs(v) > 400 ? SPRINGS.thrown : SPRINGS.standard) });
    }

    root.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: once a swipe is recognised as the drawer's, vertical
    // scrolling underneath it is suppressed for the rest of that touch.
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      spring.stop();
      handBack();
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, rootRef, setOpen]);
}
