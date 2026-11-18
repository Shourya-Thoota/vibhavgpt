import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userConnectors, pendingToolActions } from "../db/schema.js";
import { config } from "../config.js";
import { driveWriteAllowedByScopes } from "./permission-coverage.js";
import {
  COMPOSIO_TOOLKITS,
  TOOLKIT_METADATA,
  isComposioConfigured,
  initiateComposioConnection,
  checkComposioAccountStatus,
  listAllComposioConnections,
  revokeComposioConnection,
  executeComposioTool,
  accountBelongsToUser,
  accountGrantedToUser,
  sanitizeProviderError,
  uploadComposioFile,
} from "./composio-adapter.js";
import { driveFolderNeedsResolution, isDriveFolderId } from "./drive-upload.js";
import { isTextArtifact, loadArtifactForUpload } from "./drive-artifact.js";
import { accountReference } from "./account-reference.js";
import { claimAccountsByAlias, ownedAccountIds, releaseOwnedAccount, setOwnershipDbForTest } from "./account-ownership.js";
import { mapConnectorError, sanitizeConnectorMetadata } from "./error-mapper.js";

export { mapConnectorError, sanitizeConnectorMetadata };

let activeDb = db;
export function setConnectorsDbForTest(client) {
  activeDb = client;
  setOwnershipDbForTest(client);
}

/**
 * Standard connector provider IDs (re-exported for consistency).
 */
export const CONNECTOR_PROVIDERS = COMPOSIO_TOOLKITS;
export { TOOLKIT_METADATA };

/**
 * Tools classified as consequential external write mutations requiring human approval.
 * Writes to external services (create, send, post, commit, delete) are strictly gated.
 */
export const WRITE_MUTATION_TOOLS = Object.freeze(new Set([
  "stage_commit_edit",
  "draft_email",
  "create_calendar_event",
  "append_to_google_doc",
  "google_docs_create_document",
  "gmail_send_email",
  "google_calendar_create_event",
  "google_drive_upload_file",
  "github_create_issue",
  "github_create_pull_request",
  "github_commit_files",
  "notion_create_page",
  "notion_append_block_children",
  "slack_post_message",
  "slack_send_dm",
  "outlook_send_mail",
  "onedrive_upload_file",
  "googleslides_create_presentation",
  "googletasks_insert_task",
  "todoist_create_task",
]));

/**
 * Mapping of external tool names to their responsible connector integration.
 */
export const TOOL_TO_CONNECTOR_MAP = Object.freeze({
  find_repository: "github",
  read_file_contents: "github",
  stage_commit_edit: "github",
  github_create_issue: "github",
  github_create_pull_request: "github",
  github_commit_files: "github",
  github_get_repo: "github",
  github_search_code: "github",
  github_list_issues: "github",
  github_list_pull_requests: "github",

  search_emails: "gmail",
  read_email: "gmail",
  draft_email: "gmail",
  gmail_send_email: "gmail",
  gmail_list_messages: "gmail",

  list_calendar_events: "googlecalendar",
  create_calendar_event: "googlecalendar",
  google_calendar_create_event: "googlecalendar",
  google_calendar_list_events: "googlecalendar",

  read_google_doc: "googledocs",
  append_to_google_doc: "googledocs",
  google_docs_create_document: "googledocs",
  google_docs_get_document: "googledocs",

  google_drive_upload_file: "googledrive",
  google_drive_search: "googledrive",

  google_sheets_search: "googlesheets",
  google_sheets_get_info: "googlesheets",
  google_sheets_values_get: "googlesheets",

  notion_create_page: "notion",
  notion_append_block_children: "notion",
  notion_search: "notion",
  notion_get_page: "notion",
  notion_query_database: "notion",

  slack_post_message: "slack",
  slack_send_dm: "slack",
  slack_list_channels: "slack",
  slack_search_messages: "slack",

  outlook_send_mail: "outlook",
  outlook_list_messages: "outlook",
  onedrive_upload_file: "one_drive",
  onedrive_search_files: "one_drive",

  googleslides_get_presentation: "googleslides",
  googleslides_create_presentation: "googleslides",
  googletasks_list_task_lists: "googletasks",
  googletasks_list_tasks: "googletasks",
  googletasks_insert_task: "googletasks",
  asana_list_workspaces: "asana",
  asana_list_tasks: "asana",
  todoist_list_projects: "todoist",
  todoist_list_tasks: "todoist",
  todoist_create_task: "todoist",
  calendly_get_user: "calendly",
  calendly_list_events: "calendly",
  figma_discover: "figma",
  zoom_list_meetings: "zoom",
  clickup_list_workspaces: "clickup",
  youtube_get_my_channel: "youtube",
  youtube_list_playlists: "youtube",
  youtube_search: "youtube",

  gitlab_list_issues: "gitlab",
  gitlab_get_project: "gitlab",
  linear_list_issues: "linear",
  linear_list_projects: "linear",
  jira_search_issues: "jira",
  jira_get_issue: "jira",
  trello_list_boards: "trello",
  trello_search: "trello",
  dropbox_list_folder: "dropbox",
  dropbox_search: "dropbox",
  airtable_list_records: "airtable",
  airtable_get_record: "airtable",

  weather: "weather",
  web_search: "web_search",
});

/** Legacy bundles that may already hold access for a published single-app connector. */
const CONNECTOR_BUNDLE_FALLBACKS = Object.freeze({
  gmail: ["google_workspace"],
  googledocs: ["google_workspace"],
  googledrive: ["google_workspace"],
  googlecalendar: ["google_workspace"],
  outlook: ["microsoft"],
  one_drive: ["microsoft"],
});

/**
 * Computes deterministic SHA-256 hash of a payload object.
 */
