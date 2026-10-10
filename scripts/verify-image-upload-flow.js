import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool } from "../src/db/client.js";
import { uploadRoot } from "../src/uploads/service.js";

const baseUrl = process.env.IMAGE_UPLOAD_TEST_BASE_URL ?? "http://127.0.0.1:3001";
const origin = process.env.IMAGE_UPLOAD_TEST_ORIGIN ?? "http://localhost:5173";
const verifyLocalFile = process.env.IMAGE_UPLOAD_TEST_SKIP_LOCAL_FILE_CHECK !== "true";
const email = `image-upload-test-${randomUUID()}@example.invalid`;
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
let userId;
let storedName;

async function jsonRequest(pathname, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: response.status === 204 ? null : await response.json() };
}

async function cleanup() {
  if (!userId) return;
  const uploaded = await pool.query("SELECT stored_name FROM attachments WHERE user_id = $1", [userId]);
  for (const row of uploaded.rows) await rm(path.join(uploadRoot, row.stored_name), { force: true });
  await pool.query("DELETE FROM usage_events WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM memory_facts WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM attachments WHERE user_id = $1", [userId]);
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
}

try {
  const signup = await jsonRequest("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password, name: "Image Upload Verification" },
  });
  assert.equal(signup.response.status, 200, JSON.stringify(signup.data));
  userId = signup.data.user?.id;
  assert.ok(userId, "Sign-up did not create a test user.");
  await pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [userId]);
  // This disposable account needs the paid capability only to verify that the
  // branded vision path accepts the private normalized image.
  await pool.query("INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'paid', 'active')", [userId]);
  const login = await jsonRequest("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
  assert.equal(login.response.status, 200, JSON.stringify(login.data));
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Sign-in did not create a session cookie.");

  const svg = Buffer.from(`<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="120" y="350" font-size="190" font-family="Arial" fill="black">2 + 2 = 4</text></svg>`);
  const image = await sharp(svg).withMetadata({ exif: { IFD0: { Artist: "remove-this-metadata" } } }).png().toBuffer();
  const formData = new FormData();
  formData.append("files", new Blob([image], { type: "image/png" }), "math.png");
  const uploadResponse = await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: formData });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(upload));
  assert.equal(upload.attachments[0].kind, "image");

  const [stored] = await pool.query("SELECT stored_name, kind, extracted_text, message_id FROM attachments WHERE id = $1 AND user_id = $2", [upload.attachments[0].id, userId]).then((result) => result.rows);
  assert.equal(stored.kind, "image");
  assert.equal(stored.extracted_text, null);
  assert.equal(stored.message_id, null);
  storedName = stored.stored_name;
  const storedPath = path.join(uploadRoot, storedName);
  if (verifyLocalFile) {
    await access(storedPath);
    const metadata = await sharp(await readFile(storedPath)).metadata();
    assert.equal(metadata.exif, undefined, "EXIF metadata was retained after normalization.");
    assert.ok((metadata.width ?? 0) <= 2048 && (metadata.height ?? 0) <= 2048, "Image was not resized safely.");
  }

  const freeChat = await jsonRequest("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "lumen", message: "What is written in this image?", attachmentIds: [upload.attachments[0].id] },
  });
  assert.equal(freeChat.response.status, 422, JSON.stringify(freeChat.data));
  assert.equal(freeChat.data.code, "vision-model-required");

  const paidChat = await jsonRequest("/api/chat", {
    method: "POST",
    cookie,
    body: { model: "nebula", message: "What equation is written in this image? Answer briefly.", attachmentIds: [upload.attachments[0].id] },
  });
  assert.equal(paidChat.response.status, 200, JSON.stringify(paidChat.data));
  assert.match(paidChat.data.reply, /2\s*\+\s*2\s*=\s*4|four/i, "The vision model did not read the test image.");

  const deleted = await jsonRequest("/api/account", { method: "DELETE", cookie });
  assert.equal(deleted.response.status, 204, "Account deletion did not complete.");
  const remaining = await pool.query(`SELECT
    (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
    (SELECT count(*)::int FROM attachments WHERE user_id = $1) AS attachments,
    (SELECT count(*)::int FROM conversations WHERE user_id = $1) AS conversations`, [userId]);
  assert.deepEqual(remaining.rows[0], { users: 0, attachments: 0, conversations: 0 });
  if (verifyLocalFile) await assert.rejects(() => access(storedPath));
  userId = undefined;
  console.log(JSON.stringify({ imageUpload: "ok", exifStripped: "ok", freeTierPrompt: "ok", nebulaVision: "ok", accountCleanup: "ok" }));
} finally {
  await cleanup();
  await pool.end();
}
