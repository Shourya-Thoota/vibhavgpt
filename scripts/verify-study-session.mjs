import { randomBytes } from "node:crypto";
// Local-only real-backend verification. Secrets come from the process, never source.
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
if (!process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error("A local database tunnel is required.");
process.env.DOTENV_CONFIG_PATH = ".env.study-verification-unused";
process.env.START_SERVER = "false";
process.env.BETTER_AUTH_SECRET = "study-verification-local-only-" + "s".repeat(40);
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
process.env.CLIENT_ORIGINS = "http://127.0.0.1:5191,http://127.0.0.1:3001";
process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
process.env.DATABASE_SSL = "false";
process.env.UPLOAD_STORAGE_PATH = path.resolve(".tmp/study-verification/uploads");
process.env.RESEND_API_KEY = "";
process.env.SENTRY_DSN = "";
process.env.STRIPE_SECRET_KEY = "";
if (!process.env.INFERENCE_ROUTER_API_KEY) throw new Error("INFERENCE_ROUTER_API_KEY must be supplied in the process environment; local key files are not supported.");
const { pool, db } = await import("../src/db/client.js");
pool.on("error", () => console.warn("Temporary tunnel connection closed; next query will reconnect."));
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const action = process.argv[2];
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;
const email = "study-phase1-verification@example.invalid";
if (action === "serve") {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Study migration applied.");
  const { startServer } = await import("../src/server.js");
  startServer();
} else if (action === "setup") {
  const response = await fetch("http://127.0.0.1:3001/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:5191", "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" }, body: JSON.stringify({ name: "Alex Study", email, password }) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  const id = result.user.id;
  await pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [id]);
  await pool.query("INSERT INTO subscriptions (user_id,tier,status) VALUES ($1,'plus','active')", [id]);
  await pool.query("INSERT INTO user_profiles (user_id,preferred_model,last_used_model) VALUES ($1,'nebula','nebula') ON CONFLICT(user_id) DO UPDATE SET preferred_model='nebula',last_used_model='nebula'", [id]);
  await mkdir(".tmp/study-verification", { recursive: true });
  const PDFDocument = (await import("pdfkit")).default;
  const pdf = new PDFDocument({ margin: 50 });
  const output = createWriteStream(".tmp/study-verification/ecology-notes.pdf");
  pdf.pipe(output); pdf.fontSize(20).text("Ecology field notes");
  pdf.moveDown().fontSize(12).text("Fictional classroom experiment. A 2-square-meter quadrat contains 18 daisies. Population density is the number of organisms divided by sampled area. Here density is 9 daisies per square meter. A second quadrat contains 8 daisies over 2 square meters: 4 daisies per square meter. Sample selection should be random to reduce bias. This small sample cannot establish the population size of the whole meadow.");
  pdf.end(); await new Promise((resolve) => output.on("finish", resolve));
  console.log(JSON.stringify({ account: email, id, document: "ecology-notes.pdf", note: "Only this disposable account was marked email-verified. No email was sent." }));
  await pool.end();
} else if (action === "inspect") {
  const result = await pool.query('SELECT p.product_mode,p.last_used_model,p.preferred_model FROM user_profiles p JOIN "user" u ON u.id=p.user_id WHERE u.email=$1', [email]);
  const docs = await pool.query('SELECT a.original_name,a.extracted_text,a.conversation_id FROM attachments a JOIN "user" u ON u.id=a.user_id WHERE u.email=$1', [email]);
  const turns = await pool.query('SELECT c.mode,m.role,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN "user" u ON u.id=c.user_id WHERE u.email=$1 ORDER BY m.created_at', [email]);
  const report = { preferences: result.rows, documents: docs.rows, turns: turns.rows };
  await writeFile(".tmp/study-verification/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await pool.end();
} else if (action === "cleanup") {
  const { deleteUserUploads } = await import("../src/uploads/service.js");
  const { rows } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
  for (const { id } of rows) {
    await deleteUserUploads(id);
    for (const table of ["credit_ledger", "usage_events", "memory_facts", "subscriptions", "user_profiles", "conversations"]) await pool.query(`DELETE FROM ${table} WHERE user_id=$1`, [id]);
    await pool.query('DELETE FROM "user" WHERE id=$1', [id]);
  }
  console.log({ disposableAccountsRemaining: (await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rowCount }); await pool.end();
} else { await pool.end(); throw new Error("Choose serve, setup, inspect, or cleanup."); }
