/**
 * Bootstrap — must be the LAST content script in the manifest list.
 * ------------------------------------------------------------------
 * By the time this runs, every feature has already called YTX.register().
 * All this does is load settings, hand them to the registry, and wire the two
 * ongoing signals: settings changes and SPA navigation.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  YTX.settings$.load().then(() => {
    YTX.log.banner();

    // If the extension is reloaded while this tab is open, this script keeps
    // running with a dead chrome.* connection — shut every feature down rather
    // than throw on each tick. (Refresh the tab to pick up the new build.)
    YTX.settings$.onDead(() => {
      YTX.registry.stopAll();
      YTX.log.warn("extension context invalidated — features stopped");
    });

    YTX.registry.sync();
    YTX.settings$.watch((changedKeys) => YTX.registry.sync(changedKeys));
    YTX.yt.onNavigate((videoId) => YTX.registry.navigate(videoId));
  });
})();
