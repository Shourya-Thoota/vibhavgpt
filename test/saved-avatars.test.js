process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import sharp from "sharp";

const av = await import("../src/avatars/avatars.js");
const { createAvatarRouter } = await import("../src/avatars/router.js");
const { PictureError } = await import("../src/profile/picture.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return { client, db: drizzle(client) };
}
const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
async function serve(t, db, options = {}) {
  const app = express();
  app.use("/api/avatars", createAvatarRouter({ database: db, session: fakeSession, ...options }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: "server error", message: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/avatars`;
}
const as = (user) => ({ headers: { "x-test-user": user } });
const upload = (url, user, bytes, { name, type = "image/png", file = "me.png", field = "avatar" } = {}) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), file);
  if (name !== undefined) form.append("name", name);
  return fetch(url, { method: "POST", headers: user ? { "x-test-user": user } : {}, body: form });
};
const photo = (w = 800, h = 600, background = "#c0623a") => sharp({ create: { width: w, height: h, channels: 3, background } }).jpeg().toBuffer();
const png = (w = 300, h = 300, background = "#3a62c0") => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();

test("an upload is checked, decoded and written out again: no metadata, upright, bounded, the right type", async () => {
  const withExif = await sharp({ create: { width: 900, height: 450, channels: 3, background: "#336699" } }).withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "secret-owner", Make: "SecretCam" } } }).jpeg().toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif, "the test file really has camera data");
  const out = await av.processAvatar(withExif);
  const meta = await sharp(out.data).metadata();
  assert.deepEqual([meta.width, meta.height], [450, 900], "turned upright");
  assert.equal(meta.exif, undefined, "no camera or location data survives");
  assert.ok(!out.data.includes(Buffer.from("SecretCam")) && !out.data.includes(Buffer.from("secret-owner")));
  assert.equal(out.contentType, "image/jpeg");
  const big = await av.processAvatar(await photo(4000, 3000));
  assert.ok(Math.max(big.width, big.height) <= av.AVATAR_MAX_SIDE, `limited to ${av.AVATAR_MAX_SIDE}px (${big.width}x${big.height})`);
  const small = await av.processAvatar(await photo(200, 100));
  assert.deepEqual([small.width, small.height], [200, 100], "never enlarged");
  const alpha = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
  assert.equal((await av.processAvatar(alpha)).contentType, "image/png", "transparency is kept");
  assert.equal((await av.processAvatar(await sharp(await photo(300, 300)).webp().toBuffer())).contentType, "image/jpeg");
  assert.equal(out.sha256.length, 64);
});

test("files that are not good pictures are refused with a reason, not stored", async () => {
  const reject = async (bytes, code) => { await assert.rejects(() => av.processAvatar(bytes), (error) => error instanceof PictureError && error.code === code, `expected ${code}`); };
  await reject(Buffer.alloc(0), "empty");
  await reject(Buffer.from("just some text"), "unsupported_type");
  await reject(Buffer.from("GIF89a" + "x".repeat(100)), "unsupported_type");
  await reject(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), "unsupported_type");
  await reject(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a png")]), "invalid_image");
  const jpeg = await photo(300, 300);
  await reject(jpeg.subarray(0, 200), "invalid_image");
  await reject(await photo(32, 32), "too_small");
  await reject(Buffer.concat([jpeg, Buffer.alloc(av.AVATAR_MAX_BYTES)]), "too_large");
  // A small file that claims to be enormous is refused before it is decoded.
  const bomb = Buffer.from(await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer());
  await reject(bomb, "too_many_pixels");
  // The type is what the bytes are, not what the file is called or says it is.
  await reject(Buffer.from("MZ\x90\x00 an executable named .png"), "unsupported_type");
});

test("names are cleaned and bounded", () => {
  assert.equal(av.cleanAvatarName("  Mum   and\tme \n"), "Mum and me");
  assert.equal(av.cleanAvatarName("a\u0000b\u0007c"), "a b c");
  assert.equal(av.cleanAvatarName("x".repeat(100)).length, av.AVATAR_NAME_MAX);
  assert.equal(av.cleanAvatarName(null), "");
  assert.equal(av.cleanAvatarName(42), "42");
});

test("upload, list, rename, fetch and delete; each person sees only their own", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await upload(url, null, await png())).status, 401);
  const made = await upload(url, "alice", await png(), { name: "  Me,  smiling " });
  assert.equal(made.status, 201);
  assert.equal(made.headers.get("cache-control"), "private, no-store");
  const { avatar } = await made.json();
  assert.equal(avatar.name, "Me, smiling");
  assert.match(avatar.imageUrl, /^\/api\/avatars\/[0-9a-f-]{36}\/image\?v=[0-9a-f]{12}$/, "an owner-only address on this app");
  assert.doesNotMatch(JSON.stringify(avatar), /userId|user_id|sha256|"data"/, "nothing internal is exposed");
  assert.equal((await (await fetch(url, as("alice"))).json()).avatars.length, 1);
  assert.deepEqual((await (await fetch(url, as("bob"))).json()).avatars, [], "bob has none of alice's");
  const image = await fetch(`${url}/${avatar.id}/image`, as("alice"));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("cache-control"), "private, no-cache");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.match(image.headers.get("content-type"), /^image\/(png|jpeg)$/);
  assert.equal((await fetch(`${url}/${avatar.id}/image`, { headers: { "x-test-user": "alice", "if-none-match": image.headers.get("etag") } })).status, 304);
  assert.equal((await fetch(`${url}/${avatar.id}/image`, as("bob"))).status, 404, "bob cannot fetch it");
  assert.equal((await fetch(`${url}/${avatar.id}/image`)).status, 401);
  for (const bad of ["not-a-uuid", "../x", "1"]) assert.equal((await fetch(`${url}/${encodeURIComponent(bad)}/image`, as("alice"))).status, 404, bad);
  const patch = (user, id, body) => fetch(`${url}/${id}`, { method: "PATCH", headers: { "x-test-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await patch("bob", avatar.id, { name: "mine now" })).status, 404, "bob cannot rename it");
  assert.equal((await patch("alice", avatar.id, { name: "   " })).status, 400);
  assert.equal((await patch("alice", avatar.id, {})).status, 400);
  assert.equal((await (await patch("alice", avatar.id, { name: "Work photo" })).json()).avatar.name, "Work photo");
  assert.equal((await fetch(`${url}/${avatar.id}`, { method: "DELETE", ...as("bob") })).status, 404, "bob cannot delete it");
  assert.equal((await fetch(`${url}/${avatar.id}/image`, as("alice"))).status, 200, "and it is still there");
  assert.equal((await fetch(`${url}/${avatar.id}`, { method: "DELETE", ...as("alice") })).status, 204);
  assert.equal((await fetch(`${url}/${avatar.id}/image`, as("alice"))).status, 404);
  assert.equal((await fetch(`${url}/${avatar.id}`, { method: "DELETE", ...as("alice") })).status, 404);
});

test("upload errors say what is wrong, and a wrong field or a second file is refused", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db);
  const text = await upload(url, "alice", Buffer.from("hello"), { type: "image/png", file: "photo.png" });
  assert.equal(text.status, 415);
  assert.equal((await text.json()).code, "unsupported_type");
  assert.equal((await upload(url, "alice", await png(), { field: "picture" })).status, 400);
  assert.equal((await upload(url, "alice", await photo(40, 40))).status, 400, "too small");
  const big = await upload(url, "alice", Buffer.alloc(av.AVATAR_MAX_BYTES + 10, 1), { type: "image/png" });
  assert.equal(big.status, 413);
  assert.equal((await (await fetch(url, as("alice"))).json()).avatars.length, 0, "nothing was stored by any of those");
  const named = await upload(url, "alice", await png(), { file: "holiday-2025.png" });
  assert.equal((await named.json()).avatar.name, "holiday-2025", "a missing name comes from the file name, without its extension");
});

test("at most ten per account, even when uploads arrive at the same moment; another account has its own ten", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { writeLimit: 100 });
  const picture = await png(200, 200);
  const results = await Promise.all(Array.from({ length: 14 }, (_, i) => upload(url, "alice", picture, { name: `A${i}` })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, av.AVATAR_MAX_COUNT, `exactly ${av.AVATAR_MAX_COUNT} succeed: ${statuses}`);
  assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409), "the rest are told the limit is reached");
  assert.equal((await (await fetch(url, as("alice"))).json()).avatars.length, av.AVATAR_MAX_COUNT);
  assert.equal((await upload(url, "bob", picture)).status, 201, "bob is unaffected");
  const list = await (await fetch(url, as("alice"))).json();
  assert.equal(list.limit, av.AVATAR_MAX_COUNT);
  assert.equal((await fetch(`${url}/${list.avatars[0].id}`, { method: "DELETE", ...as("alice") })).status, 204);
  assert.equal((await upload(url, "alice", picture)).status, 201, "deleting one makes room");
});

test("using an avatar as the profile picture is a separate, explicit request, and changes only the profile picture", async (t) => {
  const { client, db } = await createDatabase(t);
  const url = await serve(t, db);
  const { avatar } = await (await upload(url, "alice", await photo(900, 600), { name: "Me" })).json();
  assert.equal((await client.query("SELECT count(*)::int AS n FROM profile_pictures")).rows[0].n, 0, "uploading an avatar never sets a profile picture");
  assert.equal((await fetch(`${url}/${avatar.id}/use-as-profile-picture`, { method: "POST", ...as("bob") })).status, 404, "not someone else's avatar");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM profile_pictures")).rows[0].n, 0);
  const used = await fetch(`${url}/${avatar.id}/use-as-profile-picture`, { method: "POST", ...as("alice") });
  assert.equal(used.status, 200);
  const row = (await client.query("SELECT user_id, content_type, byte_size FROM profile_pictures")).rows[0];
  assert.deepEqual({ user: row.user_id, type: row.content_type }, { user: "alice", type: "image/webp" }, "made the way an uploaded profile picture is");
  const stored = (await client.query("SELECT data FROM profile_pictures")).rows[0].data;
  const meta = await sharp(Buffer.from(stored)).metadata();
  assert.deepEqual([meta.width, meta.height], [256, 256]);
  assert.equal((await (await fetch(url, as("alice"))).json()).avatars.length, 1, "the avatar itself is unchanged");
});

test("uploads and changes are rate limited per account", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, db, { writeLimit: 3 });
  const picture = await png(120, 120);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await upload(url, "alice", picture)).status);
  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  assert.equal((await upload(url, "bob", picture)).status, 201, "another account has its own allowance");
});

test("an avatar can be the reference for an image only by its owner, and the export carries them", async () => {
  const route = await readFile(new URL("../src/generation/router.js", import.meta.url), "utf8");
  assert.match(route, /referenceAvatarId/);
  assert.match(route, /loadAvatar\(userId, referenceAvatarId\)/, "looked up for the signed-in account only");
  assert.match(route, /if \(referenceAttachmentId && referenceAvatarId\) return res\.status\(400\)/, "one reference at a time");
  const account = await readFile(new URL("../src/account/router.js", import.meta.url), "utf8");
  assert.match(account, /savedAvatars: savedAvatarsExport/);
  const sourceFiles = await Promise.all(["../src/avatars/avatars.js", "../src/avatars/router.js"].map((f) => readFile(new URL(f, import.meta.url), "utf8")));
  for (const code of sourceFiles) assert.doesNotMatch(code.replace(/\/\/.*$/gm, ""), /embedding|faceapi|face-api|recogni[sz]|biometric|fetch\(|https?:\/\//i, "no face template, no outside service");
});
