/**
 * YouTube-specific helpers: DOM lookups, SPA navigation, and the bridge to the
 * page's own player API.
 * ----------------------------------------------------------------------------
 * SELECTORS: everything YouTube-specific lives in the SEL block below, so a
 * YouTube rename is a one-line fix here instead of a hunt through features/.
 *
 * MAIN-WORLD BRIDGE: content scripts run in an isolated world, so page-added JS
 * properties (like `#movie_player.setPlaybackQualityRange`) are invisible to us.
 * src/main-world.js runs in the page world and relays those calls; we talk to it
 * with CustomEvents, which DO cross the world boundary.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const SEL = {
    mainPlayer: "#movie_player",
    player: ".html5-video-player",
    rightControls: ".ytp-right-controls",
    video: "video.html5-main-video, #movie_player video, video",
    adShowingClass: "ad-showing",
    popupContainer: "ytd-popup-container",
    skipButtons: [
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-slot",
      ".ytp-ad-skip-button-container",
      ".videoAdUiSkipButton",
    ],
    // YouTube Music uses a different player shell.
    musicPlayer: "ytmusic-player",
  };

  let requestSeq = 0; // correlates askPlayer() calls with their replies

  const yt = {
    SEL,

    isMusic: location.hostname === "music.youtube.com",

    /**
     * The real watch player. #movie_player first on purpose: YouTube keeps a
     * second, hidden player mounted for hover previews (#inline-preview-player)
     * which also matches .html5-video-player and has its own control bar, so a
     * bare querySelector can silently bind to the wrong one.
     */
    player() {
      return document.querySelector(SEL.mainPlayer) || document.querySelector(SEL.player);
    },

    /** The watch player's control bar, never a preview player's. */
    rightControls() {
      const p = this.player();
      return p ? p.querySelector(SEL.rightControls) : null;
    },

    video() {
      return document.querySelector(SEL.video);
    },

    /** True while the player is showing an ad — the canonical signal. */
    adShowing() {
      const p = this.player();
      return !!(p && p.classList.contains(SEL.adShowingClass));
    },

    /** Current video id, or null on non-watch pages. */
    videoId() {
      try {
        return new URL(location.href).searchParams.get("v");
      } catch (e) {
        return null;
      }
    },

    isWatchPage() {
      return Boolean(this.videoId());
    },

    /**
     * Run `cb(videoId)` on every SPA navigation plus once right now.
     * `yt-navigate-finish` is YouTube's own event; it crosses into our isolated
     * world because CustomEvents are not world-scoped. A URL check on top of it
     * covers back/forward and the occasional missed event.
     */
    onNavigate(cb) {
      let lastUrl = location.href;

      const fire = () => {
        lastUrl = location.href;
        cb(this.videoId());
      };

      document.addEventListener("yt-navigate-finish", fire);
      window.addEventListener("popstate", fire);

      // Safety net: some in-app transitions do not emit yt-navigate-finish.
      // YouTube mutates the DOM constantly, so coalesce a whole burst into one
      // URL check per frame rather than comparing on every single mutation.
      let checkQueued = false;
      const urlObserver = new MutationObserver(() => {
        if (checkQueued) return;
        checkQueued = true;
        requestAnimationFrame(() => {
          checkQueued = false;
          if (location.href !== lastUrl) fire();
        });
      });
      urlObserver.observe(document.documentElement, { childList: true, subtree: true });
      YTX.settings$.onDead(() => urlObserver.disconnect());

      fire();
    },

    /**
     * Resolve once `selector` exists (or immediately if it already does).
     * Rejects nothing — it just never resolves past `timeoutMs`, resolving null.
     */
    waitFor(selector, timeoutMs = 15000) {
      return new Promise((resolve) => {
        const found = document.querySelector(selector);
        if (found) return resolve(found);

        let timer = null;
        const observer = new MutationObserver(() => {
          const el = document.querySelector(selector);
          if (!el) return;
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        timer = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeoutMs);
      });
    },

    /** Fire-and-forget call into the page-world player API. */
    callPlayer(action, payload) {
      document.dispatchEvent(
        new CustomEvent("ytx:player-call", {
          detail: JSON.stringify({ action, payload }),
        })
      );
    },

    /**
     * Round-trip call into the page world. Resolves with the handler's result,
     * or null if src/main-world.js never answered (not loaded, page still
     * booting, handler threw). Payloads are JSON strings because object
     * identity does not cross the world boundary reliably.
     */
    askPlayer(action, payload) {
      return new Promise((resolve) => {
        const requestId = "ytx-" + ++requestSeq;

        const finish = (result) => {
          clearTimeout(timer);
          document.removeEventListener("ytx:player-reply", onReply);
          resolve(result);
        };

        const onReply = (event) => {
          let data;
          try {
            data = JSON.parse(event.detail);
          } catch (e) {
            return;
          }
          if (!data || data.requestId !== requestId) return;
          finish(data.result);
        };

        const timer = setTimeout(() => finish(null), 5000);
        document.addEventListener("ytx:player-reply", onReply);

        document.dispatchEvent(
          new CustomEvent("ytx:player-call", {
            detail: JSON.stringify({ action, payload, requestId }),
          })
        );
      });
    },

    /** Brief toast in the player corner (used by SponsorBlock). */
    toast(message) {
      const host = this.player() || document.body;
      if (!host) return;

      const el = document.createElement("div");
      el.className = "ytx-toast";
      el.textContent = message;
      host.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    },
  };

  YTX.yt = yt;
})();
