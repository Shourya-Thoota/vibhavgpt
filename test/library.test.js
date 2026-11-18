process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import { readFile as readText } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import sharp from "sharp";

const { attachments, conversations } = await import("../src/db/schema.js");
const library = await import("../src/library/router.js");
const delivery = await import("../src/library/delivery.js");

async function createDatabase(t) {
  const client = new PGlite();
  t.after(() => client.close());
  await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
  const journal = JSON.parse(await readText(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await client.exec(await readText(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  return drizzle(client);
}
const fakeSession = (req, res, next) => {
  const id = req.headers["x-test-user"];
  if (!id) return res.status(401).json({ error: "Sign in is required." });
  req.authSession = { user: { id } };
  return next();
};
const as = (user, extra = {}) => ({ headers: { "x-test-user": user }, ...extra });

async function world(t) {
  const db = await createDatabase(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "library-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plain = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2a6f4f" } }).png().toBuffer();
  // Stands for a picture that carries the earlier mark (generationMeta.watermarked). It is never marked a second time.
  const marked = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#7a2f4f" } }).png().toBuffer();
  const [chatA] = await db.insert(conversations).values({ userId: "alice", title: "Trip budget", model: "nova", mode: "chat" }).returning();
  const [chatB] = await db.insert(conversations).values({ userId: "bob", title: "Bob private", model: "nova", mode: "chat" }).returning();
  let n = 0;
  const add = async (userId, over = {}, bytes = plain) => {
    n += 1;
    const storedName = `file-${n}.bin`;
    if (bytes) await writeFile(path.join(root, storedName), bytes);
    const [row] = await db.insert(attachments).values({
      userId, originalName: over.originalName ?? `item-${n}.png`, storedName, mimeType: over.mimeType ?? "image/png", kind: over.kind ?? "generated-image",
      sizeBytes: bytes?.length ?? 10, prompt: over.prompt ?? null, conversationId: over.conversationId ?? null, generationMeta: over.generationMeta ?? {},
      createdAt: over.createdAt ?? new Date(Date.UTC(2026, 9, 1, 12, n)),
    }).returning();
    return row;
  };
  const rows = {
    img1: await add("alice", { originalName: "sunset.png", prompt: "a sunset over a lake", conversationId: chatA.id, generationMeta: { watermarked: true } }, marked),
    img2: await add("alice", { originalName: "old-image.png", prompt: "a green square", conversationId: chatA.id }),
    doc1: await add("alice", { originalName: "report.pdf", mimeType: "application/pdf", kind: "generated-file", conversationId: chatA.id }, Buffer.from("%PDF-1.4 report")),
    upload: await add("alice", { originalName: "my-upload.png", kind: "image" }),
    gone: await add("alice", { originalName: "lost.png", prompt: "missing on disk" }, null),
    bobImg: await add("bob", { originalName: "bob-secret.png", prompt: "bob only", conversationId: chatB.id, generationMeta: { watermarked: true } }, marked),
    bobDoc: await add("bob", { originalName: "bob-notes.pdf", mimeType: "application/pdf", kind: "generated-file" }, Buffer.from("%PDF-1.4 bob")),
  };
  // Whether each account's pictures must carry the mark (the watermark policy: Free always, paid plans if chosen); tests change it.
  const markFor = { alice: false, bob: false };
  const app = express();
  app.use("/api/library", library.createLibraryRouter({ database: db, session: fakeSession, root,
    deliver: (res, next, record, userId, options) => delivery.sendStoredFile(res, next, record, userId, { ...options, mustMark: async (id) => markFor[id] === true }) }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { db, root, rows, plain, marked, markFor, url: `http://127.0.0.1:${server.address().port}/api/library`, chatA };
}
const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });

test("a person's Library holds only the documents and pictures made for them, never uploads, never anyone else's", async (t) => {
  const { url, rows } = await world(t);
  assert.equal((await fetch(url)).status, 401, "a session is required");
  const { body } = await json(await fetch(url, as("alice")));
  assert.deepEqual(body.items.map((i) => i.id).sort(), [rows.img1.id, rows.img2.id, rows.doc1.id, rows.gone.id].sort(), "alice's generated files only");
  assert.ok(!body.items.some((i) => i.id === rows.upload.id), "a file she uploaded is not in the Library");
  assert.ok(!body.items.some((i) => [rows.bobImg.id, rows.bobDoc.id].includes(i.id)), "none of bob's");
  assert.ok(!JSON.stringify(body).includes("bob"), "nothing of bob's metadata, titles or prompts");
  const bobs = (await json(await fetch(url, as("bob")))).body.items.map((i) => i.name).sort();
  assert.deepEqual(bobs, ["bob-notes.pdf", "bob-secret.png"]);
  for (const item of body.items) {
    assert.match(item.downloadUrl, /^\/api\/library\/[0-9a-f-]{36}\/download$/, "an owner-only address on this app, not a public link");
    assert.doesNotMatch(JSON.stringify(item), /storedName|file-\d|\/tmp|library-test/, "no storage path or stored name is exposed");
  }
  const image = body.items.find((i) => i.id === rows.img1.id);
  assert.deepEqual({ kind: image.kind, name: image.name, prompt: image.prompt, conversation: image.conversation.title }, { kind: "image", name: "sunset.png", prompt: "a sunset over a lake", conversation: "Trip budget" }, "date, source conversation and prompt are there");
  assert.ok(Date.parse(image.createdAt) > 0);
  assert.equal(body.items.find((i) => i.id === rows.gone.id).available, false, "a record whose file is gone says so");
  assert.equal(image.available, true);
});

test("filtering, searching and paging", async (t) => {
  const { url, rows } = await world(t);
  const ids = async (query, user = "alice") => (await json(await fetch(`${url}?${query}`, as(user)))).body.items.map((i) => i.id);
  assert.deepEqual(await ids("type=documents"), [rows.doc1.id]);
  assert.deepEqual((await ids("type=images")).sort(), [rows.img1.id, rows.img2.id, rows.gone.id].sort());
  assert.deepEqual(await ids("q=sunset"), [rows.img1.id], "by name or prompt");
  assert.deepEqual(await ids("q=green%20square"), [rows.img2.id]);
  assert.deepEqual(await ids("q=bob"), [], "alice cannot find bob's by searching");
  assert.deepEqual(await ids("q=%25"), [], "a percent sign is a character, not a wildcard");
  assert.deepEqual(await ids("q=_"), [], "and so is an underscore");
  // Newest first, in pages, without repeats or gaps.
  const seen = []; let cursor = null;
  for (let page = 0; page < 6; page += 1) {
    const { body } = await json(await fetch(`${url}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, as("alice")));
    seen.push(...body.items.map((i) => i.id));
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4, "no item twice");
  assert.deepEqual(seen, [rows.gone.id, rows.doc1.id, rows.img2.id, rows.img1.id], "newest first");
  assert.equal((await fetch(`${url}?cursor=not-a-cursor`, as("alice"))).status, 400, "a damaged cursor is refused");
  assert.equal((await fetch(`${url}?cursor=${Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z", "'; DROP TABLE attachments;--"])).toString("base64url")}`, as("alice"))).status, 400);
  const huge = (await json(await fetch(`${url}?limit=100000`, as("alice")))).body.items.length;
  assert.ok(huge <= library.LIBRARY_MAX_PAGE);
});

test("preview, download and delete belong to the owner alone, whatever address is used", async (t) => {
  const { url, rows, root } = await world(t);
  assert.equal((await fetch(`${url}/${rows.img1.id}/preview`)).status, 401);
  for (const path_ of ["preview", "download"]) {
    assert.equal((await fetch(`${url}/${rows.bobImg.id}/${path_}`, as("alice"))).status, 404, `alice cannot ${path_} bob's picture`);
    assert.equal((await fetch(`${url}/${rows.img1.id}/${path_}`, as("bob"))).status, 404, `bob cannot ${path_} alice's picture`);
  }
  assert.equal((await fetch(`${url}/${rows.bobDoc.id}/download`, as("alice"))).status, 404);
  assert.equal((await fetch(`${url}/${rows.upload.id}/download`, as("alice"))).status, 404, "an upload is not a Library file");
  assert.equal((await fetch(`${url}/${rows.upload.id}`, { method: "DELETE", ...as("alice") })).status, 404, "nor can it be deleted through the Library");
  for (const bad of ["not-a-uuid", "..%2F..%2Fetc%2Fpasswd", "1", "' OR 1=1"]) assert.equal((await fetch(`${url}/${encodeURIComponent(bad)}/download`, as("alice"))).status, 404, bad);
  const download = await fetch(`${url}/${rows.doc1.id}/download`, as("alice"));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="?report\.pdf"?$/);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await download.text(), "%PDF-1.4 report");
  const preview = await fetch(`${url}/${rows.img1.id}/preview`, as("alice"));
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("content-disposition"), null, "shown inline, not as a download");
  assert.equal((await fetch(`${url}/${rows.doc1.id}/preview`, as("alice"))).status, 404, "only pictures have a preview");
  // Another account's delete changes nothing; the owner's removes the record and the file.
  assert.equal((await fetch(`${url}/${rows.img1.id}`, { method: "DELETE", ...as("bob") })).status, 404);
  await access(path.join(root, rows.img1.storedName));
  assert.equal((await fetch(`${url}/${rows.img1.id}`, { method: "DELETE", ...as("alice") })).status, 204);
  await assert.rejects(() => access(path.join(root, rows.img1.storedName)), "the file is gone");
  assert.equal((await fetch(`${url}/${rows.img1.id}/download`, as("alice"))).status, 404, "and so is the record");
  assert.equal((await fetch(`${url}/${rows.img1.id}`, { method: "DELETE", ...as("alice") })).status, 404, "deleting twice is not an error that leaks anything");
  const left = (await json(await fetch(url, as("alice")))).body.items.map((i) => i.id);
  assert.ok(!left.includes(rows.img1.id) && left.includes(rows.img2.id), "only that one item went");
  assert.equal((await json(await fetch(url, as("bob")))).body.items.length, 2, "bob's Library is untouched");
});

// The watermark policy (owner decision, 2026-11-16, superseding #70), through the Library's own routes.
test("a picture is marked on the way out only when the account must have it, on download and preview alike; the stored file never changes", async (t) => {
  const base = await world(t);
  const delivered = async (id, as_, path_ = "download") => Buffer.from(await (await fetch(`${base.url}/${id}/${path_}`, as(as_))).arrayBuffer());
  // A paid account that has not chosen the mark: exactly as stored.
  assert.deepEqual(await delivered(base.rows.img2.id, "alice"), base.plain, "unmarked when not required");
  assert.deepEqual(await delivered(base.rows.img2.id, "alice", "preview"), base.plain);
  // Required (Free, or chosen on a paid plan): marked, same size, on both routes.
  base.markFor.alice = true;
  for (const route of ["download", "preview"]) {
    const marked = await delivered(base.rows.img2.id, "alice", route);
    assert.notDeepEqual(marked, base.plain, `${route}: marked`);
    const meta = await sharp(marked).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [400, 300, "png"], `${route}: the same picture, in its own format`);
  }
  assert.deepEqual(await readFile(path.join(base.root, base.rows.img2.storedName)), base.plain, "the stored original is unchanged");
  assert.deepEqual(await delivered(base.rows.img1.id, "alice"), base.marked, "a picture with the earlier mark is not marked twice");
  assert.deepEqual(await delivered(base.rows.doc1.id, "alice"), Buffer.from("%PDF-1.4 report"), "documents are never altered");
  // Another account's choice does not apply here, and its pictures stay its own.
  assert.equal((await fetch(`${base.url}/${base.rows.img2.id}/download`, as("bob"))).status, 404);
});

test("the delivery module has one marking rule, for generated pictures only", async () => {
  assert.equal(typeof delivery.needsMarkingNow, "function");
  assert.equal(typeof delivery.sendStoredFile, "function");
  assert.equal(delivery.isGeneratedImage({ kind: "generated-image", mimeType: "image/png" }), true);
  assert.equal(delivery.isGeneratedImage({ kind: "image", mimeType: "image/png" }), false, "a reference photo someone uploaded is not a generated image");
  assert.equal(await delivery.needsMarkingNow({ kind: "image", mimeType: "image/png" }, "alice", { mustMark: async () => true }), false, "uploads are never marked");
});

test("the Library is rate limited per account", async (t) => {
  const db = await createDatabase(t);
  const app = express();
  app.use("/api/library", library.createLibraryRouter({ database: db, session: fakeSession, perMinute: 3 }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/library`;
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url, as("alice"))).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal((await fetch(url, as("bob"))).status, 200, "another account has its own allowance");
});
