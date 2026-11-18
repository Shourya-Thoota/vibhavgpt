import { lazy, Suspense, useEffect, useState } from "react";
import { readEnvironment, resolveReducedMotion, topographyProfile } from "../chat-topography.js";
import "../chat-topography.css";

// The drawing code is large, so it is fetched on demand only when a background is on (Chat, or Study if chosen), never for Image or a device that opts out.
const Topography = lazy(() => import("./Topography.jsx"));

const QUERIES = ["(prefers-reduced-motion: reduce)", "(pointer: coarse)", "(max-width: 760px)"];

/**
 * The decorative layer behind Chat. It is aria-hidden, takes no pointer events, and is removed (its drawing loop and listeners are
 * released by the component's own cleanup) when it unmounts. It follows the reader's motion setting and the device live.
 */
export function ChatTopography({ resolved, motion = "system" }) {
  const [environment, setEnvironment] = useState(() => readEnvironment());
  useEffect(() => {
    const lists = QUERIES.map((query) => { try { return window.matchMedia(query); } catch { return null; } }).filter(Boolean);
    const update = () => setEnvironment(readEnvironment());
    lists.forEach((list) => list.addEventListener?.("change", update));
    return () => lists.forEach((list) => list.removeEventListener?.("change", update));
  }, []);

  const reducedMotion = resolveReducedMotion(motion, environment.reducedMotion);
  const profile = topographyProfile({ ...environment, reducedMotion, resolved, allowMotion: motion === "full" });
  if (!profile.enabled) return null;
  return (
    <div className="chat-topography" aria-hidden="true" data-interactive={profile.interactive || undefined}>
      <Suspense fallback={null}>
        <Topography key={profile.still ? "still" : "moving"} {...profile.props} reduceMotion={profile.still} />
      </Suspense>
    </div>
  );
}
