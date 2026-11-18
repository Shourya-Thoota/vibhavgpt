process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import express from "express";
import sharp from "sharp";

const schema = await import("../src/db/schema.js");
const { conversations, messages, userProfiles, profilePictures } = schema;
const picture = await import("../src/profile/picture.js");
const { createPictureRouter } = await import("../src/profile/picture-router.js");
const { deleteAccountData } = await import("../src/account/deletion.js");

const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url);
async function migrate(client, { stopBefore } = {}) {
  const journal = JSON.parse(await readFile(journalUrl, "utf8"));
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  for (const entry of journal.entries) {
    if (entry.tag === stopBefore) break;
    await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  }
}
async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await migrate(client);
  return { client, db: drizzle(client) };
}

// A fake session: the test names the signed-in account in a header, and no header means no session.
const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
async function serve(t, router) {
  const app = express();
  app.use("/api/profile/picture", router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: "server error", message: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/profile/picture`;
}
const upload = (url, user, bytes, { name = "me.png", type = "image/png", field = "picture", method = "PUT" } = {}) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), name);
  return fetch(url, { method, headers: user ? { "x-test-user": user } : {}, body: form });
};
const as = (user) => ({ headers: { "x-test-user": user } });

// Pictures to upload.
const png = (width = 300, height = 300, background = "#d33") => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const SECRET = "SECRET-LOCATION-TAG";
async function jpegWithExif({ width = 400, height = 200, orientation } = {}) {
  // Left half red, right half blue, so a rotation can be seen; with an EXIF block that carries a private description.
  const left = await sharp({ create: { width: width / 2, height, channels: 3, background: "#e00" } }).png().toBuffer();
  const right = await sharp({ create: { width: width / 2, height, channels: 3, background: "#00e" } }).png().toBuffer();
  let image = sharp({ create: { width, height, channels: 3, background: "#000" } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: width / 2, top: 0 }]).jpeg({ quality: 92 });
  image = image.withExif({ IFD0: { ImageDescription: SECRET, Copyright: "camera owner" } });
  if (orientation) image = image.withMetadata({ orientation });
  return image.toBuffer();
}
const pixel = async (bytes, x, y) => { const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };

// --- The migrations ---------------------------------------------------------------------------------------------------------

test("the migrations only add: run on a copy that already holds data, nothing existing changes, and they can run twice", async (t) => {
  const client = new PGlite();
  t.after(() => client.close());
  await migrate(client, { stopBefore: "0037_profile_pictures" });
  const db = drizzle(client);
  // A copy of an account with data in it, as it was before these migrations.
  // Seeded with the columns that existed before these migrations (the schema's later columns, such as use_memory, are not in this copy yet).
  const { rows: [conversation] } = await client.query(`INSERT INTO conversations (user_id, title, model) VALUES ('u1', 'Existing chat', 'nova') RETURNING id`);
  await db.insert(messages).values({ conversationId: conversation.id, role: "user", content: "an existing message" });
  await client.query(`INSERT INTO user_profiles (user_id) VALUES ('u1')`);
  const tables = async () => (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map((r) => r.table_name);
  const counts = async (names) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, (await client.query(`SELECT count(*)::int AS c FROM "${n}"`)).rows[0].c])));
  const before = await tables();
  const countsBefore = await counts(before);
  const files = ["0037_profile_pictures", "0038_chat_search_indexes"];
  const text = await Promise.all(files.map((f) => readFile(new URL(`../drizzle/${f}.sql`, import.meta.url), "utf8")));
  for (const body of text) await client.exec(body);
  const after = await tables();
  assert.deepEqual(after.filter((n) => !before.includes(n)), ["profile_pictures"], "one new table and nothing else");
  assert.deepEqual(before.filter((n) => !after.includes(n)), [], "no table is gone");
  assert.deepEqual(await counts(before), countsBefore, "every existing row is still there");
  const indexes = (await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname);
  for (const name of ["conversations_title_fts_idx", "messages_content_fts_idx"]) assert.ok(indexes.includes(name), name);
  for (const body of text) await client.exec(body); // IF NOT EXISTS: running again changes nothing and does not fail
  assert.deepEqual(await counts(before), countsBefore);
  // And nothing in them is destructive or rewrites what exists.
  for (const body of text) assert.doesNotMatch(body.replace(/^--.*$/gm, ""), /\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME|ALTER)\b/i, "additive statements only");
});

test("the schema and the migrations agree about profile_pictures, and the journal lists them in order", async (t) => {
  const { client } = await createDatabase(t);
  const columns = (await client.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'profile_pictures' ORDER BY ordinal_position`)).rows;
  const declared = Object.values(getTableColumns(profilePictures)).map((c) => c.name).sort();
  assert.deepEqual(columns.map((c) => c.column_name).sort(), declared);
  assert.equal(columns.find((c) => c.column_name === "data").data_type, "bytea");
  assert.ok(columns.every((c) => c.is_nullable === "NO"), "nothing is optional");
  const journal = JSON.parse(await readFile(journalUrl, "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === "0037_profile_pictures");
  assert.ok(at > 0, "0037 is in the journal");
  const pair = journal.entries.slice(at, at + 2);
  assert.deepEqual(pair.map((e) => e.tag), ["0037_profile_pictures", "0038_chat_search_indexes"]);
  assert.equal(pair[1].idx, pair[0].idx + 1);
  assert.ok(pair[0].when > journal.entries[at - 1].when, "dated after the one before it");
});

