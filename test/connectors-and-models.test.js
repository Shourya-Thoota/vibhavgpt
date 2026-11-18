import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const client = new PGlite();
await client.exec(`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, email text NOT NULL);`);

// Execute connector migrations directly
const migration0043 = await readFile(new URL("../drizzle/0043_user_connectors_and_approvals.sql", import.meta.url), "utf8");
await client.exec(migration0043);
const migration0045 = await readFile(new URL("../drizzle/0045_connector_enabled.sql", import.meta.url), "utf8");
await client.exec(migration0045);

const pgliteDb = drizzle(client);

const {
  getConnectorsSummary,
  connectUserConnector,
  disconnectUserConnector,
  getConnectorAccessToken,
  createPendingAction,
  approveAndExecuteAction,
  discardAction,
  computePayloadHash,
  WRITE_MUTATION_TOOLS,
  setConnectorsDbForTest,
} = await import("../src/connectors/service.js");

setConnectorsDbForTest(pgliteDb);

const { CHAT_TOOLS } = await import("../src/chat/tool-calls.js");
const { executeToolCall } = await import("../src/chat/router.js");
const { settingsRoute, settingsPath, SETTINGS_SECTIONS } = await import("../frontend/src/settings-routes.js");
const { isCatalogUiEnabled } = await import("../frontend/src/components/catalog/catalog-gate.js");

test("Connectors: summary exposes Google Workspace, GitHub, Weather and Web Search", async () => {
  const summary = await getConnectorsSummary("usr_test_123");
  assert.ok(summary.length >= 7);

  const google = summary.find((c) => c.id === "google_workspace");
  assert.ok(google, "Google Workspace connector present");
  assert.equal(google.requiresApprovalForWrites, true);
  assert.equal(google.catalogVisible, false, "legacy Workspace bundle is not catalog-visible");

  const gmail = summary.find((c) => c.id === "gmail");
  assert.ok(gmail, "Gmail connector present");
  assert.equal(gmail.catalogVisible, true);

  const github = summary.find((c) => c.id === "github");
  assert.ok(github, "GitHub connector present");
  assert.equal(github.requiresApprovalForWrites, true);

  const weather = summary.find((c) => c.id === "weather");
  assert.ok(weather, "Weather connector present");
  assert.equal(weather.status, "connected");

  const search = summary.find((c) => c.id === "web_search");
  assert.ok(search, "Web search connector present");
  assert.equal(search.status, "connected");
});

test("Connectors: token connection, retrieval, and revocation lifecycle", async () => {
  const userId = "usr_conn_lifecycle_test";
  
  // Connect
  const connected = await connectUserConnector(userId, "google_workspace", {
    accessToken: "test_access_token_xyz",
    scopes: ["gmail.modify", "calendar.events"],
    metadata: { email: "user@example.com" },
  });
  assert.equal(connected.status, "connected");
  assert.equal(connected.accessToken, "test_access_token_xyz");

  // Retrieve token
  const token = await getConnectorAccessToken(userId, "google_workspace");
  assert.equal(token, "test_access_token_xyz");

  // Revoke / Disconnect
  const disconnected = await disconnectUserConnector(userId, "google_workspace");
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.accessToken, null);

  // Token now null
  const revokedToken = await getConnectorAccessToken(userId, "google_workspace");
  assert.equal(revokedToken, null);
});

test("Human-in-the-Loop: exact-action approvals with cryptographic payload hash and idempotency", async () => {
  const userId = "usr_hitl_test";
  const payload = {
    repo: "pansophy/vibhavgpt",
    branch: "main",
    path: "README.md",
    content: "# Updated README",
    commitMessage: "docs: update readme",
  };

  const hash = computePayloadHash(payload);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), "Hash must be 64-character SHA-256 hex");

  // Create pending action
  const pending = await createPendingAction({
    userId,
    toolName: "stage_commit_edit",
    actionDescription: "Stage commit to pansophy/vibhavgpt:main (README.md)",
    payload,
  });

  assert.equal(pending.status, "pending");
  assert.equal(pending.payloadHash, hash);
  assert.ok(pending.idempotencyKey.startsWith("act_"));
  assert.ok(new Date(pending.expiresAt) > new Date());

  // Approve and execute rejects when provider is not enabled, credentials missing, or upstream rejects
  await assert.rejects(
    () => approveAndExecuteAction(userId, pending.id),
    /disabled by user|not configured|Invalid request|External execution failed|not connected/i
  );
});

test("Human-in-the-Loop: user discard marks action discarded without execution", async () => {
  const userId = "usr_hitl_discard_test";
  const pending = await createPendingAction({
    userId,
    toolName: "draft_email",
    actionDescription: "Create draft email to alice@example.com",
    payload: { to: "alice@example.com", subject: "Meeting Notes", body: "Hello Alice" },
  });

  const discarded = await discardAction(userId, pending.id);
  assert.equal(discarded.status, "discarded");

  const replay = await approveAndExecuteAction(userId, pending.id);
  assert.equal(replay.status, "discarded");
});

test("Tool Execution: consequential write mutations automatically yield pending approval actions", async () => {
  const userId = "usr_tool_mutations_test";
  await connectUserConnector(userId, "github", { accessToken: "tok_test_mutations", metadata: { accountId: "acct_fixture_mutations" } });
  const toolCall = {
    name: "stage_commit_edit",
    arguments: {
      repo: "user/project",
      branch: "feat",
      path: "src/index.js",
      content: "console.log('hello')",
      message: "feat: add hello",
    },
  };

  const result = await executeToolCall(toolCall, "commit this code", { userId });
  assert.equal(result.kind, "pending_approval");
  assert.ok(result.pendingAction);
  assert.equal(result.pendingAction.toolName, "stage_commit_edit");
  assert.match(result.content, /\[Action Pending User Approval\]/);
});

test("Settings: Connectors section registered in settings routes", () => {
  assert.ok(SETTINGS_SECTIONS.some((s) => s.slug === "connectors" && s.group === "Security & Access"));
  const route = settingsRoute(settingsPath("connectors"));
  assert.equal(route.page, "settings");
  assert.equal(route.section, "connectors");
});

test("Catalog UI: isCatalogUiEnabled defaults to false until explicitly enabled", () => {
  // Matches catalog-gate.js — native app unchanged until the feature flag is set.
  assert.equal(isCatalogUiEnabled(), false);
});

test("CHAT_TOOLS: first-party connectors tools are formally defined", () => {
  const toolNames = new Set(CHAT_TOOLS.map((t) => t.function.name));
  assert.ok(toolNames.has("find_repository"), "find_repository defined");
  assert.ok(toolNames.has("read_file_contents"), "read_file_contents defined");
  assert.ok(toolNames.has("stage_commit_edit"), "stage_commit_edit defined");
  assert.ok(toolNames.has("search_emails"), "search_emails defined");
  assert.ok(toolNames.has("draft_email"), "draft_email defined");
  assert.ok(toolNames.has("create_calendar_event"), "create_calendar_event defined");
  assert.ok(toolNames.has("read_google_doc"), "read_google_doc defined");
  assert.ok(toolNames.has("append_to_google_doc"), "append_to_google_doc defined");
});
