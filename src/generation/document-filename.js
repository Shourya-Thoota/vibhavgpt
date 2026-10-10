const GENERIC_TITLES = /^(?:document|untitled(?: document)?|overview|summary|part \d+)$/i;

function slug(value) {
  if (typeof value !== "string" || GENERIC_TITLES.test(value.trim())) return "";
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 80).replace(/-+$/g, "");
}

export function documentFilename(plan, prompt = "") {
  const topic = typeof prompt === "string"
    ? prompt.match(/\b(?:about|on|titled)\s+(.+)/i)?.[1] : "";
  const candidates = [plan?.title, ...(plan?.sections ?? []).map((section) => section?.heading), topic];
  const name = candidates.map(slug).find(Boolean) || "vibhavgpt-document";
  // Windows reserves these basenames even when an extension is supplied.
  const safeName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `document-${name}` : name;
  return `${safeName}.docx`;
}
