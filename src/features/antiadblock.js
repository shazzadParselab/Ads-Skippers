/**
 * ⚠ STORE-UNSAFE MODULE — keep it isolated.
 * -----------------------------------------
 * Dismisses YouTube's "Ad blocker detected" enforcement dialog. This is
 * circumvention of an access control, which the Chrome Web Store's policies
 * treat differently from plain ad hiding.
 *
 * If you ever publish: delete this file and drop it from `manifest.json`'s
 * content_scripts list plus `dismissAntiAdblock` from src/core/defaults.js.
 * Nothing else references it — that is the whole point of it living alone.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  let popupObserver = null;
  let started = false; // a pending waitFor must not attach after destroy()

  function dismiss() {
    const dialog = document.querySelector("ytd-popup-container tp-yt-paper-dialog");
    if (!dialog) return;

    // Only ever touch the enforcement dialog — never a legit menu or dialog.
    const isEnforcement = dialog.querySelector(
      "ytd-enforcement-message-view-model, .ytd-enforcement-message-view-model"
    );
    if (!isEnforcement) return;

    dialog.remove();

    const backdrop = document.querySelector("tp-yt-iron-overlay-backdrop");
    if (backdrop) backdrop.remove();

    // The dialog locks scrolling; give it back.
    document.documentElement.style.removeProperty("overflow");
    if (document.body) document.body.style.removeProperty("overflow");

    const video = YTX.yt.video();
    if (video && video.paused) video.play().catch(() => {});

    YTX.log.info("anti-adblock dialog dismissed");
  }

  YTX.register({
    id: "antiadblock",
    setting: "dismissAntiAdblock",

    init() {
      started = true;
      dismiss();
      // Enforcement dialogs mount into ytd-popup-container. Watching only that
      // subtree keeps this off the hot path.
      YTX.yt.waitFor(YTX.yt.SEL.popupContainer).then((container) => {
        if (!container || popupObserver || !started) return;
        popupObserver = new MutationObserver(dismiss);
        popupObserver.observe(container, { childList: true, subtree: true });
      });
    },

    destroy() {
      started = false;
      if (popupObserver) popupObserver.disconnect();
      popupObserver = null;
    },
  });
})();
