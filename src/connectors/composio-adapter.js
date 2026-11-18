import { claimAccountsByAlias, ownedAccountIds, recordConnectAliases } from "./account-ownership.js";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { toDriveCreateArguments } from "./drive-upload.js";
import {
  deriveGrantedPermissionCoverage,
  extractGrantedScopesFromAccount,
} from "./permission-coverage.js";

const COMPOSIO_API_BASE = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev/api/v3";
const COMPOSIO_EXEC_BASE = process.env.COMPOSIO_EXEC_URL || "https://backend.composio.dev/api/v3.1";
const COMPOSIO_MCP_BASE = process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp";
const COMPOSIO_FILES_BASE = process.env.COMPOSIO_FILES_URL || "https://backend.composio.dev/api/v3.1";

/**
 * Normalization map from internal tool names to standard Composio Connect tool slugs.
 */
export const TOOL_SLUG_MAP = Object.freeze({
  // Google Docs
  google_docs_create_document: "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN",
  google_docs_get_document: "GOOGLEDOCS_GET_DOCUMENT_BY_ID",
  append_to_google_doc: "GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN",

  // Gmail
  gmail_send_email: "GMAIL_SEND_EMAIL",
  gmail_list_messages: "GMAIL_LIST_MESSAGES",
  draft_email: "GMAIL_CREATE_EMAIL_DRAFT",

  // Google Calendar
  google_calendar_create_event: "GOOGLECALENDAR_CREATE_EVENT",
  google_calendar_list_events: "GOOGLECALENDAR_LIST_EVENTS",
  create_calendar_event: "GOOGLECALENDAR_CREATE_EVENT",

  // Google Drive — slugs verified via COMPOSIO_SEARCH_TOOLS (create-from-text + find).
  google_drive_upload_file: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
  google_drive_search: "GOOGLEDRIVE_FIND_FILE",

  // GitHub
  github_create_issue: "GITHUB_CREATE_AN_ISSUE",
  github_create_pull_request: "GITHUB_CREATE_A_PULL_REQUEST",
  github_commit_files: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS",
  github_get_repo: "GITHUB_GET_A_REPOSITORY",
  github_search_code: "GITHUB_SEARCH_CODE",
  github_list_issues: "GITHUB_LIST_REPOSITORY_ISSUES",
  github_list_pull_requests: "GITHUB_LIST_PULL_REQUESTS",
  stage_commit_edit: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS",

  // Notion
  notion_create_page: "NOTION_CREATE_NOTION_PAGE",
  notion_append_block_children: "NOTION_ADD_MULTIPLE_PAGE_CONTENT",
  notion_search: "NOTION_SEARCH_NOTION_PAGE",
  notion_get_page: "NOTION_FETCH_DATA",
  notion_query_database: "NOTION_FETCH_DATABASE",

  // Slack
  slack_post_message: "SLACK_SEND_MESSAGE",
  slack_send_dm: "SLACK_OPEN_DM",
  slack_list_channels: "SLACK_LIST_ALL_CHANNELS",
  slack_search_messages: "SLACK_SEARCH_MESSAGES",

  // Microsoft / Outlook / OneDrive (Composio toolkit id for OneDrive is one_drive)
  outlook_send_mail: "OUTLOOK_SEND_EMAIL",
  outlook_list_messages: "OUTLOOK_LIST_MESSAGES",
  onedrive_upload_file: "ONE_DRIVE_UPLOAD_FILE",
  onedrive_search_files: "ONE_DRIVE_SEARCH_ITEMS",

  // Google Sheets
  google_sheets_get_info: "GOOGLESHEETS_GET_SPREADSHEET_INFO",
  google_sheets_values_get: "GOOGLESHEETS_VALUES_GET",
  google_sheets_search: "GOOGLESHEETS_SEARCH_SPREADSHEETS",

  // GitLab / Linear / Jira / Trello / Dropbox / Airtable
  gitlab_list_issues: "GITLAB_LIST_PROJECT_ISSUES",
  gitlab_get_project: "GITLAB_GET_PROJECT",
  linear_list_issues: "LINEAR_LIST_LINEAR_ISSUES",
  linear_list_projects: "LINEAR_LIST_LINEAR_PROJECTS",
  jira_search_issues: "JIRA_SEARCH_ISSUES",
  jira_get_issue: "JIRA_GET_ISSUE",
  trello_list_boards: "TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER",
  trello_search: "TRELLO_GET_SEARCH",
  dropbox_list_folder: "DROPBOX_LIST_FILES_IN_FOLDER",
  dropbox_search: "DROPBOX_SEARCH_FILE_OR_FOLDER",
  airtable_list_records: "AIRTABLE_LIST_RECORDS",
  airtable_get_record: "AIRTABLE_GET_RECORD",

  // Added from Composio toolkit docs, version 20261101_00.
  googleslides_get_presentation: "GOOGLESLIDES_PRESENTATIONS_GET",
  googleslides_create_presentation: "GOOGLESLIDES_CREATE_PRESENTATION",
  googletasks_list_task_lists: "GOOGLETASKS_LIST_TASK_LISTS",
  googletasks_list_tasks: "GOOGLETASKS_LIST_ALL_TASKS",
  googletasks_insert_task: "GOOGLETASKS_INSERT_TASK",
  asana_list_workspaces: "ASANA_GET_MULTIPLE_WORKSPACES",
  asana_list_tasks: "ASANA_GET_MULTIPLE_TASKS",
  todoist_list_projects: "TODOIST_GET_ALL_PROJECTS",
  todoist_list_tasks: "TODOIST_GET_ALL_TASKS",
  todoist_create_task: "TODOIST_CREATE_TASK",
  calendly_get_user: "CALENDLY_GET_USER",
  calendly_list_events: "CALENDLY_LIST_SCHEDULED_EVENTS",
  figma_discover: "FIGMA_DISCOVER_FIGMA_RESOURCES",
  zoom_list_meetings: "ZOOM_LIST_MEETINGS",
  clickup_list_workspaces: "CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES",
  youtube_list_playlists: "YOUTUBE_LIST_USER_PLAYLISTS",
  youtube_search: "YOUTUBE_SEARCH_YOU_TUBE",
  // The signed-in account's own channel (name, handle, statistics). Playlists
  // and search do not answer "what is my channel called". Composio docs list
  // `mine` as a boolean filter of YOUTUBE_LIST_CHANNELS.
  youtube_get_my_channel: "YOUTUBE_LIST_CHANNELS",
});

/**
 * Standard supported connector toolkits.
 * Toolkit IDs match Composio app/toolkit slugs verified via COMPOSIO_SEARCH_TOOLS.
 */
