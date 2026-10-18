// Splits a model's streamed thinking into steps for the thinking drawer.
//
// Reasoning models usually stream their thinking as short titled phases
// ("**Defining the problem**", then a paragraph). A line that is only a bold
// title or a Markdown heading starts a step; the text under it is that
// step's paragraphs (blank lines separate them). Text before the first title
// is a step without a title. Inline **bold** spans are returned as parts so
// the drawer can render them without HTML. Thinking with no titles at all
// stays one untitled step, shown as plain paragraphs.

const TITLE = /^\s*(?:\*\*([^*\n][^\n]*?)\*\*:?|#{1,4}\s+(.+?))\s*$/;

function inlineParts(text) {
  const parts = [];
  const pattern = /\*\*([^*\n]+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[1], strong: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function thinkingSteps(text) {
  const steps = [];
  let current = { title: null, lines: [] };
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const title = line.match(TITLE);
    if (title) {
      if (current.title !== null || current.lines.some((value) => value.trim())) steps.push(current);
      current = { title: (title[1] ?? title[2]).trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.title !== null || current.lines.some((value) => value.trim())) steps.push(current);
  return steps.map(({ title, lines }) => ({
    title,
    paragraphs: lines.join("\n").split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean).map(inlineParts),
  }));
}
