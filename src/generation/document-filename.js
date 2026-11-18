// Names for generated files. One rule for every format, so the download card, the saved record, the download header and a connector
// upload all show the same name: an explicit name from the person first, then the document's own title, then its subject, and only
// then the plain fallback. Nothing here calls a model; the title and sections come from the plan the document was already built from.

export const FILENAME_FALLBACK = "vibhavgpt-document";

const GENERIC_TITLES = /^(?:document|untitled(?: document)?|overview|summary|introduction|conclusion|contents?|notes?|section \d+|chapter \d+|part \d+)$/i;
// Windows reserves these basenames even when an extension is supplied.
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STEM = 60;
const KNOWN_EXTENSION = /\.(?:pdf|docx?|pptx?|md|markdown|txt|csv|json|html?)$/i;
// Words that name a kind of file, not a file: "save it as a word doc" says what to make, not what to call it.
const FORMAT_WORDS = /^(?:(?:an?|the|my|new|word|google|docs?|document|documents|file|files|pdf|docx|pptx|powerpoint|power\s*point|slides?|deck|presentation|text|plain|markdown|csv|json|html|web\s*page|webpage|spreadsheet|download|copy|version)\s*)+$/i;

function slug(value) {
  if (typeof value !== "string" || GENERIC_TITLES.test(value.trim())) return "";
  const stem = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, MAX_STEM).replace(/-+$/g, "");
  if (!stem) return "";
  return RESERVED.test(stem) ? `document-${stem}` : stem;
}

function extensionOf(extension) {
  const clean = String(extension ?? "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!clean) return "";
  return clean.startsWith(".") ? clean : `.${clean}`;
}

// A name the person asked for: "call it X", "named X", "filename X", "save as X". It ends where the rest of the request begins, and
// anything that only names a kind of file is not a name. Returned already made safe, without an extension.
export function requestedFilename(text) {
  if (typeof text !== "string" || !text) return null;
  const match = text.match(/\b(?:call(?:ed)?|name(?:d)?(?!\s+is\b)|file\s*name(?:d)?|filename|save\s+(?:it\s+)?as)\b\s*(?:it\s+|this\s+|the\s+file\s+)?[:=]?\s*["“']?([^"”'\n,;]{1,100})/i);
  if (!match) return null;
  let candidate = match[1].split(/\s+(?:and|then|please|for|with|to|in|on)\b/i)[0].trim().replace(KNOWN_EXTENSION, "").trim();
  if (!candidate || FORMAT_WORDS.test(candidate)) return null;
  return slug(candidate) || null;
}

/** The file name for a generated document: `{stem}{extension}`, safe on every common file system. */
export function artifactFilename({ plan, prompt = "", extension = ".docx", requestedName = null } = {}) {
  const topic = typeof prompt === "string" ? prompt.match(/\b(?:about|on|titled)\s+(.+)/i)?.[1] : "";
  const explicit = requestedName ? slug(String(requestedName).replace(KNOWN_EXTENSION, "")) : requestedFilename(prompt);
  const candidates = [plan?.title, ...(plan?.sections ?? []).map((section) => section?.heading), topic];
  const stem = explicit || candidates.map(slug).find(Boolean) || FILENAME_FALLBACK;
  return `${stem}${extensionOf(extension) || ".docx"}`;
}

/** The original Word-document helper, kept for callers that only ever name .docx files. */
export function documentFilename(plan, prompt = "") {
  return artifactFilename({ plan, prompt, extension: ".docx" });
}
