// The home page's background: the SplashCursor fluid, as a lazily loaded island.
//
// home-effects-boot.ts finds the element marked data-home-effect="splash-cursor" and loads home-effects.tsx, whose
// mountHomeEffect() imports this file. The effect is a fixed, full-screen WebGL canvas that cannot take a click
// (pointer-events: none) and sits behind the content: the mount element is fixed at z-index -1, after the page wash (the body's
// ::before, also -1) in document order, so it paints over the wash and under everything else. Nothing reserves space, so
// nothing moves when it loads.
//
// It is never started for a reader who asked for reduced motion or to save data (home-effects.tsx and the boot script), and the
// canvas stops drawing when nothing has moved for a moment. The props are the ones the component's own example gives.

import { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import SplashCursor from "@/components/ui/splash-cursor";

// The page records its resolved sky on <html data-theme>; appearance-boot.js keeps it current. The fluid is drawn as light ink
// on a dark sky and as dark ink on a light one.
function subscribe(onChange) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const currentTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function Background({ element }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark");
  // "live" means mounted and committed, as for the other effects.
  useEffect(() => {
    element.dataset.homeEffectState = "live";
  }, [element]);
  // A finger-sized screen has far fewer pixels to spare than a desktop: it gets the lighter simulation.
  const quality = window.matchMedia("(pointer: coarse)").matches ? "medium" : "high";
  return <SplashCursor rainbow size={1} force={1} swirl={3} trail={1} clickSplash theme={theme} quality={quality} zIndex={0} />;
}

export function mountSplashCursor(element) {
  createRoot(element).render(<Background element={element} />);
}
