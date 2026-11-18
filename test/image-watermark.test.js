// The image watermark (owner policy, 2026-11-16, superseding #70): Free plan pictures always carry the VibhavGPT mark; paid plans may turn
// it on, and it is off unless they do. Enforced on delivery (src/library/delivery.js -> src/generation/watermark.js); stored originals
// never change. Synthetic pictures only.
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import sharp from "sharp";

const { WATERMARK_LAYOUT, applyWatermark, shouldWatermark, watermarkRequiredForTier } = await import("../src/generation/watermark.js");
const { needsMarkingNow, sendStoredFile } = await import("../src/library/delivery.js");

const solid = (width, height, format = "png", colour = { r: 128, g: 128, b: 128 }) =>
  sharp({ create: { width, height, channels: 3, background: colour } })[format]().toBuffer();
const pixels = async (buffer) => { const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true }); return { data, info }; };
const at = ({ data, info }, x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };

test("the mark asset is monochrome (black, white and greys) on a transparent background", async () => {
  const asset = fs.readFileSync(new URL("../src/generation/assets/vibhavgpt-watermark.png", import.meta.url));
  const { data, info } = await sharp(asset).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  let transparent = 0; let opaque = 0; let coloured = 0; let white = 0; let black = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a === 0) { transparent += 1; continue; }
    if (a > 200) opaque += 1;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) coloured += 1;
    if (a > 200 && r > 230 && g > 230 && b > 230) white += 1;
    if (a > 200 && r < 30 && g < 30 && b < 30) black += 1;
  }
  const total = data.length / 4;
  assert.ok(transparent / total > 0.4, "the background is transparent");
  assert.ok(coloured / Math.max(1, total - transparent) < 0.01, "no colour: black, white and greys only");
  assert.ok(white > 1000 && black > 1000, "both white glyphs and their black outline");
  assert.ok(opaque > 0);
});

test("the mark is drawn bottom-right with its padding and proportions, and nothing else in the picture changes", async () => {
  const original = await solid(1024, 768);
  const out = await applyWatermark(original, "image/png");
  assert.equal(out.mimeType, "image/png");
  const meta = await sharp(out.buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [1024, 768], "same size");
  const L = WATERMARK_LAYOUT;
  assert.equal(out.box.width, Math.round(1024 * L.widthShare), "22% of the width");
  assert.equal(out.box.padding, Math.round(768 * L.paddingShare), "2.5% of the shorter side");
  assert.equal(out.box.left + out.box.width + out.box.padding, 1024, "flush to the right padding");
  assert.equal(out.box.top + out.box.height + out.box.padding, 768, "flush to the bottom padding");
  const after = await pixels(out.buffer);
  let changed = 0; let light = 0; let dark = 0;
  for (let y = out.box.top; y < out.box.top + out.box.height; y += 1) {
    for (let x = out.box.left; x < out.box.left + out.box.width; x += 1) {
      const [r] = at(after, x, y);
      if (r !== 128) changed += 1;
      if (r > 200) light += 1;
      if (r < 50) dark += 1;
    }
  }
  assert.ok(changed > out.box.width * out.box.height * 0.15, "the mark is visible");
  assert.ok(light > 200 && dark > 200, "white glyphs with a black outline: it reads on light and dark pictures");
  for (const [x, y] of [[0, 0], [512, 384], [out.box.left - 2, out.box.top - 2], [1023, out.box.top - 2], [out.box.left - 2, 767], [1023, 767]]) {
    assert.deepEqual(at(after, x, y), [128, 128, 128], `untouched at ${x},${y}`);
  }
});

test("a JPEG stays a JPEG and a WebP a WebP; small pictures get a smaller mark; huge ones a capped one", async () => {
  const jpeg = await applyWatermark(await solid(800, 800, "jpeg"), "image/jpeg");
  assert.equal(jpeg.mimeType, "image/jpeg");
  assert.equal((await sharp(jpeg.buffer).metadata()).format, "jpeg");
  const webp = await applyWatermark(await solid(640, 480, "webp"), "image/webp");
  assert.equal((await sharp(webp.buffer).metadata()).format, "webp");
  const small = await applyWatermark(await solid(150, 150), "image/png");
  assert.ok(small.box.width <= 75, "never more than half a small picture");
  assert.equal(small.box.padding, WATERMARK_LAYOUT.minPadding);
  const big = await applyWatermark(await solid(4096, 2304), "image/png");
  assert.equal(big.box.width, WATERMARK_LAYOUT.maxWidth);
});

