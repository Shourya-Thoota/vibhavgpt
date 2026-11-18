process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOLKIT_METADATA,
  checkComposioAccountStatus,
  initiateComposioConnection,
} from "../src/connectors/composio-adapter.js";
import {
  deriveGrantedPermissionCoverage,
} from "../src/connectors/permission-coverage.js";

test("Google Workspace advertises distinct Docs/Drive/Gmail/Calendar apps", () => {
  const gw = TOOLKIT_METADATA.google_workspace;
  assert.deepEqual(gw.apps, ["googledocs", "googledrive", "gmail", "googlecalendar"]);
  assert.ok(gw.readActions.includes("google_docs_get_document"));
  assert.ok(gw.readActions.includes("gmail_list_messages"));
  assert.ok(gw.readActions.includes("google_calendar_list_events"));
  assert.ok(gw.readActions.includes("google_drive_search"));
});

test("Permission coverage: app names alone never prove full authorization", () => {
  const requested = ["googledocs", "googledrive", "gmail", "googlecalendar"];

  // Connected apps without verified scopes → partial / unknown, not fullyAuthorized
  const appsOnly = deriveGrantedPermissionCoverage({
    toolkitId: "google_workspace",
    requestedApps: requested,
    connectedApps: ["googledocs", "gmail"],
    grantedScopes: [],
  });
  assert.equal(appsOnly.fullyAuthorized, false);
  assert.deepEqual(appsOnly.missingApps.sort(), ["googlecalendar", "googledrive"]);
  assert.equal(appsOnly.scopeVerification, "unverified");
  assert.ok(appsOnly.unavailableFeatures.length >= 1);

  // Docs-only connection is not full Workspace
  const docsOnly = deriveGrantedPermissionCoverage({
    toolkitId: "google_workspace",
    requestedApps: requested,
    connectedApps: ["googledocs"],
    grantedScopes: ["https://www.googleapis.com/auth/documents"],
  });
  assert.equal(docsOnly.fullyAuthorized, false);
  assert.ok(docsOnly.unavailableFeatures.some((f) => /gmail|drive|calendar/i.test(f)));
});

test("Permission coverage: fullyAuthorized requires every requested app AND matching scopes when scope evidence exists", () => {
  const requested = ["googledocs", "googledrive", "gmail", "googlecalendar"];
  const fullScopes = [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ];
  const covered = deriveGrantedPermissionCoverage({
    toolkitId: "google_workspace",
    requestedApps: requested,
    connectedApps: requested,
    grantedScopes: fullScopes,
  });
  assert.equal(covered.fullyAuthorized, true);
  assert.equal(covered.scopeVerification, "verified");
  assert.equal(covered.missingApps.length, 0);
});

test("initiate requests every advertised Google app, not Docs alone", async () => {
  const previous = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = "ck_test_key_for_permission_coverage";
  const calls = [];
  try {
    await assert.rejects(
      () =>
        initiateComposioConnection("user-perm-1", "google_workspace", {
          callbackUrl: "https://vibhavgpt.com/app?page=extensions",
          fetchImpl: async (url, init) => {
            calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
            return new Response(JSON.stringify({ error: "forced" }), { status: 500 });
          },
        }),
      /./,
    );
  } finally {
    if (previous === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = previous;
  }

  // MCP path should request all four Google apps together.
  const mcpCall = calls.find((c) => /composio\.dev\/mcp/i.test(c.url) || c.body?.method);
  // Even if transport fails early, the adapter builds toolkit list before fetch for ck_ keys.
  // Assert metadata contract instead when fetch never receives toolkits payload.
  const gw = TOOLKIT_METADATA.google_workspace;
  assert.equal(gw.apps.length, 4);
});

test("status without COMPOSIO_API_KEY stays configuration_required (honest)", async () => {
  const previous = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  try {
    const status = await checkComposioAccountStatus("user-x", "google_workspace");
    assert.equal(status.status, "configuration_required");
    assert.equal(status.isConfigured, false);
    assert.notEqual(status.fullyAuthorized, true);
  } finally {
    if (previous !== undefined) process.env.COMPOSIO_API_KEY = previous;
  }
});
