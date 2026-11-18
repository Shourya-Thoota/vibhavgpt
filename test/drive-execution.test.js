/**
 * Drive execution path. Provider calls use a labeled boundary double.
 * Nothing here uploads into a real Google Drive.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const adapterHref = new URL("../src/connectors/composio-adapter.js", import.meta.url).href;
const adapter = await import(adapterHref);
const providerCalls = [];
const providerGate = { mode: "success", pending: null };
mock.module(adapterHref, {
  namedExports: {
    COMPOSIO_TOOLKITS: adapter.COMPOSIO_TOOLKITS,
    TOOLKIT_METADATA: adapter.TOOLKIT_METADATA,
    TOOL_SLUG_MAP: adapter.TOOL_SLUG_MAP,
    COMPOSIO_AUTH_TRUSTED_HOSTS: adapter.COMPOSIO_AUTH_TRUSTED_HOSTS,
    uploadComposioFile: adapter.uploadComposioFile,
    checkComposioFilesAccess: adapter.checkComposioFilesAccess,
    accountBelongsToUser: adapter.accountBelongsToUser,
    accountGrantedToUser: adapter.accountGrantedToUser,
    isComposioConfigured: adapter.isComposioConfigured,
    computePayloadHash: adapter.computePayloadHash,
    isTrustedComposioRedirectUrl: adapter.isTrustedComposioRedirectUrl,
    listAllComposioConnections: adapter.listAllComposioConnections,
    initiateComposioConnection: adapter.initiateComposioConnection,
    checkComposioAccountStatus: adapter.checkComposioAccountStatus,
    revokeComposioConnection: adapter.revokeComposioConnection,
    sanitizeProviderError: adapter.sanitizeProviderError,
    interpretComposioExecution: adapter.interpretComposioExecution,
    executeComposioTool: async (args) => {
      providerCalls.push({
        toolSlug: args.toolSlug,
        parameters: args.parameters,
        userId: args.userId,
        connectedAccountId: args.connectedAccountId || null,
        boundary: "provider-double",
      });
      if (providerGate.mode === "schema") {
        const error = new Error("Invalid request data");
        error.code = "schema_rejected";
        throw error;
      }
      if (providerGate.mode === "timeout") {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      if (providerGate.mode === "defer") await providerGate.pending;
      return {
        data: {
          id: "drv_boundary_double",
          webViewLink: "https://drive.google.com/file/d/drv_boundary_double/view",
          boundary: "provider-double",
        },
      };
    },
  },
});

const { createIsolatedAuthFixture } = await import("./helpers/auth-test-harness.js");
const {
  connectUserConnector,
  setUserConnectorEnabled,
  createPendingAction,
  approveAndExecuteAction,
  discardAction,
  getActionForUser,
  failNextCompletedPersistForTest,
} = await import("../src/connectors/service.js");
const { executeToolCall, filterToolsForEnabledConnectors } = await import("../src/chat/router.js");
const { CHAT_TOOLS, requestedToolCall } = await import("../src/chat/tool-calls.js");
const { buildDriveUploadPayload, driveActionReply, isDriveDenialReply, isDriveUploadRequest, resolveDriveSourceContent, toDriveCreateArguments } = await import("../src/connectors/drive-upload.js");
const { getModelConfig, toolCapableEntries, applyStreamToolCallDelta, ToolsUnsupportedError } = await import("../src/chat/providers.js");

const SETUP_TUTORIAL = /python|oauth credential|google cloud console|client_secret/i;

test("selected Drive is an eligible write tool and other connectors stay out", () => {
  const names = (tools) => tools.map((tool) => tool.function.name);
  const selected = filterToolsForEnabledConnectors(CHAT_TOOLS, {
    connectorEnabled: { googledrive: true, gmail: true },
    selectedConnectors: ["googledrive"],
  });
  assert.ok(names(selected).includes("google_drive_upload_file"));
  assert.ok(names(selected).includes("google_drive_search"));
  assert.equal(names(selected).includes("search_emails"), false);
  const disconnected = filterToolsForEnabledConnectors(CHAT_TOOLS, {
    connectorEnabled: { googledrive: false },
    selectedConnectors: ["googledrive"],
  });
  assert.equal(names(disconnected).includes("google_drive_upload_file"), false);
});

test("streamed Drive tool-call deltas assemble into one executable call", () => {
  const calls = [];
  applyStreamToolCallDelta(calls, { index: 0, id: "call_drive", function: { name: "google_drive_" } });
  applyStreamToolCallDelta(calls, { index: 0, function: { name: "upload_file", arguments: "{\"fileName\":\"notes.txt\"," } });
  applyStreamToolCallDelta(calls, { index: 0, function: { arguments: "\"content\":\"hello from chat\"}" } });
  const parsed = requestedToolCall({ choices: [{ message: { tool_calls: calls } }] }, "push it");
  assert.equal(parsed.name, "google_drive_upload_file");
  assert.equal(parsed.arguments.fileName, "notes.txt");
  assert.equal(parsed.arguments.content, "hello from chat");
});

test("branded tiers keep tool-capable routes and Lumen skips the no-tool primary", () => {
  for (const key of ["nova", "nebula", "vesper"]) {
    const capable = toolCapableEntries(getModelConfig(key).chain, [{ type: "function" }]);
    assert.ok(capable.length >= 1, `${key} has a tool-capable stage`);
    assert.ok(capable.every((entry) => entry.supportsTools !== false));
  }
  const lumen = toolCapableEntries(getModelConfig("lumen").chain, [{ type: "function" }]);
  assert.ok(lumen.every((entry) => entry.provider !== "primaryFree"));
  assert.equal(toolCapableEntries([{ supportsTools: false }], [{}]).length, 0);
  const unsupported = new ToolsUnsupportedError("lumen");
  assert.equal(unsupported.code, "tools-unsupported");
  assert.match(unsupported.message, /Choose another model/);
  assert.doesNotMatch(unsupported.message, /Nova|Nebula/, "never points at a retired model");
});

test("an explicit Drive upload is prepared instead of a setup tutorial", () => {
  assert.equal(isDriveUploadRequest("can you push it to google drive for me"), true);
  assert.equal(isDriveUploadRequest("what is Google Drive?"), false);
  assert.equal(isDriveDenialReply("I can't upload files directly to your Drive. Install Python and create OAuth credentials."), true);
  const reply = driveActionReply({
    kind: "pending_approval",
    pendingAction: { payload: { fileName: "notes.txt", folderName: "My Drive" } },
  });
  assert.match(reply, /notes\.txt/);
  assert.match(reply, /Nothing has been uploaded yet/);
  assert.doesNotMatch(reply, SETUP_TUTORIAL);
});

test("Drive source resolution asks once when the file is missing or ambiguous", () => {
  assert.equal(resolveDriveSourceContent({}).clarify, "Which text or file should I put in Google Drive?");
  const many = resolveDriveSourceContent({
    attachments: [
      { extractedText: "a", originalName: "a.txt" },
      { extractedText: "b", originalName: "b.txt" },
    ],
  });
  assert.match(many.clarify, /Which of the attached files/);
  const one = resolveDriveSourceContent({ attachments: [{ extractedText: "only file", originalName: "only.txt" }] });
  assert.equal(one.content, "only file");
  const prior = resolveDriveSourceContent({ priorMessages: [{ role: "assistant", content: "Here is the note you asked for." }] });
  assert.equal(prior.content, "Here is the note you asked for.");
  const url = buildDriveUploadPayload({ fileName: "x.txt", content: "https://example.com/secret" });
  assert.equal(url.ok, false);
  assert.equal(url.code, "url_rejected");
  assert.doesNotMatch(url.message, SETUP_TUTORIAL);
});

test("Drive write waits for approval, and a denied action does not call the provider double", async () => {
  providerCalls.length = 0;
  const fixture = await createIsolatedAuthFixture({ email: "drive-approve@example.com" });
  const userId = fixture.user.id;
  await connectUserConnector(userId, "googledrive", {
    accessToken: "tok_drive_test",
    scopes: ["https://www.googleapis.com/auth/drive.file"], metadata: { accountId: "acct_fixture_drive_execution_1" } });

  const prepared = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "notes.txt", content: "hello from chat", folderName: "Notes" } },
    "can you push it to google drive for me",
    { userId },
  );
  assert.equal(prepared.kind, "pending_approval");
  assert.match(prepared.pendingAction.actionDescription, /notes\.txt/);
  assert.match(prepared.pendingAction.actionDescription, /Notes/);
  assert.equal(prepared.pendingAction.payload.content, "hello from chat");
  assert.equal(providerCalls.length, 0, "preparing a write must not upload");
  assert.doesNotMatch(prepared.content, SETUP_TUTORIAL);

  const denied = await discardAction(userId, prepared.pendingAction.id);
  assert.equal(denied.status, "discarded");
  assert.equal(providerCalls.length, 0, "declining must not upload");

  const approved = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "approved.txt", content: "exact approved body", folderName: "My Drive" } },
    "push it",
    { userId },
  );
  const done = await approveAndExecuteAction(userId, approved.pendingAction.id);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].boundary, "provider-double");
  assert.equal(providerCalls[0].parameters.fileName, "approved.txt");
  assert.equal(providerCalls[0].parameters.content, "exact approved body");
  assert.equal(providerCalls[0].parameters.folderName, "My Drive");
  assert.equal(done.result.id, "drv_boundary_double");
  assert.match(done.result.webViewLink, /drv_boundary_double/);

  const retry = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "approved.txt", content: "exact approved body", folderName: "My Drive" } },
    "push it again",
    { userId },
  );
  assert.equal(retry.kind, "already_uploaded");
  assert.equal(providerCalls.length, 1, "retry must not upload a second copy");

  await fixture.client.close();
});

test("disabled, disconnected, read-only, and cross-user Drive writes fail closed", async () => {
  providerCalls.length = 0;
  const owner = await createIsolatedAuthFixture({ email: "drive-owner@example.com" });
  const other = await createIsolatedAuthFixture({ email: "drive-other@example.com" });
  await connectUserConnector(owner.user.id, "googledrive", {
    accessToken: "tok_owner",
    scopes: ["https://www.googleapis.com/auth/drive.file"], metadata: { accountId: "acct_fixture_drive_execution_2" } });

  const foreign = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "x.txt", content: "nope" } },
    "push it",
    { userId: other.user.id },
  );
  assert.equal(foreign.kind, "connector_disabled");
  assert.equal(providerCalls.length, 0);

  await setUserConnectorEnabled(owner.user.id, "googledrive", false);
  const disabled = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "x.txt", content: "nope" } },
    "push it",
    { userId: owner.user.id },
  );
  assert.equal(disabled.kind, "connector_disabled");
  assert.equal(providerCalls.length, 0);
  await setUserConnectorEnabled(owner.user.id, "googledrive", true);

  const missing = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "x.txt" } },
    "can you push it to google drive for me",
    { userId: owner.user.id },
  );
  assert.equal(missing.kind, "clarification");
  assert.match(missing.content, /Which text or file/);
  assert.doesNotMatch(missing.content, SETUP_TUTORIAL);
  assert.equal(providerCalls.length, 0);

  const pending = await createPendingAction({
    userId: owner.user.id,
    toolName: "google_drive_upload_file",
    actionDescription: "Upload x.txt",
    payload: { fileName: "x.txt", content: "owned", folderName: "My Drive", mimeType: "text/plain" },
  });
  await assert.rejects(() => approveAndExecuteAction(other.user.id, pending.id), /not found|unauthorized/i);
  assert.equal(providerCalls.length, 0);

  const reader = await createIsolatedAuthFixture({ email: "drive-readonly@example.com" });
  await connectUserConnector(reader.user.id, "googledrive", {
    accessToken: "tok_read",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"], metadata: { accountId: "acct_fixture_drive_execution_3" } });
  const readonly = await executeToolCall(
    { name: "google_drive_upload_file", arguments: { fileName: "x.txt", content: "nope" } },
    "push it",
    { userId: reader.user.id },
  );
  assert.equal(readonly.kind, "connector_notice");
  assert.match(readonly.content, /Reconnect Google Drive/);
  assert.equal(providerCalls.length, 0);

  await owner.client.close();
  await other.client.close();
  await reader.client.close();
});

test("Drive create uses the documented schema and keeps the inner provider error", () => {
  const args = toDriveCreateArguments({
    fileName: "VibhavGPT connector test.txt",
    content: "owned text",
    folderName: "My Drive",
    mimeType: "text/plain",
  });
  assert.deepEqual(args, {
    file_name: "VibhavGPT connector test.txt",
    text_content: "owned text",
    mime_type: "text/plain",
  });
  const rejected = adapter.interpretComposioExecution({
    successful: false,
    error: "1 out of 1 tools failed",
    data: { results: [{ tool_slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", error: "Invalid request data" }] },
  }, { slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /Invalid request data/);
  const created = adapter.interpretComposioExecution({
    successful: true,
    data: { results: [{ response: { successful: true, data: { id: "1AbCdefGHIjklMNOp" } } }] },
  }, { slug: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT" });
  assert.equal(created.ok, true);
  assert.equal(created.data.webViewLink, "https://drive.google.com/file/d/1AbCdefGHIjklMNOp/view");
});

async function connectedDriveUser(email) {
  const fixture = await createIsolatedAuthFixture({ email });
  await connectUserConnector(fixture.user.id, "googledrive", {
    accessToken: "tok_drive_double",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    metadata: { id: "googledrive_test_account" },
  });
  return fixture;
}

test("a schema rejection stays failed and another click does not upload", async () => {
  providerCalls.length = 0;
  providerGate.mode = "schema";
  const fixture = await connectedDriveUser("drive-schema@example.com");
  const pending = await createPendingAction({
    userId: fixture.user.id,
    toolName: "google_drive_upload_file",
    actionDescription: "Upload notes",
    payload: { fileName: "notes.txt", content: "owned", folderName: "My Drive", mimeType: "text/plain" },
  });
  await assert.rejects(() => approveAndExecuteAction(fixture.user.id, pending.id), /Invalid request data/);
  const again = await approveAndExecuteAction(fixture.user.id, pending.id);
  assert.equal(again.status, "failed");
  assert.match(again.result.error, /Invalid request data/);
  assert.equal(providerCalls.length, 1, "provider-double was not called again");
  const reloaded = await getActionForUser(fixture.user.id, pending.id);
  assert.equal(reloaded.status, "failed");
  providerGate.mode = "success";
  await fixture.client.close();
});

test("a timeout stays uncertain and is not uploaded again", async () => {
  providerCalls.length = 0;
  providerGate.mode = "timeout";
  const fixture = await connectedDriveUser("drive-timeout@example.com");
  const pending = await createPendingAction({
    userId: fixture.user.id,
    toolName: "google_drive_upload_file",
    actionDescription: "Upload notes",
    payload: { fileName: "notes.txt", content: "owned", folderName: "My Drive", mimeType: "text/plain" },
  });
  await assert.rejects(() => approveAndExecuteAction(fixture.user.id, pending.id), /aborted/);
  const again = await approveAndExecuteAction(fixture.user.id, pending.id);
  assert.equal(again.status, "uncertain");
  assert.equal(again.result.id, undefined);
  assert.equal(providerCalls.length, 1);
  providerGate.mode = "success";
  await fixture.client.close();
});

test("concurrent approval dispatches the provider double once", async () => {
  providerCalls.length = 0;
  let release;
  providerGate.mode = "defer";
  providerGate.pending = new Promise((resolve) => { release = resolve; });
  const fixture = await connectedDriveUser("drive-race@example.com");
  const pending = await createPendingAction({
    userId: fixture.user.id,
    toolName: "google_drive_upload_file",
    actionDescription: "Upload notes",
    payload: { fileName: "notes.txt", content: "owned", folderName: "My Drive", mimeType: "text/plain" },
  });
  const first = approveAndExecuteAction(fixture.user.id, pending.id);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await approveAndExecuteAction(fixture.user.id, pending.id);
  assert.equal(second.status, "in_progress");
  assert.equal(providerCalls.length, 1);
  release();
  const done = await first;
  assert.equal(done.status, "completed");
  assert.equal(done.result.id, "drv_boundary_double");
  assert.equal(providerCalls.length, 1);
  providerGate.mode = "success";
  await fixture.client.close();
});

test("provider success is kept when the completed write fails once", async () => {
  providerCalls.length = 0;
  providerGate.mode = "success";
  const fixture = await connectedDriveUser("drive-persist@example.com");
  const pending = await createPendingAction({
    userId: fixture.user.id,
    toolName: "google_drive_upload_file",
    actionDescription: "Upload notes",
    payload: { fileName: "notes.txt", content: "owned", folderName: "My Drive", mimeType: "text/plain" },
  });
  failNextCompletedPersistForTest();
  const done = await approveAndExecuteAction(fixture.user.id, pending.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result.id, "drv_boundary_double");
  assert.match(done.result.webViewLink, /drive\.google\.com/);
  const again = await approveAndExecuteAction(fixture.user.id, pending.id);
  assert.equal(again.status, "completed");
  assert.equal(providerCalls.length, 1);
  await fixture.client.close();
});

test("composer chips sit inside the input and empty zero-second thoughts do not render", () => {
  const app = readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../frontend/src/composer.css", import.meta.url), "utf8");
  const trace = readFileSync(new URL("../frontend/src/components/ui/reasoning-trace.jsx", import.meta.url), "utf8");
  const wrap = app.slice(app.indexOf("const composerInput"), app.indexOf("const attachmentTray"));
  assert.match(wrap, /composer__input-wrap/);
  assert.match(wrap, /\{mentionChips\}/);
  assert.match(app, /selectedConnectors: turnConnectors\.map\(\(entry\) => entry\.id\)/);
  assert.match(css, /justify-content:\s*flex-start/);
  assert.match(trace, /Number\(seconds\) < 1/);
  // The card and the failure wording it imports (action-failure-copy.js) are read together.
  const card = ["ActionApprovalCard.jsx", "action-failure-copy.js"]
    .map((name) => readFileSync(new URL(`../frontend/src/components/${name}`, import.meta.url), "utf8")).join("\n");
  assert.match(card, /\/api\/connectors\/actions\/\$\{pendingAction\.id\}/);
  assert.match(card, /status === "failed" \|\| status === "expired"/);
  assert.match(card, /status === "pending" && \(/);
  assert.match(card, /disabled=\{loading\}/);
  assert.match(card, /tools failed/);
  assert.match(card, /serviceName\(action\.toolName\)/);
  assert.match(card, /Google Drive/);
  assert.doesNotMatch(card, /action-approval-card__tool-tag">\{action\.toolName\}/);
});
