// Mermaid diagrams in replies (components/DiagramViewer.jsx). The model is
// told to write diagrams, flowcharts, workflows and mind maps as ```mermaid
// blocks (src/chat/prompts.js); the source stays in the reply, so later
// turns can read and change it.

export const DIAGRAM_LANGUAGE = "mermaid";

// "strict" makes mermaid strip scripts and event handlers from labels.
export const MERMAID_CONFIG = Object.freeze({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  fontFamily: "inherit",
});

// The theme's own colours, resolved to real colour values (mermaid can't
// read CSS variables or color-mix), so diagrams match the light and dark skies.
const TOKENS = {
  background: "--color-paper-2",
  primaryColor: "--color-paper",
  primaryTextColor: "--color-ink",
  primaryBorderColor: "--color-accent",
  lineColor: "--color-muted",
  secondaryColor: "--color-paper-2",
  tertiaryColor: "--color-paper",
  textColor: "--color-ink",
  mainBkg: "--color-paper",
  nodeBorder: "--color-accent",
  clusterBkg: "--color-paper-2",
  clusterBorder: "--color-rule",
  edgeLabelBackground: "--color-paper-2",
};

export function mermaidThemeVariables(doc = globalThis.document) {
  if (!doc?.body) return {};
  const probe = doc.createElement("span");
  probe.style.display = "none";
  doc.body.append(probe);
  try {
    const variables = {};
    for (const [name, token] of Object.entries(TOKENS)) {
      probe.style.color = `var(${token})`;
      const resolved = doc.defaultView?.getComputedStyle(probe).color;
      if (resolved) variables[name] = resolved;
    }
    return variables;
  } finally {
    probe.remove();
  }
}

export const isDiagramLanguage = (language) => String(language ?? "").toLowerCase() === DIAGRAM_LANGUAGE;

// Told to the model in every tier (src/chat/prompts.js and study.js).
export const DIAGRAM_FORMAT =
  "When a diagram, flowchart, workflow, process map, sequence, timeline or mind map would help, or is asked for, write it as one fenced code block with the language mermaid, using standard Mermaid syntax (flowchart, sequenceDiagram, mindmap, timeline, classDiagram, stateDiagram, erDiagram or gantt). " +
  "The app draws it as a diagram. Keep labels short and plain, and quote any label that contains punctuation. To change an earlier diagram, write the whole updated block again.";