// --- What gets stored -----------------------------------------------------------------------------------------------------------

test("a picture becomes a square 256px WebP with no metadata, whatever it arrived as", async () => {
  for (const [name, bytes, format] of [["JPEG", await jpegWithExif(), "jpeg"], ["PNG", await png(500, 320), "png"], ["WebP", await sharp(await png(260, 400)).webp().toBuffer(), "webp"]]) {
    assert.equal(picture.sniffImageType(bytes), format, `${name} is recognised by its bytes`);
    const out = await picture.processPicture(bytes);
    const meta = await sharp(out.data).metadata();
    assert.equal(meta.format, "webp", name);
    assert.deepEqual([meta.width, meta.height], [256, 256], `${name}: square, 256px`);
    assert.equal(out.contentType, "image/webp");
    assert.equal(out.byteSize, out.data.length);
    assert.ok(out.byteSize < 60_000, `${name}: ${out.byteSize} bytes: small enough to keep in the database`);
    assert.match(out.sha256, /^[0-9a-f]{64}$/);
  }
});

test("metadata is stripped: a private EXIF description in the upload is not in what is stored", async () => {
  const input = await jpegWithExif();
  assert.ok(input.includes(Buffer.from(SECRET)), "the test picture really does carry the tag");
  const out = await picture.processPicture(input);
  assert.equal(out.data.includes(Buffer.from(SECRET)), false, "gone");
  assert.equal(out.data.includes(Buffer.from("Exif")), false, "no EXIF block at all");
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.xmp, undefined);
});

test("the way the camera was held is applied before the crop, and the crop is the middle", async () => {
  // 400x200, left red and right blue, tagged "rotate 90 degrees clockwise to display" (orientation 6): shown upright, red is on top.
  const out = await picture.processPicture(await jpegWithExif({ width: 400, height: 200, orientation: 6 }));
  const top = await pixel(out.data, 128, 20);
  const bottom = await pixel(out.data, 128, 235);
  assert.ok(top[0] > 150 && top[2] < 100, `top is red (${top})`);
  assert.ok(bottom[2] > 150 && bottom[0] < 100, `bottom is blue (${bottom})`);
  // Without the tag the same picture is wider than tall: red on the left, blue on the right.
  const flat = await picture.processPicture(await jpegWithExif({ width: 400, height: 200 }));
  const left = await pixel(flat.data, 20, 128); const right = await pixel(flat.data, 235, 128);
  assert.ok(left[0] > 150 && right[2] > 150, "red left, blue right");
});

// --- What is refused --------------------------------------------------------------------------------------------------------------

test("anything that is not a valid JPEG, PNG or WebP, within 5 MB, is refused, by what its bytes are", async () => {
  const refuse = async (bytes, status, code, label) => {
    await assert.rejects(() => picture.processPicture(bytes), (error) => { assert.equal(error.name, "PictureError", label); assert.equal(error.status, status, `${label}: status`); assert.equal(error.code, code, `${label}: code`); assert.ok(error.message.length > 10 && !/sharp|libvips|at Object|\\n/.test(error.message), `${label}: a message safe to show`); return true; });
  };
  await refuse(Buffer.alloc(0), 400, "empty", "empty");
  await refuse(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]), 413, "too_large", "over 5 MB");
  await refuse(Buffer.from("GIF89a\x01\x00\x01\x00", "binary"), 415, "unsupported_type", "a GIF");
  await refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 415, "unsupported_type", "an SVG");
  await refuse(Buffer.from("%PDF-1.7\n1 0 obj\n"), 415, "unsupported_type", "a PDF");
  await refuse(Buffer.from("MZ\x90\x00\x03\x00", "binary"), 415, "unsupported_type", "a program");
  await refuse(Buffer.from("just some text pretending to be photo.png"), 415, "unsupported_type", "text");
  await refuse(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("this is not really a jpeg body")]), 400, "invalid_image", "a JPEG header on garbage");
  const whole = await png(300, 300);
  await refuse(whole.subarray(0, 40), 400, "invalid_image", "a PNG cut off after its header");
  await refuse(await png(16, 16), 400, "too_small", "too small");
  // Decompression bomb: a tiny PNG that says it is 60,000 by 60,000 pixels.
  const bomb = Buffer.from(whole);
  bomb.writeUInt32BE(60000, 16); bomb.writeUInt32BE(60000, 20);
  await assert.rejects(() => picture.processPicture(bomb), (error) => { assert.equal(error.name, "PictureError"); assert.ok([400, 413].includes(error.status), `refused, not a crash (${error.status})`); return true; });
});