export function computePayloadHash(payload) {
  const canonical = JSON.stringify(payload ?? {}, Object.keys(payload || {}).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Automatically syncs active connections from Composio into userConnectors.
 * Strictly scoped to the authenticated user ID and never overrides explicit user disconnects.
 */
export async function syncUserConnectorsFromComposio(userId) {
  if (!userId || !isComposioConfigured()) return;
  const connections = await listAllComposioConnections({ userId }).catch(() => null);
  if (!connections) return;

  // Retrieve existing user records to respect user intent (especially explicit disconnects)
  const existingRecords = await activeDb
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.userId, userId));
  const existingMap = new Map(existingRecords.map((r) => [r.provider, r]));
  await claimAccountsByAlias(userId, Object.values(connections).flatMap((entry) => (Array.isArray(entry?.accounts) ? entry.accounts : [])));
  const owned = await ownedAccountIds(userId);

  for (const toolkit of Object.values(TOOLKIT_METADATA)) {
    if (toolkit.authType === "system") continue;

    // Do NOT automatically reconnect if the user has explicitly disconnected this provider
    const existing = existingMap.get(toolkit.id);
    if (existing?.status === "disconnected") {
      continue;
    }

    let activeAccount = null;
    let matchingApp = null;
    for (const app of [...(toolkit.apps || []), toolkit.id]) {
      const res = connections[app];
      // Only match accounts that belong to this user (never assign unowned shared accounts)
      const active = res?.accounts?.find((a) => {
        const isLive = a.status === "active" || a.status === "connected";
        return isLive && accountBelongsToUser(a, userId, owned);
      });
      if (active) {
        activeAccount = active;
        matchingApp = app;
        break;
      }
    }

    if (activeAccount) {
      await connectUserConnector(userId, toolkit.id, {
        accessToken: `comp_live_${activeAccount.id}`,
        enabled: existing ? existing.enabled : true,
        metadata: {
          accountId: activeAccount.id,
          accountName: activeAccount.user_info?.name || activeAccount.user_info?.email || activeAccount.user_info?.login || activeAccount.alias || activeAccount.id,
          email: activeAccount.user_info?.email || null,
          synced: true,
          toolkitSlug: matchingApp,
          ...activeAccount,
          ownershipVerified: true,
        },
      }).catch(() => {});
    }
  }
}

/**
 * Checks connection status against Composio and syncs to local state.
 */
export async function checkConnectorStatus(userId, provider) {
  const status = await checkComposioAccountStatus(userId, provider);
  if (status.status === "connected") {
    await connectUserConnector(userId, provider, {
      accessToken: `comp_live_${status.accountId || Date.now()}`,
      scopes: status.scopes || status.grantedApps || [],
      // Fresh verification after auth — keep enabled unless user previously disabled.
      enabled: true,
      metadata: {
        accountId: status.accountId,
        accountName: status.accountName,
        grantedApps: status.grantedApps || [],
        missingApps: status.missingApps || [],
        fullyAuthorized: status.fullyAuthorized !== false,
        verifiedAt: new Date().toISOString(),
        ...(status.metadata || {}),
        ownershipVerified: true,
      },
    }).catch(() => {});
  }
  return status;
}

/**
 * Lists the connection and enabled state of all connectors for a user.
 */
function findBundleCoveringProvider(map, providerId) {
  const fallbacks = CONNECTOR_BUNDLE_FALLBACKS[providerId] || [];
  for (const bundleId of fallbacks) {
    const bundle = map.get(bundleId);
    if (bundle?.status !== "connected") continue;
    const granted = bundle.metadata?.grantedApps || TOOLKIT_METADATA[bundleId]?.apps || [];
    const apps = TOOLKIT_METADATA[providerId]?.apps || [providerId];
    if (apps.some((app) => granted.includes(app) || granted.includes(providerId))) {
      return bundle;
    }
    // Legacy workspace rows may omit grantedApps — treat full Google bundle as covering.
    if (!bundle.metadata?.grantedApps?.length && TOOLKIT_METADATA[bundleId]?.apps?.includes(apps[0])) {
      return bundle;
    }
  }
  return null;
}

// The account alias the provider generates ("youtube_instep-graip"): an internal reference, never something a person should be shown.
const ALIAS_LIKE = /^[a-z0-9]+_[a-z0-9]+(?:-[a-z0-9]+)+$/i;

/**
 * What the browser is told about a connected account: a name a person recognises, and an email if there is one. Not the provider's raw
 * account record (it carries identifiers and the account's whole profile payload), and not the internal alias.
 * Google's YouTube account carries a channel response instead of a name, so the channel title is used.
 */
