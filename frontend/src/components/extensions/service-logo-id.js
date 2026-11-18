const LOGO_ALIASES = Object.freeze({
  googledocs: "googledocs",
  google_docs: "googledocs",
  "google-docs": "googledocs",
  googledrive: "googledrive",
  google_drive: "googledrive",
  "google-drive": "googledrive",
  gmail: "gmail",
  googlecalendar: "googlecalendar",
  google_calendar: "googlecalendar",
  "google-calendar": "googlecalendar",
  googlesheets: "googlesheets",
  google_sheets: "googlesheets",
  "google-sheets": "googlesheets",
  googleslides: "googleslides",
  google_slides: "googleslides",
  "google-slides": "googleslides",
  googletasks: "googletasks",
  google_tasks: "googletasks",
  "google-tasks": "googletasks",
  youtube: "youtube",
  one_drive: "one_drive",
  onedrive: "one_drive",
  "one-drive": "one_drive",
  outlook: "outlook",
  microsoft365: "microsoft",
  microsoft_365: "microsoft",
  web: "web_search",
  websearch: "web_search",
  web_search: "web_search",
  googleworkspace: "google_workspace",
  google_workspace: "google_workspace",
  asana: "asana",
  todoist: "todoist",
  calendly: "calendly",
  figma: "figma",
  zoom: "zoom",
  clickup: "clickup",
});

export function resolveServiceLogoId(serviceId = "") {
  const raw = String(serviceId || "").toLowerCase().trim();
  if (!raw) return "";
  if (LOGO_ALIASES[raw]) return LOGO_ALIASES[raw];
  const compact = raw.replace(/[\s_-]+/g, "");
  return LOGO_ALIASES[compact] || raw;
}
