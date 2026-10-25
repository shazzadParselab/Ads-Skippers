/**
 * Settings + stats access for the content script.
 * -----------------------------------------------
 *  settings → chrome.storage.sync  (follows you across devices)
 *  stats    → chrome.storage.local (per-device counters)
 *
 * Also owns extension-context safety: when the extension is reloaded, an old
 * content script left running in an open tab loses its chrome.* connection and
 * every call throws "Extension context invalidated". `alive()` detects that and
 * `onDead` lets the registry tear everything down cleanly.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  let deadCallbacks = [];
  let dead = false;

  const settings = {
    /** False once the extension context is gone. */
    alive() {
      try {
        return Boolean(chrome.runtime && chrome.runtime.id);
      } catch (e) {
        return false;
      }
    },

    /** Register a teardown callback for when the context dies. */
    onDead(cb) {
      deadCallbacks.push(cb);
    },

    _die() {
      if (dead) return;
      dead = true;
      for (const cb of deadCallbacks) {
        try { cb(); } catch (e) { /* ignore */ }
      }
      deadCallbacks = [];
    },

    /** Read everything once. Resolves with { settings, stats }. */
    load() {
      return new Promise((resolve) => {
        if (!this.alive()) return resolve({ settings: { ...self.YTX_DEFAULTS }, stats: { ...self.YTX_STAT_DEFAULTS } });
        chrome.storage.sync.get(self.YTX_DEFAULTS, (synced) => {
          chrome.storage.local.get(self.YTX_STAT_DEFAULTS, (local) => {
            YTX.settings = { ...self.YTX_DEFAULTS, ...synced };
            YTX.stats = { ...self.YTX_STAT_DEFAULTS, ...local };
            YTX.log.on = !!YTX.settings.debug;
            resolve({ settings: YTX.settings, stats: YTX.stats });
          });
        });
      });
    },

    /**
     * Watch for changes made in the popup/options page. `cb(changedKeys)` runs
     * after YTX.settings has already been updated in place.
     */
    watch(cb) {
      if (!this.alive()) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!this.alive()) return this._die();

        if (area === "sync") {
          const keys = Object.keys(changes);
          for (const key of keys) YTX.settings[key] = changes[key].newValue;
          if ("debug" in changes) YTX.log.on = !!YTX.settings.debug;
          if (keys.length) cb(keys);
        } else if (area === "local") {
          for (const key of Object.keys(changes)) YTX.stats[key] = changes[key].newValue;
        }
      });
    },

    /**
     * Bump one or more numeric stats. Uses a read-modify-write, which is fine
     * here: increments happen a few times per video, not per frame.
     */
    bumpStats(deltas) {
      if (!this.alive()) return this._die();
      try {
        chrome.storage.local.get(self.YTX_STAT_DEFAULTS, (res) => {
          if (!this.alive()) return this._die();
          const next = {};
          for (const [key, delta] of Object.entries(deltas)) {
            next[key] = Math.round((res[key] || 0) + delta);
          }
          chrome.storage.local.set(next);
        });
      } catch (e) {
        this._die();
      }
    },
  };

  YTX.settings$ = settings;
})();
