/**
 * YouTube Ad Skipper — content script
 * ------------------------------------
 * Watches YouTube's ad containers (.video-ads.ytp-ad-module) — there are
 * usually ~3 of them and they stay EMPTY until an ad plays. When an ad shows,
 * we walk down: skip-or-preview container -> .ytp-skip-ad -> .ytp-skip-ad-button,
 * FORCE the button visible (YouTube hides it with inline display:none / fades
 * it with opacity:0.5), then click it. Works across SPA navigation because we
 * keep (re)discovering the containers on an interval.
 *
 * To update behavior in the future, edit the CONFIG block below —
 * that's the only part you should normally need to touch.
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // CONFIG — safe to edit
  // ─────────────────────────────────────────────────────────────
  const CONFIG = {
    // Only act on watch pages.
    watchPathMatch: "/watch",

    // Ad container YouTube renders each ad into. Empty until an ad plays;
    // usually ~3 of these exist on a watch page.
    adModuleSelector: ".video-ads.ytp-ad-module",

    // Layout box that holds the skip/preview area (only present during an ad).
    skipOrPreviewSelector: ".ytp-ad-player-overlay-layout__skip-or-preview-container",

    // Wrapper that holds the skip button (only present during an ad).
    skipWrapperSelector: ".ytp-skip-ad",

    // The actual button we click. If YouTube renames it and skipping
    // stops, inspect the "Skip" button during an ad and update this.
    skipButtonSelector: ".ytp-skip-ad-button",

    // Re-scan for ad containers this often (ms). Cheap; also a safety retry.
    rescanIntervalMs: 1000,

    // Force the skip button visible (display) + solid (opacity) + red.
    highlightSkipButton: true,
  };

  // Keys used in chrome.storage.local (shared with the popup).
  const STORAGE = {
    enabled: "enabled",
    skipCount: "skipCount",
  };

  // ─────────────────────────────────────────────────────────────
  // Connection banner (visible in the browser DevTools console)
  // ─────────────────────────────────────────────────────────────
  console.log(
    "%c⏭ Shazzad %cOur Ads Skipper is connected and working properly ",
    "background:#ff0000;color:#fff;font-weight:bold;padding:3px 8px;border-radius:4px 0 0 4px;",
    "background:#0f0f0f;color:#00e676;font-weight:bold;padding:3px 8px;border-radius:0 4px 4px 0;"
  );

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────
  let enabled = true; // default ON until storage loads
  let scheduled = false;
  let stopped = false; // set true once the extension context dies
  let intervalId = null;

  const observedContainers = new WeakSet(); // ad containers we already watch
  const clickedContainers = new WeakSet(); // containers where we clicked skip
  const observers = []; // MutationObservers, so we can disconnect on teardown

  // ─────────────────────────────────────────────────────────────
  // Extension-context safety
  // When the extension is reloaded/updated, any OLD content script still
  // running in an open tab loses its chrome.* connection. Calling chrome.*
  // then throws "Extension context invalidated". We detect that and shut the
  // old script down cleanly (no error spam). Refresh the tab to get the new
  // script.
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
    if (intervalId) clearInterval(intervalId);
    for (const obs of observers) {
      try {
        obs.disconnect();
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

  // ─────────────────────────────────────────────────────────────
  // Styling — force the skip button visible + solid + red
  // ─────────────────────────────────────────────────────────────
  if (CONFIG.highlightSkipButton) {
    const style = document.createElement("style");
    style.textContent = `
      ${CONFIG.skipButtonSelector} {
        display: block !important;
        opacity: 1 !important;
        background-color: #ff0000 !important;
        color: #ffffff !important;
        cursor: pointer !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────
  // Core logic
  // ─────────────────────────────────────────────────────────────
  function isWatchPage() {
    return (
      location.hostname.endsWith("youtube.com") &&
      location.href.includes(CONFIG.watchPathMatch)
    );
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

  function skipAd() {
    scheduled = false;
    if (stopped) return;
    if (!extensionAlive()) return teardown();
    if (!enabled || !isWatchPage()) return;

    // Check every ad module (there are ~3). Empty when no ad is playing.
    const containers = document.querySelectorAll(CONFIG.adModuleSelector);
    for (const container of containers) {
      // Ad ended -> if we had clicked skip here, count ONE confirmed skip.
      // (Counting on ad-clear instead of per-click keeps the number sane.)
      if (container.childElementCount === 0) {
        if (clickedContainers.has(container)) {
          clickedContainers.delete(container);
          bumpSkipCount();
          console.log("%c⏭ Ad skipped", "color:#ff0000;font-weight:bold;");
        }
        continue;
      }

      // Walk the ad DOM: skip-or-preview box -> skip wrapper -> skip button.
      const skipOrPreview = container.querySelector(CONFIG.skipOrPreviewSelector);
      if (!skipOrPreview) continue;

      const wrapper = skipOrPreview.querySelector(CONFIG.skipWrapperSelector);
      if (!wrapper || wrapper.childElementCount === 0) continue;

      const buttons = wrapper.querySelectorAll(CONFIG.skipButtonSelector);
      if (buttons.length === 0) continue;

      // KEY FIX: YouTube hides the real skip button with inline display:none
      // (and fades it with opacity:0.5), so it never renders and clicks are
      // ignored. Force it visible + solid on the ELEMENT itself FIRST, then
      // click — now the click actually registers.
      for (const button of buttons) {
        button.style.setProperty("display", "block", "important");
        button.style.setProperty("opacity", "1", "important");
        button.style.setProperty("background-color", "#ff0000", "important");
        button.style.setProperty("color", "#ffffff", "important");
        button.style.setProperty("cursor", "pointer", "important");
        // Click directly. No setTimeout: skipAd() already re-runs every frame
        // and every second, so this naturally retries until the click lands —
        // a per-call setTimeout would instead pile up hundreds of timers.
        button.click();
      }
      clickedContainers.add(container);
    }
  }

  // Debounce: observers can fire many times per second, so we batch all
  // triggers into a single check per animation frame.
  function scheduleSkipCheck() {
    if (stopped) return;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(skipAd);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Observers / triggers
  // ─────────────────────────────────────────────────────────────
  // Attach a MutationObserver to each ad container so we react the instant
  // a child (the ad) is inserted. Containers can be created after load or
  // recreated on SPA navigation, so we re-scan on an interval too.
  function watchAdContainers() {
    const containers = document.querySelectorAll(CONFIG.adModuleSelector);
    for (const container of containers) {
      if (observedContainers.has(container)) continue;
      observedContainers.add(container);
      const obs = new MutationObserver(scheduleSkipCheck);
      obs.observe(container, { childList: true, subtree: true });
      observers.push(obs);
    }
  }

  watchAdContainers();
  scheduleSkipCheck();

  intervalId = setInterval(() => {
    if (!extensionAlive()) return teardown();
    watchAdContainers();
    scheduleSkipCheck();
  }, CONFIG.rescanIntervalMs);
})();
