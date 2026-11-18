// Builds Google's Gemini mark for the model picker (frontend/public/brand/providers/gemini.png), drawn to the reference the owner supplied
// (2026-11-16): a four-pointed star with softly rounded tips, red at the top, yellow on the left, green at the bottom, and blue across the
// right. Unlike the single-colour marks it is shown in its own colours in both themes (model-marketplace.js COLOR_MARKS).
// Run: node scripts/build-gemini-mark.mjs
import sharp from "sharp";

const SIZE = 800;
const OUTPUT_SIZE = 128;
const c = SIZE / 2;
const r = 372;
// The star: four concave sides, each a curve through the centre's pull, meeting at the four tips.
const k = 0.2; // how far each side's control point sits from the centre (0 = sharp cusp-like sides)
const ctrl = (x, y) => `${c + (x - c) * k} ${c + (y - c) * k}`;
const top = [c, c - r]; const right = [c + r, c]; const bottom = [c, c + r]; const left = [c - r, c];
const star = `M ${top} Q ${ctrl(c + r, c - r)} ${right} Q ${ctrl(c + r, c + r)} ${bottom} Q ${ctrl(c - r, c + r)} ${left} Q ${ctrl(c - r, c - r)} ${top} Z`;

// The colour: blue across the right, with red, yellow and green blended in from the top, left and bottom.
const colour = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="58"/></filter></defs>
  <rect width="${SIZE}" height="${SIZE}" fill="#3186ff"/>
  <g filter="url(#b)">
    <ellipse cx="${c - 40}" cy="${c - 270}" rx="170" ry="210" fill="#ff3b3b"/><ellipse cx="${c - 90}" cy="${c - 170}" rx="90" ry="90" fill="#f0583c"/>
    <ellipse cx="${c - 270}" cy="${c - 10}" rx="200" ry="120" fill="#ffbf00"/>
    <ellipse cx="${c - 150}" cy="${c + 130}" rx="130" ry="120" fill="#a8d64a"/>
    <ellipse cx="${c - 20}" cy="${c + 290}" rx="150" ry="180" fill="#0fae55"/>
    <ellipse cx="${c + 190}" cy="${c + 20}" rx="230" ry="260" fill="#3186ff"/>
  </g>
</svg>`;

// The shape, with the tips rounded: drawn sharp, blurred a little and cut back at the midpoint (a small morphological close).
const shape = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="#000"/><path d="${star}" fill="#fff"/></svg>`))
  .greyscale().blur(22).threshold(110).blur(1.2).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });

const rgb = await sharp(Buffer.from(colour)).removeAlpha().raw().toBuffer();
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let i = 0; i < SIZE * SIZE; i += 1) {
  out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2];
  out[i * 4 + 3] = shape.data[i];
}
// Drawn at 800px so the blurs and the rounded tips keep their shape, then written at 128px: the mark is shown at 20px (60px on a 3x
// screen), and the 800px file was 503 KB for that (2026-11-17).
await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 4 } }).resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(new URL("../frontend/public/brand/providers/gemini.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
console.log("Gemini mark built: frontend/public/brand/providers/gemini.png");
