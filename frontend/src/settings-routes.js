export const SETTINGS_SECTIONS = [
  { slug: "account", label: "Account" },
  { slug: "appearance", label: "Appearance" },
  { slug: "replies", label: "Replies" },
  { slug: "personality", label: "Personality" },
  { slug: "memory", label: "Memory" },
  { slug: "security", label: "Security" },
  { slug: "your-data", label: "Your data" },
  { slug: "delete-account", label: "Delete account" },
];

export const settingsPath = (section = "account") => `/app/settings/${SETTINGS_SECTIONS.some(item => item.slug === section) ? section : "account"}`;

export function settingsRoute(pathname, search = "") {
  const path = pathname.replace(/\/$/, "");
  if (path === "/app/chat") return { page: "chat" };
  if (path === "/app/usage") return { page: "usage" };
  if (path === "/app/memory" || path === "/app/billing") return { page: path.split("/").pop() };
  if (path === "/app/settings" || path.startsWith("/app/settings/")) {
    const section = path.slice("/app/settings/".length);
    const canonical = settingsPath(section);
    return { page: "settings", section: canonical.split("/").pop(), redirect: pathname === canonical ? null : canonical };
  }
  if (new URLSearchParams(search).has("delete-account")) return { page: "settings", section: "delete-account", redirect: `${settingsPath("delete-account")}${search}` };
  return null;
}