export function publicConnectorMetadata(metadata) {
  const source = sanitizeConnectorMetadata(metadata);
  const info = source.user_info && typeof source.user_info === "object" ? source.user_info : {};
  const channelTitle = Array.isArray(info.items) ? info.items[0]?.snippet?.title : null;
  const candidates = [info.name, info.email, info.login, channelTitle, source.email, source.accountName];
  const label = candidates.find((value) => typeof value === "string" && value.trim() && !ALIAS_LIKE.test(value.trim())) || null;
  const email = typeof info.email === "string" ? info.email : typeof source.email === "string" ? source.email : null;
  const out = {};
  if (label) { out.accountName = label.trim().slice(0, 120); out.accountLabel = out.accountName; }
  if (email) out.email = email;
  for (const key of ["grantedApps", "missingApps", "requestedApps", "fullyAuthorized", "scopeVerification", "unavailableFeatures", "linkedViaBundle", "verifiedAt", "needsReconnectAt"]) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export async function getConnectorsSummary(userId) {
  const records = await activeDb
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.userId, userId));

  const composioConfigured = isComposioConfigured();
  const map = new Map(records.map((r) => [r.provider, r]));
  const owned = await ownedAccountIds(userId);

  return Object.values(TOOLKIT_METADATA).map((toolkit) => {
    let record = map.get(toolkit.id);
    let linkedViaBundle = null;
    if ((!record || record.status !== "connected") && toolkit.authType !== "system") {
      const bundle = findBundleCoveringProvider(map, toolkit.id);
      if (bundle) {
        linkedViaBundle = bundle.provider;
        record = {
          ...bundle,
          // Do not invent a separate account row — reuse bundle auth for status only.
          metadata: {
            ...(bundle.metadata || {}),
            linkedViaBundle: bundle.provider,
          },
        };
      }
    }
    const isSystem = toolkit.authType === "system";
    const isConnected = isSystem || record?.status === "connected";
    const isPendingAuth = !isSystem && !linkedViaBundle && record?.status === "pending_auth";
    const isEnabled = isSystem ? true : (isConnected ? Boolean(record?.enabled ?? true) : false);
    const grantedApps = record?.metadata?.grantedApps || [];
    const missingApps = record?.metadata?.missingApps || [];
    const scopeVerification = record?.metadata?.scopeVerification || (isSystem ? "not_applicable" : "unverified");
    const unavailableFeatures = record?.metadata?.unavailableFeatures || [];
    // Real OAuth scopes only — never treat connected app names as granted scopes.
    const scopes = Array.isArray(record?.scopes)
      ? record.scopes.filter((s) => typeof s === "string" && (s.includes("/") || s.includes(":")))
      : [];
    const fullyAuthorized = isSystem
      ? true
      : Boolean(record?.metadata?.fullyAuthorized === true);

    // "expired" is what markConnectorNeedsReconnect records when the provider no longer has a live connection.
    const needsReconnect = !isSystem && !linkedViaBundle && record?.status === "expired";
    let status = isConnected ? "connected" : isPendingAuth ? "pending_auth" : needsReconnect ? "needs_reconnect" : "available";
    let blockerNotice = null;
    // A stored connection that is not verified for this person is not ready to use, and says nothing about whose account it is.
    const unverified = !isSystem && composioConfigured && isConnected && !verifiedWith(userId, record, owned);

    if (!isSystem && !composioConfigured) {
      status = record?.status === "connected" ? "connected" : "configuration_required";
      blockerNotice = "Requires owner configuration.";
    } else if (needsReconnect) {
      blockerNotice = "The sign-in expired or was removed. Reconnect to use it again.";
    } else if (isPendingAuth) {
      blockerNotice = "Waiting for authorization.";
    } else if (isConnected && !fullyAuthorized) {
      if (unavailableFeatures.length) {
        blockerNotice = `Incomplete authorization: ${unavailableFeatures.join(", ")}. Reconnect to grant the missing access.`;
      } else if (missingApps.length) {
        blockerNotice = `Partial access: reconnect to authorize ${missingApps.join(", ")}.`;
      } else if (scopeVerification === "unverified") {
        blockerNotice = "Connected, but granted permissions could not be verified yet. Reconnect if a feature is missing.";
      }
    }

    if (unverified) {
      status = "verification_required";
      blockerNotice = "This connection needs secure verification before it can be used. Reconnect this account to confirm it's yours. Until then, nothing runs on it.";
    }

    return {
      id: toolkit.id,
      name: toolkit.name,
      namespace: toolkit.namespace,
      category: toolkit.category,
      description: toolkit.description,
      apps: toolkit.apps,
      status,
      enabled: unverified ? false : isEnabled,
      configured: isSystem || composioConfigured,
      catalogVisible: toolkit.catalogVisible !== false,
      scopes,
      grantedApps,
      missingApps,
      fullyAuthorized,
      scopeVerification,
      unavailableFeatures,
      metadata: unverified ? {} : publicConnectorMetadata({
        ...(record?.metadata || {}),
        ...(linkedViaBundle ? { linkedViaBundle } : {}),
      }),
      connectedAt: record?.createdAt || null,
      requiresApprovalForWrites: toolkit.requiresApprovalForWrites,
      writeActions: toolkit.writeActions,
      readActions: toolkit.readActions,
      blockerNotice,
      linkedViaBundle,
    };
  });
}

/**
 * Initiates an OAuth link or connection flow for a connector.
 */
export async function initiateConnectorFlow(userId, provider, { callbackUrl } = {}) {
  const flow = await initiateComposioConnection(userId, provider, { callbackUrl });

  // Bind the attempt to this authenticated user + provider before the user leaves for OAuth.
  if (flow?.attemptId && !flow.connected) {
    const existing = await activeDb
      .select()
      .from(userConnectors)
      .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
      .limit(1);

    const attemptMeta = {
      attemptId: flow.attemptId,
      connectionId: flow.connectionId || null,
      requestedApps: flow.requestedApps || [],
      callbackUrl: flow.callbackUrl || callbackUrl || null,
      initiatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      phase: "waiting_for_authorization",
    };

    if (existing.length) {
      // Do not flip a connected account to pending; store attempt alongside current state.
      await activeDb
        .update(userConnectors)
        .set({
          status: existing[0].status === "connected" ? existing[0].status : "pending_auth",
          metadata: { ...(existing[0].metadata || {}), authAttempt: attemptMeta },
          updatedAt: new Date(),
        })
        .where(eq(userConnectors.id, existing[0].id));
    } else {
      await activeDb.insert(userConnectors).values({
        userId,
        provider,
        status: "pending_auth",
        enabled: false,
        scopes: [],
        metadata: { authAttempt: attemptMeta },
        accessToken: null,
      });
    }
  }

  return flow;
}

/**
 * Connects or updates a user connector with valid tokens.
 */
