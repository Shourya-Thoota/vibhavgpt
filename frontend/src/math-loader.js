// Loads the math plugins once and shares them (math-render.js). After normalizeTexDelimiters and protectPlainDollarSigns
// (markdown.js), every formula reaches the renderer as $…$ and every plain dollar sign as \$, so an unescaped $ is the sign a reply
// needs them.
let loaded = null;
let loading = null;

/** True when the text has a $ not escaped as \$ (a formula delimiter). */
export const needsMath = (text) => /(^|[^\\])\$/.test(String(text ?? ""));

/** The loaded plugins ({ remarkMath, rehypeKatex }), or null until they are. */
export const loadedMath = () => loaded;

/** Starts (or joins) the one load. A failed load is retried on the next call. */
export function loadMath(importer = () => import("./math-render.js")) {
  if (loaded) return Promise.resolve(loaded);
  loading ??= importer().then((module) => {
    loaded = { remarkMath: module.remarkMath, rehypeKatex: module.rehypeKatex };
    return loaded;
  }, (error) => {
    loading = null;
    throw error;
  });
  return loading;
}