test("the policy: Free is always marked; paid plans only if they turned it on; an unreadable plan is marked", async () => {
  assert.equal(watermarkRequiredForTier("free"), true);
  assert.equal(watermarkRequiredForTier(undefined), true);
  for (const tier of ["plus", "pro", "max"]) assert.equal(watermarkRequiredForTier(tier), false, tier);
  const tiers = { free: "free", plus: "plus", pro: "pro", max: "max", comp: "pro" };
  const prefs = { free: { imageWatermark: false }, plus: null, pro: { imageWatermark: true }, max: { imageWatermark: false }, comp: { imageWatermark: true } };
  const deps = { tierOf: async (id) => tiers[id], preferencesOf: async (id) => prefs[id] };
  assert.equal(await shouldWatermark("free", deps), true, "Free: always, even with the choice stored off");
  assert.equal(await shouldWatermark("plus", deps), false, "paid: off by default");
  assert.equal(await shouldWatermark("pro", deps), true, "paid: on when chosen");
  assert.equal(await shouldWatermark("max", deps), false);
  assert.equal(await shouldWatermark("comp", deps), true, "a complimentary account is treated as its paid plan");
  assert.equal(await shouldWatermark("x", { tierOf: async () => { throw new Error("db down"); }, preferencesOf: async () => null }), true, "fails closed");
});

// ---- Delivery: one rule for every route that hands out a generated picture -----------------------------------------------------------

async function deliveryServer(t, record, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vg-wm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, record.storedName), record.bytes);
  const app = express();
  app.get("/file", (req, res, next) => sendStoredFile(res, next, record, "u1", { root, disposition: req.query.d ?? "attachment", ...options }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (d = "attachment") => fetch(`http://127.0.0.1:${server.address().port}/file?d=${d}`);
}

test("delivery marks a generated picture for an account that must have it, on view and download alike; the stored file is unchanged", async (t) => {
  const bytes = await solid(512, 512);
  const record = { kind: "generated-image", mimeType: "image/png", storedName: "a.png", originalName: "sunset.png", bytes };
  const get = await deliveryServer(t, record, { mustMark: async () => true });
  for (const d of ["attachment", "inline"]) {
    const res = await get(d);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(!body.equals(bytes), `${d}: marked`);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
  assert.match((await get("attachment")).headers.get("content-disposition"), /^attachment; filename="?sunset\.png"?$/);
});

test("delivery leaves a paid account's picture as stored when it has not chosen the mark, and never marks other files", async (t) => {
  const bytes = await solid(256, 256);
  const off = await deliveryServer(t, { kind: "generated-image", mimeType: "image/png", storedName: "b.png", originalName: "b.png", bytes }, { mustMark: async () => false });
  assert.ok(Buffer.from(await (await off()).arrayBuffer()).equals(bytes));
  assert.equal(await needsMarkingNow({ kind: "upload", mimeType: "image/png" }, "u1", { mustMark: async () => true }), false, "an uploaded photo is the person's own");
  assert.equal(await needsMarkingNow({ kind: "generated-document", mimeType: "application/pdf" }, "u1", { mustMark: async () => true }), false);
  assert.equal(await needsMarkingNow({ kind: "generated-image", mimeType: "image/png", generationMeta: { watermarked: true } }, "u1", { mustMark: async () => true }), false, "not marked twice");
});

test("a picture that must be marked but can't be is not delivered unmarked", async (t) => {
  const bytes = await solid(64, 64);
  const get = await deliveryServer(t, { kind: "generated-image", mimeType: "image/png", storedName: "c.png", originalName: "c.png", bytes }, { mustMark: async () => true, mark: async () => { throw new Error("sharp failed"); } });
  const res = await get();
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "watermark_failed");
});

test("an exported sample: a real marked picture, saved for review", async () => {
  // A picture with light and dark areas, like a real image: the mark must read over both.
  const width = 1024; const height = 1024;
  const gradient = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0b1f3a"/><stop offset="0.5" stop-color="#e9b872"/><stop offset="1" stop-color="#f7f4ec"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  const original = await sharp(gradient).png().toBuffer();
  const out = await applyWatermark(original, "image/png");
  fs.mkdirSync(path.resolve("test-results"), { recursive: true });
  fs.writeFileSync(path.resolve("test-results/watermark-sample.png"), out.buffer);
  assert.equal((await sharp(out.buffer).metadata()).width, width);
});
