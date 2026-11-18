/**
 * "Add it to my Google Drive", end to end, with nothing real behind it: the real chat route, the real document generator (only its model
 * call is replaced), the real file store on a temporary disk, the real approval service and provider adapter, an isolated database, and a
 * stand-in for the connection gateway and its file storage over real HTTP on 127.0.0.1. Nothing reaches a real account.
 *
 * What is proven: the document already on the screen is the one that is uploaded, not a second copy; nothing is uploaded until a card naming the
 * file, folder and account is approved; the bytes the provider receives are the stored bytes; a failure, a missing connection, a missing
 * or changed file, or an answer that names no file is reported as exactly that and never as success; and a connector is routed by its
 * structured id, never by the words "@YouTube" in the text.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";
process.env.UPLOAD_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "drive-artifact-"));

// --- The stand-in gateway: tool calls (MCP), the file hand-off request, and the storage address it names. -------------------------------
const seen = { tools: [], fileRequests: [], puts: [], accessChecks: [] };
const gateway = {
  tool: () => ({}),
  fileRequestStatus: 200,
  putStatus: 200,
};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    if (gateway.toolDelayMs && req.url.startsWith("/mcp")) await new Promise((resolve) => setTimeout(resolve, gateway.toolDelayMs));
    if (req.method === "GET" && req.url.startsWith("/files-api/files/list")) {
      seen.accessChecks.push({ url: req.url, bodyBytes: body.length, apiKey: req.headers["x-api-key"] });
      res.writeHead(gateway.fileRequestStatus === 200 ? 200 : gateway.fileRequestStatus, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(gateway.fileRequestStatus === 200 ? { items: [] } : { error: { message: "Invalid API key: ck_**masked" } }));
    }
    if (req.url.startsWith("/files-api/files/upload/request")) {
      const parsed = JSON.parse(body.toString("utf8"));
      seen.fileRequests.push({ ...parsed, apiKeyPresent: Boolean(req.headers["x-api-key"]), apiKey: req.headers["x-api-key"] });
      if (gateway.fileRequestStatus !== 200) { res.writeHead(gateway.fileRequestStatus); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "f1", key: `stored/${parsed.filename}`, new_presigned_url: `http://127.0.0.1:${server.address().port}/put/${encodeURIComponent(parsed.filename)}`, type: "new" }));
    }
    if (req.method === "PUT" && req.url.startsWith("/put/")) {
      seen.puts.push({ name: decodeURIComponent(req.url.slice(5)), bytes: body, contentType: req.headers["content-type"] });
      res.writeHead(gateway.putStatus);
      return res.end();
    }
    const rpc = JSON.parse(body.toString("utf8") || "{}");
    const call = rpc.params?.arguments ?? {};
    if (rpc.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL") seen.tools.push({ slug: call.tools?.[0]?.tool_slug, arguments: call.tools?.[0]?.arguments, account: call.tools?.[0]?.account });
    const envelope = rpc.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL" ? gateway.tool(call.tools?.[0]?.tool_slug, call.tools?.[0]?.arguments) : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${server.address().port}/mcp`;
process.env.COMPOSIO_FILES_URL = `http://127.0.0.1:${server.address().port}/files-api`;
process.env.COMPOSIO_API_KEY = "ck_test_gateway_key_not_a_real_key";

// --- An isolated database, a signed-in stand-in, and a model call that returns a fixed plan. -------------------------------------------------
const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);
const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
for (const entry of journal.entries) await client.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
const db = drizzle(client);
mock.module(new URL("../src/db/client.js", import.meta.url).href, { namedExports: { db, pool: { query: (text, params) => client.query(text, params) } } });
mock.module(new URL("../src/middleware/require-session.js", import.meta.url).href, {
  namedExports: {
    requireSession: (req, res, next) => (req.authSession ? next() : res.status(401).json({ error: "Sign in is required." })),
    loadOptionalSession: (_req, _res, next) => next(),
  },
});
const planHref = new URL("../src/generation/document-plan.js", import.meta.url).href;
const realPlan = await import(planHref);
let planCalls = 0;
mock.module(planHref, {
  namedExports: {
    ...realPlan,
    buildDocumentPlan: async () => {
      planCalls += 1;
      return {
        plan: { title: "Cell Biology Guide", sections: [{ heading: "Cells", body: "Cells are the basic units of life. Every living thing is made of cells that carry out the work keeping it alive." }, { heading: "Organelles", body: "Organelles are small structures inside a cell, each with its own job, such as making energy or storing information." }] },
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      };
    },
  },
});

const schema = await import("../src/db/schema.js");
const { config } = await import("../src/config.js");
const { default: express } = await import("express");
const { chatRouter, filterToolsForEnabledConnectors } = await import("../src/chat/router.js");
const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
const { connectUserConnector, approveAndExecuteAction, getActionForUser, reconcileUncertainAction } = await import("../src/connectors/service.js");
const { eq, and } = await import("drizzle-orm");
test.after(async () => { server.closeAllConnections?.(); server.close(); await client.close(); });

// Lumen must look configured for the chat route to take requests; it is never called (documents and Drive requests do not reach a model).
for (const [stage, key] of [["primaryFree", "lumen"], ["gatewayFree", "lumenFallback1"]]) {
  config.providerKeys[stage] = "fixture-key";
  config.providerBaseUrls[stage] = `https://${stage.toLowerCase()}.fixture.test/v1`;
  config.chatModels[key] = `fixture-${stage}`;
}
config.lumenPrimaryApproved = true;
config.lumenApprovals.gateway = { approved: true, model: "fixture-gatewayFree" };
config.moderationApiKey = "";
config.moderationDataPolicyApproved = false;

const ACCOUNT = "googledrive_test-account";
let counter = 0;
async function addUser({ drive = true, scopes = [], metadata = { accountName: "Test Account" } } = {}) {
  const id = `drive-user-${++counter}`;
  await client.query(`INSERT INTO "user" (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, `${id}@example.com`]);
  await client.query("INSERT INTO user_profiles (user_id, memory_enabled) VALUES ($1, false) ON CONFLICT DO NOTHING", [id]);
  await db.insert(schema.subscriptions).values({ userId: id, tier: "plus", status: "active", currentPeriodStartedAt: new Date(Date.now() - 10 * 86_400_000), currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000), billingSource: "stripe" });
  if (drive) await connectUserConnector(id, "googledrive", { accessToken: `comp_live_${ACCOUNT}`, scopes, metadata: { id: ACCOUNT, accountId: ACCOUNT, status: "active", ...metadata } });
  return id;
}

async function chat(t, userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authSession = { user: { id: userId } }; next(); });
  app.use("/api/chat", chatRouter);
  app.use((error, _req, res, _next) => res.status(error?.status ?? 500).json({ error: String(error?.message ?? error) }));
  const listener = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const base = `http://127.0.0.1:${listener.address().port}`;
  return async (message, extra = {}) => {
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "lumen", message, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
}

const reset = () => { seen.tools.length = 0; seen.fileRequests.length = 0; seen.puts.length = 0; seen.accessChecks.length = 0; planCalls = 0; gateway.fileRequestStatus = 200; gateway.putStatus = 200; };
const uploaded = (id = "drive_file_123") => ({ successful: true, data: { results: [{ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", response: { successful: true, data: { id, name: "cell-biology-guide.pdf" } } }] }, log_id: "log_ok" });
const folderList = (folders) => ({ successful: true, data: { results: [{ tool_slug: "GOOGLEDRIVE_FIND_FOLDER", response: { successful: true, data: { files: folders } } }] }, log_id: "log_ok" });
const generatedFiles = (userId) => db.select().from(schema.attachments).where(and(eq(schema.attachments.userId, userId), eq(schema.attachments.kind, "generated-file")));
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const uploadsOf = () => seen.tools.filter((call) => call.slug === "GOOGLEDRIVE_UPLOAD_FILE" || call.slug === "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT");

// Makes the document, then asks for it to go to Drive; returns what a person would see after each step.
async function documentThenDrive(t, { drive = true, driveRequest = "add it to my google drive", userId = null } = {}) {
  const id = userId ?? await addUser({ drive });
  const say = await chat(t, id);
  const made = await say("Make a PDF about cell biology");
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const conversationId = made.body.conversationId;
  reset();
  const asked = await say(driveRequest, { conversationId });
  return { userId: id, say, conversationId, made, asked };
}

// -------------------------------------------------------------------------------------------------------------------------------------
test("A. a generated PDF, then 'add it to my google drive': the same file is prepared for approval, then uploaded once, confirmed", async (t) => {
  const { userId, made, asked } = await documentThenDrive(t);
  const [artifact] = await generatedFiles(userId);
  assert.equal(artifact.originalName, "cell-biology-guide.pdf", "named from its content, not vibhavgpt-document.pdf");
  assert.equal(made.body.attachment.name, "cell-biology-guide.pdf");

  // The follow-up prepares the existing file. It makes no new document and uploads nothing yet.
  assert.equal(asked.status, 200);
  assert.equal(planCalls, 0, "no second document was generated");
  assert.equal((await generatedFiles(userId)).length, 1, "no duplicate PDF exists");
  // Before approval: nothing about the file leaves the app. The only call is a check that the file service accepts our credential, and it carries no
  // artifact data at all: a GET with no body, no filename and no checksum, and it creates nothing.
  assert.equal(seen.tools.length + seen.puts.length + seen.fileRequests.length, 0, "no upload, no bytes and no upload slot before approval");
  assert.equal(seen.accessChecks.length, 1, "one credential check");
  assert.deepEqual([seen.accessChecks[0].url, seen.accessChecks[0].bodyBytes], ["/files-api/files/list?limit=1", 0], "a plain GET that names nothing about the file");
  const pending = asked.body.pendingAction;
  assert.ok(pending, "an approval card was prepared");
  assert.equal(pending.payload.attachmentId, artifact.id, "the card is bound to the file on the screen");
  assert.equal(pending.payload.fileName, "cell-biology-guide.pdf");
  assert.equal(pending.payload.folderName, "My Drive", "the destination is stated, not implied");
  assert.match(pending.actionDescription, /cell-biology-guide\.pdf.*PDF.*My Drive.*Test Account/);
  assert.match(asked.body.reply, /nothing has been uploaded yet/i);
  assert.ok(!/created your/i.test(asked.body.reply), "the reply does not claim a document was made");
  assert.ok(!JSON.stringify(asked.body).includes(artifact.storedName), "no storage path or private URL is shown");

  // Approval performs exactly the approved upload, with the stored bytes.
  gateway.tool = () => uploaded();
  const done = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(done.status, "completed");
  assert.equal(done.result.id, "drive_file_123");
  assert.match(done.result.webViewLink, /drive_file_123/, "the link comes from the file id Drive returned");
  const stored = fs.readFileSync(path.join(process.env.UPLOAD_STORAGE_PATH, artifact.storedName));
  assert.equal(seen.fileRequests.length, 1, "the one real hand-off happens only after approval");
  assert.deepEqual([seen.fileRequests.at(-1).filename, seen.fileRequests.at(-1).mimetype, seen.fileRequests.at(-1).toolkit_slug, seen.fileRequests.at(-1).tool_slug], ["cell-biology-guide.pdf", "application/pdf", "googledrive", "GOOGLEDRIVE_UPLOAD_FILE"]);
  assert.equal(seen.fileRequests.at(-1).md5, createHash("md5").update(stored).digest("hex"));
  assert.equal(seen.puts.length, 1);
  assert.equal(sha(seen.puts[0].bytes), sha(stored), "the bytes handed over are the stored document's bytes");
  assert.equal(uploadsOf().length, 1, "one upload");
  assert.deepEqual(uploadsOf()[0].arguments.file_to_upload, { name: "cell-biology-guide.pdf", mimetype: "application/pdf", s3key: "stored/cell-biology-guide.pdf" });
  assert.equal(uploadsOf()[0].arguments.folder_to_upload_to, undefined, "no folder means the top of My Drive");
  assert.equal(uploadsOf()[0].account, ACCOUNT, "the account that was connected, not a default");
  // Approving again does nothing more.
  seen.tools.length = 0;
  assert.equal((await approveAndExecuteAction(userId, pending.id, pending.payloadHash)).status, "completed");
  assert.equal(seen.tools.length, 0);
});

test("A. a text document is uploaded as text with its own type, and a named folder is looked up and used", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a markdown file about cell biology");
  assert.equal(made.body.attachment.name, "cell-biology-guide.md");
  reset();
  gateway.tool = (slug) => (slug === "GOOGLEDRIVE_FIND_FOLDER" ? folderList([{ id: "1AbCdEfGhIjKlMnOpQr", name: "School", modifiedTime: "2026-01-02T00:00:00Z" }]) : uploaded("text_file_1"));
  const asked = await say("put it in my School folder on google drive", { conversationId: made.body.conversationId });
  const pending = asked.body.pendingAction;
  assert.ok(pending, JSON.stringify(asked.body));
  assert.equal(pending.payload.folderId, "1AbCdEfGhIjKlMnOpQr");
  assert.match(pending.actionDescription, /“School”/);
  const lookup = seen.tools.find((call) => call.slug === "GOOGLEDRIVE_FIND_FOLDER");
  assert.ok(lookup && lookup.account === ACCOUNT, "the folder was looked up in the connected account");
  assert.equal(uploadsOf().length, 0, "looking up a folder is a read; nothing was uploaded");
  const done = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(done.status, "completed");
  const sent = uploadsOf()[0];
  assert.equal(sent.slug, "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT");
  assert.equal(sent.arguments.parent_id, "1AbCdEfGhIjKlMnOpQr");
  assert.equal(sent.arguments.mime_type, "text/markdown");
  assert.match(sent.arguments.text_content, /^# Cell Biology Guide/);
  assert.equal(seen.fileRequests.length, 0, "a text file needs no hand-off");
});

test("B. Drive rejects the upload: the failure is reported as it is, nothing is retried, and no second document is made", async (t) => {
  const { userId, asked } = await documentThenDrive(t);
  gateway.tool = () => ({ successful: false, error: "1 out of 1 tools failed", data: { results: [{ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", error: "Insufficient permission to create files", response: { successful: false, data: { error: "Insufficient permission" } } }] }, log_id: "log_x" });
  const pending = asked.body.pendingAction;
  const result = await approveAndExecuteAction(userId, pending.id, pending.payloadHash).then((r) => r, (e) => e);
  assert.ok(result instanceof Error, "the approval reports an error");
  const action = await getActionForUser(userId, pending.id);
  assert.equal(action.status, "failed");
  assert.ok(action.result.error && !action.result.id);
  assert.equal(uploadsOf().length, 1, "tried once");
  const again = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(again.status, "failed", "approving again does not run it again");
  assert.equal(uploadsOf().length, 1);
  assert.equal(planCalls, 0, "no document was generated to make up for it");
  assert.equal((await generatedFiles(userId)).length, 1);
});

test("B. the hand-over of the file fails: nothing is uploaded and the person is told that, not that it was done", async (t) => {
  const { userId, asked } = await documentThenDrive(t);
  gateway.fileRequestStatus = 401;
  const pending = asked.body.pendingAction;
  await assert.rejects(approveAndExecuteAction(userId, pending.id, pending.payloadHash), /couldn't hand the file over/i);
  const action = await getActionForUser(userId, pending.id);
  assert.equal(action.status, "failed");
  assert.equal(action.result.code, "file_transfer_failed");
  assert.equal(action.result.dispatchStatus, "pre_dispatch_failure", "failed before anything touched Drive");
  assert.match(action.result.error, /nothing was uploaded/i);
  assert.equal(uploadsOf().length, 0);
  assert.ok(!/composio|401/i.test(action.result.error), "no vendor name or raw status is shown");
});

test("B. Drive answers 'ok' but names no file: it is recorded as unconfirmed, never as uploaded", async (t) => {
  const { userId, asked } = await documentThenDrive(t);
  gateway.tool = () => ({ successful: true, data: { results: [{ tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", response: { successful: true, data: {} } }] }, log_id: "log_empty" });
  const pending = asked.body.pendingAction;
  const action = await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  assert.equal(action.status, "uncertain");
  assert.notEqual(action.status, "completed");
  assert.match(action.result.error, /did not confirm a file/i);
  assert.equal(uploadsOf().length, 1);
  assert.equal((await approveAndExecuteAction(userId, pending.id, pending.payloadHash)).status, "uncertain");
  assert.equal(uploadsOf().length, 1, "never sent again on its own");
});

test("C. Drive is not connected: the person is told what to connect, and nothing is prepared or sent", async (t) => {
  const { userId, asked } = await documentThenDrive(t, { drive: false });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.pendingAction, undefined);
  assert.match(asked.body.reply, /isn't connected|turned off/i);
  assert.match(asked.body.reply, /Extensions/);
  assert.match(asked.body.reply, /nothing was uploaded/i);
  assert.equal(planCalls, 0, "no PDF was made in reply");
  assert.equal(seen.tools.length + seen.fileRequests.length, 0);
  assert.equal((await generatedFiles(userId)).length, 1);
});

test("C. Drive is connected read-only: the person is told to allow file creation", async (t) => {
  const userId = await addUser({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const { asked } = await documentThenDrive(t, { userId });
  assert.equal(asked.body.pendingAction, undefined);
  assert.match(asked.body.reply, /only read files/i);
  assert.equal(seen.tools.length, 0);
});

test("D. a folder name that matches more than one folder, or none, gets a targeted question and prepares nothing", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  reset();
  gateway.tool = () => folderList([{ id: "1AbCdEfGhIjKlMnOpQr", name: "Reports", modifiedTime: "2026-01-02T00:00:00Z" }, { id: "1ZyXwVuTsRqPoNmLkJi", name: "Reports", modifiedTime: "2025-06-01T00:00:00Z" }]);
  const two = await say("add it to my Reports folder in google drive", { conversationId: made.body.conversationId });
  assert.equal(two.body.pendingAction, undefined);
  assert.match(two.body.reply, /more than one folder/i);
  assert.match(two.body.reply, /“Reports”.*2026-01-02/);
  assert.equal(uploadsOf().length, 0);

  gateway.tool = () => folderList([]);
  const none = await say("add it to my Archive folder in google drive", { conversationId: made.body.conversationId });
  assert.equal(none.body.pendingAction, undefined);
  assert.match(none.body.reply, /couldn't find a folder named “Archive”/i);
  assert.match(none.body.reply, /won't create one without asking/i);
  assert.equal(uploadsOf().length, 0);

  gateway.tool = () => { throw new Error("unused"); };
});

test("E. the file is gone before the follow-up: the person is told, offered a way forward, and nothing is faked", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  const [artifact] = await generatedFiles(userId);
  fs.rmSync(path.join(process.env.UPLOAD_STORAGE_PATH, artifact.storedName));
  reset();
  const asked = await say("add it to my google drive", { conversationId: made.body.conversationId });
  assert.equal(asked.body.pendingAction, undefined);
  assert.match(asked.body.reply, /could not be read from storage|no longer/i);
  assert.match(asked.body.reply, /make it again/i);
  assert.equal(planCalls, 0, "it is not silently regenerated");
  assert.equal(seen.tools.length + seen.fileRequests.length, 0);
});

test("E. the file disappears or changes between the card and the approval: nothing is uploaded and the reason is stated", async (t) => {
  const first = await documentThenDrive(t);
  const [artifact] = await generatedFiles(first.userId);
  const location = path.join(process.env.UPLOAD_STORAGE_PATH, artifact.storedName);
  const original = fs.readFileSync(location);
  fs.writeFileSync(location, Buffer.concat([original, Buffer.from("tampered")]));
  const pending = first.asked.body.pendingAction;
  await assert.rejects(approveAndExecuteAction(first.userId, pending.id, pending.payloadHash), /not the one you approved/i);
  assert.equal((await getActionForUser(first.userId, pending.id)).result.code, "artifact_changed");
  assert.equal(seen.tools.length + seen.puts.length, 0, "nothing was handed over or uploaded");

  const second = await documentThenDrive(t);
  const [other] = await generatedFiles(second.userId);
  fs.rmSync(path.join(process.env.UPLOAD_STORAGE_PATH, other.storedName));
  const pendingTwo = second.asked.body.pendingAction;
  await assert.rejects(approveAndExecuteAction(second.userId, pendingTwo.id, pendingTwo.payloadHash), /could not be read from storage|no longer/i);
  assert.equal((await getActionForUser(second.userId, pendingTwo.id)).result.code, "artifact_missing");
});

test("E. another person's document can never be uploaded: a card for it cannot be approved by someone else", async (t) => {
  const owner = await documentThenDrive(t);
  const stranger = await addUser();
  const pending = owner.asked.body.pendingAction;
  await assert.rejects(approveAndExecuteAction(stranger, pending.id, pending.payloadHash), /not found or unauthorized/i);
  assert.equal(seen.tools.length + seen.puts.length, 0);
});

test("F. the connector chosen by an inline mention is routed by its structured id; the words '@YouTube' in the text route nothing", async () => {
  const names = (tools) => tools.map((tool) => tool.function.name);
  const enabled = { googledrive: true, youtube: true };
  const only = names(filterToolsForEnabledConnectors(CHAT_TOOLS, { connectorEnabled: enabled, selectedConnectors: ["youtube"] }));
  assert.ok(only.includes("youtube_search"), "the mentioned connector's tools are offered");
  assert.ok(!only.includes("google_drive_upload_file"), "another connector's tools are not");
  // The text alone changes nothing: tool routing only ever reads the structured list, so display text can't select a connector.
  const text = names(filterToolsForEnabledConnectors(CHAT_TOOLS, { connectorEnabled: enabled, selectedConnectors: [] }));
  assert.ok(text.includes("youtube_search") && text.includes("google_drive_upload_file"), "with no structured selection nothing is narrowed by the message text");
  const routerSource = fs.readFileSync(new URL("../src/chat/router.js", import.meta.url), "utf8");
  assert.doesNotMatch(routerSource, /content\.match\(\/@\w|message\.match\(\/@\w|\/@\[\^/, "no code path reads @names out of the message");
  // A structured id the person does not own is dropped, whatever the text says.
  assert.match(routerSource, /ownedConnectedConnectors\.has\(id\)/);
});

test("F. mentioning a connector does not authorise a write: the upload still waits for an approval, and 'selectedConnectors' alone changes nothing about it", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  reset();
  const asked = await say("@Google Drive add it to my google drive", { conversationId: made.body.conversationId, selectedConnectors: ["googledrive"] });
  assert.ok(asked.body.pendingAction, "a card to approve was prepared");
  assert.equal(seen.tools.length + seen.puts.length, 0, "the mention uploaded nothing");
  assert.equal((await getActionForUser(userId, asked.body.pendingAction.id)).status, "pending");
});

test("questions about Drive are not mistaken for requests to upload", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const { isDriveUploadRequest } = await import("../src/connectors/drive-upload.js");
  assert.equal(isDriveUploadRequest("add it to my google drive"), true);
  assert.equal(isDriveUploadRequest("save it to drive"), true);
  assert.equal(isDriveUploadRequest("how do I upload a file to google drive?"), false);
  assert.equal(isDriveUploadRequest("what is google drive"), false);
  assert.ok(say, "route available");
});

// --- What the real test on production showed ----------------------------------------------------------------------------------------------
// The approval card named the account by the connection's internal alias, and a PDF was offered for approval although the file hand-off was
// going to be refused (HTTP 401). The card must not show an internal alias, and a binary upload that cannot work must not ask for approval.

test("the approval card never shows the connection's internal alias as the account", async (t) => {
  const aliasOnly = await addUser({ metadata: { accountName: "googledrive_unsin-besin" } });
  const a = await documentThenDrive(t, { userId: aliasOnly });
  assert.ok(a.asked.body.pendingAction, "a card was prepared");
  assert.doesNotMatch(JSON.stringify(a.asked.body), /googledrive_unsin-besin|googledrive_[a-z]+-[a-z]+/i, "the alias is not shown, in the card or the reply");
  assert.equal(a.asked.body.pendingAction.payload.accountLabel, undefined, "and it is not kept in what is approved");
  assert.match(a.asked.body.pendingAction.actionDescription, /Google Drive: My Drive$/, "the card names the destination without an account it cannot name");

  const named = await addUser({ metadata: { accountName: "googledrive_x-y", email: "owner@example.com" } });
  const b = await documentThenDrive(t, { userId: named });
  assert.match(b.asked.body.pendingAction.actionDescription, /My Drive, owner@example\.com$/, "a real email is shown when there is one");
});

test("a PDF is not offered for approval when the file hand-off is refused, and the person is told plainly; text files are unaffected", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  reset();
  gateway.fileRequestStatus = 401;
  const asked = await say("add it to my google drive", { conversationId: made.body.conversationId });
  assert.equal(asked.body.pendingAction, undefined, "no card for an upload that cannot work");
  assert.match(asked.body.reply, /can't upload (a )?PDF.*right now|isn't available/i);
  assert.match(asked.body.reply, /nothing was uploaded/i);
  assert.doesNotMatch(asked.body.reply, /composio|401|api key|credential/i, "no vendor name, status or credential talk to the person");
  assert.equal(seen.puts.length, 0, "no bytes were sent anywhere");
  assert.equal(uploadsOf().length, 0);
  assert.equal(seen.fileRequests.length, 0, "no upload slot was requested for a file nobody had approved");
  assert.ok(!JSON.stringify(seen.accessChecks).includes("cell-biology"), "the check named no file");
  const pending = await db.select().from(schema.pendingToolActions).where(eq(schema.pendingToolActions.userId, userId));
  assert.equal(pending.length, 0, "no approval was created");

  // A text document needs no hand-off, so the same refusal does not stop it.
  const text = await chat(t, userId);
  const madeText = await text("Make a markdown file about cell biology");
  gateway.tool = () => uploaded("text_1");
  const askedText = await text("add it to my google drive", { conversationId: madeText.body.conversationId });
  assert.ok(askedText.body.pendingAction, "a text file still gets its card");
  gateway.fileRequestStatus = 200;
});

test("a dedicated files key is used for the file hand-off when one is set, and the tool key is used otherwise", async (t) => {
  const userId = await addUser();
  const first = await documentThenDrive(t, { userId });
  gateway.tool = () => uploaded("file_a");
  await approveAndExecuteAction(userId, first.asked.body.pendingAction.id, first.asked.body.pendingAction.payloadHash);
  assert.equal(seen.fileRequests.at(-1).apiKey, "ck_test_gateway_key_not_a_real_key", "without a dedicated key the existing key is used, as before");

  process.env.COMPOSIO_FILES_API_KEY = "files_key_for_test_only";
  t.after(() => { delete process.env.COMPOSIO_FILES_API_KEY; });
  const second = await documentThenDrive(t, { userId });
  gateway.tool = () => uploaded("file_b");
  await approveAndExecuteAction(userId, second.asked.body.pendingAction.id, second.asked.body.pendingAction.payloadHash);
  assert.ok(seen.fileRequests.some((request) => request.apiKey === "files_key_for_test_only"), "the dedicated key reached the file hand-off");
  assert.ok(seen.fileRequests.every((request) => request.apiKey !== undefined));
  assert.equal(uploadsOf().at(-1).account, ACCOUNT);
});

// --- binding, and what the pre-flight may reveal -------------------------------------------------------------------------------------------------

test("an approval is bound to the connected account it was prepared for: if the account changes before approval, nothing is uploaded", async (t) => {
  const userId = await addUser();
  const prepared = await documentThenDrive(t, { userId });
  const pending = prepared.asked.body.pendingAction;
  assert.ok(pending.payload.accountRef, "the card carries an opaque reference to the account, not its alias");
  assert.ok(!JSON.stringify(pending).includes(ACCOUNT), "the connection's internal alias is not in the card or its payload");
  // The person disconnects and connects a different Drive account before approving.
  await connectUserConnector(userId, "googledrive", { accessToken: "comp_live_other", scopes: [], metadata: { id: "googledrive_other-account", accountId: "googledrive_other-account", status: "active" } });
  reset();
  gateway.tool = () => uploaded("should_not_happen");
  await assert.rejects(approveAndExecuteAction(userId, pending.id, pending.payloadHash), /account changed/i);
  const action = await getActionForUser(userId, pending.id);
  assert.equal(action.status, "failed");
  assert.equal(action.result.code, "account_changed");
  assert.equal(action.result.dispatchStatus, "pre_dispatch_failure");
  assert.equal(seen.tools.length + seen.puts.length + seen.fileRequests.length, 0, "no hand-off and no upload went anywhere");
});

test("the file service credential never appears in a log, an error, a reply or an approval card", async (t) => {
  const canary = "files_key_CANARY_9f31c7e2d0a4b658";
  process.env.COMPOSIO_FILES_API_KEY = canary;
  t.after(() => { delete process.env.COMPOSIO_FILES_API_KEY; });
  const lines = [];
  const original = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  for (const level of Object.keys(original)) console[level] = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => Object.assign(console, original));
  const userId = await addUser();
  // Refused at the check: the person is told, and nothing carries the key.
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  reset();
  gateway.fileRequestStatus = 401;
  const refused = await say("add it to my google drive", { conversationId: made.body.conversationId });
  assert.equal(seen.accessChecks[0].apiKey, canary, "the key was used for the check");
  assert.ok(!JSON.stringify(refused.body).includes(canary), "not in the reply");
  // Accepted at the check but refused at the hand-off after approval: not in the action's error either.
  gateway.fileRequestStatus = 200;
  const prepared = await documentThenDrive(t, { userId });
  gateway.fileRequestStatus = 200;
  const pending = prepared.asked.body.pendingAction;
  assert.ok(!JSON.stringify(pending).includes(canary), "not in the approval card");
  gateway.tool = () => uploaded("canary_ok");
  await approveAndExecuteAction(userId, pending.id, pending.payloadHash);
  const action = await getActionForUser(userId, pending.id);
  assert.ok(!JSON.stringify(action).includes(canary), "not in the saved action");
  assert.ok(lines.some((line) => line.includes("drive_file_service_unavailable")), "the log was captured, so its absence of the key means something");
  assert.ok(!lines.join("\n").includes(canary), "not in any log line");
});

// --- duplicate uploads: repeated and concurrent approvals --------------------------------------------------------------------------------------

test("three simultaneous approvals of one card upload once", async (t) => {
  const { userId, asked } = await documentThenDrive(t);
  const pending = asked.body.pendingAction;
  gateway.tool = () => uploaded("only_one");
  gateway.toolDelayMs = 60;
  t.after(() => { gateway.toolDelayMs = 0; });
  await Promise.all([1, 2, 3].map(() => approveAndExecuteAction(userId, pending.id, pending.payloadHash).catch(() => null)));
  assert.equal(uploadsOf().length, 1, "one Drive upload");
  assert.equal(seen.puts.length, 1, "one hand-over of the bytes");
  assert.equal((await getActionForUser(userId, pending.id)).status, "completed");
});

test("asking twice makes two cards, and approving both one after the other uploads once", async (t) => {
  const { userId, say, conversationId, asked } = await documentThenDrive(t);
  const second = await say("add it to my google drive", { conversationId });
  const [a, b] = [asked.body.pendingAction, second.body.pendingAction];
  assert.ok(a && b && a.id !== b.id, "two distinct cards");
  gateway.tool = () => uploaded("first_only");
  assert.equal((await approveAndExecuteAction(userId, a.id, a.payloadHash)).status, "completed");
  const again = await approveAndExecuteAction(userId, b.id, b.payloadHash);
  assert.equal(again.status, "completed");
  assert.equal(uploadsOf().length, 1, "the second card did not upload again");
  assert.equal(again.deduped, true, "and it says it was already uploaded");
});

test("two cards for the same file approved at the same moment upload once", async (t) => {
  const { userId, say, conversationId, asked } = await documentThenDrive(t);
  const second = await say("add it to my google drive", { conversationId });
  const [a, b] = [asked.body.pendingAction, second.body.pendingAction];
  gateway.tool = () => uploaded("race");
  gateway.toolDelayMs = 80;
  t.after(() => { gateway.toolDelayMs = 0; });
  const results = await Promise.all([a, b].map((card) => approveAndExecuteAction(userId, card.id, card.payloadHash).catch((error) => ({ error: String(error.message) }))));
  assert.equal(uploadsOf().length, 1, `exactly one Drive upload, got ${uploadsOf().length}`);
  assert.equal(seen.puts.length, 1, "one hand-over of the bytes");
  const statuses = await Promise.all([a, b].map(async (card) => (await getActionForUser(userId, card.id)).status));
  assert.ok(statuses.includes("completed"), "one is completed");
  assert.ok(!statuses.includes("in_progress"), "none is left hanging");
  assert.ok(results.length === 2);
});

test("an account whose id and accountId differ is not reported as 'changed' when nothing changed", async (t) => {
  const userId = await addUser({ metadata: { accountName: "Two Ids", id: "googledrive_alias-one", accountId: "googledrive_alias-two" } });
  const prepared = await documentThenDrive(t, { userId });
  const pending = prepared.asked.body.pendingAction;
  assert.ok(pending, "a card was prepared");
  gateway.tool = () => uploaded("same_account");
  assert.equal((await approveAndExecuteAction(userId, pending.id, pending.payloadHash)).status, "completed");
  assert.equal(uploadsOf().length, 1);
});

test("a struggling file service (503) does not turn into a refusal: the card is prepared and the upload reports its own failure", async (t) => {
  const userId = await addUser();
  const say = await chat(t, userId);
  const made = await say("Make a PDF about cell biology");
  reset();
  gateway.fileRequestStatus = 503;
  const asked = await say("add it to my google drive", { conversationId: made.body.conversationId });
  assert.ok(asked.body.pendingAction, "a card was prepared; only a refused credential stops it");
  assert.equal(seen.tools.length + seen.puts.length, 0, "nothing was uploaded before approval");
});

test("an in-flight twin that has outlived any bounded upload is not free to repeat: it becomes uncertain and blocks until a person settles it", async (t) => {
  const { userId, say, conversationId, asked } = await documentThenDrive(t);
  const second = await say("add it to my google drive", { conversationId });
  const [a, b] = [asked.body.pendingAction, second.body.pendingAction];
  await client.query("UPDATE pending_tool_actions SET status = 'in_progress', updated_at = now() - interval '10 minutes' WHERE id = $1", [a.id]);
  gateway.tool = () => uploaded("must_not_happen");
  await assert.rejects(approveAndExecuteAction(userId, b.id, b.payloadHash), /did not report back/i);
  assert.equal(uploadsOf().length, 0, "no second upload was attempted");
  assert.equal((await getActionForUser(userId, a.id)).status, "uncertain", "the abandoned claim is recorded as unconfirmed, not forgotten");
  assert.equal((await getActionForUser(userId, b.id)).status, "pending", "the second card stays usable");

  // The person checks their Drive and says it is not there: the file can be sent again, once.
  await assert.rejects(reconcileUncertainAction("someone-else", a.id, "not_uploaded"), /not found or unauthorized/i);
  const settled = await reconcileUncertainAction(userId, a.id, "not_uploaded");
  assert.equal(settled.status, "failed");
  assert.equal(settled.result.code, "reconciled_not_uploaded");
  assert.equal((await approveAndExecuteAction(userId, b.id, b.payloadHash)).status, "completed");
  assert.equal(uploadsOf().length, 1);
  await assert.rejects(reconcileUncertainAction(userId, b.id, "uploaded"), /did not report back can be settled/i, "a finished upload cannot be re-settled");
});

test("an uncertain upload that the person confirms is in Drive is recorded as done and never repeated", async (t) => {
  const { userId, say, conversationId, asked } = await documentThenDrive(t);
  const second = await say("add it to my google drive", { conversationId });
  const [a, b] = [asked.body.pendingAction, second.body.pendingAction];
  await client.query("UPDATE pending_tool_actions SET status = 'uncertain', result = '{\"dispatchStatus\":\"dispatch_uncertain\"}'::jsonb WHERE id = $1", [a.id]);
  gateway.tool = () => uploaded("must_not_happen");
  await assert.rejects(approveAndExecuteAction(userId, b.id, b.payloadHash), /did not report back/i);
  await reconcileUncertainAction(userId, a.id, "uploaded");
  const again = await approveAndExecuteAction(userId, b.id, b.payloadHash);
  assert.equal(again.status, "completed");
  assert.equal(again.deduped, true, "recognised as already uploaded");
  assert.equal(uploadsOf().length, 0, "nothing was sent");
});

test("a fresh in-flight twin does block, and says why without claiming anything was uploaded", async (t) => {
  const { userId, say, conversationId, asked } = await documentThenDrive(t);
  const second = await say("add it to my google drive", { conversationId });
  const [a, b] = [asked.body.pendingAction, second.body.pendingAction];
  await client.query("UPDATE pending_tool_actions SET status = 'in_progress', updated_at = now() WHERE id = $1", [a.id]);
  await assert.rejects(approveAndExecuteAction(userId, b.id, b.payloadHash), /already being uploaded/i);
  assert.equal(uploadsOf().length, 0);
  assert.equal((await getActionForUser(userId, b.id)).status, "pending", "the second card stays usable");
});

test("a worker still running when its claim was marked unconfirmed and then settled by the person cannot overwrite that settlement", async (t) => {
  const { userId, asked } = await documentThenDrive(t);
  const pending = asked.body.pendingAction;
  gateway.tool = () => uploaded("late_answer");
  gateway.toolDelayMs = 500;
  t.after(() => { gateway.toolDelayMs = 0; });
  const running = approveAndExecuteAction(userId, pending.id, pending.payloadHash).catch((error) => error);
  for (let i = 0; i < 100; i += 1) {
    const row = await client.query("SELECT result ->> 'dispatchStatus' AS s FROM pending_tool_actions WHERE id = $1", [pending.id]);
    if (row.rows[0]?.s === "dispatch_started") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The claim is treated as abandoned, and the person (who checked their Drive) says the file is not there.
  await client.query("UPDATE pending_tool_actions SET status = 'uncertain', result = '{\"code\":\"claim_abandoned\"}'::jsonb WHERE id = $1", [pending.id]);
  await reconcileUncertainAction(userId, pending.id, "not_uploaded");
  await running;
  const action = await getActionForUser(userId, pending.id);
  assert.equal(action.status, "failed", "the person's settlement stands");
  assert.equal(action.result.code, "reconciled_not_uploaded");
  assert.ok(!JSON.stringify(action.result).includes("late_answer"), "the late answer did not overwrite it");
  assert.equal(uploadsOf().length, 1, "the original worker's single upload is the only one: reconciling started nothing");
});
