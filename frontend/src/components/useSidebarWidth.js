import { useLayoutEffect, useRef } from "react";
import { createSpring, prefersReducedMotion, SPRINGS } from "../motion/spring.js";

/**
 * Collapses and expands the desktop sidebar on a spring instead of a CSS
 * transition. A grid-track transition does not reliably reverse from where it
 * is: pressing the toggle again mid-collapse made the column jump in every
 * engine we test. The spring always continues from its current width and
 * velocity, so a reversal is one smooth motion.
 *
 * The stylesheet stays the source of truth for the two resting widths
 * (--sidebar-w, overridden for [data-collapsed="true"]); this only animates
 * between them and hands the column back to CSS once it settles.
 */
export function useSidebarWidth({ rail, narrow, workspaceRef }) {
  const spring = useRef(null);
  const rest = useRef(null);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    // React has already written the new data-collapsed, so this is where the
    // column is going.
    const target = parseFloat(getComputedStyle(workspace).getPropertyValue("--sidebar-w"));
    const handBack = (width) => { rest.current = width; workspace.style.removeProperty("grid-template-columns"); };
    if (rest.current === null || narrow || !Number.isFinite(target)) {
      spring.current?.stop();
      handBack(target);
      return;
    }
    const from = spring.current?.running ? spring.current.value : rest.current;
    if (Math.abs(target - from) < 0.5) return;
    if (prefersReducedMotion()) { spring.current?.stop(); handBack(target); return; }
    const paint = (width) => { workspace.style.gridTemplateColumns = `${width}px minmax(0, 1fr)`; };
    if (!spring.current) spring.current = createSpring({ onUpdate: paint, onRest: handBack });
    // At rest, start from the old width this same frame, before the new CSS
    // width can paint; mid-motion, `to` simply retargets.
    if (!spring.current.running) { spring.current.set(from); paint(from); }
    spring.current.to(target, SPRINGS.standard);
  }, [rail, narrow, workspaceRef]);

  useLayoutEffect(() => () => spring.current?.stop(), []);
}