export async function connectUserConnector(userId, provider, { accessToken, refreshToken, scopes = [], metadata = {}, expiresAt = null, enabled = true }) {
  const existing = await activeDb
    .select()
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
    .limit(1);

  if (existing.length) {
    const [updated] = await activeDb
      .update(userConnectors)
      .set({
        status: "connected",
        enabled: enabled ?? true,
        accessToken,
        refreshToken: refreshToken ?? existing[0].refreshToken,
        scopes,
        metadata: { ...existing[0].metadata, ...metadata },
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(userConnectors.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await activeDb
    .insert(userConnectors)
    .values({
      userId,
      provider,
      status: "connected",
      enabled: enabled ?? true,
      accessToken,
      refreshToken,
      scopes,
      metadata,
      expiresAt,
    })
    .returning();
  return created;
}

/**
 * Disconnects and revokes a user connector.
 * Scoped strictly to the authenticated user so other users are never affected.
 */
export async function disconnectUserConnector(userId, provider) {
  const [record] = await activeDb
    .select()
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
    .limit(1);

  let upstreamRevoked = false;
  let upstreamError = null;

  // Only an account this server verified as the person's is revoked upstream. An id that arrived in a request body or an event is never trusted.
  const revokeTarget = record?.metadata?.ownershipVerified === true && (await connectionVerified(userId, record)) ? (record.metadata.accountId || record.metadata.id) : null;
  if (revokeTarget) {
    try {
      const res = await revokeComposioConnection(userId, provider, {
        connectionId: revokeTarget,
      });
      upstreamRevoked = Boolean(res?.success);
      // The account is gone or let go, so it no longer counts as theirs. Reconnecting makes a new account with a new alias.
      await releaseOwnedAccount(userId, revokeTarget).catch(() => {});
    } catch (err) {
      upstreamError = err.message || "Failed to revoke upstream connection";
      console.warn(`[composio-adapter] Revoke warning: ${upstreamError}`);
    }
  }

  const metadataUpdate = {
    ...(record?.metadata || {}),
    disconnectedAt: new Date().toISOString(),
    upstreamRevoked,
    ...(upstreamError ? { upstreamRevocationError: upstreamError } : {}),
  };

  let updated;
  if (record) {
    [updated] = await activeDb
      .update(userConnectors)
      .set({
        status: "disconnected",
        enabled: false,
        accessToken: null,
        refreshToken: null,
        metadata: metadataUpdate,
        updatedAt: new Date(),
      })
      .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
      .returning();
  } else {
    // Record explicit disconnect so background sync never automatically reconnects it
    [updated] = await activeDb
      .insert(userConnectors)
      .values({
        userId,
        provider,
        status: "disconnected",
        enabled: false,
        accessToken: null,
        refreshToken: null,
        metadata: metadataUpdate,
      })
      .returning();
  }

  return {
    ...updated,
    localDisconnected: true,
    upstreamRevoked,
    upstreamError,
  };
}

/**
 * Enables or disables tool-use permission for a connected connector.
 * Keeps authorization state separate from tool-use permission.
 */
export async function setUserConnectorEnabled(userId, provider, enabled) {
  if (!userId) throw new Error("userId is required.");
  const toolkit = TOOLKIT_METADATA[provider];
  if (!toolkit) throw new Error(`Unknown connector provider: ${provider}`);

  if (toolkit.authType === "system") {
    return { provider, status: "connected", enabled: Boolean(enabled) };
  }

  const [record] = await activeDb
    .select()
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
    .limit(1);

  if (!record || record.status !== "connected") {
    throw new Error("Cannot enable or disable a disconnected service. Connect the account first.");
  }

  const [updated] = await activeDb
    .update(userConnectors)
    .set({
      enabled: Boolean(enabled),
      updatedAt: new Date(),
    })
    .where(eq(userConnectors.id, record.id))
    .returning();

  return updated;
}

/**
 * Returns true if a connector is authorized and enabled for tool execution.
 */
export async function isConnectorEnabled(userId, provider) {
  if (!userId) return false;
  const toolkit = TOOLKIT_METADATA[provider];
  if (!toolkit) return false;
  if (toolkit.authType === "system") return true;

  const candidates = [provider, ...(CONNECTOR_BUNDLE_FALLBACKS[provider] || [])];
  for (const candidate of candidates) {
    const [record] = await activeDb
      .select()
      .from(userConnectors)
      .where(and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.provider, candidate),
        eq(userConnectors.status, "connected"),
        eq(userConnectors.enabled, true)
      ))
      .limit(1);
    if (!record) continue;
    if (!(await connectionVerified(userId, record))) continue;
    if (candidate !== provider) {
      const granted = record.metadata?.grantedApps || TOOLKIT_METADATA[candidate]?.apps || [];
      const apps = toolkit.apps || [provider];
      const covers = apps.some((app) => granted.includes(app) || granted.includes(provider))
        || (!record.metadata?.grantedApps?.length && TOOLKIT_METADATA[candidate]?.apps?.includes(apps[0]));
      if (!covers) continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether a stored connection is one this person may use: it names a well-formed account, and that account was granted to them (or the key lists
 * accounts per person on the provider's side). A row created some other way, or with no account, is not verified.
 */
export async function connectionVerified(userId, record, owned = null) {
  return verifiedWith(userId, record, owned ?? (await ownedAccountIds(userId)));
}

function verifiedWith(userId, record, owned) {
  const ref = record?.metadata?.accountId || record?.metadata?.id || null;
  return typeof ref === "string" && ACCOUNT_REF.test(ref) && accountGrantedToUser(userId, ref, owned);
}

/** The enabled connection exists but is not verified for this person. Used to say so plainly instead of "not connected". */
export async function connectorNeedsVerification(userId, provider) {
  if (!userId) return false;
  const toolkit = TOOLKIT_METADATA[provider];
  if (!toolkit || toolkit.authType === "system") return false;
  const candidates = [provider, ...(CONNECTOR_BUNDLE_FALLBACKS[provider] || [])];
  for (const candidate of candidates) {
    const [record] = await activeDb
      .select()
      .from(userConnectors)
      .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, candidate), eq(userConnectors.status, "connected"), eq(userConnectors.enabled, true)))
      .limit(1);
    if (record && !(await connectionVerified(userId, record))) return true;
  }
  return false;
}

/** The enabled connection row that covers this provider, including a legacy bundle. */
export async function getEnabledConnectorGrant(userId, provider) {
  if (!userId) return null;
  const toolkit = TOOLKIT_METADATA[provider];
  if (!toolkit || toolkit.authType === "system") return null;
  const candidates = [provider, ...(CONNECTOR_BUNDLE_FALLBACKS[provider] || [])];
  for (const candidate of candidates) {
    const [record] = await activeDb
      .select()
      .from(userConnectors)
      .where(and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.provider, candidate),
        eq(userConnectors.status, "connected"),
        eq(userConnectors.enabled, true),
      ))
      .limit(1);
    if (!record) continue;
    if (!(await connectionVerified(userId, record))) continue;
    if (candidate !== provider) {
      const granted = record.metadata?.grantedApps || TOOLKIT_METADATA[candidate]?.apps || [];
      const apps = toolkit.apps || [provider];
      const covers = apps.some((app) => granted.includes(app) || granted.includes(provider))
        || (!record.metadata?.grantedApps?.length && TOOLKIT_METADATA[candidate]?.apps?.includes(apps[0]));
      if (!covers) continue;
    }
    return record;
  }
  return null;
}

/** Completed write with the same payload hash — retries must not upload again. */
export async function findCompletedActionByPayloadHash(userId, toolName, payloadHash, { withinMs = null } = {}) {
  const [row] = await activeDb
    .select()
    .from(pendingToolActions)
    .where(and(
      eq(pendingToolActions.userId, userId),
      eq(pendingToolActions.toolName, toolName),
      eq(pendingToolActions.payloadHash, payloadHash),
      eq(pendingToolActions.status, "completed"),
      // A card that was itself only recognised as a repeat did not send anything, so it never extends the protection.
      sql`${pendingToolActions.result} ->> 'deduped' IS NULL`,
      ...(withinMs ? [gt(pendingToolActions.updatedAt, new Date(Date.now() - withinMs))] : []),
    ))
    .limit(1);
  return row || null;
}

/**
 * Retrieves the active access token for a connector, or null if disconnected or disabled.
 */
export async function getConnectorAccessToken(userId, provider) {
  const candidates = [provider, ...(CONNECTOR_BUNDLE_FALLBACKS[provider] || [])];
  for (const candidate of candidates) {
    const [record] = await activeDb
      .select()
      .from(userConnectors)
      .where(and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.provider, candidate),
        eq(userConnectors.status, "connected"),
        eq(userConnectors.enabled, true)
      ))
      .limit(1);

    if (!record?.accessToken) continue;
    if (record.expiresAt && new Date(record.expiresAt) <= new Date()) continue;
    if (candidate !== provider) {
      const granted = record.metadata?.grantedApps || TOOLKIT_METADATA[candidate]?.apps || [];
      const apps = TOOLKIT_METADATA[provider]?.apps || [provider];
      const covers = apps.some((app) => granted.includes(app) || granted.includes(provider))
        || (!record.metadata?.grantedApps?.length && TOOLKIT_METADATA[candidate]?.apps?.includes(apps[0]));
      if (!covers) continue;
    }
    return record.accessToken;
  }
  return null;
}

