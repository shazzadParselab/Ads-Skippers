/**
 * Player pack — default quality, default speed, audio-only, volume boost,
 * loop, PiP, and hotkeys.
 * ----------------------------------------------------------------------------
 * Everything that can be done on the <video> element is done here directly.
 * Quality is the one exception: it lives on YouTube's own player object, which
 * is invisible from our isolated world, so it goes through the page-world
 * bridge in src/main-world.js.
 *
 * HOTKEYS (Alt is used throughout so nothing collides with YouTube's own keys)
 *   Alt + P   picture-in-picture
 *   Alt + L   loop this video
 *   Alt + A   audio-only
 *   Alt + ]   speed up      Alt + [   speed down      Alt + \   reset to 1x
 *   Alt + ↑   volume boost up (+25%)   Alt + ↓   down
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const MAX_BOOST = 500;

  let video = null;
  let onLoaded = null;
  let onKeyDown = null;
  let generation = 0; // bumped on every init/destroy to invalidate pending waits

  // Web Audio graph for volume boost. createMediaElementSource can only be
  // called once per element, so the node is cached against the element itself.
  let audioCtx = null;
  const gainFor = new WeakMap();

  // ── Quality ───────────────────────────────────────────────────
  function applyQuality() {
    const quality = YTX.settings.audioOnly ? "tiny" : YTX.settings.defaultQuality;
    if (quality === "auto") return;
    YTX.yt.callPlayer("setQuality", { quality });
  }

  // ── Speed ─────────────────────────────────────────────────────
  function applySpeed() {
    if (!video || YTX.yt.adShowing()) return; // adblock owns the rate during ads
    const speed = Number(YTX.settings.defaultSpeed) || 1;
    if (video.playbackRate !== speed) video.playbackRate = speed;
  }

  function nudgeSpeed(direction) {
    if (!video) return;
    const index = SPEEDS.indexOf(Number(YTX.settings.defaultSpeed) || 1);
    const base = index === -1 ? SPEEDS.indexOf(1) : index;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, base + direction))];
    saveSetting({ defaultSpeed: next });
    YTX.yt.toast(next + "×");
  }

  // ── Loop ──────────────────────────────────────────────────────
  function applyLoop() {
    if (video) video.loop = Boolean(YTX.settings.loopVideo);
  }

  // ── Volume boost ──────────────────────────────────────────────
  function applyBoost() {
    const boost = Number(YTX.settings.volumeBoost) || 100;
    if (!video) return;

    // Never build the audio graph just to set it to 1× — routing YouTube's
    // audio through Web Audio is not free, so we only do it once boosted.
    if (boost <= 100 && !gainFor.has(video)) return;

    try {
      if (!gainFor.has(video)) {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaElementSource(video);
        const gain = audioCtx.createGain();
        source.connect(gain);
        gain.connect(audioCtx.destination);
        gainFor.set(video, gain);
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      gainFor.get(video).gain.value = Math.min(MAX_BOOST, boost) / 100;
    } catch (e) {
      YTX.log.warn("volume boost unavailable", e);
    }
  }

  function nudgeBoost(delta) {
    const next = Math.min(MAX_BOOST, Math.max(100, (Number(YTX.settings.volumeBoost) || 100) + delta));
    saveSetting({ volumeBoost: next });
    YTX.yt.toast("Volume " + next + "%");
  }

  // ── Picture-in-picture ────────────────────────────────────────
  function togglePip() {
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture().catch((e) => YTX.log.warn("pip refused", e));
    }
  }

  // ── Hotkeys ───────────────────────────────────────────────────
  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  }

  function handleKey(event) {
    if (!YTX.settings.hotkeys || !event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTyping(event.target)) return;

    let handled = true;
    switch (event.key) {
      case "p": case "P": togglePip(); break;
      case "l": case "L": toggleSetting("loopVideo", "Loop"); break;
      case "a": case "A": toggleSetting("audioOnly", "Audio-only"); break;
      case "]": nudgeSpeed(1); break;
      case "[": nudgeSpeed(-1); break;
      case "\\": saveSetting({ defaultSpeed: 1 }); YTX.yt.toast("1×"); break;
      case "ArrowUp": nudgeBoost(25); break;
      case "ArrowDown": nudgeBoost(-25); break;
      default: handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // ── Shared plumbing ───────────────────────────────────────────
  // Writing to storage rather than mutating YTX.settings directly means the
  // change reaches the options page and every other tab, and comes back to us
  // through the normal onSettings path.
  function saveSetting(patch) {
    if (!YTX.settings$.alive()) return;
    chrome.storage.sync.set(patch);
  }

  function toggleSetting(key, label) {
    const next = !YTX.settings[key];
    saveSetting({ [key]: next });
    YTX.yt.toast(label + ": " + (next ? "on" : "off"));
  }

  function applyAll() {
    applyQuality();
    applySpeed();
    applyLoop();
    applyBoost();
  }

  function bindVideo() {
    if (onLoaded && video) video.removeEventListener("loadeddata", onLoaded);

    video = YTX.yt.video();
    if (!video) {
      // We run at document_start, so on a cold load the player has not mounted
      // yet. Wait for it — but only rebind if the feature is still on the same
      // life cycle, or a destroy() mid-wait would resurrect us.
      const gen = generation;
      YTX.yt.waitFor(YTX.yt.SEL.video).then((el) => {
        if (el && gen === generation && !video) bindVideo();
      });
      return;
    }

    // YouTube resets rate/loop when it swaps sources, so re-apply per load.
    onLoaded = applyAll;
    video.addEventListener("loadeddata", onLoaded);
    applyAll();
  }

  YTX.register({
    id: "player",

    init() {
      generation++;
      bindVideo();
      onKeyDown = handleKey;
      document.addEventListener("keydown", onKeyDown, true);
    },

    destroy() {
      generation++;
      if (onKeyDown) document.removeEventListener("keydown", onKeyDown, true);
      onKeyDown = null;

      if (video) {
        if (onLoaded) video.removeEventListener("loadeddata", onLoaded);
        video.loop = false;
        video.playbackRate = 1;
        const gain = gainFor.get(video);
        if (gain) gain.gain.value = 1;
      }
      video = null;
      onLoaded = null;
    },

    onNavigate() {
      // The <video> element itself usually survives navigation, but not always.
      if (video !== YTX.yt.video()) bindVideo();
      else applyAll();
    },

    onSettings(keys) {
      if (keys.includes("defaultQuality") || keys.includes("audioOnly")) applyQuality();
      if (keys.includes("defaultSpeed")) applySpeed();
      if (keys.includes("loopVideo")) applyLoop();
      if (keys.includes("volumeBoost")) applyBoost();
    },
  });
})();
