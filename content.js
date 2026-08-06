/**
 * YouTube Ad Skipper / Blocker — content script
 * ---------------------------------------------
 * Multiple methods run together for maximum coverage:
 *   1. Video ads   → fast-forward (playbackRate + currentTime=duration) and
 *                    click every known "Skip" button.
 *   2. Page ads    → hide banner / feed / masthead ad elements via CSS.
 *   3. Anti-adblock→ best-effort dismissal of the "Ad blocker detected" popup.
 *
 * Detection uses the player's `ad-showing` class (the canonical signal).
 * Runs ONLY on DOM changes via MutationObserver (no constant polling): one
 * check on load, then it reacts whenever the player toggles its ad state.
 *
 * To change behavior, edit the CONFIG block below — each feature has its own
 * on/off flag, and every selector lives here so YouTube renames are a 1-line fix.
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CONFIG — safe to edit
  // ─────────────────────────────────────────────────────────────
  const CONFIG = {
    // Console logging (connection banner + per-ad "Ad skipped"). Set false
    // for a fully silent console once you're done testing.
    debug: true,

    // Video-player ad handling.
    skipVideoAds: true, // fast-forward through unskippable video ads
    clickSkipButtons: true, // also click any "Skip" button
    muteAds: true, // mute while an ad plays (restored afterwards)
    adPlaybackRate: 16, // speed used to blow through the ad (Chrome max = 16)

    // Hide static page ads (banners, feed ads, masthead) across YouTube.
    hidePageAds: true,

    // Best-effort dismissal of YouTube's "ad blocker detected" popup.
    dismissAntiAdblock: true,

    // Keep the skip button visible + red (handy, and needed to click it).
    highlightSkipButton: true,

    // Selectors — update here if YouTube renames things.
    playerSelector: ".html5-video-player",
    adShowingClass: "ad-showing",
    videoSelector: "video.html5-main-video, video",
    skipButtonSelectors: [
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button",
      ".ytp-ad-skip-button-slot",
      ".ytp-ad-skip-button-container",
      ".videoAdUiSkipButton",
    ],
  };

  // Keys used in chrome.storage.local (shared with the popup).
  const STORAGE = {
    enabled: "enabled",
    skipCount: "skipCount",
  };

  // ─────────────────────────────────────────────────────────────
  // Connection banner (visible in the browser DevTools console)
  // ─────────────────────────────────────────────────────────────
  if (CONFIG.debug) {
    console.log(
      "%c⏭ Shazzad %cOur Ad Blocker is connected and working properly ",
      "background:#ff0000;color:#fff;font-weight:bold;padding:3px 8px;border-radius:4px 0 0 4px;",
      "background:#0f0f0f;color:#00e676;font-weight:bold;padding:3px 8px;border-radius:0 4px 4px 0;"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────
  let enabled = true; // default ON until storage loads
  let stopped = false; // set true once the extension context dies
  let scheduled = false; // a tick is already queued for the next frame

  // MutationObservers (all disconnected on teardown).
  let adObserver = null; // watches the player's class for ad start/end
  let popupObserver = null; // watches for the anti-adblock popup
  let bootObserver = null; // short-lived: waits for the player to appear

  let adInProgress = false; // are we currently inside an ad?
  let savedPlaybackRate = 1; // user's normal speed, restored after the ad
  let savedMuted = false; // user's normal mute state, restored after the ad

  // ─────────────────────────────────────────────────────────────
  // Extension-context safety
  // When the extension is reloaded/updated, an OLD content script still
  // running in an open tab loses its chrome.* connection and throws
  // "Extension context invalidated". We detect that and shut down cleanly.
  // (After reloading the extension, refresh the tab to load the new script.)
  // ─────────────────────────────────────────────────────────────
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function teardown() {
    if (stopped) return;
    stopped = true;
    for (const obs of [adObserver, popupObserver, bootObserver]) {
      try {
        if (obs) obs.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Load the persisted on/off state, then keep it in sync with the popup.
  try {
    chrome.storage.local.get(STORAGE.enabled, (res) => {
      if (!extensionAlive()) return;
      enabled = res[STORAGE.enabled] !== false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (!extensionAlive()) return teardown();
      if (area === "local" && changes[STORAGE.enabled]) {
        enabled = changes[STORAGE.enabled].newValue !== false;
      }
    });
  } catch (e) {
    teardown();
  }

  function bumpSkipCount() {
    if (!extensionAlive()) return teardown();
    try {
      chrome.storage.local.get(STORAGE.skipCount, (res) => {
        if (!extensionAlive()) return teardown();
        const next = (res[STORAGE.skipCount] || 0) + 1;
        chrome.storage.local.set({ [STORAGE.skipCount]: next });
      });
    } catch (e) {
      teardown();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Styles: force skip button visible + red, and hide static page ads.
  // ─────────────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement("style");
    let css = "";

    if (CONFIG.highlightSkipButton) {
      css += `
        ${CONFIG.skipButtonSelectors.join(",\n        ")} {
          display: block !important;
          opacity: 1 !important;
          background-color: #ff0000 !important;
          color: #ffffff !important;
          cursor: pointer !important;
        }
      `;
    }

    if (CONFIG.hidePageAds) {
      css += `
        ytd-action-companion-ad-renderer,
        ytd-display-ad-renderer,
        ytd-video-masthead-ad-advertiser-info-renderer,
        ytd-video-masthead-ad-primary-video-renderer,
        ytd-in-feed-ad-layout-renderer,
        ytd-ad-slot-renderer,
        yt-about-this-ad-renderer,
        yt-mealbar-promo-renderer,
        ytd-statement-banner-renderer,
        ytd-banner-promo-renderer,
        ytd-banner-promo-renderer-background,
        .ytd-video-masthead-ad-v3-renderer,
        div#root.style-scope.ytd-display-ad-renderer.yt-simple-endpoint,
        div#sparkles-container.style-scope.ytd-promoted-sparkles-web-renderer,
        div#main-container.style-scope.ytd-promoted-video-renderer,
        div#player-ads.style-scope.ytd-watch-flexy,
        ad-slot-renderer,
        ytm-promoted-sparkles-web-renderer,
        masthead-ad,
        #masthead-ad {
          display: none !important;
        }
      `;
    }

    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────
  // Core helpers
  // ─────────────────────────────────────────────────────────────
  function clickSkipButtons() {
    for (const selector of CONFIG.skipButtonSelectors) {
      const buttons = document.querySelectorAll(selector);
      for (const button of buttons) {
        // YouTube hides the real button (inline display:none / opacity:0.5),
        // so force it visible on the element itself, then click.
        button.style.setProperty("display", "block", "important");
        button.style.setProperty("opacity", "1", "important");
        button.click();
      }
    }
  }

  // Remove the "Ad blocker detected" enforcement popup (and its backdrop),
  // but only when it's actually that popup — never legit menus/dialogs.
  function dismissAntiAdblock() {
    const dialog = document.querySelector(
      "ytd-popup-container tp-yt-paper-dialog"
    );
    if (!dialog) return;
    const isEnforcement = dialog.querySelector(
      "ytd-enforcement-message-view-model, .ytd-enforcement-message-view-model"
    );
    if (!isEnforcement) return;

    dialog.remove();
    const backdrop = document.querySelector("tp-yt-iron-overlay-backdrop");
    if (backdrop) backdrop.remove();
    document.documentElement.style.removeProperty("overflow");
    document.body && document.body.style.removeProperty("overflow");

    const video = document.querySelector(CONFIG.videoSelector);
    if (video && video.paused) video.play().catch(() => {});
  }

  function tick() {
    if (stopped) return;
    if (!extensionAlive()) return teardown();
    if (!enabled) return;

    if (CONFIG.dismissAntiAdblock) dismissAntiAdblock();

    const player = document.querySelector(CONFIG.playerSelector);
    const video = document.querySelector(CONFIG.videoSelector);
    const adShowing = !!(
      player && player.classList.contains(CONFIG.adShowingClass)
    );

    if (adShowing && video) {
      // First frame of a new ad: remember normal state + count it once.
      if (!adInProgress) {
        adInProgress = true;
        savedPlaybackRate =
          isFinite(video.playbackRate) && video.playbackRate !== CONFIG.adPlaybackRate
            ? video.playbackRate
            : 1;
        savedMuted = video.muted;
        bumpSkipCount();
        if (CONFIG.debug) {
          console.log("%c⏭ Ad skipped", "color:#ff0000;font-weight:bold;");
        }
      }

      // 1) Click any skip button that exists.
      if (CONFIG.clickSkipButtons) clickSkipButtons();

      // 2) Mute + fast-forward straight to the end of the ad.
      if (CONFIG.muteAds) video.muted = true;
      if (CONFIG.skipVideoAds) {
        video.playbackRate = CONFIG.adPlaybackRate;
        if (isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }
        if (video.paused) video.play().catch(() => {});
      }
    } else if (adInProgress) {
      // Ad just ended → restore the user's normal playback state.
      adInProgress = false;
      if (video) {
        video.muted = savedMuted;
        if (isFinite(savedPlaybackRate)) {
          video.playbackRate = savedPlaybackRate;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Trigger — run ONLY when the DOM actually changes (no polling).
  // MutationObserver can fire in bursts, so we coalesce a whole burst into a
  // single tick on the next animation frame.
  // ─────────────────────────────────────────────────────────────
  function scheduleTick() {
    if (stopped || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!extensionAlive()) return teardown();
      tick();
    });
  }

  // Anti-adblock popups live in ytd-popup-container; react only when one
  // actually opens (rare) rather than on every ad tick.
  function onPopupChange() {
    if (stopped || !enabled) return;
    if (!extensionAlive()) return teardown();
    if (CONFIG.dismissAntiAdblock) dismissAntiAdblock();
  }

  // Attach the real observers once their targets exist. Returns true once the
  // player is found (so the bootstrap observer below can stop).
  function attachObservers() {
    if (!adObserver) {
      const player = document.querySelector(CONFIG.playerSelector);
      if (player) {
        // The player's `ad-showing` class toggles on/off per ad — a handful of
        // mutations per ad, not hundreds. This is our ONLY ad trigger.
        adObserver = new MutationObserver(scheduleTick);
        adObserver.observe(player, {
          attributes: true,
          attributeFilter: ["class"],
        });
        scheduleTick(); // check whatever is on screen right now
      }
    }

    if (!popupObserver) {
      const popupContainer = document.querySelector("ytd-popup-container");
      if (popupContainer) {
        popupObserver = new MutationObserver(onPopupChange);
        popupObserver.observe(popupContainer, { childList: true, subtree: true });
      }
    }

    return Boolean(adObserver);
  }

  // ─────────────────────────────────────────────────────────────
  // Boot: inject CSS, do ONE initial check, then go fully event-driven.
  // ─────────────────────────────────────────────────────────────
  injectStyles();
  tick();

  if (!attachObservers()) {
    // Player not in the DOM yet (e.g. opened on a non-watch page). Wait for it
    // to appear, then attach the real observers and stop this bootstrap one.
    bootObserver = new MutationObserver(() => {
      if (stopped) return;
      if (attachObservers() && bootObserver) {
        bootObserver.disconnect();
        bootObserver = null;
      }
    });
    bootObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
