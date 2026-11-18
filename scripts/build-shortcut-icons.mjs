// Builds the launch-shortcut icons (New Chat, New Image, New Build): a white glyph on the app's blue rounded square.
// - frontend/public/brand/shortcuts/<id>-96.png: the PWA manifest's shortcuts (Windows jump list, Android long-press).
// - mobile-capacitor*/android/app/src/main/res/drawable-nodpi/shortcut_<id>.png (192px): the Android apps' launcher shortcuts.
// Run: node scripts/build-shortcut-icons.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BLUE = "#2563eb"; // the manifest's theme_color
// 24-unit glyphs, stroked.
const GLYPHS = {
  "new-chat": `<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>`,
  "new-image": `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>`,
  "new-build": `<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>`,
};
const svg = (glyph, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="22" fill="${BLUE}"/>
  <g transform="translate(24 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
</svg>`;

const write = async (glyph, size, file) => {
  mkdirSync(dirname(file), { recursive: true });
  await sharp(Buffer.from(svg(glyph, size))).png({ compressionLevel: 9 }).toFile(file);
};
for (const [id, glyph] of Object.entries(GLYPHS)) {
  await write(glyph, 96, resolve(root, `frontend/public/brand/shortcuts/${id}-96.png`));
  for (const app of ["mobile-capacitor", "mobile-capacitor-direct"]) {
    await write(glyph, 192, resolve(root, `${app}/android/app/src/main/res/drawable-nodpi/shortcut_${id.replace("-", "_")}.png`));
  }
}
console.log("Shortcut icons built:", Object.keys(GLYPHS).join(", "));
