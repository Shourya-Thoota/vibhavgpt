/* Runs inline in the <head> of every HTML entry, before first paint (the
   Vite plugin in vite.config.js injects it). It sets the sky (data-theme)
   and the universe (data-accent) from what the reader last chose, so a
   Daybreak or Nebula reader never sees a flash of Deep Space cyan while the
   app boots. useAppearance in App.jsx keeps both attributes in step after
   that. Plain ES5 and no dependencies: it runs before anything else loads.

   Deep Space is the default. "Match system" is honoured only when the reader
   picked it themselves (vibhavgpt-theme-chosen): older builds saved "system"
   for everyone who never touched the setting, and those readers now get the
   night sky like every new one. Keep in step with resolveSavedTheme in
   App.jsx. */
(function () {
  var root = document.documentElement;
  function applySavedAppearance() {
    try {
      var saved = localStorage.getItem("vibhavgpt-theme");
      var chosen = localStorage.getItem("vibhavgpt-theme-chosen") === "1";
      var sky = saved === "light" || saved === "dark"
        ? saved
        : saved === "system" && chosen && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      root.setAttribute("data-theme", sky);
      var accent = localStorage.getItem("vibhavgpt-accent");
      if (/^(cerulean|nebula|ember|pine|amber)$/.test(accent || "")) root.setAttribute("data-accent", accent);
    } catch (error) {
      // Storage blocked (private mode, site data off): the night sky and Orbit
      // cyan are the theme's own defaults, so nothing else needs setting.
      root.setAttribute("data-theme", "dark");
    }
  }
  applySavedAppearance();
  // Standalone pages have no React appearance hook. Re-read on bfcache
  // return, another tab's selection, and a system-theme change.
  window.addEventListener("pageshow", applySavedAppearance);
  window.addEventListener("storage", function (event) {
    if (!event.key || /^(vibhavgpt-theme|vibhavgpt-theme-chosen|vibhavgpt-accent)$/.test(event.key)) applySavedAppearance();
  });
  var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)");
  if (media && media.addEventListener) media.addEventListener("change", applySavedAppearance);
})();
