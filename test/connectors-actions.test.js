import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real-at-least-32-chars";

const { createIsolatedAuthFixture } = await import("./helpers/auth-test-harness.js");
const {
  getConnectorsSummary,
  connectUserConnector,
  disconnectUserConnector,
  setUserConnectorEnabled,
  isConnectorEnabled,
  getConnectorAccessToken,
  syncUserConnectorsFromComposio,
  createPendingAction,
  approveAndExecuteAction,
  TOOL_TO_CONNECTOR_MAP,
  WRITE_MUTATION_TOOLS,
} = await import("../src/connectors/service.js");
const { executeToolCall } = await import("../src/chat/router.js");

test("Connectors: plain compact names, logos and initial state metadata", async () => {
  const fixture = await createIsolatedAuthFixture();
  const summary = await getConnectorsSummary(fixture.user.id);

  assert.ok(Array.isArray(summary), "Summary must be an array of connector objects");
  assert.ok(summary.length >= 7, "Core toolkits present");
  assert.ok(summary.some((c) => c.id === "gmail" && c.catalogVisible !== false), "Gmail published");
  assert.ok(summary.some((c) => c.id === "googlesheets" && c.catalogVisible !== false), "Sheets published");
  assert.ok(summary.some((c) => c.id === "gitlab" && c.catalogVisible !== false), "GitLab published");
  assert.ok(summary.some((c) => c.id === "google_workspace" && c.catalogVisible === false), "Workspace bundle hidden from catalog");

  const expectedPlainNames = {
    google_workspace: "Google Workspace",
    gmail: "Gmail",
    googledrive: "Google Drive",
    googlecalendar: "Google Calendar",
    googledocs: "Google Docs",
    googlesheets: "Google Sheets",
    googleslides: "Google Slides",
    googletasks: "Google Tasks",
    github: "GitHub",
    gitlab: "GitLab",
    notion: "Notion",
    slack: "Slack",
    microsoft: "Microsoft 365",
    outlook: "Outlook",
    one_drive: "OneDrive",
    linear: "Linear",
    jira: "Jira",
    trello: "Trello",
    dropbox: "Dropbox",
    airtable: "Airtable",
    asana: "Asana",
    todoist: "Todoist",
    calendly: "Calendly",
    figma: "Figma",
    zoom: "Zoom",
    clickup: "ClickUp",
    youtube: "YouTube",
    weather: "Weather",
    web_search: "Web Search",
  };

  for (const item of summary) {
    assert.equal(
      item.name,
      expectedPlainNames[item.id],
      `Connector ${item.id} must have plain name ${expectedPlainNames[item.id]}`
    );
    // Invented names must be absent
    assert.doesNotMatch(item.name, /Power|Companion|Dispatcher|Radar/i);

    // Initial enabled states: system services default to true, unconnected OAuth services default to false
    if (item.id === "weather" || item.id === "web_search") {
      assert.equal(item.status, "connected");
      assert.equal(item.enabled, true);
    } else {
      assert.equal(item.enabled, false);
      assert.notEqual(item.status, "connected");
    }
  }

  await fixture.client.close();
});

test("Connectors: successful Connect updates status and sets enabled by default", async () => {
  const fixture = await createIsolatedAuthFixture();
  const userId = fixture.user.id;

  const connected = await connectUserConnector(userId, "google_workspace", {
    accessToken: "tok_gw_user_123",
    scopes: ["gmail.readonly", "drive.readonly"],
    metadata: { accountId: "acct_fixture_connectors_actions_1", accountName: "user@example.com" },
  });

  assert.equal(connected.status, "connected");
  assert.equal(connected.enabled, true);
  assert.equal(connected.accessToken, "tok_gw_user_123");

  const summary = await getConnectorsSummary(userId);
  const gw = summary.find((c) => c.id === "google_workspace");
  assert.ok(gw);
  assert.equal(gw.status, "connected");
  assert.equal(gw.enabled, true);
  assert.equal(gw.metadata?.accountName, "user@example.com");

  await fixture.client.close();
});

test("Connectors: Enable and Disable actions keep authorization separate and persist state", async () => {
  const fixture = await createIsolatedAuthFixture();
  const userId = fixture.user.id;

  // 1. Cannot enable/disable a service that is not connected
  await assert.rejects(
    () => setUserConnectorEnabled(userId, "github", true),
    /Cannot enable or disable a disconnected service/
  );

  // 2. Connect GitHub
  await connectUserConnector(userId, "github", {
    accessToken: "tok_gh_abc",
    scopes: ["repo"],
    metadata: { accountId: "acct_fixture_connectors_actions_2", accountName: "octocat" },
  });

  let isEnabled = await isConnectorEnabled(userId, "github");
  assert.equal(isEnabled, true, "Should be enabled immediately upon connection");

  // 3. Disable GitHub
  const disabledRecord = await setUserConnectorEnabled(userId, "github", false);
  assert.equal(disabledRecord.status, "connected", "Authorization status remains connected");
  assert.equal(disabledRecord.enabled, false, "Tool permission is disabled");

  isEnabled = await isConnectorEnabled(userId, "github");
  assert.equal(isEnabled, false, "isConnectorEnabled returns false when disabled");

  // 4. Persistence check: reload / query summary
  const summaryAfterDisable = await getConnectorsSummary(userId);
  const ghDisabled = summaryAfterDisable.find((c) => c.id === "github");
  assert.equal(ghDisabled.status, "connected", "Remains connected in DB");
  assert.equal(ghDisabled.enabled, false, "Persists enabled: false after reload");

  // 5. Re-enable GitHub
  const reEnabledRecord = await setUserConnectorEnabled(userId, "github", true);
  assert.equal(reEnabledRecord.status, "connected");
  assert.equal(reEnabledRecord.enabled, true);

  isEnabled = await isConnectorEnabled(userId, "github");
  assert.equal(isEnabled, true, "isConnectorEnabled returns true when re-enabled");

  await fixture.client.close();
});

