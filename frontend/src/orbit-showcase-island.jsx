// The model showcase on the static homepage, as a lazily loaded island.
//
// home-effects-boot.ts finds the element marked data-home-effect="orbit-showcase" and, when it is about to be seen, loads
// home-effects.tsx, whose mountHomeEffect() imports this file. GSAP comes with this file and nowhere else, so it is a chunk of
// its own: it is not in the page's first paint, in the logo's code, or in the app.
//
// The static page already holds the same five models as plain HTML (orbit-showcase-fallback.jsx, made at build time from the
// same data). Mounting replaces that with the interactive stage. Without script, for readers who asked to save data, and if
// this file fails to load, the plain list stays.
//
// The wording follows the server, as every other credits wording on the site does: the page starts from what the build was
// made with and, once GET /api/usage/policy answers, shows what the server enforces (see credits-runtime.js). A rollback or
// an activation on the server therefore reaches this section without a frontend deploy.

import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { OrbitShowcase } from "@/components/ui/orbit-showcase";
import { ORBIT_ACTIONS, ORBIT_SCROLL_PER_SLIDE, ORBIT_STICKY_TOP, orbitSlides } from "./orbit-showcase-data.js";
import { API_BASE } from "./api.js";
import { applyServerCreditsPolicy, useCreditsMode } from "./credits-runtime.js";

// The same API host the page's own script uses for /api/me: the build's, else api.<this host>, else same-origin on localhost.
function apiBase() {
  if (API_BASE) return API_BASE;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "";
  return `https://api.${location.hostname.replace(/^www\./, "")}`;
}

async function syncPolicy() {
  try {
    // Public and read-only: no credentials, no account data.
    const response = await fetch(`${apiBase()}/api/usage/policy`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (response.ok) applyServerCreditsPolicy(await response.json());
  } catch {
    // Unreachable: the wording the build was made with stands.
  }
}

function Island({ element }) {
  const mode = useCreditsMode();
  const slides = useMemo(() => orbitSlides(mode), [mode]);
  // "live" means mounted and committed, not "render() was called", as for the logo effect.
  useEffect(() => {
    element.dataset.homeEffectState = "live";
    void syncPolicy();
    window.addEventListener("focus", syncPolicy);
    return () => window.removeEventListener("focus", syncPolicy);
  }, [element]);
  return (
    <OrbitShowcase
      slides={slides}
      actions={ORBIT_ACTIONS}
      loop={false}
      ariaLabel="VibhavGPT models"
      height={`calc(100svh - ${ORBIT_STICKY_TOP}px)`}
      stickyTop={ORBIT_STICKY_TOP}
      scrollPerSlide={ORBIT_SCROLL_PER_SLIDE}
    />
  );
}

export function mountOrbitShowcase(element) {
  createRoot(element).render(<Island element={element} />);
}
