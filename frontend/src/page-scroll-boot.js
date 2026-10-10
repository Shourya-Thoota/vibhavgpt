// Runs before the browser can restore an old document's scroll position.
(function () {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  function top() { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }
  window.addEventListener("pageshow", function () {
    top();
    requestAnimationFrame(top);
  });
})();
