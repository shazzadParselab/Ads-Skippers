/**
 * Single source of truth for every setting.
 * -----------------------------------------
 * Loaded in all four contexts (content script, popup, options page, service
 * worker), so it uses `self` — which is `window` in a page and the global
 * scope in a worker.
 *
 * ADDING A SETTING: add it here with a default, then reference the key from
 * your feature module and (if user-facing) from options.js. Nothing else.
 *
 * `cssFeatures` maps a boolean setting → a stylesheet the service worker
 * registers at document_start. That is what makes CSS-only features flash-free:
 * the stylesheet is only injected while the setting is on.
 */
(function (root) {
  "use strict";

  root.YTX_DEFAULTS = {
    // ── Master ────────────────────────────────────────────────
    enabled: true,
    debug: false,

    // ── Ad blocking ───────────────────────────────────────────
    skipVideoAds: true,       // fast-forward through unskippable video ads
    clickSkipButtons: true,   // also click any "Skip" button that appears
    muteAds: true,            // mute while an ad plays (restored afterwards)
    adPlaybackRate: 16,       // speed used to blow through the ad (Chrome max)
    hidePageAds: true,        // CSS: banners, feed ads, masthead
    dismissAntiAdblock: true, // ⚠ store-unsafe — see src/features/antiadblock.js

    // ── SponsorBlock ──────────────────────────────────────────
    sponsorblock: false,
    sponsorblockCategories: ["sponsor", "selfpromo", "interaction"],
    sponsorblockNotify: true, // brief on-screen toast when a segment is skipped

    // ── Player ────────────────────────────────────────────────
    defaultQuality: "auto",   // auto | highres | hd2160 | hd1440 | hd1080 | hd720 | large | medium | small | tiny
    defaultSpeed: 1,          // 0.25 – 4
    audioOnly: false,         // force 144p + hide the picture (saves bandwidth)
    volumeBoost: 100,         // 100 = off, up to 500 (%)
    loopVideo: false,
    hotkeys: true,            // see src/features/player.js for the key map

    // ── Download ──────────────────────────────────────────────
    download: true,
    downloadConnections: 6, // parallel byte-range requests; higher = faster
    downloadAutoAudio: true, // after a video-only file, grab the matching audio

    // ── Distraction-free ──────────────────────────────────────
    hideShorts: false,
    hideComments: false,
    hideRelated: false,
    hideEndScreen: false,
    disableAutoplay: false,
    dismissContinueWatching: true, // kill the "Video paused. Continue watching?" dialog
  };

  // Setting key → stylesheet injected at document_start while it is true.
  root.YTX_CSS_FEATURES = {
    hidePageAds: "styles/adblock.css",
    clickSkipButtons: "styles/skip-button.css",
    hideShorts: "styles/no-shorts.css",
    hideComments: "styles/no-comments.css",
    hideRelated: "styles/no-related.css",
    hideEndScreen: "styles/no-endscreen.css",
    audioOnly: "styles/audio-only.css",
    download: "styles/download.css",
  };

  // Stats live in storage.local (device-specific); settings live in storage.sync.
  root.YTX_STAT_DEFAULTS = {
    skipCount: 0,        // ads skipped
    segmentCount: 0,     // sponsor segments skipped
    timeSaved: 0,        // seconds
  };
})(typeof self !== "undefined" ? self : this);
