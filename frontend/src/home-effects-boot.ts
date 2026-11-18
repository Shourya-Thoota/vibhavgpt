// Loads the homepage animations only when they are about to be seen.
//
// This is the one script the static homepage references (the build injects it,
// see scripts/prerender-public.js). It is tiny on purpose: the animation brings
// React and a WebGL shader with it, neither of which belongs in the first paint of
// a page whose largest paint is its heading. Each element marked
// data-home-effect starts loading when it comes within a screen or so of the
// viewport; the module they share is fetched once.
//
// Without script, and for readers who asked their browser to save data, the page
// keeps what it already shows: the still logo.

const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-home-effect]"));
const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);

// With data saving on, the logo stays the still image the page already shows.
if (!saveData && targets.length) {
  let module: Promise<typeof import("./home-effects")> | null = null;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        module ??= import("./home-effects");
        const element = entry.target as HTMLElement;
        module
          .then((effects) => effects.mountHomeEffect(element))
          .catch((error) => {
            console.error("Homepage effect failed to load", error);
          });
      }
    },
    { rootMargin: "700px 0px" },
  );
  for (const target of targets) observer.observe(target);
}
