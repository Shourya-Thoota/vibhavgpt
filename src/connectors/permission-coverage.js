/**
 * Honest connector permission coverage.
 *
 * Connected app identifiers alone do NOT prove OAuth scopes were granted.
 * fullyAuthorized requires every advertised app to be connected AND, when
 * scope evidence is present, that those scopes cover the toolkit's features.
 */

/** Known Google OAuth scopes mapped to advertised Workspace apps / features. */
export const GOOGLE_APP_SCOPE_HINTS = Object.freeze({
  googledocs: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/documents.readonly",
  ],
  googledrive: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  gmail: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  googlecalendar: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
  googlesheets: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
});

/**
 * Write access for Drive. Empty scope evidence stays unverified (the connection
 * can still be confirmed). A read-only Drive scope is a hard no.
 */
export function driveWriteAllowedByScopes(scopes) {
  const list = (Array.isArray(scopes) ? scopes : []).map((scope) => String(scope).toLowerCase());
  if (!list.length) return { ok: true, unverified: true };
  const write = list.some((scope) =>
    scope === "https://www.googleapis.com/auth/drive"
    || scope === "https://www.googleapis.com/auth/drive.file"
    || scope.endsWith("/auth/drive")
    || scope.endsWith("/auth/drive.file")
    || scope === "drive"
    || scope === "drive.file",
  );
  const readOnly = list.some((scope) => scope.includes("drive.readonly") || scope.includes("drive.metadata.readonly"));
  if (write) return { ok: true, unverified: false };
  if (readOnly) return { ok: false, code: "insufficient_scope" };
  return { ok: true, unverified: true };
}

export const GOOGLE_FEATURE_LABELS = Object.freeze({
  googledocs: "Google Docs",
  googledrive: "Google Drive",
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googlesheets: "Google Sheets",
  googleslides: "Google Slides",
  googletasks: "Google Tasks",
  youtube: "YouTube",
});

/**
 * Extract granted OAuth scope strings from a Composio account payload when present.
 * Returns [] when the provider response does not include scope evidence.
 */
export function extractGrantedScopesFromAccount(account) {
  if (!account || typeof account !== "object") return [];
  const candidates = [
    account.scopes,
    account.scope,
    account.granted_scopes,
    account.permissions,
    account.auth_config?.scopes,
    account.authConfig?.scopes,
    account.connection_params?.scopes,
    account.connectionParams?.scopes,
    account.metadata?.scopes,
    account.data?.scopes,
  ];
  const out = [];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) out.push(item.trim());
      }
    } else if (typeof value === "string" && value.trim()) {
      out.push(...value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
    }
  }
  return [...new Set(out)];
}

function scopesCoverApp(appName, grantedScopes) {
  const hints = GOOGLE_APP_SCOPE_HINTS[appName];
  if (!hints) {
    // Non-Google apps: without a known scope map we cannot claim scope coverage.
    return false;
  }
  const normalized = grantedScopes.map((s) => s.toLowerCase());
  return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

/**
 * Derive honest coverage for a toolkit connection attempt/result.
 *
 * @returns {{
 *   requestedApps: string[],
 *   connectedApps: string[],
 *   missingApps: string[],
 *   grantedScopes: string[],
 *   scopeVerification: 'verified'|'partial'|'unverified'|'not_applicable',
 *   fullyAuthorized: boolean,
 *   unavailableFeatures: string[],
 *   supportedPermissions: string[],
 * }}
 */
export function deriveGrantedPermissionCoverage({
  toolkitId,
  requestedApps = [],
  connectedApps = [],
  grantedScopes = [],
} = {}) {
  const requested = [...new Set((requestedApps || []).map(String))];
  const connected = [...new Set((connectedApps || []).map(String))];
  const scopes = [...new Set((grantedScopes || []).map(String))];
  const missingApps = requested.filter((app) => !connected.includes(app));

  const unavailableFeatures = [];
  for (const app of missingApps) {
    unavailableFeatures.push(GOOGLE_FEATURE_LABELS[app] || app);
  }

  let scopeVerification = "not_applicable";
  const supportedPermissions = [];

  if (toolkitId === "google_workspace") {
    if (scopes.length === 0) {
      scopeVerification = "unverified";
    } else {
      let covered = 0;
      for (const app of connected) {
        if (scopesCoverApp(app, scopes)) {
          covered += 1;
          supportedPermissions.push(...(GOOGLE_APP_SCOPE_HINTS[app] || []).filter((s) =>
            scopes.map((x) => x.toLowerCase()).includes(s.toLowerCase()),
          ));
        } else {
          unavailableFeatures.push(`${GOOGLE_FEATURE_LABELS[app] || app} (scope missing)`);
        }
      }
      scopeVerification = covered === connected.length && connected.length > 0 ? "verified" : "partial";
    }
  } else if (scopes.length > 0) {
    scopeVerification = "partial";
    supportedPermissions.push(...scopes);
  } else if (connected.length > 0) {
    scopeVerification = "unverified";
  }

  // Never mark fullyAuthorized solely because app identifiers appeared.
  // Require: every requested app connected AND (no scope evidence needed for non-Google
  // only when we explicitly treat scopeVerification as not_applicable with empty scopes
  // is insufficient for Google — Google requires verified scopes).
  let fullyAuthorized = false;
  if (missingApps.length === 0 && requested.length > 0 && connected.length >= requested.length) {
    if (toolkitId === "google_workspace") {
      fullyAuthorized = scopeVerification === "verified";
    } else {
      // Without a published scope map, connected apps are necessary but not sufficient
      // proof of feature authorization when scopes are absent.
      fullyAuthorized = scopes.length > 0 ? scopeVerification !== "unverified" : false;
    }
  }

  return {
    requestedApps: requested,
    connectedApps: connected,
    missingApps,
    grantedScopes: scopes,
    scopeVerification,
    fullyAuthorized,
    unavailableFeatures: [...new Set(unavailableFeatures)],
    supportedPermissions: [...new Set(supportedPermissions)],
  };
}
