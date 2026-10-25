/**
 * SponsorBlock — auto-skip sponsor / intro / outro segments.
 * ----------------------------------------------------------
 * Segments come from the community database at sponsor.ajay.app. The network
 * call happens in the service worker (src/background.js) for two reasons: it
 * keeps the host permission off the content script, and it lets one cache serve
 * every tab.
 *
 * PRIVACY: the worker never sends the video id. It sends the first 4 hex chars
 * of its SHA-256 hash and filters the (many) matching videos locally, so the
 * server cannot tell which video you are watching.
 *
 * Two segment action types are honoured:
 *   skip → jump to the end of the segment
 *   mute → mute for its duration, then restore
 * `poi_highlight` and `full` are deliberately ignored: they are navigation
 * hints and whole-video labels, not things to skip past.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const LABEL = {
    sponsor: "Sponsor",
    selfpromo: "Self-promo",
    interaction: "Interaction reminder",
    intro: "Intro",
    outro: "Outro",
    preview: "Recap",
    music_offtopic: "Non-music section",
    filler: "Filler",
  };

  let segments = [];
  let currentVideoId = null;
  let video = null;
  let onTimeUpdate = null;
  const skipped = new Set(); // segment UUIDs already acted on this playback
  let mutedBySb = false;
  let mutedWas = false;
  let generation = 0; // invalidates pending waits across navigation/teardown

  function detach() {
    if (video && onTimeUpdate) video.removeEventListener("timeupdate", onTimeUpdate);
    if (mutedBySb && video) video.muted = mutedWas;
    mutedBySb = false;
    video = null;
    onTimeUpdate = null;
  }

  function attach() {
    detach();
    video = YTX.yt.video();
    if (!video) {
      // Cold load at document_start: the player is not in the DOM yet.
      const gen = generation;
      YTX.yt.waitFor(YTX.yt.SEL.video).then((el) => {
        if (el && gen === generation && !video) attach();
      });
      return;
    }

    onTimeUpdate = () => {
      // Never fight the ad skipper — it is already seeking to the end.
      if (!segments.length || YTX.yt.adShowing()) return;

      const t = video.currentTime;
      let insideMute = null;

      for (const seg of segments) {
        const [start, end] = seg.segment;
        const inside = t >= start && t < end - 0.15;

        if (seg.actionType === "mute") {
          if (inside) insideMute = seg;
          continue;
        }

        if (!inside || skipped.has(seg.UUID)) continue;

        skipped.add(seg.UUID);
        video.currentTime = end;
        YTX.settings$.bumpStats({ segmentCount: 1, timeSaved: end - start });
        if (YTX.settings.sponsorblockNotify) {
          YTX.yt.toast("Skipped: " + (LABEL[seg.category] || seg.category));
        }
        YTX.log.info("skipped segment", seg.category, start, "→", end);
        return; // one jump per tick; the next tick re-evaluates from the new time
      }

      // Mute segments: enter and leave cleanly, preserving the user's own mute.
      if (insideMute && !mutedBySb) {
        mutedWas = video.muted;
        video.muted = true;
        mutedBySb = true;
      } else if (!insideMute && mutedBySb) {
        video.muted = mutedWas;
        mutedBySb = false;
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
  }

  function fetchSegments(videoId) {
    if (!YTX.settings$.alive()) return;
    chrome.runtime.sendMessage(
      {
        type: "sponsorblock:segments",
        videoId,
        categories: YTX.settings.sponsorblockCategories,
      },
      (response) => {
        // A dropped response (worker restarting, context gone) is not an error.
        if (chrome.runtime.lastError) return;
        if (!response || !response.ok) return;
        if (videoId !== currentVideoId) return; // user navigated away mid-flight

        segments = response.segments || [];
        YTX.log.info("sponsorblock:", segments.length, "segment(s) for", videoId);
      }
    );
  }

  function load(videoId) {
    generation++;
    segments = [];
    skipped.clear();
    currentVideoId = videoId;
    if (!videoId) return detach();

    attach();
    fetchSegments(videoId);
  }

  YTX.register({
    id: "sponsorblock",
    setting: "sponsorblock",

    init() {
      load(YTX.yt.videoId());
    },

    destroy() {
      generation++;
      detach();
      segments = [];
      skipped.clear();
      currentVideoId = null;
    },

    onNavigate(videoId) {
      load(videoId);
    },

    onSettings(keys) {
      // Category list changed → the cached segment set no longer matches.
      if (keys.includes("sponsorblockCategories")) load(currentVideoId);
    },
  });
})();
