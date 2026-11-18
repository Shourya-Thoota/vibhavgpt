// Runs in the page (pass to page.evaluate). Measures every visible run of
// text against what is actually behind it and returns the runs below WCAG AA:
// 4.5:1, or 3:1 for large text (24px, or 18.66px at weight 700 and above).
//
// The background is composited the way it paints: each ancestor's
// background colour, translucent ones blended over what is under them, down
// to the page. A gradient (the glossy buttons) is sampled across the text's
// own vertical span and the worst colour counts, not an average. Backdrop
// blur is not modelled: text on glass is measured against the glass tint over
// the page colour, which is what a blurred, plain backdrop resolves to.
// Disabled controls, hidden and aria-hidden content, and placeholders are
// exempt (WCAG 1.4.3 exempts inactive components); so is text over images.
export function auditContrast() {
  const parse = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  // A vertical linear-gradient's colour at fraction f of the element's height.
  const gradientAt = (image, f) => {
    // Computed styles drop the default direction (180deg), so it is optional.
    const m = image.match(/linear-gradient\((?:(?:180deg|to bottom),\s*)?(rgba?\(.+)\)$/);
    if (!m) return null;
    const stops = [...m[1].matchAll(/(rgba?\([^)]+\))\s*([\d.]+)%?/g)].map((s) => ({ c: parse(s[1]), p: Number(s[2]) / 100 }));
    if (stops.length < 2) return null;
    if (f <= stops[0].p) return stops[0].c;
    for (let i = 1; i < stops.length; i += 1) {
      if (f <= stops[i].p) { const a = stops[i - 1]; const b = stops[i]; const t = (f - a.p) / ((b.p - a.p) || 1); return { r: a.c.r + (b.c.r - a.c.r) * t, g: a.c.g + (b.c.g - a.c.g) * t, b: a.c.b + (b.c.b - a.c.b) * t, a: a.c.a + (b.c.a - a.c.a) * t }; }
    }
    return stops[stops.length - 1].c;
  };
  const page = parse(getComputedStyle(document.body).backgroundColor);
  const root = parse(getComputedStyle(document.documentElement).backgroundColor);
  const base = page && page.a > 0 ? over(page, root && root.a ? over(root, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 }) : root && root.a ? over(root, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
  // Backgrounds from the element down to the body, worst case over the text span.
  const backgrounds = (el, textTop, textBottom) => {
    const layers = [];
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage.includes("url(")) return null; // text over an image: not measured
      const box = node.getBoundingClientRect();
      if (style.backgroundImage.includes("linear-gradient")) {
        const f1 = Math.min(1, Math.max(0, (textTop - box.top) / (box.height || 1)));
        const f2 = Math.min(1, Math.max(0, (textBottom - box.top) / (box.height || 1)));
        const samples = [f1, (f1 + f2) / 2, f2].map((f) => gradientAt(style.backgroundImage, f)).filter(Boolean);
        if (samples.length) layers.push(samples);
      }
      const colour = parse(style.backgroundColor);
      if (colour && colour.a > 0) layers.push([colour]);
      if (layers.length && layers[layers.length - 1].every((c) => c.a >= 0.999)) break;
    }
    // Every combination of sampled gradient positions; return all candidates.
    let results = [base];
    for (const layer of layers.reverse()) results = layer.flatMap((c) => results.map((under) => over(c, under)));
    return results;
  };
  const failures = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest("[aria-hidden='true'], [inert], :disabled, [aria-disabled='true'], script, style, noscript, svg")) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || Number(style.opacity) === 0) continue;
    let hidden = false;
    for (let a = el; a; a = a.parentElement) if (Number(getComputedStyle(a).opacity) < 0.05) { hidden = true; break; }
    if (hidden) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
    const ink = parse(style.color);
    if (!ink) continue;
    const grounds = backgrounds(el, rect.top, rect.bottom);
    if (!grounds) continue;
    const size = parseFloat(style.fontSize); const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    let worst = Infinity; let worstGround = null;
    for (const ground of grounds) { const r = ratio(over(ink, ground), ground); if (r < worst) { worst = r; worstGround = ground; } }
    if (worst < need) failures.push({ text: node.nodeValue.trim().slice(0, 50), selector: `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`, ratio: Math.round(worst * 100) / 100, need, ink: hex(over(ink, worstGround)), ground: hex(worstGround), size: Math.round(size * 10) / 10, weight });
  }
  return failures;
}
