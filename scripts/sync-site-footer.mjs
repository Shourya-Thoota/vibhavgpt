// Writes the one public-site footer (frontend/src/site-footer.js) into every static public page, between
// <!-- site-footer:start --> and <!-- site-footer:end -->, and makes sure each page loads /theme/site-footer.css.
//
//   node scripts/sync-site-footer.mjs          write
//   node scripts/sync-site-footer.mjs --check  exit 1 if any page differs (test/site-footer.test.js runs the same check)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const STATIC_PUBLIC_PAGES = ["account-deletion.html", "home/index.html", "apps/index.html", "sources/index.html", "android/index.html", "vibhavgpt-windows/index.html"];
const START = "<!-- site-footer:start -->";
const END = "<!-- site-footer:end -->";
const LINK = '<link rel="stylesheet" href="/theme/site-footer.css" />';

export async function expectedPage(html) {
  const { siteFooterHtml } = await import(pathToFileURL(path.resolve("frontend/src/site-footer.js")).href);
  const block = `${START}${siteFooterHtml()}${END}`;
  let out = html;
  if (out.includes(START)) {
    out = out.slice(0, out.indexOf(START)) + block + out.slice(out.indexOf(END) + END.length);
  } else {
    // First run: the page's own hand-written footer is replaced by the shared one.
    const match = out.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/);
    if (!match) throw new Error("no footer to replace");
    out = out.replace(match[0], block);
  }
  if (!out.includes(LINK)) out = out.replace("</head>", `  ${LINK}\n</head>`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  let differs = 0;
  for (const rel of STATIC_PUBLIC_PAGES) {
    const file = path.resolve("frontend/public", rel);
    const html = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const next = await expectedPage(html);
    if (next !== html) {
      differs += 1;
      if (!check) fs.writeFileSync(file, next);
      console.log(`${check ? "differs" : "wrote"} ${rel}`);
    }
  }
  if (check && differs) process.exit(1);
}
