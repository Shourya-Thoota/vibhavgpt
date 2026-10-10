// Builds build/icon.ico (16 to 256 px) from the brand icon in the web app's
// public folder. Run with `npm run icon` after the brand icon changes.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pngToIco from "png-to-ico";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../frontend/public/brand/vibhavgpt-icon-512.png");
const target = path.resolve(here, "../build/icon.ico");

const ico = await pngToIco(source);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, ico);
console.log(`Wrote ${path.relative(process.cwd(), target)} (${ico.length} bytes)`);