const ACCOUNT_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,119}$/;

/**
 * The connected account this user's connector was verified against, so a call names it and does not leave the provider to pick one
 * (a re-authorization creates another account at the provider, and the default is not always the one that was verified). Only a
 * connected, enabled connector has one; the value is checked to look like an account reference before it is sent anywhere.
 */
export async function getConnectorAccountId(userId, provider) {
  const [record] = await activeDb
    .select()
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider), eq(userConnectors.status, "connected"), eq(userConnectors.enabled, true)))
    .limit(1);
  const ref = record?.metadata?.accountId || record?.metadata?.id || null;
  if (typeof ref !== "string" || !ACCOUNT_REF.test(ref)) return null;
  // A stored account that was not granted to this person (for instance one attached before this check existed) is not usable.
  return accountGrantedToUser(userId, ref, await ownedAccountIds(userId)) ? ref : null;
}

/**
 * The provider no longer has a live connection for this user and service. The connector stops claiming to be connected, so the
 * Extensions page, the next request and the model all say "reconnect" and no further provider call is made for it.
 */
export async function markConnectorNeedsReconnect(userId, provider) {
  const [record] = await activeDb
    .select()
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
    .limit(1);
  if (!record || record.status !== "connected") return false;
  await activeDb
    .update(userConnectors)
    .set({ status: "expired", metadata: { ...(record.metadata || {}), needsReconnectAt: new Date().toISOString() }, updatedAt: new Date() })
    .where(eq(userConnectors.id, record.id));
  return true;
}

/** True when the connector was connected once and the provider has since lost the connection (see markConnectorNeedsReconnect). */
export async function connectorNeedsReconnect(userId, provider) {
  const [record] = await activeDb
    .select({ status: userConnectors.status })
    .from(userConnectors)
    .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
    .limit(1);
  return record?.status === "expired";
}

/**
 * After a read fails for a reason that could be the connection itself, ask the provider whether the user still has a live account for
 * this service. Only a definite "not connected" changes anything; a provider that cannot be asked, or lists the account as active,
 * leaves the connection alone. Returns whether the connection is still believed live.
 */
export async function verifyConnectorAfterFailure(userId, provider) {
  let status;
  try {
    status = await checkComposioAccountStatus(userId, provider);
  } catch {
    return true;
  }
  // "available" is the provider's answer that it listed the user's accounts and none is live. "disconnected" means the lookup itself
  // failed (for example the provider could not be reached), which says nothing about the user's account, so it changes nothing.
  if (status?.status === "available") {
    await markConnectorNeedsReconnect(userId, provider);
    return false;
  }
  return true;
}

/**
 * Creates a pending consequential write action requiring human approval.
 * Enforces cryptographic payload binding, single-use idempotency, and 5-minute TTL.
 */
