// Build's background (owner request, 2026-11-15): React Bits Threads, with the owner's exact settings, behind Build's content only.
// Decorative: hidden from assistive technology, never focusable, never takes a click, a touch, a scroll or a selection. Loaded only when
// Build is on screen (a separate chunk). While it loads, or where WebGL2 is unavailable, a shader fails or the GPU context is lost, a still
// picture of the same blue threads is shown instead of an empty box. Reduced motion (the app's setting, which follows the device and
// changes without a reload) holds the threads still.
import { lazy, Suspense, useState } from "react";

const Threads = lazy(() => import("./Threads.jsx"));

// The owner's settings, exactly.
const SETTINGS = Object.freeze({
  color: "#137eef",
  lineCount: 90,
  thickness: 0.6,
  softness: 1.3,
  amplitude: 1.7,
  distance: 0.4,
  waves: 1.05,
  speed: 0.6,
  split: 0.04,
  fray: 0.5,
  angle: 25,
  taper: 0.85,
  brightness: 1.4,
  parting: 0,
  enableMouseInteraction: true,
  fade: 0,
  opacity: 1,
});

// A still picture of the threads: a fan of thin blue curves along the same 25° line, for when the moving version cannot run.
function StillThreads() {
  const curves = Array.from({ length: 18 }, (_, i) => {
    const spread = (i - 8.5) * 9;
    return `M -40 ${300 + spread * 0.2} C 260 ${300 + spread * 0.4}, 520 ${250 + spread * 1.6}, 840 ${300 + spread * 2.4}`;
  });
  return (
    <svg className="build-threads__still" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" focusable="false">
      <g transform="rotate(-25 400 300)" fill="none" stroke="#137eef" strokeLinecap="round">
        {curves.map((d, i) => <path key={i} d={d} strokeWidth={i % 3 === 0 ? 1.4 : 0.8} strokeOpacity={0.85 - i * 0.035} />)}
      </g>
    </svg>
  );
}

export default function BuildThreads({ reducedMotion = false }) {
  const [unavailable, setUnavailable] = useState(false);
  return (
    <div className="build-threads" aria-hidden="true" data-state={unavailable ? "still" : "live"}>
      {unavailable ? <StillThreads /> : (
        <Suspense fallback={<StillThreads />}>
          <Threads {...SETTINGS} reducedMotion={reducedMotion} onUnavailable={() => setUnavailable(true)} />
        </Suspense>
      )}
    </div>
  );
}

export { SETTINGS as BUILD_THREADS_SETTINGS };
