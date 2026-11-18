import * as React from "react";
import { createRoot } from "react-dom/client";

import "./home-effects.css";
import { GlassRevealVibhavGPT } from "@/components/ui/liquid-glass-logo-reveal";

// The supplied glass logo on the static homepage. The page itself is plain
// HTML (public/home/index.html); home-effects-boot.ts loads this module only
// when an element marked data-home-effect is about to be seen, and each such
// element gets its own small React root. Everything outside those elements is
// unchanged.

type Theme = "light" | "dark";

// The page records its resolved sky on <html data-theme>; appearance-boot.js
// keeps it current (a stored choice, another tab, the system setting).
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  return () => observer.disconnect();
}
const currentTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const useTheme = () => React.useSyncExternalStore(subscribe, currentTheme, () => "dark" as Theme);
// The accent, so the glass backdrop is repainted when the reader picks another.
const currentAccent = () => document.documentElement.dataset.accent ?? "";
const useAccent = () => React.useSyncExternalStore(subscribe, currentAccent, () => "");

// The glass paints its own backdrop on a canvas, so that colour has to match the page. The page is a gradient in the selected
// accent, so there is no single colour to read: the theme names one instead (--wash-stage, a flat colour close to the wash where
// the logo sits) and the stage's CSS mask fades the canvas into the page. The token is a colour mix, so the browser resolves it:
// a probe element takes it as its background, and the browser's own colour handling turns that into pixels: the colour is painted
// onto a one-pixel canvas and read back, which works whatever form the browser serialises it in ("rgb(...)" or "color(srgb ...)").
function pageBackground(): string {
  const fallback = currentTheme() === "light" ? "#f0f3fb" : "#0a1224";
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;background-color:var(--wash-stage)";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  try {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!context) return fallback;
    context.canvas.width = 1;
    context.canvas.height = 1;
    context.fillStyle = "#010203";
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return fallback;
  }
}

function LogoReveal() {
  const theme = useTheme();
  const accent = useAccent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const background = React.useMemo(pageBackground, [theme, accent]);
  // It plays once and settles on the finished logo: the logo is the hero's identity, so it stays.
  return <GlassRevealVibhavGPT className="h-full w-full" look={theme} background={background} loop={false} tileSize={320} logoScale={1} finalScale={0.9} />;
}

// "live" means mounted and committed, not "render() was called": React commits after the call
// returns, so claiming it earlier let anything waiting on the attribute look at an empty stage.
function Live({ element, children }: { element: HTMLElement; children: React.ReactNode }) {
  React.useEffect(() => {
    element.dataset.homeEffectState = "live";
  }, [element]);
  return children;
}

// The model showcase (a stage pinned while the page scrolls) is loaded as a chunk of its own, so GSAP is fetched only here:
// not with the logo, and not in the first paint. If it cannot load, the plain list the build wrote into the page stays, and
// the state says so (the space reserved for the stage is released).
function mountOrbitShowcase(element: HTMLElement) {
  element.dataset.homeEffectState = "loading";
  import("./orbit-showcase-island")
    .then((island) => island.mountOrbitShowcase(element))
    .catch((error) => {
      element.dataset.homeEffectState = "failed";
      console.error("The model showcase failed to load", error);
    });
}

// The page's background: a fluid that follows the pointer. It is motion for its own sake, so a reader who asked for reduced
// motion does not get it (the state says "still"); the boot script already skips it for readers who save data. It is a chunk of
// its own, so its shaders are fetched only here.
function mountSplashCursor(element: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.dataset.homeEffectState = "still";
    return;
  }
  element.dataset.homeEffectState = "loading";
  import("./splash-cursor-island")
    .then((island) => island.mountSplashCursor(element))
    .catch((error) => {
      element.dataset.homeEffectState = "failed";
      console.error("The background effect failed to load", error);
    });
}

export function mountHomeEffect(element: HTMLElement) {
  if (element.dataset.homeEffectState) return;
  const kind = element.dataset.homeEffect;
  if (kind === "splash-cursor") {
    mountSplashCursor(element);
    return;
  }
  if (kind === "orbit-showcase") {
    mountOrbitShowcase(element);
    return;
  }
  if (kind !== "logo-reveal") return;
  // Reduced motion: the logo stays the still image the page already shows. The glass component has
  // a still-frame mode of its own, but it draws one frame and stops, and in the WebKit build tested
  // that frame never appears: the band would be blank where the logo should be. A plain image is
  // the same in every engine and asks nothing of the GPU.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.dataset.homeEffectState = "still";
    return;
  }
  // Replaces what the page shows without script (a still logo) with the effect. "loading" stops a
  // second call from mounting it again while React commits.
  element.dataset.homeEffectState = "loading";
  createRoot(element).render(<Live element={element}><LogoReveal /></Live>);
}
