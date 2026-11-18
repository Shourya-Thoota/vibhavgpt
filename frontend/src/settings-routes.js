export const SETTINGS_SECTIONS = [
  { slug: "general", label: "General", group: "Personal" },
  { slug: "appearance", label: "Appearance", group: "Personal" },
  { slug: "profile", label: "Profile", group: "Personal" },
  { slug: "personalization", label: "Personalization", group: "Personal" },
  { slug: "location", label: "Location", group: "Personal" },
  { slug: "media", label: "Media", group: "Personal" },
  { slug: "security", label: "Security", group: "Security & Access" },
  { slug: "connectors", label: "Connectors", group: "Security & Access" },
  { slug: "data-controls", label: "Data controls", group: "Security & Access" },
  { slug: "usage", label: "Usage", group: "Billing & Usage" },
  { slug: "billing", label: "Billing", group: "Billing & Usage" },
  // Backward-compatible slugs:
  { slug: "account", label: "Profile", group: "Personal", legacy: true },
  { slug: "replies", label: "General", group: "Personal", legacy: true },
  { slug: "personality", label: "Personalization", group: "Personal", legacy: true },
  { slug: "memory", label: "Personalization", group: "Personal", legacy: true },
  { slug: "your-data", label: "Data controls", group: "Security & Access", legacy: true },
  { slug: "delete-account", label: "Delete account", group: "Security & Access", legacy: true },
];

export const settingsPath = (section = "account") => `/app/settings/${SETTINGS_SECTIONS.some(item => item.slug === section) ? section : "account"}`;

export function settingsRoute(pathname, search = "") {
  const path = pathname.replace(/\/$/, "");
  const params = new URLSearchParams(search);
  if (params.get("page") === "extensions") return { page: "extensions" };
  if (path === "/app/chat") return { page: "chat" };
  if (path === "/app/usage") return { page: "usage" };
  if (path === "/app/extensions") return { page: "extensions" };
  if (path === "/app/memory" || path === "/app/billing" || path === "/app/library") return { page: path.split("/").pop() };
  if (path === "/app/settings" || path.startsWith("/app/settings/")) {
    const section = path.slice("/app/settings/".length);
    const canonical = settingsPath(section);
    return { page: "settings", section: canonical.split("/").pop(), redirect: pathname === canonical ? null : canonical };
  }
  if (params.has("delete-account")) return { page: "settings", section: "delete-account", redirect: `${settingsPath("delete-account")}${search}` };
  return null;
}
