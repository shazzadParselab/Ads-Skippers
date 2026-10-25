/**
 * Page-world bridge (manifest `world: "MAIN"`).
 * ---------------------------------------------
 * Content scripts run in an isolated world and cannot see JS properties the
 * page attached to DOM nodes — including YouTube's player object on
 * #movie_player. This script runs in the page world and relays a fixed set of
 * calls back over CustomEvents.
 *
 * Payloads are JSON strings, not objects: object identity does not survive the
 * world boundary reliably, but a string always does.
 *
 * It also watches for the deciphered `n` parameter — see the block below.
 */
(function () {
  "use strict";

  function player() {
    return (
      document.getElementById("movie_player") ||
      document.querySelector(".html5-video-player")
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Deciphered `n` capture
  //
  // Stream URLs in streamingData carry an `n` challenge. Until it is
  // transformed by a function buried in YouTube's base.js, the server throttles
  // that URL to roughly 50 KB/s — which is what makes naive downloaders crawl.
  //
  // Rather than parsing base.js (what yt-dlp does, and what breaks every few
  // weeks), we let the player do it: every media segment it fetches carries the
  // ANSWER in its `n`. All formats in one playback session share the same
  // answer, so capturing one is enough for all of them.
  //
  // Keyed by `ei` (the per-playback event id) so an ad's `n`, or a stale one
  // from the previously watched video, is never applied to the wrong URL.
  //
  // PerformanceObserver is used deliberately instead of patching fetch/XHR:
  // it is read-only and cannot break the player.
  // ─────────────────────────────────────────────────────────────
  const nBySession = new Map();
  const MAX_SESSIONS = 12;

  function noteMediaUrl(rawUrl) {
    if (!rawUrl || rawUrl.indexOf("videoplayback") === -1) return;
    try {
      const params = new URL(rawUrl, location.href).searchParams;
      const ei = params.get("ei");
      const n = params.get("n");
      if (!ei || !n) return;

      nBySession.delete(ei); // re-insert so Map keeps insertion order = recency
      nBySession.set(ei, n);
      while (nBySession.size > MAX_SESSIONS) {
        nBySession.delete(nBySession.keys().next().value);
      }
    } catch (e) {
      /* not a URL we care about */
    }
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteMediaUrl(entry.name);
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (e) {
    /* no PerformanceObserver — downloads will be throttled, nothing else breaks */
  }

  // ─────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────
  function playerResponse() {
    const p = player();
    try {
      if (p && typeof p.getPlayerResponse === "function") {
        const response = p.getPlayerResponse();
        if (response && response.streamingData) return response;
      }
    } catch (e) {
      /* fall through to the initial response */
    }
    // ytInitialPlayerResponse goes stale after SPA navigation, so it is only
    // the fallback for when the player object is not ready yet.
    return window.ytInitialPlayerResponse || null;
  }

  const handlers = {
    setQuality({ quality }) {
      const p = player();
      if (!p) return { ok: false, reason: "no-player" };
      try {
        // setPlaybackQualityRange is the modern API; setPlaybackQuality is a
        // fallback for older player builds.
        if (typeof p.setPlaybackQualityRange === "function") {
          p.setPlaybackQualityRange(quality, quality);
        }
        if (typeof p.setPlaybackQuality === "function") {
          p.setPlaybackQuality(quality);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    },

    /** Everything the download feature needs, in one round trip. */
    getFormats() {
      const response = playerResponse();
      const streaming = response && response.streamingData;
      if (!streaming) return { ok: false, reason: "no-streaming-data" };

      const details = response.videoDetails || {};
      const raw = [].concat(streaming.formats || [], streaming.adaptiveFormats || []);

      const formats = raw.map((f) => ({
        itag: f.itag,
        url: f.url || null,
        // Age-restricted and some protected videos ship a signatureCipher
        // instead of a plain url. Deciphering that needs base.js parsing, which
        // this extension deliberately does not do — such formats are skipped.
        ciphered: !f.url && Boolean(f.signatureCipher || f.cipher),
        mimeType: f.mimeType || "",
        bitrate: f.bitrate || 0,
        contentLength: f.contentLength ? Number(f.contentLength) : 0,
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        qualityLabel: f.qualityLabel || "",
        audioQuality: f.audioQuality || "",
      }));

      return {
        ok: true,
        title: details.title || "video",
        videoId: details.videoId || "",
        durationSeconds: Number(details.lengthSeconds) || 0,
        isLive: Boolean(streaming.hlsManifestUrl || streaming.dashManifestUrl) && !raw.length,
        formats,
        // ei → deciphered n, for the content script to splice into format URLs.
        sessions: Array.from(nBySession.entries()),
      };
    },
  };

  // ─────────────────────────────────────────────────────────────
  // Diagnostic
  //
  // This script runs in the PAGE world, so a function defined here is callable
  // straight from the DevTools console on its default context. The equivalent
  // content-script helper is not: everything in the isolated world answers
  // "YTX is not defined" until you change the console's context dropdown, which
  // is exactly the trap this avoids.
  //
  // Reads the data-ytx attributes the registry stamps onto <html>, so it can
  // report the isolated world's state without talking to it.
  // ─────────────────────────────────────────────────────────────
  window.__ytxDebug = function () {
    const root = document.documentElement;
    const button = document.querySelector(".ytx-dl-button");
    const box = button ? button.getBoundingClientRect() : null;
    const response = playerResponse();

    return {
      extensionLoaded: root.hasAttribute("data-ytx"),
      version: root.getAttribute("data-ytx"),
      activeFeatures: (root.getAttribute("data-ytx-active") || "").split(" ").filter(Boolean),
      playerFound: Boolean(player()),
      controlsFound: Boolean(document.querySelector(".ytp-right-controls")),
      buttonInDom: Boolean(button),
      buttonSize: box ? Math.round(box.width) + "x" + Math.round(box.height) : null,
      buttonVisible: Boolean(box && box.width > 0 && box.height > 0),
      streamsFound: Boolean(response && response.streamingData),
      decipheredSessions: nBySession.size,
    };
  };

  document.addEventListener("ytx:player-call", (event) => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch (e) {
      return;
    }

    const handler = handlers[request.action];
    let result;
    try {
      result = handler
        ? handler(request.payload || {})
        : { ok: false, reason: "unknown-action" };
    } catch (e) {
      result = { ok: false, reason: String(e) };
    }

    if (!request.requestId) return; // fire-and-forget call, nothing to reply to
    document.dispatchEvent(
      new CustomEvent("ytx:player-reply", {
        detail: JSON.stringify({ requestId: request.requestId, result }),
      })
    );
  });
})();
