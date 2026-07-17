/**
 * Popup logic — reads/writes settings in chrome.storage.local.
 * The content script listens to the same storage, so toggling here
 * takes effect immediately on any open YouTube tab (no reload needed).
 */
(function () {
  "use strict";

  const STORAGE = {
    enabled: "enabled",
    skipCount: "skipCount",
  };

  const toggle = document.getElementById("toggle");
  const count = document.getElementById("count");
  const reset = document.getElementById("reset");

  // Load initial state.
  chrome.storage.local.get([STORAGE.enabled, STORAGE.skipCount], (res) => {
    toggle.checked = res[STORAGE.enabled] !== false; // default ON
    count.textContent = res[STORAGE.skipCount] || 0;
  });

  // Persist the on/off toggle.
  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ [STORAGE.enabled]: toggle.checked });
  });

  // Reset the counter.
  reset.addEventListener("click", () => {
    chrome.storage.local.set({ [STORAGE.skipCount]: 0 });
  });

  // Live-update the counter while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE.skipCount]) {
      count.textContent = changes[STORAGE.skipCount].newValue || 0;
    }
  });
})();