// --- Over HTTP: ownership, headers, limits ----------------------------------------------------------------------------------------

test("only the signed-in owner can change or read a picture: no session, no access; nobody can address another account", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  const bytes = await png();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = method === "PUT" ? await upload(url, null, bytes) : await fetch(url, { method });
    assert.equal(response.status, 401, `${method} without a session`);
  }
  assert.equal((await upload(url, "alice", bytes)).status, 200);
  const aliceStored = (await db.select().from(profilePictures))[0];
  assert.equal(aliceStored.userId, "alice");
  // Bob sees nothing of Alice's, and a user id in the path, the query or the body changes nothing about whose picture it is.
  assert.equal((await fetch(url, as("bob"))).status, 404, "bob has no picture, and gets none of alice's");
  assert.equal((await fetch(`${url}?userId=alice`, as("bob"))).status, 404);
  assert.equal((await fetch(`${url}/alice`, as("bob"))).status, 404, "there is no path that names an account");
  assert.equal((await fetch(`${url}/`, { method: "DELETE", headers: { "x-test-user": "bob", "content-type": "application/json" }, body: JSON.stringify({ userId: "alice" }) })).status, 204);
  assert.equal((await db.select().from(profilePictures)).find((p) => p.userId === "alice")?.sha256, aliceStored.sha256, "bob's delete left alice's picture alone");
  assert.equal((await upload(`${url}?userId=alice`, "bob", await png(300, 300, "#3a3"))).status, 200);
  const rows = await db.select().from(profilePictures);
  assert.deepEqual(rows.map((r) => r.userId).sort(), ["alice", "bob"], "bob's upload made bob's own row");
  assert.equal(rows.find((r) => r.userId === "alice").sha256, aliceStored.sha256, "and did not touch alice's");
});

test("a picture is served only to its owner, privately, with a validator, and revalidates to a 304", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  const put = await upload(url, "alice", await jpegWithExif(), { name: "me.jpg", type: "image/jpeg" });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.match(saved.picture.version, /^[0-9a-f]{16}$/);
  assert.equal(put.headers.get("cache-control"), "private, no-store");
  const response = await fetch(url, as("alice"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), "private, no-cache", "private, and checked again every time");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-site");
  assert.match(response.headers.get("vary"), /cookie/i);
  assert.match(response.headers.get("content-disposition"), /^inline/);
  const etag = response.headers.get("etag");
  assert.ok(etag?.startsWith('"') && etag.length > 20);
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual((({ width, height, format }) => [width, height, format])(await sharp(body).metadata()), [256, 256, "webp"]);
  assert.equal(saved.picture.version, etag.slice(1, 17), "the version is the start of the validator");
  const again = await fetch(url, { headers: { "x-test-user": "alice", "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  // Replacing it changes the validator, so the new picture shows at once.
  await upload(url, "alice", await png(300, 300, "#3a3"));
  const changed = await fetch(url, { headers: { "x-test-user": "alice", "if-none-match": etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal((await db.select().from(profilePictures)).length, 1, "replace, not add: one picture per account");
});

test("bad uploads over HTTP get a clear message and a calm status, and store nothing", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  const cases = [
    ["a GIF named .png", () => upload(url, "alice", Buffer.from("GIF89a\x01\x00\x01\x00", "binary")), 415, "unsupported_type"],
    ["text named .jpg", () => upload(url, "alice", Buffer.from("not an image"), { name: "x.jpg", type: "image/jpeg" }), 415, "unsupported_type"],
    ["a corrupt PNG", async () => upload(url, "alice", (await png()).subarray(0, 60)), 400, "invalid_image"],
    ["6 MB", () => upload(url, "alice", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)])), 413, "too_large"],
    ["the wrong field name", async () => upload(url, "alice", await png(), { field: "file" }), 400, "bad_upload"],
    ["no file at all", () => fetch(url, { method: "PUT", headers: { "x-test-user": "alice", "content-type": "application/json" }, body: "{}" }), 400, "empty"],
  ];
  for (const [label, run, status, code] of cases) {
    const response = await run();
    assert.equal(response.status, status, label);
    const body = await response.json();
    assert.equal(body.code, code, label);
    assert.ok(typeof body.error === "string" && body.error.length > 10 && !/at \w+ \(|node_modules|sharp/.test(body.error), `${label}: nothing technical in the message`);
  }
  assert.equal((await db.select().from(profilePictures)).length, 0, "nothing was stored by any of them");
});

test("uploads are rate limited per account, failed attempts included, and reading is not", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession, writeLimit: 3 }));
  const bytes = await png();
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await upload(url, "alice", i === 1 ? Buffer.from("junk") : bytes)).status);
  assert.deepEqual(statuses, [200, 415, 200, 429], "the fourth attempt, a bad one counted, is stopped");
  const limited = await upload(url, "alice", bytes);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /wait/i);
  assert.equal((await fetch(url, { method: "DELETE", headers: { "x-test-user": "alice" } })).status, 429, "removing counts too");
  assert.equal((await upload(url, "bob", bytes)).status, 200, "another account has its own allowance");
  for (let i = 0; i < 8; i += 1) assert.equal((await fetch(url, as("alice"))).status, 200, "reading is never limited");
});