export const COMPOSIO_TOOLKITS = Object.freeze({
  GOOGLE_WORKSPACE: "google_workspace",
  GOOGLE_DOCS: "googledocs",
  GOOGLE_DRIVE: "googledrive",
  GMAIL: "gmail",
  GOOGLE_CALENDAR: "googlecalendar",
  GOOGLE_SHEETS: "googlesheets",
  GITHUB: "github",
  GITLAB: "gitlab",
  NOTION: "notion",
  SLACK: "slack",
  MICROSOFT: "microsoft",
  OUTLOOK: "outlook",
  ONE_DRIVE: "one_drive",
  LINEAR: "linear",
  JIRA: "jira",
  TRELLO: "trello",
  DROPBOX: "dropbox",
  AIRTABLE: "airtable",
  GOOGLE_SLIDES: "googleslides",
  GOOGLE_TASKS: "googletasks",
  ASANA: "asana",
  TODOIST: "todoist",
  CALENDLY: "calendly",
  FIGMA: "figma",
  ZOOM: "zoom",
  CLICKUP: "clickup",
  YOUTUBE: "youtube",
  WEATHER: "weather",
  WEB_SEARCH: "web_search",
});

/**
 * Metadata catalog of all supported integrations.
 * catalogVisible:false keeps legacy bundle IDs for ownership/sync without publishing
 * duplicate Connect cards in the Extensions UI.
 */