test("Connectors: disabled connectors are strictly blocked from execution and token access", async () => {
  const fixture = await createIsolatedAuthFixture();
  const userId = fixture.user.id;

  // Connect Google Workspace
  await connectUserConnector(userId, "google_workspace", {
    accessToken: "tok_gw_active",
    scopes: ["gmail.send", "docs"], metadata: { accountId: "acct_fixture_connectors_actions_3" } });

  // Token is accessible while enabled
  let token = await getConnectorAccessToken(userId, "google_workspace");
  assert.equal(token, "tok_gw_active");

  // Disable Google Workspace
  await setUserConnectorEnabled(userId, "google_workspace", false);

  // Token access must now return null
  token = await getConnectorAccessToken(userId, "google_workspace");
  assert.equal(token, null, "Disabled connector must return null token");

  // Chat executeToolCall: Read tool execution is blocked
  const readResult = await executeToolCall(
    { name: "search_emails", arguments: { query: "inbox" } },
    "search email",
    { userId }
  );
  assert.match(readResult.content, /disabled|not connected/i);

  // Chat executeToolCall: Consequential write tool execution is blocked
  const writeResult = await executeToolCall(
    { name: "draft_email", arguments: { to: "alice@example.com", subject: "Hi", body: "Hello" } },
    "send email",
    { userId }
  );
  assert.equal(writeResult.kind, "connector_disabled");
  assert.match(writeResult.content, /(Gmail|Google Workspace) is currently disabled/i);

  // Direct approveAndExecuteAction on pending action is blocked when disabled
  const pending = await createPendingAction({
    userId,
    toolName: "draft_email",
    actionDescription: "Create draft email to alice@example.com",
    payload: { to: "alice@example.com", subject: "Hi", body: "Hello" },
  });

  await assert.rejects(
    () => approveAndExecuteAction(userId, pending.id),
    /disabled by user|Gmail is disabled|Google Workspace is disabled/i
  );

  await fixture.client.close();
});

test("Connectors: Disconnect revokes tokens and is never undone by synchronization", async () => {
  const fixture = await createIsolatedAuthFixture();
  const userId = fixture.user.id;

  // Connect
  await connectUserConnector(userId, "google_workspace", {
    accessToken: "tok_gw_to_revoke",
    scopes: ["gmail.modify"],
    metadata: { accountId: "acct_fixture_connectors_actions_4", accountName: "revoked@example.com" },
  });

  // Disconnect
  const disconnected = await disconnectUserConnector(userId, "google_workspace");
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.enabled, false);
  assert.equal(disconnected.accessToken, null);

  // Token is null
  const token = await getConnectorAccessToken(userId, "google_workspace");
  assert.equal(token, null);

  // Run synchronization: must NOT automatically reconnect a disconnected service
  await syncUserConnectorsFromComposio(userId);

  const summary = await getConnectorsSummary(userId);
  const gw = summary.find((c) => c.id === "google_workspace");
  assert.notEqual(gw.status, "connected", "Must remain disconnected, not re-connected");
  assert.equal(gw.enabled, false);

  await fixture.client.close();
});

test("Connectors: strict cross-user isolation", async () => {
  const fixtureA = await createIsolatedAuthFixture({ email: "user-a@example.com" });
  const fixtureB = await createIsolatedAuthFixture({ email: "user-b@example.com" });

  const userA = fixtureA.user.id;
  const userB = fixtureB.user.id;

  // User A connects GitHub
  await connectUserConnector(userA, "github", {
    accessToken: "tok_gh_user_a",
    metadata: { accountId: "acct_fixture_connectors_actions_5", accountName: "user-a-github" },
  });

  // User B's GitHub must remain unconnected
  const summaryB = await getConnectorsSummary(userB);
  const ghB = summaryB.find((c) => c.id === "github");
  assert.notEqual(ghB.status, "connected");
  assert.equal(ghB.enabled, false);

  const tokenB = await getConnectorAccessToken(userB, "github");
  assert.equal(tokenB, null, "User B must not have access to User A's token");

  // User A disables GitHub
  await setUserConnectorEnabled(userA, "github", false);

  // User A's token is blocked
  const tokenA = await getConnectorAccessToken(userA, "github");
  assert.equal(tokenA, null);

  // User B's record remains unaffected
  assert.equal(await isConnectorEnabled(userB, "github"), false);

  await fixtureA.client.close();
  await fixtureB.client.close();
});
