import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { attachments } from "../../src/db/schema.js";

// In-memory Postgres: never reads DATABASE_URL or accesses a production account.
export async function createImageLibraryFixture() {
  const client = new PGlite();
  for (const name of ["0000_zippy_rawhide_kid", "0001_file_uploads", "0014_image_mode"]) {
    await client.exec(await readFile(new URL(`../../drizzle/${name}.sql`, import.meta.url), "utf8"));
  }
  const { rows: [legacy] } = await client.query(`INSERT INTO attachments
    (user_id, original_name, stored_name, mime_type, kind, size_bytes, prompt)
    VALUES ('library-owner', 'original.png', 'original.png', 'image/png', 'generated-image', 1, 'Original mountain lake prompt') RETURNING id`);
  await client.exec(await readFile(new URL("../../drizzle/0019_image_folders.sql", import.meta.url), "utf8"));
  const db = drizzle(client);
  const sameTimestamp = new Date("2026-09-20T12:00:00Z");
  await db.insert(attachments).values(Array.from({ length: 30 }, (_, index) => ({
    userId: "library-owner", originalName: `fixture-${index}.png`, storedName: `fixture-${index}.png`,
    mimeType: "image/png", kind: "generated-image", sizeBytes: 1, prompt: `Fixture image ${index + 1}`,
    createdAt: sameTimestamp,
  })));
  const [other] = await db.insert(attachments).values({ userId: "other-owner", originalName: "private.png", storedName: "private.png", mimeType: "image/png", kind: "generated-image", sizeBytes: 1 }).returning();
  const [document] = await db.insert(attachments).values({ userId: "library-owner", originalName: "private.txt", storedName: "private.txt", mimeType: "text/plain", kind: "document", sizeBytes: 1 }).returning();
  return { client, db, legacyId: legacy.id, otherId: other.id, documentId: document.id };
}