export async function createPendingAction({ userId, conversationId = null, toolName, actionDescription, payload }) {
  const payloadHash = computePayloadHash(payload);
  const idempotencyKey = `act_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min TTL

  const [action] = await activeDb
    .insert(pendingToolActions)
    .values({
      userId,
      conversationId,
      toolName,
      actionDescription,
      payload,
      payloadHash,
      idempotencyKey,
      status: "pending",
      expiresAt,
    })
    .returning();

  return {
    id: action.id,
    toolName: action.toolName,
    actionDescription: action.actionDescription,
    payload: action.payload,
    payloadHash: action.payloadHash,
    idempotencyKey: action.idempotencyKey,
    status: action.status,
    expiresAt: action.expiresAt,
  };
}

/**
 * Lists all pending actions for a user that have not yet expired.
 */
export async function listPendingActions(userId) {
  return activeDb
    .select()
    .from(pendingToolActions)
    .where(and(eq(pendingToolActions.userId, userId), eq(pendingToolActions.status, "pending"), gt(pendingToolActions.expiresAt, new Date())));
}

const TERMINAL_ACTION_STATUSES = new Set(["completed", "failed", "discarded", "expired", "uncertain"]);
const ACTION_STALE_MS = 120_000;
const EMAIL_WRITE_TOOLS = new Set(["gmail_send_email", "draft_email"]);
// Repeat protection for a send covers a short window; the same words sent to the same person later are a new email.
const EMAIL_REPEAT_WINDOW_MS = 10 * 60 * 1000;

function providerFileId(result) {
  return result?.id || result?.documentId || null;
}

function dispatchIsUncertain(error) {
  const name = error?.name || "";
  const message = String(error?.message || "");
  return name === "AbortError" || name === "TimeoutError" || /timeout|timed out|aborted|network|ECONNRESET|fetch failed/i.test(message);
}

async function readOwnedAction(userId, actionId) {
  const [action] = await activeDb
    .select()
    .from(pendingToolActions)
    .where(and(eq(pendingToolActions.id, actionId), eq(pendingToolActions.userId, userId)))
    .limit(1);
  return action || null;
}

async function writeAction(actionId, values, extraWhere = []) {
  const [row] = await activeDb
    .update(pendingToolActions)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(pendingToolActions.id, actionId), ...extraWhere))
    .returning();
  return row || null;
}

/**
 * Writes made by the one worker that holds an action's claim. The condition is part of the UPDATE, so it holds across processes: the row must still be
 * in flight, or have been marked unconfirmed by the abandoned-claim rule (a late honest answer from the provider may then upgrade it). Once a person has
 * settled it, or anything else has moved it on, this writes nothing and returns null.
 */
export function writeClaimed(actionId, values) {
  return writeAction(actionId, values, [or(
    eq(pendingToolActions.status, "in_progress"),
    and(eq(pendingToolActions.status, "uncertain"), sql`${pendingToolActions.result} ->> 'code' = 'claim_abandoned'`),
  )]);
}

/**
 * The lease taken immediately before anything is sent: allowed only while the row is still plainly in flight (not marked unconfirmed, not settled), and it
 * restarts the clock the abandoned-claim rule uses. Returns null when the worker no longer holds the claim, in which case it must send nothing.
 */
export function leaseDispatch(actionId, values) {
  return writeAction(actionId, values, [eq(pendingToolActions.status, "in_progress")]);
}

/** The caller's action, including a terminal failure. Does not execute anything. */
export async function getActionForUser(userId, actionId) {
  const action = await readOwnedAction(userId, actionId);
  if (!action) return null;
  if (action.status === "in_progress" && !providerFileId(action.result)) {
    const updatedAt = new Date(action.updatedAt || action.createdAt || 0).getTime();
    if (Date.now() - updatedAt > ACTION_STALE_MS) {
      return (await writeAction(actionId, {
        status: "uncertain",
        result: {
          ...(action.result || {}),
          code: "claim_abandoned",
          dispatchStatus: "dispatch_uncertain",
          error: "The upload was sent and its result was not confirmed. It was not sent again.",
        },
      }, [eq(pendingToolActions.status, "in_progress")])) || action;
    }
  }
  if (action.status === "in_progress" && providerFileId(action.result)) {
    return (await writeAction(actionId, {
      status: "completed",
      executedAt: action.executedAt || new Date(),
      result: { ...(action.result || {}), dispatchStatus: "dispatched_succeeded" },
    }, [eq(pendingToolActions.status, "in_progress")])) || action;
  }
  return action;
}

let completedPersistFailures = 0;

/** Test seam: the provider result is stored, then the completed write fails once. */
export function failNextCompletedPersistForTest() {
  completedPersistFailures += 1;
}

/**
 * Takes the exclusive right to dispatch an approved action. Two things are prevented here, under a lock keyed on the user, the tool and the payload
 * (which names the artifact, its checksum, the connected account and the destination):
 *  - the same card running twice, and
 *  - two different cards for the same operation (asked for twice) both being in flight.
 * A twin that is in flight blocks this action however long it has been running, and a twin that did not report back (uncertain) blocks it until a
 * person reconciles it. A claim that has outlived any bounded upload is turned into "uncertain" rather than becoming free to repeat, because the
 * provider cannot tell us whether a call that never reported back reached Drive. Returns { row } when claimed, { row: null } when this action was
 * not pending, or { row: null, blockedBy: "in_progress" | "uncertain" }.
 */
export async function claimActionForDispatch(userId, action) {
  const lockKey = `${userId}:${action.toolName}:${action.payloadHash}`;
  const twinWhere = and(
    eq(pendingToolActions.userId, userId),
    eq(pendingToolActions.toolName, action.toolName),
    eq(pendingToolActions.payloadHash, action.payloadHash),
    ne(pendingToolActions.id, action.id),
  );
  return activeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    await tx
      .update(pendingToolActions)
      .set({
        status: "uncertain",
        result: { dispatchStatus: "dispatch_uncertain", code: "claim_abandoned", error: "The upload was sent and its result was not confirmed. It was not sent again." },
        updatedAt: new Date(),
      })
      .where(and(twinWhere, eq(pendingToolActions.status, "in_progress"), lt(pendingToolActions.updatedAt, new Date(Date.now() - ACTION_STALE_MS))));
    const [twin] = await tx
      .select({ status: pendingToolActions.status })
      .from(pendingToolActions)
      .where(and(twinWhere, inArray(pendingToolActions.status, ["in_progress", "uncertain"])))
      .orderBy(pendingToolActions.createdAt)
      .limit(1);
    if (twin) return { row: null, blockedBy: twin.status };
    const [row] = await tx
      .update(pendingToolActions)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(and(eq(pendingToolActions.id, action.id), eq(pendingToolActions.userId, userId), eq(pendingToolActions.status, "pending")))
      .returning();
    return { row: row ?? null };
  });
}

/**
 * Settles an upload whose result was never confirmed, by the person's own word after checking their Drive. "uploaded" records it as done (so a
 * repeat is recognised and not sent); "not_uploaded" records that nothing arrived, which lets the file be sent again. Only an uncertain action can be
 * settled this way, and only by its owner.
 */
export async function reconcileUncertainAction(userId, actionId, outcome) {
  const action = await readOwnedAction(userId, actionId);
  if (!action) throw new Error("Action not found or unauthorized.");
  if (outcome !== "uploaded" && outcome !== "not_uploaded") throw new Error("Say whether the file is in Drive: uploaded or not_uploaded.");
  if (action.status !== "uncertain") throw new Error(`Only an upload that did not report back can be settled this way (this one is ${action.status}).`);
  // What is recorded is the person's own declaration, not something Drive confirmed, and it says so. No link or file content is kept.
  const record = { reconciled: outcome, reconciledAt: new Date().toISOString(), reconciledBy: "owner", providerVerified: false };
  const settled = outcome === "uploaded"
    ? { status: "completed", executedAt: action.executedAt || new Date(), result: { ...(action.result || {}), ...record, dispatchStatus: "user_reported_uploaded" } }
    : { status: "failed", result: { ...(action.result || {}), ...record, code: "reconciled_not_uploaded", dispatchStatus: "user_reported_not_uploaded", error: "You told us this file did not reach Drive. Nothing was sent again." } };
  // One atomic transition: of any number of simultaneous settlements, exactly one is applied.
  const applied = await writeAction(actionId, settled, [eq(pendingToolActions.status, "uncertain"), eq(pendingToolActions.userId, userId)]);
  if (!applied) {
    const now = await readOwnedAction(userId, actionId);
    throw new Error(`This upload was already settled (${now?.status ?? "unknown"}), so nothing was changed.`);
  }
  return applied;
}

/**
 * Approves and executes a pending action after verifying payload hash and session authority.
 * A repeated call returns the current state and does not upload again.
 */
export async function approveAndExecuteAction(userId, actionId, expectedPayloadHash = null) {
  const action = await readOwnedAction(userId, actionId);

  if (!action) {
    throw new Error("Action not found or unauthorized.");
  }

  if (TERMINAL_ACTION_STATUSES.has(action.status)) return action;

  if (action.status === "in_progress") {
    return getActionForUser(userId, actionId);
  }

  if (action.status !== "pending") {
    throw new Error(`Action is already ${action.status}.`);
  }

  if (new Date(action.expiresAt) <= new Date()) {
    return (await writeAction(actionId, {
      status: "expired",
      result: { error: "This approval expired before it was executed.", dispatchStatus: "pre_dispatch_failure" },
    })) || action;
  }

  // Exact payload binding: verify cryptographic hash of payload matches action record
  const currentHash = computePayloadHash(action.payload);
  if (currentHash !== action.payloadHash || (expectedPayloadHash && expectedPayloadHash !== action.payloadHash)) {
    throw new Error("Action payload mismatch or approval has been tampered with.");
  }

  const claim = await claimActionForDispatch(userId, action);
  if (claim.blockedBy) {
    throw new Error(claim.blockedBy === "uncertain"
      ? "An earlier upload of this file did not report back, so it is not known whether it reached Drive, and nothing more was sent. Check your Drive for it, then mark it as uploaded or not uploaded and ask again."
      : "This file is already being uploaded from another approval, so nothing more was sent. Check your Drive in a moment.");
  }
  const claimed = claim.row;
  if (!claimed) {
    return (await getActionForUser(userId, actionId)) || action;
  }

  // Verify that the owning connector (or a covering legacy bundle) is not
  // explicitly disabled. Missing connectors still proceed so unconfigured
  // environments fail with an honest configuration error (never synthetic success).
  const { toolName, payload } = action;
  const connectorId = TOOL_TO_CONNECTOR_MAP[toolName];
  if (connectorId) {
    const providerCandidates = [connectorId, ...(CONNECTOR_BUNDLE_FALLBACKS[connectorId] || [])];
    for (const provider of providerCandidates) {
      const [record] = await activeDb
        .select()
        .from(userConnectors)
        .where(and(eq(userConnectors.userId, userId), eq(userConnectors.provider, provider)))
        .limit(1);
      if (record?.status === "connected" && record.enabled === false) {
        const label = TOOLKIT_METADATA[connectorId]?.name || TOOLKIT_METADATA[provider]?.name || connectorId;
        await writeClaimed(actionId, {
          status: "failed",
          result: {
            error: `${label} is disabled by user.`,
            dispatchStatus: "pre_dispatch_failure",
            failedAt: new Date().toISOString(),
          },
        });
        throw new Error(`Execution blocked: ${label} is disabled by user.`);
      }
    }
  }

  let driveAccountId = null;
  let artifactUpload = null;
  if (toolName === "google_drive_upload_file") {
    const grant = await getEnabledConnectorGrant(userId, "googledrive");
    driveAccountId = grant?.metadata?.id || grant?.metadata?.accountId || null;
    const scope = driveWriteAllowedByScopes(grant?.scopes || []);
    if (!scope.ok) {
      const error = "Google Drive is connected with read-only access. Reconnect it to allow creating files.";
      await writeClaimed(actionId, {
        status: "failed",
        result: { code: "insufficient_scope", error, dispatchStatus: "pre_dispatch_failure" },
      });
      throw new Error(error);
    }
    if (payload?.attachmentId) {
      // A file this conversation made: the approval is bound to its exact bytes, and the destination was resolved before it was shown.
      if (payload.folderId && !isDriveFolderId(payload.folderId)) {
        const error = "The destination folder could not be confirmed, so nothing was uploaded.";
        await writeClaimed(actionId, { status: "failed", result: { code: "folder_unresolved", error, dispatchStatus: "pre_dispatch_failure" } });
        throw new Error(error);
      }
      // The approval was prepared for one connected account. If it is not that account now (disconnected and reconnected as another), nothing is sent.
      if (payload.accountRef) {
        // The same lookup the card was prepared with, so an unchanged account is never reported as changed.
        const current = await getConnectorAccountId(userId, "googledrive").catch(() => null);
        if (current == null || accountReference(current) !== payload.accountRef) {
          const error = "The connected Google Drive account changed since this was prepared, so nothing was uploaded. Ask again if you still want it uploaded.";
          await writeClaimed(actionId, { status: "failed", result: { code: "account_changed", error, dispatchStatus: "pre_dispatch_failure" } });
          throw new Error(error);
        }
      }
      const loaded = await loadArtifactForUpload(userId, payload.attachmentId, { expectedSha256: payload.sha256, executor: activeDb });
      if (!loaded.ok) {
        await writeClaimed(actionId, { status: "failed", result: { code: loaded.code, error: loaded.message, dispatchStatus: "pre_dispatch_failure" } });
        throw new Error(loaded.message);
      }
      artifactUpload = loaded;
    } else if (driveFolderNeedsResolution(payload)) {
      const error = "That destination is a folder name, not a Drive folder id, so nothing was uploaded.";
      await writeClaimed(actionId, {
        status: "failed",
        result: { code: "folder_unresolved", error, dispatchStatus: "pre_dispatch_failure" },
      });
      throw new Error(error);
    }
  }

  // An email was prepared for one connected Gmail account. If that is not the account now, nothing is sent.
  if (EMAIL_WRITE_TOOLS.has(toolName) && payload.accountRef) {
    const current = await getConnectorAccountId(userId, "gmail").catch(() => null);
    if (current == null || accountReference(current) !== payload.accountRef) {
      const error = "The connected Gmail account changed since this was prepared, so nothing was sent. Ask again if you still want it sent.";
      await writeClaimed(actionId, { status: "failed", result: { code: "account_changed", error, dispatchStatus: "pre_dispatch_failure" } });
      throw new Error(error);
    }
  }

  // A previous approval of the same payload already uploaded. Do not dispatch again.
  const prior = await findCompletedActionByPayloadHash(userId, toolName, action.payloadHash, EMAIL_WRITE_TOOLS.has(toolName) ? { withinMs: EMAIL_REPEAT_WINDOW_MS } : {});
  if (prior?.result) {
    await activeDb
      .update(pendingToolActions)
      .set({
        status: "completed",
        executedAt: prior.executedAt || new Date(),
        result: { ...(prior.result || {}), deduped: true },
        updatedAt: new Date(),
      })
      .where(eq(pendingToolActions.id, actionId));
    return { ...prior, deduped: true, id: actionId };
  }

  // What is actually sent. A text format is created from its text; any other format is handed to the connection service first, and the
  // tool is given the key it returns. A failure here is before anything touches the person's Drive, so it is reported as exactly that.
  let dispatchSlug = toolName;
  let dispatchParameters = payload;
  if (artifactUpload) {
    const { record, buffer } = artifactUpload;
    if (isTextArtifact(record.mimeType)) {
      dispatchParameters = { fileName: payload.fileName, content: buffer.toString("utf8"), mimeType: record.mimeType, ...(payload.folderId ? { parent_id: payload.folderId } : { folderName: "My Drive" }) };
    } else {
      try {
        const handed = await uploadComposioFile({ toolkit: "googledrive", tool: "GOOGLEDRIVE_UPLOAD_FILE", filename: payload.fileName, mimetype: record.mimeType, buffer });
        dispatchSlug = "GOOGLEDRIVE_UPLOAD_FILE";
        dispatchParameters = {
          file_to_upload: { name: payload.fileName, mimetype: record.mimeType, s3key: handed.s3key },
          ...(payload.folderId ? { folder_to_upload_to: payload.folderId } : {}),
        };
      } catch (err) {
        const error = "I couldn't hand the file over to Google Drive, so nothing was uploaded. Nothing was created and nothing will be retried on its own.";
        await writeClaimed(actionId, {
          status: "failed",
          result: { code: err?.code || "file_transfer_failed", error, httpStatus: err?.httpStatus ?? null, dispatchStatus: "pre_dispatch_failure", failedAt: new Date().toISOString() },
        });
        throw new Error(error);
      }
    }
  }

  // Execute external mutation via verified tool adapter (requires configured credentials)
  let result = null;
  let dispatchStarted = false;

  // The lease: nothing is sent unless this worker still holds the claim at this moment (in flight, not marked unconfirmed, not settled). The write also
  // restarts the clock the abandoned-claim rule uses, so the time left for the call to finish is the whole window.
  const leased = await leaseDispatch(actionId, {
    result: {
      dispatchStatus: "dispatch_started",
      accountId: driveAccountId ? String(driveAccountId).slice(0, 32) : null,
      idempotencyKey: action.idempotencyKey,
    },
  });
  if (!leased) {
    console.warn(JSON.stringify({ event: "action_dispatch_fenced", actionId }));
    throw new Error("This upload was no longer waiting for its turn when it was about to be sent, so nothing was sent.");
  }

  // Every write names the account it was verified against. Drive already did; the others left the provider to choose its default, which
  // is not always the account that was connected (a re-authorization creates another one at the provider).
  const pinnedAccountId = driveAccountId || (connectorId ? await getConnectorAccountId(userId, connectorId).catch(() => null) : null);

  try {
    dispatchStarted = true;
    const execResponse = await executeComposioTool({
      userId,
      toolSlug: dispatchSlug,
      parameters: dispatchParameters,
      connectedAccountId: pinnedAccountId,
    });
    result = execResponse.data;
  } catch (err) {
    const uncertain = dispatchIsUncertain(err);
    const serviceName = TOOLKIT_METADATA[connectorId]?.name || connectorId;
    const mapped = mapConnectorError(err, { service: serviceName, toolName });
    await writeClaimed(actionId, {
      status: uncertain ? "uncertain" : "failed",
      result: {
        error: mapped.message,
        code: mapped.code || (uncertain ? "dispatch_uncertain" : "provider_rejected"),
        logId: err.logId || null,
        dispatchStatus: uncertain ? "dispatch_uncertain" : (dispatchStarted && mapped.code !== "tool_unavailable" ? "dispatch_failed" : "pre_dispatch_failure"),
        accountId: driveAccountId ? String(driveAccountId).slice(0, 32) : null,
        failedAt: new Date().toISOString(),
      },
    });
    throw new Error(`External execution failed: ${mapped.message}`);
  }

  // A Drive upload is only reported as done when Drive names the file it made. An answer without one is not a confirmation: the file may or
  // may not exist, so it is recorded as unconfirmed and never retried on its own.
  if (toolName === "google_drive_upload_file" && !providerFileId(result)) {
    const error = "Google Drive answered but did not confirm a file, so I can't say the upload happened. Check your Drive before asking again.";
    await writeClaimed(actionId, {
      status: "uncertain",
      result: { code: "unconfirmed", error, logId: result?.logId || null, dispatchStatus: "dispatch_uncertain", accountId: driveAccountId ? String(driveAccountId).slice(0, 32) : null, failedAt: new Date().toISOString() },
    });
    return getActionForUser(userId, actionId);
  }

  // A send or a draft is only reported as done when Gmail names the message or draft it made. An answer without one is not a confirmation, and it is
  // never retried on its own.
  if (EMAIL_WRITE_TOOLS.has(toolName) && !providerFileId(result)) {
    const error = toolName === "gmail_send_email"
      ? "Gmail answered but did not confirm a sent message, so I can't say the email was sent. Check your Sent folder before asking again."
      : "Gmail answered but did not confirm a draft, so I can't say it was saved. Check your Drafts before asking again.";
    await writeClaimed(actionId, {
      status: "uncertain",
      result: { code: "unconfirmed", error, logId: result?.logId || null, dispatchStatus: "dispatch_uncertain", failedAt: new Date().toISOString() },
    });
    return getActionForUser(userId, actionId);
  }

  const providerResult = {
    ...(result || {}),
    dispatchStatus: "provider_succeeded",
    logId: result?.logId || null,
    accountId: driveAccountId ? String(driveAccountId).slice(0, 32) : null,
  };
  // Persist the provider file before the completed flag. A crash after this
  // point can be finished locally without uploading again.
  await writeClaimed(actionId, { result: providerResult });
  if (completedPersistFailures > 0) {
    completedPersistFailures -= 1;
    return getActionForUser(userId, actionId);
  }

  const completed = await writeClaimed(actionId, {
    status: "completed",
    executedAt: new Date(),
    result: { ...providerResult, dispatchStatus: "dispatched_succeeded" },
  });
  if (!completed) {
    // Something else settled this action first (a person reconciled it). Their record stands; this late answer does not overwrite it.
    console.warn(JSON.stringify({ event: "action_result_after_settlement", actionId }));
    return (await getActionForUser(userId, actionId)) || providerResult;
  }
  return completed;
}

/**
 * Discards a pending action when the user declines approval.
 */
export async function discardAction(userId, actionId) {
  const [action] = await activeDb
    .select()
    .from(pendingToolActions)
    .where(and(eq(pendingToolActions.id, actionId), eq(pendingToolActions.userId, userId)))
    .limit(1);

  if (!action) throw new Error("Action not found or unauthorized.");
  if (action.status !== "pending") return action;

  const [discarded] = await activeDb
    .update(pendingToolActions)
    .set({
      status: "discarded",
      result: { summary: "Action declined by user." },
      updatedAt: new Date(),
    })
    .where(eq(pendingToolActions.id, actionId))
    .returning();

  return discarded;
}
