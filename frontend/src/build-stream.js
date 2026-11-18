// What Build shows while Tecton writes (src/build/artifacts.js has the file protocol): the summary text, and one line per file being
// written, never the raw files. The saved reply comes from the server already without them.

const PROJECT_LINE = /^<<<PROJECT[^\n]*>>>[ \t]*\n?/gm;
const FILE_OPEN = /^<<<FILE\s+path="([^"]{1,160})">>>[ \t]*$/m;
const FILE_CLOSE = /^<<<END FILE>>>[ \t]*$/m;

/** The streamed text with every file block replaced by "Writing <path>…" (or "Wrote <path>" once its end marker has arrived). */
export function visibleBuildStream(text) {
  let rest = String(text ?? "").replace(PROJECT_LINE, "");
  let out = "";
  for (;;) {
    const open = rest.match(FILE_OPEN);
    if (!open) {
      // A marker still arriving at the very end ("<<<FI") is held back rather than shown.
      out += rest.replace(/<<<[^\n]*$/, "");
      break;
    }
    out += rest.slice(0, open.index);
    const after = rest.slice(open.index + open[0].length);
    const close = after.match(FILE_CLOSE);
    if (!close) { out += `\n_Writing ${open[1]}…_\n`; break; }
    out += `\n_Wrote ${open[1]}_\n`;
    rest = after.slice(close.index + close[0].length);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
