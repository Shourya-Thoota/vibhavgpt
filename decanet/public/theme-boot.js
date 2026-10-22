// Applies the saved theme before first paint so there is no flash.
(function () {
  try {
    var theme = localStorage.getItem("decanet-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch (error) {}
})();
