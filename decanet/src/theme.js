// "system" follows the device; "light" and "dark" are remembered per browser.
export function readTheme() {
  try { return localStorage.getItem("decanet-theme") ?? "system"; } catch { return "system"; }
}

export function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme === "system") localStorage.removeItem("decanet-theme");
    else localStorage.setItem("decanet-theme", theme);
  } catch {}
}
