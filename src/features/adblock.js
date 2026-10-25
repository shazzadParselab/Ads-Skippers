/**
 * Video-ad handling — the original v2 logic, now a registry feature.
 * ------------------------------------------------------------------
 * On the first frame of an ad we remember the user's speed/mute state, then:
 *   1. click every known "Skip" button,
 *   2. mute and fast-forward straight to the end of the ad clip.
 * When `ad-showing` clears we put the player back exactly as we found it.
 *
 * Purely event-driven: the only trigger is the player's `ad-showing` class
 * toggling, which is a handful of mutations per ad — no polling.
 *
 * Static page ads (banners, feed, masthead) are NOT handled here — they are
 * pure CSS, injected at document_start by the service worker so there is no
 * flash of an ad before we hide it. See styles/adblock.css.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  let adObserver = null;
  let bootObserver = null;
  let scheduled = false;

  let adInProgress = false;
  let savedPlaybackRate = 1;
  let savedMuted = false;
  let adStartRemaining = 0; // seconds of ad we are about to skip, for the stat

  function clickSkipButtons() {
    for (const selector of YTX.yt.SEL.skipButtons) {
      for (const button of document.querySelectorAll(selector)) {
        // YouTube hides the real button inline (display:none / opacity:.5),
        // so force it visible on the element itself before clicking.
        button.style.setProperty("display", "block", "important");
        button.style.setProperty("opacity", "1", "important");
        button.click();
      }
    }
  }

  function tick() {
    if (!YTX.settings$.alive()) return;

    const video = YTX.yt.video();
    const adShowing = YTX.yt.adShowing();

    if (adShowing && video) {
      if (!adInProgress) {
        adInProgress = true;
        savedPlaybackRate =
          isFinite(video.playbackRate) && video.playbackRate !== YTX.settings.adPlaybackRate
            ? video.playbackRate
            : 1;
        savedMuted = video.muted;

        const remaining = isFinite(video.duration) ? video.duration - video.currentTime : 0;
        adStartRemaining = remaining > 0 ? remaining : 0;

        YTX.settings$.bumpStats({ skipCount: 1, timeSaved: adStartRemaining });
        YTX.log.info("ad skipped (~" + Math.round(adStartRemaining) + "s)");
      }

      if (YTX.settings.clickSkipButtons) clickSkipButtons();
      if (YTX.settings.muteAds) video.muted = true;

      if (YTX.settings.skipVideoAds) {
        video.playbackRate = YTX.settings.adPlaybackRate;
        if (isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }
        if (video.paused) video.play().catch(() => {});
      }
    } else if (adInProgress) {
      adInProgress = false;
      if (video) {
        video.muted = savedMuted;
        if (isFinite(savedPlaybackRate)) video.playbackRate = savedPlaybackRate;
      }
    }
  }

  // MutationObserver fires in bursts; collapse a whole burst into one tick.
  function scheduleTick() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tick();
    });
  }

  function attach() {
    if (adObserver) return true;
    const player = YTX.yt.player();
    if (!player) return false;

    adObserver = new MutationObserver(scheduleTick);
    adObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    scheduleTick(); // handle whatever is on screen right now
    return true;
  }

  YTX.register({
    id: "adblock",
    // No `setting` gate: the master switch already covers it, and the
    // sub-options (skipVideoAds / muteAds / …) are read live inside tick().

    init() {
      tick();
      if (attach()) return;

      // Player not in the DOM yet (opened on the home page, say). Wait for it.
      bootObserver = new MutationObserver(() => {
        if (attach() && bootObserver) {
          bootObserver.disconnect();
          bootObserver = null;
        }
      });
      bootObserver.observe(document.documentElement, { childList: true, subtree: true });
    },

    destroy() {
      for (const obs of [adObserver, bootObserver]) {
        try { if (obs) obs.disconnect(); } catch (e) { /* ignore */ }
      }
      adObserver = null;
      bootObserver = null;

      // Leave the player as the user expects it.
      const video = YTX.yt.video();
      if (adInProgress && video) {
        video.muted = savedMuted;
        if (isFinite(savedPlaybackRate)) video.playbackRate = savedPlaybackRate;
      }
      adInProgress = false;
    },

    onNavigate() {
      // A new page can mean a new player element; re-attach if it was replaced.
      if (adObserver && !document.contains(YTX.yt.player())) {
        adObserver.disconnect();
        adObserver = null;
      }
      attach();
    },
  });
})();
