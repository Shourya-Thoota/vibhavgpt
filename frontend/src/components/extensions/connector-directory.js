const PLAIN_SERVICE_NAMES = Object.freeze({
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
});

export const STATUS_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "not_connected", label: "Not connected" },
  { id: "needs_permissions", label: "Needs permissions" },
]);

export { PLAIN_SERVICE_NAMES };

/**
 * Connected accounts that are missing an advertised app or a listed feature.
 * Unverified scope evidence is not the same as a missing permission.
 */
export function connectorNeedsPermissions(connector) {
  if (!connector || connector.status !== "connected") return false;
  const missing = Array.isArray(connector.missingApps) && connector.missingApps.length > 0;
  const unavailable = Array.isArray(connector.unavailableFeatures) && connector.unavailableFeatures.length > 0;
  return missing || unavailable;
}

export function connectorMatchesDirectoryFilters(connector, { query = "", statusFilter = "all", categoryFilter = "all" } = {}) {
  if (!connector) return false;
  const q = String(query || "").trim().toLowerCase();
  if (q) {
    const plain = (PLAIN_SERVICE_NAMES[connector.id] || "").toLowerCase();
    const name = (connector.name || "").toLowerCase();
    const desc = (connector.description || "").toLowerCase();
    const id = String(connector.id || "").toLowerCase();
    if (!plain.includes(q) && !name.includes(q) && !desc.includes(q) && !id.includes(q)) return false;
  }
  if (statusFilter === "connected" && connector.status !== "connected") return false;
  if (statusFilter === "not_connected" && connector.status === "connected") return false;
  if (statusFilter === "needs_permissions" && !connectorNeedsPermissions(connector)) return false;
  if (categoryFilter !== "all" && connector.category !== categoryFilter) return false;
  return true;
}

/**
 * The status filters worth offering right now: "All", the one already chosen (so the control never shows a value it does not
 * list), and every other filter that would show at least one connector with the current search. A filter that returns nothing
 * is not offered, so there is no "Needs permissions" with nothing behind it.
 */
export function availableStatusFilters(connectors, { query = "", selected = "all" } = {}) {
  return STATUS_FILTERS.filter((option) => option.id === "all" || option.id === selected
    || connectors.some((connector) => connectorMatchesDirectoryFilters(connector, { query, statusFilter: option.id })));
}

/** What a connector without a category is listed under. */
export const OTHER_CATEGORY = "Other";

/**
 * The directory as it is listed: "Connected" first (only if any connector is), then one group per category in the order the
 * directory gives them. A connected connector is listed once, under "Connected".
 */
export function groupConnectors(connectors) {
  const groups = [];
  const connected = connectors.filter((connector) => connector.status === "connected");
  if (connected.length) groups.push({ id: "connected", title: "Connected", items: connected });
  const byCategory = new Map();
  for (const connector of connectors) {
    if (connector.status === "connected") continue;
    const title = connector.category || OTHER_CATEGORY;
    if (!byCategory.has(title)) byCategory.set(title, []);
    byCategory.get(title).push(connector);
  }
  for (const [title, items] of byCategory) groups.push({ id: `category-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, title, items });
  return groups;
}

export function directoryResultLabel(matchCount, directoryCount, filtered) {
  if (filtered) return `${matchCount} of ${directoryCount} connectors match`;
  return `${directoryCount} ${directoryCount === 1 ? "connector" : "connectors"}`;
}
