function isMathLike(content) {
  const value = content.trim();
  if (!value) return false;
  // TeX commands and unambiguous mathematical notation are safe evidence that
  // a dollar pair is an inline math delimiter. A bare monetary amount is not.
  if (/\\[a-zA-Z]+/.test(value)) return true;
  // Deliberately exclude `*`: Markdown bold frequently appears between two
  // currency amounts, and treating it as math would swallow those prices.
  if (/[=+^{}_<>×÷≠≤≥]/.test(value)) return true;
  if (/^[a-zA-Z]$/.test(value)) return true;
  if (/^[a-zA-Z]+\s*\/\s*[a-zA-Z]+$/.test(value)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(value)) return true;
  return false;
}

// remark-math parses every pair of single dollar signs as TeX. Convert only
// the dollar signs that cannot delimit math into Markdown-escaped literals so
// prose such as "$6.99/mo or $79.69/yr" remains intact.
export function protectPlainDollarSigns(text) {
  const source = String(text ?? "");
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$") {
      output += source[index];
      continue;
    }

    const closing = source.indexOf("$", index + 1);
    if (closing === -1 || !isMathLike(source.slice(index + 1, closing))) {
      output += "\\$";
      continue;
    }

    output += source.slice(index, closing + 1);
    index = closing;
  }

  return output;
}

// Providers commonly use TeX's \( \) and \[ \] delimiters in worked
// solutions. Normalize these before remark-math; leave code samples untouched.
export function normalizeTexDelimiters(text) {
  return String(text ?? "").split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `$${formula.trim().replace(/\n/g, " ")}$`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_, formula) => `$${formula.trim()}$`)).join("");
}
