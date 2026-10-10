/**
 * Copies text and reports whether it actually worked.
 *
 * `navigator.clipboard.writeText` rejects in plenty of ordinary situations —
 * an insecure origin, a document that does not have focus, a browser that
 * denies the permission — so callers must not assume success. Every rejection
 * is handled here and the legacy path is tried before giving up.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based path below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
