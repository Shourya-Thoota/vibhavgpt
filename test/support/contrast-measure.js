// Worst-case text contrast over the animated background.
//
// Every probed element's glyphs are made transparent, the viewport is captured over many frames of the animation, and each pixel keeps
// its brightest and its darkest value across all frames. Each element is then scored against the map that is worse for its own text
// colour (the brightest background under light text, the darkest under dark text), at the 98th percentile of adverse pixels: a single
// anti-aliased contour pixel cannot decide it, but a contour band running under the text does.
import sharp from "sharp";

const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const parseRgb = (css) => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

const HIDE = "[data-contrast-probe], [data-contrast-probe] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } [data-contrast-probe]::placeholder { color: transparent !important; }";

/**
 * `targets`: [{ zone, selector, placeholder?, limit? }]. Every visible match (up to `limit`, default 12) inside the viewport is scored.
 * Returns [{ zone, ratio, textColor, worstBackgroundLuminance, elements }], the minimum over each zone's elements.
 */
// `advance(ms)` moves the animation on between captures. By default it waits in real time; a test passes Playwright's fake clock
// (page.clock.runFor) so the same span of animation is sampled on every run, whatever the machine's speed.
export async function worstCaseContrastMany(page, targets, { frames = 20, intervalMs = 500, advance = (ms) => page.waitForTimeout(ms) } = {}) {
  const boxes = await page.evaluate((list) => {
    const out = [];
    // The reading area: below the header bars and above the composer. Text scrolled under the translucent header is meant to be
    // obscured as it leaves, so it is not scored.
    const visible = (sel) => [...document.querySelectorAll(sel)].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const top = Math.max(0, ...visible(".topbar-mobile, .mode-tabs-bar").map((r) => r.bottom));
    const composerTops = visible(".composer").map((r) => r.top);
    const bottom = composerTops.length ? Math.min(innerHeight, ...composerTops) : innerHeight;
    for (const { zone, selector, placeholder, limit = 12 } of list) {
      let count = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (getComputedStyle(el).visibility === "hidden") continue;
        // The area under the text itself: the line boxes of the element's text (a Range), not its border box, so the element's own rules
        // and borders (a table header's underline, for instance) are not mistaken for background. A form field keeps its own box.
        let r = el.getBoundingClientRect();
        if (!placeholder) {
          // Text nodes only: an icon beside the words (the byline's mark) is not the background of the words.
          const lines = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            lines.push(...[...range.getClientRects()].filter((line) => line.width > 1 && line.height > 1));
          }
          if (lines.length) r = { left: Math.min(...lines.map((l) => l.left)), right: Math.max(...lines.map((l) => l.right)), top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)), width: 0 };
          r.width = r.right - r.left;
        }
        // The composer's own field is measured inside the composer; everything else is clipped to the reading area.
        const inComposer = Boolean(el.closest(".composer"));
        const y0 = inComposer ? r.top : Math.max(r.top, top);
        const y1 = inComposer ? r.bottom : Math.min(r.bottom, bottom);
        if (r.width < 4 || y1 - y0 < 8 || r.right <= 0 || r.left >= innerWidth) continue;
        el.setAttribute("data-contrast-probe", "");
        const x = Math.max(0, Math.floor(r.left)); const y = Math.max(0, Math.floor(y0));
        out.push({ zone, x, y, w: Math.min(innerWidth, Math.ceil(r.right)) - x, h: Math.min(innerHeight, Math.ceil(y1)) - y, color: placeholder ? getComputedStyle(el, "::placeholder").color : getComputedStyle(el).color });
        if (++count >= limit) break;
      }
    }
    return out;
  }, targets);
  const positions = () => page.evaluate(() => [...document.querySelectorAll("[data-contrast-probe]")].map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}`; }).join("|"));
  const startPositions = await positions();
  const style = await page.addStyleTag({ content: HIDE });
  let brightest = null; let darkest = null; let width = 0;
  for (let i = 0; i < frames; i += 1) {
    const png = await page.screenshot();
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    width = info.width;
    if (!brightest) { brightest = new Float32Array(n); darkest = new Float32Array(n).fill(1); }
    for (let p = 0; p < n; p += 1) {
      const l = luminance(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
      if (l > brightest[p]) brightest[p] = l;
      if (l < darkest[p]) darkest[p] = l;
    }
    if (i < frames - 1) await advance(intervalMs);
  }
  // A measurement is only valid if nothing moved under the boxes while the frames were taken (a late scroll, a re-layout).
  const moved = (await positions()) !== startPositions;
  await style.evaluate((node) => node.remove());
  if (moved) {
    await page.evaluate(() => document.querySelectorAll("[data-contrast-probe]").forEach((el) => el.removeAttribute("data-contrast-probe")));
    throw new Error("The layout moved while the frames were being taken; the measurement is not valid. Let the page settle first.");
  }
  await page.evaluate(() => document.querySelectorAll("[data-contrast-probe]").forEach((el) => el.removeAttribute("data-contrast-probe")));
  const scale = width / (await page.evaluate(() => innerWidth));
  const byZone = new Map();
  for (const box of boxes) {
    const [r, g, b] = parseRgb(box.color);
    const textL = luminance(r, g, b);
    const light = textL > 0.18;
    const map = light ? brightest : darkest;
    const values = [];
    for (let yy = Math.floor(box.y * scale); yy < Math.floor((box.y + box.h) * scale); yy += 1) {
      for (let xx = Math.floor(box.x * scale); xx < Math.floor((box.x + box.w) * scale); xx += 1) values.push(map[yy * width + xx]);
    }
    if (!values.length) continue;
    values.sort((a, b2) => a - b2);
    const adverse = light ? values[Math.floor(values.length * 0.98)] : values[Math.floor(values.length * 0.02)];
    const result = { ratio: Number(ratio(textL, adverse).toFixed(2)), textColor: box.color, worstBackgroundLuminance: Number(adverse.toFixed(4)) };
    const current = byZone.get(box.zone);
    if (!current || result.ratio < current.ratio) byZone.set(box.zone, { zone: box.zone, ...result, elements: (current?.elements ?? 0) + 1 });
    else current.elements += 1;
  }
  return [...byZone.values()];
}

/** The text zones the readability tests score in a conversation and on the new-chat screen. */
export const CHAT_ZONES = [
  { zone: "assistant text", selector: ".bubble--assistant p, .bubble--assistant li, .bubble--assistant h3, .bubble--assistant td" },
  { zone: "byline", selector: ".turn__byline" },
  { zone: "table header", selector: ".bubble--assistant th" },
  { zone: "code label", selector: ".code-block__language" },
  { zone: "user bubble", selector: ".bubble--user" },
  { zone: "placeholder", selector: "textarea.composer__input", placeholder: true, limit: 1 },
];
export const NEW_CHAT_ZONES = [
  { zone: "greeting", selector: ".opening__title", limit: 1 },
  { zone: "temporary notice", selector: ".temporary-banner", limit: 1 },
  { zone: "placeholder", selector: "textarea.composer__input", placeholder: true, limit: 1 },
];
