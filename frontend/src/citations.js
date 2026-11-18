// Inline citations in a reply (owner request, 2026-11-15). The server numbers the pages a turn's searches retrieved and saves them as
// the reply's sources (src/search/citations.js); the reply cites them as [n]. This turns each [n] in the reply's prose into a small
// numbered link to that source, so a claim and its page are one click apart. Code is a different node type and is never touched;
// a number with no source stays plain text, so nothing links anywhere the turn did not retrieve.

const MARKER = /\[(\d{1,3})\]/g;

/** A source's number: the one the server gave it, or its position for replies saved before sources were numbered. */
export const sourceNumber = (source, index) => (Number.isInteger(source?.n) && source.n > 0 ? source.n : index + 1);

const webUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

/** The reply's sources by number, keeping only web links. */
export function sourcesByNumber(sources = []) {
  const byNumber = new Map();
  (Array.isArray(sources) ? sources : []).forEach((source, index) => {
    const href = webUrl(source?.url);
    if (!href) return;
    const n = sourceNumber(source, index);
    if (byNumber.has(n)) return;
    let domain = source.domain;
    try { domain ||= new URL(href).hostname.replace(/^www\./, ""); } catch { /* kept empty */ }
    byNumber.set(n, { n, href, title: String(source.title || domain || href), domain, publishedDate: source.publishedDate ?? null, ...(typeof source.cited === "boolean" ? { cited: source.cited } : {}) });
  });
  return byNumber;
}

/** Splits text into plain runs and citations that name a known source. Exported for tests. */
export function citationParts(text, byNumber) {
  const parts = [];
  let last = 0;
  for (const match of String(text).matchAll(MARKER)) {
    const source = byNumber.get(Number(match[1]));
    if (!source) continue;
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: "citation", source });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

// Inside these, a [n] is someone else's text (a link's words, a heading's anchor), not a citation.
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "math", "inlineMath", "html"]);

/** A remark plugin: [n] in a text node becomes a link node that the reply's renderer draws as a citation. */
export function remarkCitations({ sources = [] } = {}) {
  const byNumber = sourcesByNumber(sources);
  return (tree) => {
    if (!byNumber.size) return;
    const visit = (node) => {
      if (!node?.children || SKIP.has(node.type)) return;
      const next = [];
      for (const child of node.children) {
        if (child.type !== "text" || !MARKER.test(child.value)) {
          MARKER.lastIndex = 0;
          visit(child);
          next.push(child);
          continue;
        }
        MARKER.lastIndex = 0;
        for (const part of citationParts(child.value, byNumber)) {
          if (part.type === "text") { next.push({ type: "text", value: part.value }); continue; }
          next.push({
            type: "link",
            url: part.source.href,
            title: null,
            data: { hProperties: { "data-citation": String(part.source.n) } },
            children: [{ type: "text", value: String(part.source.n) }],
          });
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}

/** What a citation says to a screen reader and on hover: "Source 2: Title, site". */
export function citationLabel(source) {
  return `Source ${source.n}: ${source.title}${source.domain && source.domain !== source.title ? `, ${source.domain}` : ""}`;
}
