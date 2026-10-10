import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { eq } from "drizzle-orm";
import { attachments } from "../src/db/schema.js";
import { createImageLibrary } from "../src/generation/image-library.js";
import { createImageLibraryRouter } from "../src/generation/image-library-router.js";
import { createImageLibraryFixture } from "./helpers/image-library-db.js";

test("image library migration, ownership, pagination and HTTP operations on isolated Postgres", async (t) => {
  const fixture = await createImageLibraryFixture();
  const { client, db, legacyId, otherId, documentId } = fixture;
  t.after(() => client.close());
  const library = createImageLibrary(db);
  const owner = "library-owner";
  let folder;
  await t.test("migration preserves existing images and adds nullable organization fields", async () => {
    const [image] = await db.select().from(attachments).where(eq(attachments.id, legacyId));
    assert.equal(image.prompt, "Original mountain lake prompt");
    assert.equal(image.originalName, "original.png");
    assert.equal(image.folderId, null);
    assert.equal(image.displayName, null);
  });
  await t.test("folder create and rename are scoped to their owner", async () => {
    folder = await library.createFolder(owner, "  Travel  ");
    assert.equal(folder.name, "Travel");
    assert.equal((await library.listFolders(owner)).length, 1);
    assert.deepEqual(await library.listFolders("other-owner"), []);
    await assert.rejects(library.renameFolder("other-owner", folder.id, "Stolen"), { status: 404 });
    assert.equal((await library.renameFolder(owner, folder.id, "Places")).name, "Places");
    for (const name of [" ", "x".repeat(121), null, []]) await assert.rejects(library.createFolder(owner, name), { status: 400 });
  });
  await t.test("moves, caption renames, clearing and unfiled filtering preserve the prompt", async () => {
    const image = await library.updateImage(owner, legacyId, { folderId: folder.id, displayName: "Summer lake", prompt: "Must be ignored" });
    assert.equal(image.prompt, "Original mountain lake prompt");
    assert.equal(image.originalName, "original.png");
    assert.equal(image.displayName, "Summer lake");
    assert.equal((await library.listImages(owner, { folder: folder.id })).images[0].id, legacyId);
    assert.ok(!(await library.listImages(owner, { folder: "unfiled" })).images.some(i => i.id === legacyId));
    const cleared = await library.updateImage(owner, legacyId, { folderId: null, displayName: " " });
    assert.equal(cleared.displayName, null);
    assert.equal(cleared.folderId, null);
  });
  await t.test("foreign images, foreign folders and nongenerated attachments cannot be changed", async () => {
    const foreign = await library.createFolder("other-owner", "Private");
    await assert.rejects(library.updateImage(owner, otherId, { displayName: "No" }), { status: 404 });
    await assert.rejects(library.updateImage(owner, documentId, { displayName: "No" }), { status: 404 });
    await assert.rejects(library.updateImage(owner, legacyId, { folderId: foreign.id }), { status: 404 });
    await assert.rejects(library.listImages(owner, { folder: foreign.id }), { status: 404 });
    // Even a query bypassing the service cannot cross-link two owners.
    await assert.rejects(db.update(attachments).set({ folderId: foreign.id }).where(eq(attachments.id, legacyId)), e => e.cause?.code === "23503");
  });
  await t.test("pagination returns every same-timestamp image once and rejects foreign cursors", async () => {
    const first = await library.listImages(owner);
    const second = await library.listImages(owner, { cursor: first.nextCursor });
    const ids = [...first.images, ...second.images].map(i => i.id);
    assert.equal(ids.length, 31);
    assert.equal(new Set(ids).size, 31);
    assert.equal(second.nextCursor, null);
    await assert.rejects(library.listImages(owner, { cursor: otherId }), { status: 400 });
    await assert.rejects(library.listImages(owner, { folder: ["all"] }), { status: 400 });
  });
  await t.test("invalid edits fail without changing data", async () => {
    for (const body of [{}, { displayName: 3 }, { displayName: "x".repeat(161) }, { folderId: "bad" }, { folderId: {} }]) {
      await assert.rejects(library.updateImage(owner, legacyId, body), { status: 400 });
    }
  });
  await t.test("actual HTTP router supports create, rename, move, reload and ownership denial", async () => {
    const app = express();
    app.use(express.json());
    // Test authentication boundary; production mounts this router after requireSession.
    app.use((req, res, next) => { req.authSession = { user: { id: req.headers["x-test-user"] || owner } }; next(); });
    app.use("/api/generation", createImageLibraryRouter(db));
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/generation`;
    const request = (path, body, method = "PATCH", user = owner) => fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify(body) });
    try {
      const created = await request("/image-folders", { name: "Browser folder" }, "POST");
      assert.equal(created.status, 201);
      const { folder: createdFolder } = await created.json();
      assert.equal((await request(`/image-folders/${createdFolder.id}`, { name: "Renamed folder" })).status, 200);
      const changed = await request(`/images/${legacyId}`, { folderId: createdFolder.id, displayName: "My lake" });
      assert.equal(changed.status, 200);
      const loaded = await (await fetch(`${base}/images?folder=${createdFolder.id}`)).json();
      assert.equal(loaded.images[0].displayName, "My lake");
      assert.equal(loaded.images[0].prompt, "Original mountain lake prompt");
      assert.equal((await request(`/images/${legacyId}`, { displayName: "Intrusion" }, "PATCH", "other-owner")).status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
