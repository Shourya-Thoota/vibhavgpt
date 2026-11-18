import test from "node:test";
import assert from "node:assert/strict";

import {
  mapConnectorError,
  scrubVendorNames,
  sanitizeConnectorMetadata,
  serviceNameForTool,
  serviceNameForSlug,
} from "../src/connectors/error-mapper.js";
import { sanitizeProviderError } from "../src/connectors/composio-adapter.js";
import { sanitizeActionForUser } from "../src/connectors/router.js";

const FORBIDDEN_VENDORS = /composio|openrouter|openai|anthropic|gemini|groq|deepseek|qwen|moonshot|kimi|ck_|sk_|ya29/i;

test("mapConnectorError: scrubs vendor names and returns branded wording for configuration errors", () => {
  const err = new Error("Connector service is not configured (missing COMPOSIO_API_KEY in server deployment).");
  const mapped = mapConnectorError(err, { toolName: "google_docs_create_document" });
  assert.equal(mapped.message, "Connector service is not configured.");
  assert.equal(mapped.code, "configuration_required");
  assert.equal(mapped.status, 503);
  assert.doesNotMatch(mapped.message, FORBIDDEN_VENDORS);
});

test("mapConnectorError: write-approval errors with Composio vendor names map to branded service wording", () => {
  const err = new Error("Composio tool execution failed (500): Internal server error connecting to Google Docs API");
  const mapped = mapConnectorError(err, { toolName: "google_docs_create_document" });
  assert.match(mapped.message, /Google Docs/);
  assert.doesNotMatch(mapped.message, FORBIDDEN_VENDORS);
});

test("mapConnectorError: scrubs secrets and tokens from error messages", () => {
  const err = new Error("Upstream rejected request with key ck_live_secret1234567890 and Bearer ya29.A0ARrdaMtokensecret");
  const mapped = mapConnectorError(err, { toolName: "slack_post_message" });
  assert.doesNotMatch(mapped.message, /ck_live|ya29|Bearer/i);
  assert.doesNotMatch(mapped.message, FORBIDDEN_VENDORS);
  assert.match(mapped.message, /\[redacted\]/);
});

test("mapConnectorError: permission and scope errors name the service and guide reconnecting without vendor names", () => {
  const err = new Error("403 Forbidden: insufficient_scope for Google Drive files");
  const mapped = mapConnectorError(err, { toolName: "google_drive_upload_file" });
  assert.match(mapped.message, /Google Drive/);
  assert.match(mapped.message, /reconnect Google Drive in Extensions > Connectors/i);
  assert.equal(mapped.code, "insufficient_scope");
  assert.doesNotMatch(mapped.message, FORBIDDEN_VENDORS);
});

test("mapConnectorError: authorization expired errors advise reconnecting without vendor names", () => {
  const err = new Error("401 Unauthorized: token expired or invalid_grant");
  const mapped = mapConnectorError(err, { toolName: "github_create_issue" });
  assert.match(mapped.message, /GitHub/);
  assert.match(mapped.message, /sign-in has expired or was revoked/i);
  assert.equal(mapped.code, "authorization_expired");
  assert.doesNotMatch(mapped.message, FORBIDDEN_VENDORS);
});

test("mapConnectorError: timeout and rate limit errors produce branded wording", () => {
  const timeoutErr = new Error("ETIMEDOUT: Connection timed out after 15000ms");
  const mappedTimeout = mapConnectorError(timeoutErr, { toolName: "slack_post_message" });
  assert.match(mappedTimeout.message, /Slack did not respond in time/i);
  assert.equal(mappedTimeout.code, "timeout");
  assert.doesNotMatch(mappedTimeout.message, FORBIDDEN_VENDORS);

  const rateLimitErr = new Error("429 rate limit reached for Jira API");
  const mappedRate = mapConnectorError(rateLimitErr, { toolName: "jira_get_issue" });
  assert.match(mappedRate.message, /Jira rate limit or quota exceeded/i);
  assert.equal(mappedRate.code, "rate_limit_exceeded");
  assert.doesNotMatch(mappedRate.message, FORBIDDEN_VENDORS);
});

test("mapConnectorError: batch failures preserve Drive specific wording and attribute other services", () => {
  const batchErr = new Error("1 out of 1 tools failed");
  const driveMapped = mapConnectorError(batchErr, { toolName: "google_drive_upload_file" });
  assert.equal(driveMapped.message, "Google Drive rejected the upload before it confirmed a file.");
  assert.doesNotMatch(driveMapped.message, FORBIDDEN_VENDORS);

  const gitHubMapped = mapConnectorError(batchErr, { toolName: "github_create_issue" });
  assert.equal(gitHubMapped.message, "GitHub rejected the request before it confirmed a result.");
  assert.doesNotMatch(gitHubMapped.message, FORBIDDEN_VENDORS);
});

test("sanitizeConnectorMetadata: removes all Composio internal keys and redirect URLs from metadata", () => {
  const rawMetadata = {
    accountName: "test-user",
    email: "test@example.com",
    syncedFromComposio: true,
    composioConnectionId: "ca_12345",
    redirectUrl: "https://connect.composio.dev/link/abc",
    linkedViaBundle: "google_workspace",
  };
  const sanitized = sanitizeConnectorMetadata(rawMetadata);
  assert.equal(sanitized.accountName, "test-user");
  assert.equal(sanitized.email, "test@example.com");
  assert.equal(sanitized.linkedViaBundle, "google_workspace");
  assert.equal(sanitized.syncedFromComposio, undefined);
  assert.equal(sanitized.composioConnectionId, undefined);
  assert.equal(sanitized.redirectUrl, undefined);
  assert.doesNotMatch(JSON.stringify(sanitized), FORBIDDEN_VENDORS);
});

test("sanitizeActionForUser: ensures pending action error payload contains no vendor leaks", () => {
  const action = {
    id: "act_123",
    toolName: "google_docs_create_document",
    status: "failed",
    result: {
      error: "Composio tool execution failed (400): Bad Request on ck_test_12345678",
      code: "provider_rejected",
    },
  };
  const sanitized = sanitizeActionForUser(action);
  assert.doesNotMatch(sanitized.result.error, FORBIDDEN_VENDORS);
  assert.match(sanitized.result.error, /Google Docs/);
});

test("sanitizeProviderError: strips vendor names and scrubs COMPOSIO env var references", () => {
  const out1 = sanitizeProviderError("Failed due to Composio tool failure with ck_secret_test1234");
  assert.doesNotMatch(out1, FORBIDDEN_VENDORS);

  const out2 = sanitizeProviderError("Missing COMPOSIO_API_KEY in deployment settings");
  assert.doesNotMatch(out2, FORBIDDEN_VENDORS);
});

test("serviceName resolution: resolves service names for internal tool names and slugs", () => {
  assert.equal(serviceNameForTool("google_drive_upload_file"), "Google Drive");
  assert.equal(serviceNameForTool("google_docs_create_document"), "Google Docs");
  assert.equal(serviceNameForTool("slack_post_message"), "Slack");
  assert.equal(serviceNameForTool("github_create_issue"), "GitHub");
  assert.equal(serviceNameForSlug("GOOGLEDRIVE_CREATE_FILE_FROM_TEXT"), "Google Drive");
  assert.equal(serviceNameForSlug("SLACK_SEND_MESSAGE"), "Slack");
});
