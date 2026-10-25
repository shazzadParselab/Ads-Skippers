/**
 * Debug logging. Silent unless the `debug` setting is on, except for the
 * one-time boot banner which is gated the same way.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  YTX.log = {
    on: false,

    banner() {
      if (!this.on) return;
      console.log(
        "%c⏭ Ads-Skipper %cconnected — v" + (chrome.runtime.getManifest().version),
        "background:#ff0000;color:#fff;font-weight:bold;padding:3px 8px;border-radius:4px 0 0 4px;",
        "background:#0f0f0f;color:#00e676;font-weight:bold;padding:3px 8px;border-radius:0 4px 4px 0;"
      );
    },

    info(...args) {
      if (this.on) console.log("%c[ytx]", "color:#00e676;font-weight:bold;", ...args);
    },

    warn(...args) {
      if (this.on) console.warn("%c[ytx]", "color:#ffab00;font-weight:bold;", ...args);
    },
  };
})();
