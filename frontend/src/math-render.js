// KaTeX for replies, loaded the first time a reply holds math (or once the app is idle), not with the first download: the engine
// was a sixth of it (about 250 KB) although most replies have no math (2026-11-17). The stylesheet comes with it, from the same
// package path as before.
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

export { rehypeKatex, remarkMath };
