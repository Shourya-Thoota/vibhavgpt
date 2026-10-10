import {
  AlignmentType, BorderStyle, Document, Footer, Header, LevelFormat, Packer, PageNumber, Paragraph, TextRun,
} from "docx";

/* ==========================================================================
   Word documents that look made, not dumped.

   A document plan is a title and sections whose bodies are plain text:
   paragraphs on their own lines, hyphen bullets, numbered lines, and the
   occasional short "Label:" line. This turns that into a styled .docx:
   - one style sheet: Georgia headings over Calibri 11 pt body at 1.15
     spacing, in a print-safe navy with one teal rule under the title;
   - real Word bullet and numbered lists (numbering restarts per list);
   - short lines ending in a colon become subheadings, and a leading
     "Answer:" style label is set in bold;
   - headings are kept with the text after them, so none strands at the
     foot of a page;
   - the title and date open page one; later pages carry the title in a
     quiet running header, and every page is numbered "Page X of Y".
   The user's document carries no VibhavGPT branding on the page.
   ========================================================================== */

const FONT_BODY = "Calibri";
const FONT_HEAD = "Georgia";
const INK = "1F2A37";
const NAVY = "0C1A2E";
const HEADING = "12355B";
const MUTED = "5B6B7D";
const RULE = "0C6A7D";

// Half-points for sizes, twentieths of a point for spacing (Word's units).
const pt = (value) => value * 2;
const twip = (value) => value * 20;

const BULLET = /^\s*(?:[-*•–]\s+)(.+)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const SUBHEADING = /^[^\s].{1,78}:$/;
const LABEL = /^([A-Z][A-Za-z0-9 ()'/&-]{1,28}):\s+(\S.*)$/;

// **bold** survives from some sources (a reply converted to a file); render
// it as bold rather than printing the asterisks.
function runs(text, base = {}) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part) => (part.startsWith("**") && part.endsWith("**")
    ? new TextRun({ ...base, text: part.slice(2, -2), bold: true })
    : new TextRun({ ...base, text: part.replace(/\*\*/g, "") })));
}

function bodyParagraph(line) {
  const label = line.match(LABEL);
  if (label) return new Paragraph({ children: [new TextRun({ text: `${label[1]}: `, bold: true, color: NAVY }), ...runs(label[2])] });
  return new Paragraph({ children: runs(line) });
}

// One section body to Word paragraphs. Lists are grouped so each new list
// restarts its numbering; a numbered list that does not start at 1 keeps
// the author's own numbers as text, so "3." never turns back into "1.".
export function bodyToParagraphs(body, counter) {
  const lines = String(body).replace(/\r/g, "").split("\n");
  const out = [];
  let list = null;
  const endList = () => { list = null; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();
    if (!line.trim()) { endList(); continue; }
    const bullet = line.match(BULLET);
    const numbered = !bullet && line.match(NUMBERED);
    if (bullet) {
      if (list?.kind !== "bullet") list = { kind: "bullet" };
      const level = /^\s{2,}/.test(line) ? 1 : 0;
      out.push(new Paragraph({ numbering: { reference: "vibhav-bullets", level }, children: runs(bullet[1]) }));
      continue;
    }
    if (numbered) {
      if (list?.kind !== "number") list = { kind: "number", literal: numbered[1] !== "1", instance: (counter.lists += 1) };
      out.push(list.literal
        ? new Paragraph({ indent: { left: twip(22), hanging: twip(18) }, children: [new TextRun({ text: `${numbered[1]}.\t` }), ...runs(numbered[2])] })
        : new Paragraph({ numbering: { reference: "vibhav-numbers", level: 0, instance: list.instance }, children: runs(numbered[2]) }));
      continue;
    }
    endList();
    const next = lines.slice(index + 1).find((candidate) => candidate.trim());
    if (SUBHEADING.test(line.trim()) && next !== undefined) {
      out.push(new Paragraph({ style: "VibhavSubheading", children: runs(line.trim().replace(/:$/, "")) }));
      continue;
    }
    out.push(bodyParagraph(line.trim()));
  }
  return out;
}

export function formatDocumentDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

export async function renderDocx(plan, { date = new Date() } = {}) {
  const counter = { lists: 0 };
  const children = [
    new Paragraph({ style: "Title", children: [new TextRun(plan.title)] }),
    new Paragraph({
      style: "VibhavDateline",
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: RULE, space: 10 } },
      children: [new TextRun(formatDocumentDate(date))],
    }),
  ];
  for (const section of plan.sections) {
    children.push(new Paragraph({ style: "Heading1", children: [new TextRun(section.heading)] }));
    children.push(...bodyToParagraphs(section.body, counter));
  }

  const muted = { font: FONT_BODY, size: pt(9), color: MUTED };
  const document = new Document({
    creator: "VibhavGPT",
    title: plan.title,
    styles: {
      default: {
        document: {
          run: { font: FONT_BODY, size: pt(11), color: INK },
          paragraph: { spacing: { line: 276, after: twip(8) } },
        },
        title: {
          run: { font: FONT_HEAD, size: pt(28), color: NAVY },
          paragraph: { spacing: { before: 0, after: twip(4), line: 240 } },
        },
        heading1: {
          run: { font: FONT_HEAD, size: pt(16), color: HEADING, bold: false },
          paragraph: { spacing: { before: twip(20), after: twip(6) }, keepNext: true, keepLines: true },
        },
        listParagraph: { paragraph: { spacing: { after: twip(4) } } },
      },
      paragraphStyles: [
        {
          id: "VibhavDateline",
          name: "Dateline",
          basedOn: "Normal",
          run: { font: FONT_BODY, size: pt(10), color: MUTED },
          paragraph: { spacing: { after: twip(18) } },
        },
        {
          id: "VibhavSubheading",
          name: "Subheading",
          basedOn: "Normal",
          next: "Normal",
          run: { font: FONT_BODY, size: pt(11.5), color: NAVY, bold: true },
          paragraph: { spacing: { before: twip(10), after: twip(4) }, keepNext: true },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "vibhav-bullets",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: twip(22), hanging: twip(14) } }, run: { color: RULE } } },
            { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: twip(44), hanging: twip(14) } }, run: { color: MUTED } } },
          ],
        },
        {
          reference: "vibhav-numbers",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: twip(22), hanging: twip(18) } }, run: { color: HEADING } } },
          ],
        },
      ],
    },
    sections: [{
      properties: {
        titlePage: true,
        // US Letter with one-inch margins.
        page: {
          size: { width: twip(612), height: twip(792) },
          margin: { top: twip(72), right: twip(72), bottom: twip(72), left: twip(72), header: twip(36), footer: twip(36) },
        },
      },
      headers: {
        first: new Header({ children: [new Paragraph({ children: [] })] }),
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D5DCE5", space: 6 } },
            children: [new TextRun({ ...muted, text: plan.title })],
          })],
        }),
      },
      footers: {
        first: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ ...muted, children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })] }),
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ ...muted, children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })] }),
      },
      children,
    }],
  });
  return Packer.toBuffer(document);
}
