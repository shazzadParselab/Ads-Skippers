/**
 * Distraction-free pack — the JavaScript half.
 * --------------------------------------------
 * The pure-hiding options (Shorts, comments, related videos, end-screen cards)
 * are stylesheets registered at document_start by the service worker, so they
 * never flash. Only the two that need behaviour live here:
 *
 *   disableAutoplay          turn off YouTube's "Autoplay next video" toggle
 *   dismissContinueWatching  auto-confirm "Video paused. Continue watching?"
 *
 * That dialog is the desktop equivalent of the mobile app's background-play
 * problem: leave a long video running unattended and YouTube stops it. Clicking
 * through it automatically is what keeps playback going.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const AUTONAV_TOGGLE = ".ytp-autonav-toggle-button";
  const CONFIRM_DIALOG = "ytd-popup-container yt-confirm-dialog-renderer";

  let popupObserver = null;
  let playerObserver = null;
  let started = false; // a pending waitFor must not attach after destroy()

  // ── Autoplay ──────────────────────────────────────────────────
  function disableAutoplay() {
    if (!YTX.settings.disableAutoplay) return;
    const toggle = document.querySelector(AUTONAV_TOGGLE);
    // aria-checked is the state; only click when it is actually on, or we would
    // toggle it back on every time the player re-renders.
    if (toggle && toggle.getAttribute("aria-checked") === "true") {
      toggle.click();
      YTX.log.info("autoplay disabled");
    }
  }

  // ── "Continue watching?" ──────────────────────────────────────
  function dismissContinueWatching() {
    if (!YTX.settings.dismissContinueWatching) return;

    const dialog = document.querySelector(CONFIRM_DIALOG);
    // offsetParent is null for anything inside a position:fixed dialog, so
    // measure instead — a mounted-but-hidden renderer has zero height.
    if (!dialog || dialog.getBoundingClientRect().height === 0) return;

    const confirm =
      dialog.querySelector("#confirm-button button") ||
      dialog.querySelector("#confirm-button") ||
      dialog.querySelector("yt-button-renderer#confirm-button");
    if (!confirm) return;

    confirm.click();
    YTX.log.info('dismissed "Continue watching?"');

    const video = YTX.yt.video();
    if (video && video.paused) video.play().catch(() => {});
  }

  function onPopupChange() {
    dismissContinueWatching();
  }

  // The autonav toggle is rebuilt whenever the player re-renders, so watch the
  // player's subtree rather than trying to catch the button once. On a cold load
  // (or from the home page) there is no player yet, hence the retry on navigate.
  function attachPlayerObserver() {
    if (playerObserver) return;
    YTX.yt.waitFor(YTX.yt.SEL.player).then((player) => {
      if (!player || playerObserver || !started) return;
      playerObserver = new MutationObserver(disableAutoplay);
      playerObserver.observe(player, {
        attributes: true,
        attributeFilter: ["aria-checked"],
        subtree: true,
      });
      disableAutoplay();
    });
  }

  YTX.register({
    id: "distraction",
    // Not gated on a single setting: it owns two independent options, each
    // checked at the top of its own handler.

    init() {
      started = true;
      YTX.yt.waitFor(YTX.yt.SEL.popupContainer).then((container) => {
        if (!container || popupObserver || !started) return;
        popupObserver = new MutationObserver(onPopupChange);
        popupObserver.observe(container, { childList: true, subtree: true });
        onPopupChange();
      });

      attachPlayerObserver();
    },

    destroy() {
      started = false;
      for (const obs of [popupObserver, playerObserver]) {
        try { if (obs) obs.disconnect(); } catch (e) { /* ignore */ }
      }
      popupObserver = null;
      playerObserver = null;
    },

    onNavigate() {
      // A new page can mean a replaced player element.
      if (playerObserver && !document.contains(YTX.yt.player())) {
        playerObserver.disconnect();
        playerObserver = null;
      }
      attachPlayerObserver();
      disableAutoplay();
    },

    onSettings(keys) {
      if (keys.includes("disableAutoplay")) disableAutoplay();
    },
  });
})();