test("removing a picture is final and repeatable: it is gone, and removing it again is not an error", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  await upload(url, "alice", await png());
  assert.equal((await fetch(url, { method: "DELETE", headers: { "x-test-user": "alice" } })).status, 204);
  const gone = await fetch(url, as("alice"));
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, "none");
  assert.equal((await fetch(url, { method: "DELETE", headers: { "x-test-user": "alice" } })).status, 204);
  assert.equal((await db.select().from(profilePictures)).length, 0);
});

// --- Account deletion and data export ------------------------------------------------------------------------------------------

test("deleting an account deletes its picture, and only its picture", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  await upload(url, "alice", await png());
  await upload(url, "bob", await png(300, 300, "#3a3"));
  await deleteAccountData(db, "alice");
  assert.deepEqual((await db.select().from(profilePictures)).map((p) => p.userId), ["bob"]);
});

test("the data export carries the picture, exactly as stored, and null when there is none", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  assert.equal(await picture.profilePictureForExport("alice", db), null);
  await upload(url, "alice", await png());
  const exported = await picture.profilePictureForExport("alice", db);
  assert.equal(exported.contentType, "image/webp");
  const bytes = Buffer.from(exported.dataBase64, "base64");
  assert.equal(bytes.length, exported.byteSize);
  assert.deepEqual((({ width, height }) => [width, height])(await sharp(bytes).metadata()), [256, 256]);
  assert.equal(await picture.profilePictureForExport("bob", db), null, "nobody else's");
  const router = (await readFile(new URL("../src/account/router.js", import.meta.url), "utf8"));
  assert.match(router, /profilePicture: picture,/, "the route puts it in the export");
});

// --- The Google photo ---------------------------------------------------------------------------------------------------------------

test("only a Google photo address on Google's own picture host is ever handed to a browser", () => {
  assert.equal(picture.googlePhotoUrl("https://lh3.googleusercontent.com/a/abc=s96-c"), "https://lh3.googleusercontent.com/a/abc=s96-c");
  for (const bad of ["http://lh3.googleusercontent.com/a/abc", "https://example.com/a.png", "https://googleusercontent.com.evil.example/a", "https://evilgoogleusercontent.com/a", "javascript:alert(1)", "data:image/png;base64,AAAA", "//lh3.googleusercontent.com/a", "", null, undefined, 42]) {
    assert.equal(picture.googlePhotoUrl(bad), null, String(bad));
  }
});

test("the picture is stored by the server's own result, never the upload: the table holds only the re-encoded bytes", async (t) => {
  const { db } = await createDatabase(t);
  const url = await serve(t, createPictureRouter({ database: db, session: fakeSession }));
  const original = await jpegWithExif();
  await upload(url, "alice", original, { name: "me.jpg", type: "image/jpeg" });
  const [row] = await db.select().from(profilePictures);
  const stored = Buffer.from(row.data);
  assert.equal(stored.includes(Buffer.from(SECRET)), false);
  assert.notDeepEqual(stored, original);
  assert.equal(row.byteSize, stored.length);
});
