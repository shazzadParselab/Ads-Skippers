/**
 * Popup — master switch, stats, and a handful of quick toggles.
 * -------------------------------------------------------------
 * Deliberately small: everything else lives in the options page. Writes go
 * straight to chrome.storage, and the content script's registry picks them up
 * on the storage change event, so open tabs react without a reload.
 *
 * To promote a setting to the popup, add its key to QUICK below.
 */
(function () {
  "use strict";

  const QUICK = [
    { key: "sponsorblock", label: "Skip sponsor segments" },
    { key: "hideShorts", label: "Hide Shorts" },
    { key: "audioOnly", label: "Audio-only" },
  ];

  const enabled = document.getElementById("enabled");
  const quick = document.getElementById("quick");

  function formatSeconds(total) {
    const seconds = Math.max(0, Math.round(total || 0));
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    return (seconds / 3600).toFixed(1) + "h";
  }

  function renderStats(stats) {
    for (const el of document.querySelectorAll("[data-stat]")) {
      const key = el.dataset.stat;
      el.textContent = key === "timeSaved"
        ? formatSeconds(stats[key])
        : String(stats[key] || 0);
    }
  }

  function renderMaster(isOn) {
    enabled.checked = isOn;
    document.body.classList.toggle("off", !isOn);
  }

  // ── Build the quick rows ────────────────────────────
  const inputs = new Map();

  for (const item of QUICK) {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = item.label;

    const wrap = document.createElement("label");
    wrap.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      chrome.storage.sync.set({ [item.key]: input.checked });
    });

    const slider = document.createElement("span");
    slider.className = "slider";

    wrap.append(input, slider);
    row.append(label, wrap);
    quick.appendChild(row);
    inputs.set(item.key, input);
  }

  // ── Initial state ───────────────────────────────────
  chrome.storage.sync.get(self.YTX_DEFAULTS, (settings) => {
    renderMaster(settings.enabled !== false);
    for (const [key, input] of inputs) input.checked = Boolean(settings[key]);
  });

  chrome.storage.local.get(self.YTX_STAT_DEFAULTS, renderStats);

  // ── Wiring ──────────────────────────────────────────
  enabled.addEventListener("change", () => {
    renderMaster(enabled.checked);
    chrome.storage.sync.set({ enabled: enabled.checked });
  });

  document.getElementById("reset").addEventListener("click", () => {
    chrome.storage.local.set({ ...self.YTX_STAT_DEFAULTS });
  });

  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Keep in sync if the options page (or another popup) changes something.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      return chrome.storage.local.get(self.YTX_STAT_DEFAULTS, renderStats);
    }
    if (area !== "sync") return;
    if ("enabled" in changes) renderMaster(changes.enabled.newValue !== false);
    for (const [key, input] of inputs) {
      if (key in changes) input.checked = Boolean(changes[key].newValue);
    }
  });
})();
