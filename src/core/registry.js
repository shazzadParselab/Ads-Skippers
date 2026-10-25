/**
 * Feature registry + lifecycle.
 * -----------------------------
 * Every feature module calls YTX.register({ ... }) at load time. The registry
 * decides — from settings — which ones actually run, and re-evaluates that
 * whenever settings change, so toggles in the options page take effect on open
 * tabs without a reload.
 *
 * FEATURE CONTRACT
 *   id        string    unique
 *   setting   string?   settings key that gates it (omit = always on)
 *   init()              called when it becomes active
 *   destroy()           called when it becomes inactive — MUST undo everything
 *   onNavigate(videoId) optional, called on every SPA navigation while active
 *   onSettings(keys)    optional, called when settings change while active
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const active = new Set();

  YTX.register = function (feature) {
    YTX.features.push(feature);
  };

  function shouldRun(feature) {
    if (!YTX.settings.enabled) return false;
    if (!feature.setting) return true;
    return Boolean(YTX.settings[feature.setting]);
  }

  function sync(changedKeys) {
    for (const feature of YTX.features) {
      const want = shouldRun(feature);
      const is = active.has(feature.id);

      if (want && !is) {
        try {
          feature.init();
          active.add(feature.id);
          YTX.log.info("started", feature.id);
        } catch (e) {
          YTX.log.warn("failed to start", feature.id, e);
        }
      } else if (!want && is) {
        try {
          feature.destroy();
        } catch (e) {
          YTX.log.warn("failed to stop", feature.id, e);
        }
        active.delete(feature.id);
        YTX.log.info("stopped", feature.id);
      } else if (want && is && changedKeys && feature.onSettings) {
        try {
          feature.onSettings(changedKeys);
        } catch (e) {
          YTX.log.warn("onSettings failed", feature.id, e);
        }
      }
    }

    writeMarker();
  }

  /**
   * Stamp the live state onto <html> as data attributes. Content-script state
   * is otherwise invisible from the page world — including from a DevTools
   * console left on its default context — and "is it even running?" is the
   * first question worth answering when something does not show up.
   */
  function writeMarker() {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute("data-ytx", chrome.runtime.getManifest().version);
      root.setAttribute("data-ytx-active", Array.from(active).sort().join(" "));
    } catch (e) {
      /* extension context gone — nothing useful to record */
    }
  }

  function navigate(videoId) {
    for (const feature of YTX.features) {
      if (!active.has(feature.id) || !feature.onNavigate) continue;
      try {
        feature.onNavigate(videoId);
      } catch (e) {
        YTX.log.warn("onNavigate failed", feature.id, e);
      }
    }
  }

  function stopAll() {
    for (const feature of YTX.features) {
      if (!active.has(feature.id)) continue;
      try { feature.destroy(); } catch (e) { /* ignore */ }
    }
    active.clear();
    writeMarker();
  }

  YTX.registry = { sync, navigate, stopAll };
})();