export const TOOLKIT_METADATA = Object.freeze({
  [COMPOSIO_TOOLKITS.GOOGLE_WORKSPACE]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_WORKSPACE,
    name: "Google Workspace",
    namespace: "VibhavGPT/GoogleWorkspace",
    category: "Productivity",
    description: "Legacy bundle for Docs, Drive, Gmail, and Calendar. Prefer the individual Google connectors.",
    apps: ["googledocs", "googledrive", "gmail", "googlecalendar"],
    authType: "oauth2",
    catalogVisible: false,
    requiresApprovalForWrites: true,
    writeActions: ["google_docs_create_document", "gmail_send_email", "google_calendar_create_event", "google_drive_upload_file"],
    readActions: ["google_docs_get_document", "google_drive_search", "gmail_list_messages", "google_calendar_list_events"],
  },
  [COMPOSIO_TOOLKITS.GMAIL]: {
    id: COMPOSIO_TOOLKITS.GMAIL,
    name: "Gmail",
    namespace: "VibhavGPT/Gmail",
    category: "Communication",
    description: "Search and read email. Sending mail requires your approval.",
    apps: ["gmail"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["gmail_send_email", "draft_email"],
    readActions: ["gmail_list_messages", "search_emails", "read_email"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_DRIVE]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_DRIVE,
    name: "Google Drive",
    namespace: "VibhavGPT/GoogleDrive",
    category: "Productivity",
    description: "Search and organize Drive files. Uploads require your approval.",
    apps: ["googledrive"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["google_drive_upload_file"],
    readActions: ["google_drive_search"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_CALENDAR]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_CALENDAR,
    name: "Google Calendar",
    namespace: "VibhavGPT/GoogleCalendar",
    category: "Productivity",
    description: "List events and schedules. Creating events requires your approval.",
    apps: ["googlecalendar"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["google_calendar_create_event", "create_calendar_event"],
    readActions: ["google_calendar_list_events", "list_calendar_events"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_DOCS]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_DOCS,
    name: "Google Docs",
    namespace: "VibhavGPT/GoogleDocs",
    category: "Productivity",
    description: "Read documents. Creating or editing docs requires your approval.",
    apps: ["googledocs"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["google_docs_create_document", "append_to_google_doc"],
    readActions: ["google_docs_get_document", "read_google_doc"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_SHEETS]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_SHEETS,
    name: "Google Sheets",
    namespace: "VibhavGPT/GoogleSheets",
    category: "Productivity",
    description: "Find spreadsheets and read cell values.",
    apps: ["googlesheets"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["google_sheets_search", "google_sheets_get_info", "google_sheets_values_get"],
  },
  [COMPOSIO_TOOLKITS.GITHUB]: {
    id: COMPOSIO_TOOLKITS.GITHUB,
    name: "GitHub",
    namespace: "VibhavGPT/GitHub",
    category: "Developer",
    description: "Inspect repositories, search source code, view pull requests, and stage issues or commits.",
    apps: ["github"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["github_create_issue", "github_create_pull_request", "github_commit_files"],
    readActions: ["github_get_repo", "github_search_code", "github_list_issues", "github_list_pull_requests"],
  },
  [COMPOSIO_TOOLKITS.GITLAB]: {
    id: COMPOSIO_TOOLKITS.GITLAB,
    name: "GitLab",
    namespace: "VibhavGPT/GitLab",
    category: "Developer",
    description: "Browse projects and issues. Creating or updating issues requires your approval.",
    apps: ["gitlab"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["gitlab_list_issues", "gitlab_get_project"],
  },
  [COMPOSIO_TOOLKITS.NOTION]: {
    id: COMPOSIO_TOOLKITS.NOTION,
    name: "Notion",
    namespace: "VibhavGPT/Notion",
    category: "Knowledge",
    description: "Search workspace pages, databases, reading lists, and append project notes.",
    apps: ["notion"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["notion_create_page", "notion_append_block_children"],
    readActions: ["notion_search", "notion_get_page", "notion_query_database"],
  },
  [COMPOSIO_TOOLKITS.SLACK]: {
    id: COMPOSIO_TOOLKITS.SLACK,
    name: "Slack",
    namespace: "VibhavGPT/Slack",
    category: "Communication",
    description: "Send channel messages, post team updates, and search chat history with approval.",
    apps: ["slack"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["slack_post_message", "slack_send_dm"],
    readActions: ["slack_list_channels", "slack_search_messages"],
  },
  [COMPOSIO_TOOLKITS.MICROSOFT]: {
    id: COMPOSIO_TOOLKITS.MICROSOFT,
    name: "Microsoft 365",
    namespace: "VibhavGPT/Microsoft365",
    category: "Productivity",
    description: "Legacy Microsoft bundle. Prefer Outlook and OneDrive.",
    apps: ["outlook", "one_drive"],
    authType: "oauth2",
    catalogVisible: false,
    requiresApprovalForWrites: true,
    writeActions: ["outlook_send_mail", "onedrive_upload_file"],
    readActions: ["outlook_list_messages", "onedrive_search_files"],
  },
  [COMPOSIO_TOOLKITS.OUTLOOK]: {
    id: COMPOSIO_TOOLKITS.OUTLOOK,
    name: "Outlook",
    namespace: "VibhavGPT/Outlook",
    category: "Communication",
    description: "Read Outlook mail. Sending mail requires your approval.",
    apps: ["outlook"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["outlook_send_mail"],
    readActions: ["outlook_list_messages"],
  },
  [COMPOSIO_TOOLKITS.ONE_DRIVE]: {
    id: COMPOSIO_TOOLKITS.ONE_DRIVE,
    name: "OneDrive",
    namespace: "VibhavGPT/OneDrive",
    category: "Productivity",
    description: "Search and browse OneDrive files. Uploads require your approval.",
    apps: ["one_drive"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["onedrive_upload_file"],
    readActions: ["onedrive_search_files"],
  },
  [COMPOSIO_TOOLKITS.LINEAR]: {
    id: COMPOSIO_TOOLKITS.LINEAR,
    name: "Linear",
    namespace: "VibhavGPT/Linear",
    category: "Developer",
    description: "List and search Linear issues and projects.",
    apps: ["linear"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["linear_list_issues", "linear_list_projects"],
  },
  [COMPOSIO_TOOLKITS.JIRA]: {
    id: COMPOSIO_TOOLKITS.JIRA,
    name: "Jira",
    namespace: "VibhavGPT/Jira",
    category: "Developer",
    description: "Search and read Jira issues.",
    apps: ["jira"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["jira_search_issues", "jira_get_issue"],
  },
  [COMPOSIO_TOOLKITS.TRELLO]: {
    id: COMPOSIO_TOOLKITS.TRELLO,
    name: "Trello",
    namespace: "VibhavGPT/Trello",
    category: "Productivity",
    description: "Browse Trello boards and search cards.",
    apps: ["trello"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["trello_list_boards", "trello_search"],
  },
  [COMPOSIO_TOOLKITS.DROPBOX]: {
    id: COMPOSIO_TOOLKITS.DROPBOX,
    name: "Dropbox",
    namespace: "VibhavGPT/Dropbox",
    category: "Productivity",
    description: "List and search Dropbox files and folders.",
    apps: ["dropbox"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["dropbox_list_folder", "dropbox_search"],
  },
  [COMPOSIO_TOOLKITS.AIRTABLE]: {
    id: COMPOSIO_TOOLKITS.AIRTABLE,
    name: "Airtable",
    namespace: "VibhavGPT/Airtable",
    category: "Productivity",
    description: "List and read Airtable records.",
    apps: ["airtable"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["airtable_list_records", "airtable_get_record"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_SLIDES]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_SLIDES,
    name: "Google Slides",
    namespace: "VibhavGPT/GoogleSlides",
    category: "Productivity",
    description: "Read a presentation by id or exact name. Creating a deck requires your approval.",
    apps: ["googleslides"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["googleslides_create_presentation"],
    readActions: ["googleslides_get_presentation"],
  },
  [COMPOSIO_TOOLKITS.GOOGLE_TASKS]: {
    id: COMPOSIO_TOOLKITS.GOOGLE_TASKS,
    name: "Google Tasks",
    namespace: "VibhavGPT/GoogleTasks",
    category: "Productivity",
    description: "List task lists and tasks. Adding a task requires your approval.",
    apps: ["googletasks"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["googletasks_insert_task"],
    readActions: ["googletasks_list_task_lists", "googletasks_list_tasks"],
  },
  [COMPOSIO_TOOLKITS.ASANA]: {
    id: COMPOSIO_TOOLKITS.ASANA,
    name: "Asana",
    namespace: "VibhavGPT/Asana",
    category: "Productivity",
    description: "List workspaces and tasks the connected account can see.",
    apps: ["asana"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["asana_list_workspaces", "asana_list_tasks"],
  },
  [COMPOSIO_TOOLKITS.TODOIST]: {
    id: COMPOSIO_TOOLKITS.TODOIST,
    name: "Todoist",
    namespace: "VibhavGPT/Todoist",
    category: "Productivity",
    description: "List projects and incomplete tasks. Creating a task requires your approval.",
    apps: ["todoist"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: ["todoist_create_task"],
    readActions: ["todoist_list_projects", "todoist_list_tasks"],
  },
  [COMPOSIO_TOOLKITS.CALENDLY]: {
    id: COMPOSIO_TOOLKITS.CALENDLY,
    name: "Calendly",
    namespace: "VibhavGPT/Calendly",
    category: "Productivity",
    description: "Read the connected Calendly user and scheduled events.",
    apps: ["calendly"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["calendly_get_user", "calendly_list_events"],
  },
  [COMPOSIO_TOOLKITS.FIGMA]: {
    id: COMPOSIO_TOOLKITS.FIGMA,
    name: "Figma",
    namespace: "VibhavGPT/Figma",
    category: "Design",
    description: "Resolve a Figma file, team, or project link the account can access.",
    apps: ["figma"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["figma_discover"],
  },
  [COMPOSIO_TOOLKITS.ZOOM]: {
    id: COMPOSIO_TOOLKITS.ZOOM,
    name: "Zoom",
    namespace: "VibhavGPT/Zoom",
    category: "Communication",
    description: "List scheduled Zoom meetings for the connected user.",
    apps: ["zoom"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["zoom_list_meetings"],
  },
  [COMPOSIO_TOOLKITS.CLICKUP]: {
    id: COMPOSIO_TOOLKITS.CLICKUP,
    name: "ClickUp",
    namespace: "VibhavGPT/ClickUp",
    category: "Productivity",
    description: "List ClickUp workspaces the connected account can access.",
    apps: ["clickup"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["clickup_list_workspaces"],
  },
  [COMPOSIO_TOOLKITS.YOUTUBE]: {
    id: COMPOSIO_TOOLKITS.YOUTUBE,
    name: "YouTube",
    namespace: "VibhavGPT/YouTube",
    category: "Knowledge",
    description: "Look up the connected channel, search YouTube and list playlists on the connected channel.",
    apps: ["youtube"],
    authType: "oauth2",
    requiresApprovalForWrites: true,
    writeActions: [],
    readActions: ["youtube_get_my_channel", "youtube_list_playlists", "youtube_search"],
  },
  [COMPOSIO_TOOLKITS.WEATHER]: {
    id: COMPOSIO_TOOLKITS.WEATHER,
    name: "Weather",
    namespace: "VibhavGPT/Weather",
    category: "Utilities",
    description: "National Weather Service NOAA and global meteorological observations.",
    apps: ["weather"],
    authType: "system",
    requiresApprovalForWrites: false,
    writeActions: [],
    readActions: ["weather_get_current", "weather_get_forecast"],
  },
  [COMPOSIO_TOOLKITS.WEB_SEARCH]: {
    id: COMPOSIO_TOOLKITS.WEB_SEARCH,
    name: "Web Search",
    namespace: "VibhavGPT/WebSearch",
    category: "Utilities",
    description: "Live search indexing, real-time facts, current news, and cited supporting sources.",
    apps: ["web_search"],
    authType: "system",
    requiresApprovalForWrites: false,
    writeActions: [],
    readActions: ["web_search_query"],
  },
});

/**
 * Returns true if a Composio project API key is present in environment.
 */
export function isComposioConfigured() {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

/**
 * Securely retrieves Composio API key. Throws if missing when required.
 */
function getComposioApiKey() {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  return key || null;
}

/**
 * Computes deterministic SHA-256 hash of a payload object.
 */
export function computePayloadHash(payload) {
  const canonical = JSON.stringify(payload ?? {}, Object.keys(payload || {}).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Trusted hosts for Composio authorization redirect URLs.
 * Reject anything outside this allowlist before sending users there.
 */
export const COMPOSIO_AUTH_TRUSTED_HOSTS = Object.freeze([
  "connect.composio.dev",
  "backend.composio.dev",
  "app.composio.dev",
  "accounts.google.com",
  "github.com",
  "gitlab.com",
  "login.microsoftonline.com",
  "slack.com",
  "api.notion.com",
  "www.notion.so",
  "notion.so",
  "linear.app",
  "auth.atlassian.com",
  "id.atlassian.com",
  "atlassian.com",
  "trello.com",
  "dropbox.com",
  "www.dropbox.com",
  "airtable.com",
]);

/**
 * Returns true when a redirect URL is https and hosted on a trusted auth host.
 */
export function isTrustedComposioRedirectUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return COMPOSIO_AUTH_TRUSTED_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}


// --- whose connected account is whose ---------------------------------------------------------------------------------------------------------
// The production gateway is reached with one shared consumer key, and it shows every caller the same list of accounts: the user id on the request is
// not honoured, and the accounts carry no owner marker. So the list itself says nothing about who owns an account. An account is a person's only if
// the account names them, it is recorded as theirs in connector_account_owners (it carries the alias their own Connect press was given; see
// account-ownership.js), or the operator has granted it to them by id in COMPOSIO_CONSUMER_ACCOUNT_GRANTS, a JSON object of
// { "<app user id>": ["<connected account id>", ...] }. Nothing else is ever attached to a person or run for them.
function isConsumerKey() {
  return String(getComposioApiKey() ?? "").startsWith("ck_");
}

function readGrants() {
  try {
    const parsed = JSON.parse(process.env.COMPOSIO_CONSUMER_ACCOUNT_GRANTS || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether this connected account has been granted to this person. Always true when the key lists accounts per user on the provider's side.
 * "owned" is the set of account ids recorded as this person's (ownedAccountIds); without it only the operator's grants count.
 */
export function accountGrantedToUser(userId, accountId, owned = null) {
  if (!isConsumerKey()) return true;
  if (!userId) return false;
  if (accountId && owned instanceof Set && owned.has(accountId)) return true;
  const grants = readGrants();
  const wildcardAllowed = process.env.COMPOSIO_GRANTS_ALLOW_WILDCARD_FOR_TESTS === "true";
  const list = grants[userId] ?? (wildcardAllowed ? grants["*"] : undefined);
  if (!Array.isArray(list)) return false;
  if (wildcardAllowed && list.includes("*")) return true;
  return Boolean(accountId) && list.includes(accountId);
}

/** An account counts as the person's only on positive evidence: it names them, it is recorded as theirs, or it was granted to them. */
export function accountBelongsToUser(account, userId, owned = null) {
  if (!account || !userId) return false;
  if (account.user_id === userId || account.entity_id === userId || account.metadata?.userId === userId) return true;
  return isConsumerKey() && accountGrantedToUser(userId, account.id, owned);
}

/** Every account in a MANAGE_CONNECTIONS result, across its toolkits. */
function accountsInResults(results) {
  return Object.values(results || {}).flatMap((entry) => (Array.isArray(entry?.accounts) ? entry.accounts : []));
}

/** Records the listed accounts that carry this person's Connect aliases, then returns every account id recorded as theirs. */
async function claimAndLoadOwned(userId, results) {
  if (!isConsumerKey()) return null;
  await claimAccountsByAlias(userId, accountsInResults(results));
  return ownedAccountIds(userId);
}

/**
 * Builds the MCP gateway URL with mandatory user scoping.
 * Composio requires user_id (or connected_account_id) on MCP URLs.
 */
function buildComposioMcpUrl(userId) {
  const base = COMPOSIO_MCP_BASE;
  if (!userId) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("user_id", String(userId));
    return url.toString();
  } catch {
    const join = base.includes("?") ? "&" : "?";
    return `${base}${join}user_id=${encodeURIComponent(String(userId))}`;
  }
}

/**
 * Calls Composio Connect MCP gateway (for consumer keys starting with 'ck_').
 */
async function callComposioMcp({ method, params = {}, apiKey, fetchImpl = fetch, timeoutMs = 15_000, userId = null }) {
  const mcpUrl = buildComposioMcpUrl(userId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        "x-consumer-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Composio MCP error (${response.status}): ${errText}`);
    }

    const text = await response.text();
    let rpcResponse = null;
    if (text.includes("data: ")) {
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
            rpcResponse = parsed;
            break;
          }
        } catch {}
      }
    }
    if (!rpcResponse) {
      try {
        rpcResponse = JSON.parse(text);
      } catch {
        throw new Error(`Composio MCP invalid response format: ${text.slice(0, 200)}`);
      }
    }

    if (rpcResponse.error) {
      throw new Error(rpcResponse.error.message || JSON.stringify(rpcResponse.error));
    }

    const content = rpcResponse.result?.content?.[0]?.text;
    if (content) {
      try {
        return JSON.parse(content);
      } catch {
        return { text: content };
      }
    }

    return rpcResponse.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries all connected accounts across all toolkits in a single call (for ck_ MCP consumer keys).
 */
export async function listAllComposioConnections({ userId = null, fetchImpl = fetch } = {}) {
  const apiKey = getComposioApiKey();
  if (!apiKey || !apiKey.startsWith("ck_")) {
    return null;
  }

  const toolkits = ["googledocs", "googledrive", "gmail", "googlecalendar", "github", "notion", "slack", "outlook", "microsoft"];
  const mcpResult = await callComposioMcp({
    method: "tools/call",
    params: {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: {
        toolkits: toolkits.map((name) => ({ name, action: "list" })),
      },
    },
    apiKey,
    fetchImpl,
    timeoutMs: 8_000,
    userId,
  });

  return mcpResult.data?.results || null;
}

/**
 * Initiates an OAuth link flow for an authenticated user.
 */
export async function initiateComposioConnection(userId, toolkitId, { callbackUrl, fetchImpl = fetch } = {}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("A valid authenticated user ID is required to initiate connection.");
  }

  const toolkit = TOOLKIT_METADATA[toolkitId];
  if (!toolkit) {
    throw new Error(`Unsupported connector toolkit: ${toolkitId}`);
  }

  if (toolkit.authType === "system") {
    // Built-in system services are always connected
    return {
      connected: true,
      redirectUrl: null,
      connectionId: `sys_${toolkitId}`,
    };
  }

  const apiKey = getComposioApiKey();
  const returnUrl = callbackUrl || `https://vibhavgpt.com/app?page=extensions&tab=connectors&toolkit=${encodeURIComponent(toolkitId)}`;
  const attemptId = `att_${randomUUID()}`;
  // Request authorization for every advertised app in the toolkit (e.g. Docs+Drive+Gmail+Calendar).
  const appNames = (toolkit.apps?.length ? toolkit.apps : [toolkitId]).map(String);

  if (!apiKey) {
    throw new Error("Composio connector service is not configured (missing COMPOSIO_API_KEY in server deployment).");
  }

  // 1. Connect MCP protocol (ck_ consumer keys) — scoped to this VibhavGPT user
  if (apiKey.startsWith("ck_")) {
    // Each app gets a fresh alias stored against this person first; "add" always creates a new account, and it carries the alias. That is how
    // the account is later known to be theirs (account-ownership.js). If the alias cannot be stored, no link is made.
    const aliases = await recordConnectAliases(userId, toolkitId, appNames);
    const mcpResult = await callComposioMcp({
      method: "tools/call",
      params: {
        name: "COMPOSIO_MANAGE_CONNECTIONS",
        arguments: {
          toolkits: appNames.map((name) => ({ name, action: "add", alias: aliases[name] })),
          reinitiate_all: false,
        },
      },
      apiKey,
      fetchImpl,
      userId,
    });

    const results = mcpResult.data?.results || {};
    const owned = await claimAndLoadOwned(userId, results);
    const redirectCandidates = [];
    const connectionIds = [];
    const activeApps = [];
    const initiatedApps = [];

    for (const appName of appNames) {
      const toolkitData = results[appName] || results[toolkitId];
      if (!toolkitData) continue;
      if (toolkitData.redirect_url) redirectCandidates.push(toolkitData.redirect_url);
      const accounts = toolkitData.accounts || [];
      const pending = (a) => a.status === "initiated" || a.status === "initializing";
      const initiated = accounts.find((a) => pending(a) && a.alias === aliases[appName]) || accounts.find(pending);
      const active = accounts.find((a) => (a.status === "active" || a.status === "connected") && accountBelongsToUser(a, userId, owned));
      if (initiated?.id) connectionIds.push(initiated.id);
      if (active?.id) {
        connectionIds.push(active.id);
        activeApps.push(appName);
      }
      if (initiated || toolkitData.redirect_url) initiatedApps.push(appName);
      if (Array.isArray(toolkitData.redirect_urls)) {
        redirectCandidates.push(...toolkitData.redirect_urls.filter(Boolean));
      }
    }

    if (!Object.keys(results).length && !mcpResult.successful) {
      throw new Error(mcpResult.error || "Failed to initiate connection via Composio Connect.");
    }

    const redirectUrl = redirectCandidates.find((url) => isTrustedComposioRedirectUrl(url)) || null;
    if (redirectCandidates.length && !redirectUrl) {
      throw new Error("Connector authorization returned an untrusted redirect URL.");
    }

    const allActive = activeApps.length === appNames.length && !redirectUrl;
    return {
      connected: allActive,
      redirectUrl,
      connectionId: connectionIds[0] || `ca_${Date.now()}`,
      attemptId,
      requestedApps: appNames,
      activeApps,
      initiatedApps,
      callbackUrl: returnUrl,
    };
  }

  // 2. REST link endpoint fallback (v3.1 / v3)
  // Prefer linking the primary app first; caller polls status for remaining apps.
  const linkEndpoints = [
    `${COMPOSIO_EXEC_BASE}/connected_accounts/link`,
    `${COMPOSIO_API_BASE}/connectedAccounts/link`,
  ];

  let lastError = null;
  for (const endpoint of linkEndpoints) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          app_name: appNames[0],
          toolkit: appNames[0],
          // Request remaining apps where the API accepts a list
          app_names: appNames,
          toolkits: appNames,
          callback_url: returnUrl,
          redirect_url: returnUrl,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Composio link error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const redirectUrl = data.redirect_url || data.redirectUrl || data.url || null;
      if (redirectUrl && !isTrustedComposioRedirectUrl(redirectUrl)) {
        throw new Error("Connector authorization returned an untrusted redirect URL.");
      }
      return {
        connected: false,
        redirectUrl,
        connectionId: data.connection_request_id || data.connected_account_id || data.id,
        attemptId,
        requestedApps: appNames,
        callbackUrl: returnUrl,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to initiate connection with Composio.");
}

/**
 * Checks connection status for a user and toolkit.
 */
export async function checkComposioAccountStatus(userId, toolkitId, { fetchImpl = fetch } = {}) {
  if (!userId) throw new Error("userId is required.");
  const toolkit = TOOLKIT_METADATA[toolkitId];
  if (!toolkit) return { status: "unsupported" };

  if (toolkit.authType === "system") {
    return { status: "connected", accountName: "System Default", isConfigured: true };
  }

  const apiKey = getComposioApiKey();
  if (!apiKey) {
    return { status: "configuration_required", isConfigured: false, notice: "Requires owner configuration in deployment settings." };
  }

  const appNames = (toolkit.apps?.length ? toolkit.apps : [toolkitId]).map(String);

  let owned = null;
  const belongsToUser = (account) => accountBelongsToUser(account, userId, owned);

  // 1. Connect MCP protocol (ck_ consumer keys)
  if (apiKey.startsWith("ck_")) {
    try {
      const mcpResult = await callComposioMcp({
        method: "tools/call",
        params: {
          name: "COMPOSIO_MANAGE_CONNECTIONS",
          arguments: {
            toolkits: appNames.map((name) => ({ name, action: "list" })),
          },
        },
        apiKey,
        fetchImpl,
        userId,
      });

      const results = mcpResult.data?.results || {};
      owned = await claimAndLoadOwned(userId, results);
      const grantedApps = [];
      const missingApps = [];
      let primaryAccount = null;

      for (const appName of appNames) {
        const toolkitData = results[appName] || results[toolkitId];
        const active = (toolkitData?.accounts || []).find(
          (a) => (a.status === "active" || a.status === "connected") && belongsToUser(a),
        );
        if (active) {
          grantedApps.push(appName);
          if (!primaryAccount) primaryAccount = active;
        } else {
          missingApps.push(appName);
        }
      }

      if (primaryAccount && grantedApps.length > 0) {
        const grantedScopes = extractGrantedScopesFromAccount(primaryAccount);
        const coverage = deriveGrantedPermissionCoverage({
          toolkitId,
          requestedApps: appNames,
          connectedApps: grantedApps,
          grantedScopes,
        });
        return {
          status: "connected",
          isConfigured: true,
          accountId: primaryAccount.id,
          accountName:
            primaryAccount.user_info?.name ||
            primaryAccount.user_info?.email ||
            primaryAccount.user_info?.login ||
            primaryAccount.user_name ||
            primaryAccount.id,
          connectedAt: primaryAccount.created_at || new Date().toISOString(),
          grantedApps: coverage.connectedApps,
          missingApps: coverage.missingApps,
          fullyAuthorized: coverage.fullyAuthorized,
          scopeVerification: coverage.scopeVerification,
          supportedPermissions: coverage.supportedPermissions,
          unavailableFeatures: coverage.unavailableFeatures,
          // Persist real OAuth scopes when present — never substitute app names as scopes.
          scopes: coverage.grantedScopes,
          metadata: {
            ...primaryAccount,
            grantedApps: coverage.connectedApps,
            missingApps: coverage.missingApps,
            requestedApps: appNames,
            scopeVerification: coverage.scopeVerification,
            unavailableFeatures: coverage.unavailableFeatures,
          },
        };
      }

      return {
        status: "available",
        isConfigured: true,
        grantedApps: [],
        missingApps: appNames,
        fullyAuthorized: false,
        scopeVerification: "unverified",
        unavailableFeatures: appNames,
      };
    } catch (err) {
      return { status: "disconnected", isConfigured: true, error: err.message };
    }
  }

  // 2. REST status endpoint fallback (v3)
  try {
    const grantedApps = [];
    const missingApps = [];
    let primaryAccount = null;
    const scopeBag = [];

    for (const appName of appNames) {
      const response = await fetchImpl(
        `${COMPOSIO_API_BASE}/connectedAccounts?user_id=${encodeURIComponent(userId)}&app_name=${encodeURIComponent(appName)}`,
        {
          method: "GET",
          headers: { "x-api-key": apiKey },
        },
      );
      if (!response.ok) {
        missingApps.push(appName);
        continue;
      }
      const data = await response.json();
      const accounts = Array.isArray(data) ? data : data.items || data.accounts || [];
      const active = accounts.find(
        (a) =>
          (a.status === "ACTIVE" || a.status === "active" || a.status === "connected") &&
          belongsToUser(a),
      );
      if (active) {
        grantedApps.push(appName);
        scopeBag.push(...extractGrantedScopesFromAccount(active));
        if (!primaryAccount) primaryAccount = active;
      } else {
        missingApps.push(appName);
      }
    }

    if (primaryAccount) {
      const coverage = deriveGrantedPermissionCoverage({
        toolkitId,
        requestedApps: appNames,
        connectedApps: grantedApps,
        grantedScopes: scopeBag,
      });
      return {
        status: "connected",
        isConfigured: true,
        accountId: primaryAccount.id,
        accountName: primaryAccount.user_name || primaryAccount.email || primaryAccount.id,
        connectedAt: primaryAccount.created_at,
        grantedApps: coverage.connectedApps,
        missingApps: coverage.missingApps,
        fullyAuthorized: coverage.fullyAuthorized,
        scopeVerification: coverage.scopeVerification,
        supportedPermissions: coverage.supportedPermissions,
        unavailableFeatures: coverage.unavailableFeatures,
        scopes: coverage.grantedScopes,
        metadata: {
          ...primaryAccount,
          grantedApps: coverage.connectedApps,
          missingApps: coverage.missingApps,
          requestedApps: appNames,
          scopeVerification: coverage.scopeVerification,
          unavailableFeatures: coverage.unavailableFeatures,
        },
      };
    }

    return {
      status: "available",
      isConfigured: true,
      grantedApps: [],
      missingApps: appNames,
      fullyAuthorized: false,
      scopeVerification: "unverified",
      unavailableFeatures: appNames,
    };
  } catch (err) {
    return { status: "disconnected", isConfigured: true, error: err.message };
  }
}

/**
 * Revokes and deletes a user's connection for a toolkit.
 */
export async function revokeComposioConnection(userId, toolkitId, { connectionId, fetchImpl = fetch } = {}) {
  if (!userId) throw new Error("userId is required.");
  const apiKey = getComposioApiKey();

  if (apiKey && connectionId) {
    if (apiKey.startsWith("ck_")) {
      try {
        const toolkit = TOOLKIT_METADATA[toolkitId];
        const appName = toolkit?.apps?.[0] || toolkitId;
        await callComposioMcp({
          method: "tools/call",
          params: {
            name: "COMPOSIO_MANAGE_CONNECTIONS",
            arguments: {
              toolkits: [{
                name: appName,
                action: "remove",
                account_id: connectionId,
              }],
            },
          },
          apiKey,
          fetchImpl,
          userId,
        });
      } catch (err) {
        console.warn(`[composio-adapter] Revoke warning: ${err.message}`);
      }
    } else {
      try {
        await fetchImpl(`${COMPOSIO_API_BASE}/connectedAccounts/${encodeURIComponent(connectionId)}`, {
          method: "DELETE",
          headers: { "x-api-key": apiKey },
        });
      } catch (err) {
        console.warn(`[composio-adapter] Revoke warning: ${err.message}`);
      }
    }
  }

  return { success: true, revokedToolkit: toolkitId };
}

const BATCH_FAILURE = /^\d+ out of \d+ tools failed$/i;

/**
 * The customer-facing name of the service a tool slug belongs to, or null.
 * Slugs start with the toolkit id ("YOUTUBE_LIST_CHANNELS", "googledrive_...").
 */
export function serviceNameForSlug(slug) {
  const prefix = String(slug || "").split("_")[0].toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOOLKIT_METADATA, prefix) ? TOOLKIT_METADATA[prefix].name : null;
}

/**
 * Remove credentials from a provider error. Never include document text.
 * `service` names the service the failed tool belongs to, so a batch summary
 * with no specific cause is attributed to that service and no other.
 */
export function sanitizeProviderError(message, { service = null } = {}) {
  let flat = String(message || "The action failed.")
    .replace(/(ck_|sk_|ya29\.|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\bCOMPOSIO_[A-Z_]+\b/g, "deployment settings")
    .replace(/\bcomposio(?:\.dev)?\b/gi, service || "Connector")
    .replace(/\s+/g, " ")
    .trim();
  if (BATCH_FAILURE.test(flat)) {
    // Drive's wording is kept exactly: its approval card and tests rely on it.
    if (service === "Google Drive") return "Google Drive rejected the upload before it confirmed a file.";
    return `${service || "The service"} rejected the request before it confirmed a result.`;
  }
  return flat.slice(0, 300);
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

// Reason tokens Google's APIs use. Only these, never free text, are written to the log: they say what kind of failure it was and carry no
// account data.
const KNOWN_REASONS = new Set([
  "quotaExceeded", "rateLimitExceeded", "dailyLimitExceeded", "userRateLimitExceeded", "limitExceeded",
  "insufficientPermissions", "forbidden", "accessNotConfigured", "youtubeSignupRequired",
  "authError", "invalidCredentials", "keyInvalid",
  "required", "invalidParameter", "badRequest", "notFound", "backendError", "internalError",
]);
// Where a gateway or the API behind it may put the reason. The old reader looked at three string fields; Google-style errors are objects
// ({ code, message, errors: [{ reason }] }) and the reason is often under `data`, so they were dropped and the failure was reported as
// "rejected the request" with nothing to classify.
const EVIDENCE_KEYS = ["error", "message", "detail", "details", "description", "error_description", "errors", "reason", "status", "status_code", "statusCode", "code", "data", "response"];

/**
 * Finds why a tool execution failed, wherever in the envelope the reason was put. Bounded in depth and breadth; never throws.
 * Returns the readable text (for classification and, after sanitizing, for the message), an HTTP status if one was given, a known reason
 * token if one was given, and a description of the envelope's shape that is safe to log.
 */
export function extractFailureEvidence(...roots) {
  const texts = [];
  let httpStatus = null;
  let reason = null;
  const path = new Set();
  const shape = { itemErrorType: null, responseErrorType: null, dataMessage: false };
  const visit = (value, depth, key = "") => {
    if (value == null || depth > 4) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || BATCH_FAILURE.test(text)) return;
      if (key === "reason" && KNOWN_REASONS.has(text)) reason ||= text;
      else if (!/^(?:true|false|null)$/i.test(text) && key !== "status" ) texts.push(text);
      return;
    }
    if (typeof value === "number") {
      if (["status", "status_code", "statusCode", "code"].includes(key) && value >= 100 && value <= 599) httpStatus ||= value;
      return;
    }
    // Only the current path is tracked (to stop a cycle). A global "already seen" set would let the first, deepest starting point use up
    // an object and stop a shallower one from reaching a reason that is within its depth.
    if (typeof value !== "object" || path.has(value)) return;
    path.add(value);
    if (Array.isArray(value)) value.slice(0, 5).forEach((entry) => visit(entry, depth + 1, key));
    else {
      for (const name of EVIDENCE_KEYS) {
        if (!(name in value)) continue;
        if (name === "status" && typeof value[name] === "string" && /^\d{3}$/.test(value[name])) httpStatus ||= Number(value[name]);
        visit(value[name], depth + 1, name);
      }
    }
    path.delete(value);
  };
  const [item, response, data] = roots;
  shape.itemErrorType = item && "error" in item ? (Array.isArray(item.error) ? "array" : typeof item.error) : null;
  shape.responseErrorType = response && "error" in response ? (Array.isArray(response.error) ? "array" : typeof response.error) : null;
  shape.dataMessage = Boolean(response?.data && typeof response.data === "object" && ("message" in response.data || "detail" in response.data));
  for (const root of roots) visit(root, 0);
  const unique = [...new Set(texts)];
  return {
    text: unique.join(" | ").slice(0, 600),
    display: unique[0] || "",
    httpStatus,
    reason,
    envelope: { ...shape, batchOnly: unique.length === 0, reasonFound: unique.length > 0 || Boolean(reason) || httpStatus !== null },
  };
}

/**
 * Read a Composio multi-execute envelope.
 * A batch summary such as "1 out of 1 tools failed" is not the tool error.
 * A successful tool with a file id is success even when no link field is present.
 */
export function interpretComposioExecution(mcpResult, { slug = "" } = {}) {
  const data = mcpResult?.data && typeof mcpResult.data === "object" ? mcpResult.data : {};
  const results = Array.isArray(data.results) ? data.results : [];
  const item = results[0] && typeof results[0] === "object" ? results[0] : null;
  const response = item?.response && typeof item.response === "object" ? item.response : null;
  const itemError = firstText(item?.error, response?.error);
  const summary = firstText(mcpResult?.error, data.error);
  const logId = firstText(mcpResult?.log_id, item?.log_id, response?.log_id) || null;
  const file = response?.data && typeof response.data === "object" ? response.data : (response || null);
  const fileId = file?.id || file?.documentId || null;
  const succeeded = response?.successful === true || (Boolean(fileId) && response?.successful !== false && !itemError);
  if (!succeeded) {
    const evidence = extractFailureEvidence(item, response, data, mcpResult);
    const specific = firstText(itemError, response?.data?.error) || evidence.text;
    const resolvedServiceName = serviceNameForSlug(slug);
    const message = sanitizeProviderError(
      (specific && !BATCH_FAILURE.test(specific) ? specific : "")
      || (summary && !BATCH_FAILURE.test(summary) ? summary : "")
      || summary
      || `${resolvedServiceName || "Connector"} tool execution failed.`,
      { service: resolvedServiceName },
    );
    const badRequest = /invalid request data|schema|missing required|invalid (?:argument|parameter|request)/i.test(message)
      || evidence.reason === "required" || evidence.reason === "invalidParameter";
    return {
      ok: false,
      message,
      logId,
      code: badRequest ? "schema_rejected" : "provider_rejected",
      httpStatus: evidence.httpStatus,
      reason: evidence.reason,
      envelope: evidence.envelope,
    };
  }
  const normalized = { ...file };
  if (normalized.id && !normalized.documentId) normalized.documentId = normalized.id;
  if (normalized.html_url && !normalized.documentUrl) normalized.documentUrl = normalized.html_url;
  if (normalized.documentId && !normalized.documentUrl && String(slug).startsWith("GOOGLEDOCS")) {
    normalized.documentUrl = `https://docs.google.com/document/d/${normalized.documentId}/edit`;
  }
  if (String(slug).startsWith("GOOGLEDRIVE") && normalized.id && !normalized.webViewLink) {
    normalized.webViewLink = `https://drive.google.com/file/d/${encodeURIComponent(normalized.id)}/view`;
  }
  return { ok: true, data: normalized, logId };
}

/**
 * Parameter names accepted by newly added Composio tools.
 * Chat tool calls also carry query, location, prompt, and format. Those extra
 * keys are removed here so a strict provider schema is not rejected.
 * Documented defaults: Zoom user-level meetings use user_id "me"; Calendly
 * get-user uses uuid "me".
 */
export const TOOL_ARGUMENT_ALLOWLIST = Object.freeze({
  googleslides_get_presentation: ["presentationId", "presentationName", "fields"],
  googleslides_create_presentation: ["title", "locale"],
  googletasks_list_task_lists: ["pageToken", "maxResults"],
  googletasks_list_tasks: ["dueMax", "dueMin", "showHidden", "updatedMin", "showDeleted", "completedMax", "completedMin", "showAssigned", "showCompleted", "max_tasks_total"],
  googletasks_insert_task: ["title", "notes", "due", "tasklist_id", "status"],
  asana_list_workspaces: ["limit", "offset"],
  asana_list_tasks: ["project", "assignee", "workspace", "limit", "completed_since"],
  todoist_list_projects: ["limit", "cursor"],
  todoist_list_tasks: ["filter", "limit", "cursor", "lang"],
  todoist_create_task: ["content", "description", "project_id", "due_string", "priority"],
  calendly_get_user: ["uuid"],
  calendly_list_events: ["user", "organization", "group", "status", "count", "page_token", "min_start_time", "max_start_time", "invitee_email", "sort"],
  figma_discover: ["figma_url", "file_key", "team_id", "project_id", "max_depth"],
  zoom_list_meetings: ["user_id", "type", "from", "to", "timezone", "page_size", "page_number", "next_page_token"],
  clickup_list_workspaces: [],
  // `mine` and `part` are set by pickToolArguments, never by the model: this
  // action only ever reads the connected account's own channel. Both are
  // documented parameters of YOUTUBE_LIST_CHANNELS.
  youtube_get_my_channel: ["mine", "part"],
  // GMAIL_SEND_EMAIL and GMAIL_CREATE_EMAIL_DRAFT take the recipient as `recipient_email`; the chat tools call it `to`.
  gmail_send_email: ["recipient_email", "subject", "body", "is_html", "cc", "bcc"],
  draft_email: ["recipient_email", "subject", "body", "is_html", "cc", "bcc"],
  youtube_list_playlists: ["part", "pageToken", "maxResults"],
  youtube_search: ["q", "part", "type", "order", "pageToken", "maxResults", "regionCode", "publishedAfter", "publishedBefore", "relevanceLanguage"],
});

export function pickToolArguments(toolSlug, parameters = {}) {
  const allow = TOOL_ARGUMENT_ALLOWLIST[toolSlug];
  if (!allow) return { ...(parameters || {}) };
  const out = {};
  for (const key of allow) {
    const value = parameters?.[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  if ((toolSlug === "gmail_send_email" || toolSlug === "draft_email") && !out.recipient_email && typeof parameters?.to === "string" && parameters.to.trim()) {
    out.recipient_email = parameters.to.trim();
  }
  if (toolSlug === "zoom_list_meetings" && !out.user_id) out.user_id = "me";
  if (toolSlug === "calendly_get_user" && !out.uuid) out.uuid = "me";
  // `mine` cannot be combined with another filter, so nothing the model sent is
  // kept. `part` is optional in the wrapper but required by the YouTube API and
  // its default is undocumented; the title is in `snippet`, handle and counts in
  // `statistics`.
  if (toolSlug === "youtube_get_my_channel") return { mine: true, part: "snippet,statistics" };
  return out;
}

// The file hand-off has its own key when one is set (COMPOSIO_FILES_API_KEY): the connection service's file endpoint takes a project key, which
// is not the consumer key the tool gateway uses. Without it the gateway's key is used, as before.
function getComposioFilesApiKey() {
  return String(process.env.COMPOSIO_FILES_API_KEY ?? "").trim() || getComposioApiKey();
}

const fileTransferError = (httpStatus = null) => Object.assign(new Error("The file could not be handed to the connection service, so nothing was uploaded."), { code: "file_transfer_failed", httpStatus });

// Asks for a one-time upload address. Only a name, a type and a checksum are sent; never the file.
async function requestFileUploadAddress({ toolkit, tool, filename, mimetype, md5, fetchImpl }) {
  const apiKey = getComposioFilesApiKey();
  if (!apiKey) throw fileTransferError();
  let request;
  try {
    request = await fetchImpl(`${COMPOSIO_FILES_BASE}/files/upload/request`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ toolkit_slug: toolkit, tool_slug: tool, filename, mimetype, md5 }),
      // Every step of a hand-off is bounded, so an upload cannot stay in flight longer than the window after which it is treated as unconfirmed.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw fileTransferError();
  }
  if (!request.ok) throw fileTransferError(request.status);
  const info = await request.json().catch(() => null);
  const key = typeof info?.key === "string" && info.key ? info.key : null;
  if (!key) throw fileTransferError();
  return { key, url: info?.new_presigned_url || info?.newPresignedUrl, existing: info?.type === "exists" };
}

/**
 * Whether the file service accepts our credential and the file routes at all, found out before anyone is asked to approve an upload that cannot work.
 * It is a plain GET of the file list, limited to one item: no body, no filename, no checksum and nothing about any artifact leaves the app, and it
 * creates nothing on the other side. Only the status is used. Returns { ok }, or { ok: false, httpStatus, transient? } where transient means a timeout, 429 or 5xx; it never throws.
 *
 * It cannot prove the upload itself will work (a key can be accepted for listing and still belong to a different project than the connected
 * account), so a failure after approval is still reported truthfully; this only spares the person a card that was certain to fail.
 */
export async function checkComposioFilesAccess({ fetchImpl = fetch } = {}) {
  const apiKey = getComposioFilesApiKey();
  if (!apiKey) return { ok: false, httpStatus: null };
  try {
    const response = await fetchImpl(`${COMPOSIO_FILES_BASE}/files/list?limit=1`, { method: "GET", headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(5000) });
    if (response.ok) return { ok: true };
    // 401 and 403 are the service refusing our credential. A 429 or a 5xx is the service struggling, which says nothing about the credential.
    return { ok: false, httpStatus: response.status, transient: response.status === 429 || response.status >= 500 };
  } catch {
    return { ok: false, httpStatus: null, transient: true };
  }
}

/**
 * Hands a file's bytes to the connector service so a tool that takes a file (Drive upload) can read it: ask for a one-time upload address,
 * send the bytes there, and return the key the tool is given. Nothing reaches the person's account in this step; if it fails, nothing
 * was uploaded anywhere, so the failure is a clean "the file could not be handed over", never a half-done upload.
 */
export async function uploadComposioFile({ toolkit, tool, filename, mimetype, buffer, fetchImpl = fetch }) {
  const address = await requestFileUploadAddress({ toolkit, tool, filename, mimetype, md5: createHash("md5").update(buffer).digest("hex"), fetchImpl });
  // "exists" means the same bytes were stored before; only a new file is sent.
  if (!address.existing) {
    if (typeof address.url !== "string" || !address.url) throw fileTransferError();
    let sent;
    try {
      sent = await fetchImpl(address.url, { method: "PUT", headers: { "Content-Type": mimetype }, body: buffer, signal: AbortSignal.timeout(45_000) });
    } catch {
      throw fileTransferError();
    }
    if (!sent.ok) throw fileTransferError(sent.status);
  }
  return { s3key: address.key };
}

/**
 * Dispatches an approved tool execution through Composio.
 * Requires genuine configured credentials. Never generates synthetic results.
 */
export async function executeComposioTool({
  userId,
  toolSlug,
  parameters = {},
  connectedAccountId = null,
  fetchImpl = fetch,
}) {
  if (!userId) throw new Error("Authenticated userId is required for tool execution.");
  const owned = isConsumerKey() ? await ownedAccountIds(userId) : null;
  if (!accountGrantedToUser(userId, connectedAccountId, owned)) {
    console.warn(JSON.stringify({ event: "account_not_authorized", toolSlug: String(toolSlug).slice(0, 60) }));
    throw Object.assign(new Error("This connection isn't verified for your account, so nothing was run."), { code: "account_not_authorized" });
  }

  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new Error(`Cannot execute tool '${toolSlug}': Composio integration is not configured (missing COMPOSIO_API_KEY).`);
  }

  // 1. Connect MCP protocol (ck_ consumer keys)
  if (apiKey.startsWith("ck_")) {
    const resolvedSlug = TOOL_SLUG_MAP[toolSlug] || (toolSlug.toUpperCase() === toolSlug ? toolSlug : toolSlug.toUpperCase());

    // Normalize parameters for tool schema. Drive create accepts only
    // file_name, text_content, mime_type, and an optional folder id.
    let mappedArguments = pickToolArguments(toolSlug, parameters);
    if (resolvedSlug === "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT") {
      mappedArguments = toDriveCreateArguments(parameters);
    } else if (resolvedSlug.startsWith("GOOGLEDOCS") && mappedArguments.content && !mappedArguments.markdown_text) {
      mappedArguments.markdown_text = mappedArguments.content;
    }
    if (resolvedSlug.startsWith("GITHUB") && mappedArguments.content && !mappedArguments.body) {
      mappedArguments.body = mappedArguments.content;
    }
    if (resolvedSlug.startsWith("SLACK") && mappedArguments.content && !mappedArguments.text) {
      mappedArguments.text = mappedArguments.content;
    }

    const mcpResult = await callComposioMcp({
      method: "tools/call",
      params: {
        name: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: {
          tools: [
            {
              tool_slug: resolvedSlug,
              arguments: mappedArguments,
              ...(connectedAccountId ? { account: connectedAccountId } : {}),
            },
          ],
          sync_response_to_workbench: false,
        },
      },
      apiKey,
      fetchImpl,
      userId,
    });

    const interpreted = interpretComposioExecution(mcpResult, { slug: resolvedSlug });
    if (!interpreted.ok) {
      const error = new Error(interpreted.message);
      error.logId = interpreted.logId;
      error.code = interpreted.code;
      error.httpStatus = interpreted.httpStatus;
      error.reason = interpreted.reason;
      error.envelope = interpreted.envelope;
      throw error;
    }

    return {
      success: true,
      data: interpreted.data,
      logId: interpreted.logId,
      executionMode: "live",
    };
  }

  // 2. REST tool execution fallback (v3.1)
  const response = await fetchImpl(`${COMPOSIO_EXEC_BASE}/tools/execute/${encodeURIComponent(toolSlug)}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: userId,
      connected_account_id: connectedAccountId,
      arguments: pickToolArguments(toolSlug, parameters),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Composio tool execution failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  if (result?.successful === false || result?.error) {
    const interpreted = interpretComposioExecution(result, { slug: toolSlug });
    if (!interpreted.ok) {
      const error = new Error(interpreted.message);
      error.logId = interpreted.logId;
      error.code = interpreted.code;
      error.httpStatus = interpreted.httpStatus;
      error.reason = interpreted.reason;
      error.envelope = interpreted.envelope;
      throw error;
    }
  }
  return {
    success: true,
    data: result.data || result,
    executionMode: "live",
  };
}
