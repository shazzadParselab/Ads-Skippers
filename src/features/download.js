/**
 * Video / audio download.
 * -----------------------
 * Adds a button to the player controls that lists every downloadable format
 * and pulls the chosen one with the parallel range downloader in
 * src/core/download-engine.js.
 *
 * TWO THINGS SHAPE THIS WHOLE FEATURE:
 *
 * 1. THROTTLING. Stream URLs carry an `n` challenge; served as-is, the server
 *    caps the transfer at roughly 50 KB/s. We do not parse base.js to solve it
 *    (fragile, breaks every few weeks) — src/main-world.js captures the ANSWER
 *    from the player's own segment requests and we splice it in, matched on the
 *    `ei` session id so an ad's value never lands on the wrong URL. If no match
 *    is available yet the download still works, just slowly, and the panel says
 *    so: playing the video for a second fixes it.
 *
 * 2. NO MUXER. Above 720p YouTube ships video and audio as separate streams and
 *    merging needs ffmpeg, which a browser does not have. So: progressive and
 *    audio-only formats download as one finished file, and HD downloads the
 *    video, then the matching audio, then puts an ffmpeg command on the
 *    clipboard.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const CHUNK_SIZE = 4 * 1024 * 1024;
  const BUTTON_CLASS = "ytx-dl-button";

  let button = null;
  let panel = null;
  let meta = null;        // last getFormats() payload, normalised
  let sessions = new Map(); // ei -> deciphered n
  let busy = false;
  let cancelled = false;
  let started = false;    // guards pending async work against destroy()
  let mountObserver = null;
  let mountFailures = 0;
  let warnTimer = null;
  const MAX_MOUNT_FAILURES = 5; // give up rather than retry every frame forever

  // ─────────────────────────────────────────────────────────────
  // Format helpers
  // ─────────────────────────────────────────────────────────────
  function containerOf(mimeType) {
    if (mimeType.indexOf("mp4") !== -1) return "mp4";
    if (mimeType.indexOf("webm") !== -1) return "webm";
    return "bin";
  }

  function extensionFor(format) {
    const container = containerOf(format.mimeType);
    if (format.kind !== "audio") return container;
    return container === "mp4" ? "m4a" : "webm";
  }

  /**
   * A progressive format lists two codecs (video + audio) in one mimeType;
   * an adaptive one lists a single codec.
   */
  function classify(format) {
    if (format.mimeType.indexOf("audio/") === 0) return "audio";
    const match = /codecs="([^"]*)"/.exec(format.mimeType);
    const codecs = match ? match[1].split(",").length : 1;
    return codecs > 1 ? "both" : "video";
  }

  function sizeLabel(bytes) {
    if (!bytes) return "—";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function speedLabel(bytesPerSecond) {
    if (!bytesPerSecond) return "";
    if (bytesPerSecond < 1024 * 1024) return Math.round(bytesPerSecond / 1024) + " KB/s";
    return (bytesPerSecond / 1024 / 1024).toFixed(1) + " MB/s";
  }

  function audioLabel(format) {
    const kbps = Math.round((format.bitrate || 0) / 1000);
    const codec = containerOf(format.mimeType) === "mp4" ? "m4a" : "opus";
    return kbps ? kbps + " kbps " + codec : codec;
  }

  function videoLabel(format) {
    const base = format.qualityLabel || format.height + "p";
    return format.fps > 30 ? base + " " + format.fps + "fps" : base;
  }

  /** Strip characters that are illegal in filenames or awkward in a shell. */
  function safeFilename(name) {
    return name
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video";
  }

  function filenameFor(format) {
    const label = format.kind === "audio"
      ? audioLabel(format).replace(/\s+/g, "")
      : videoLabel(format).replace(/\s+/g, "");
    return safeFilename(meta.title + " [" + meta.videoId + "] " + label) +
      "." + extensionFor(format);
  }

  /**
   * Splice the deciphered `n` for this playback session into a format URL.
   * Returns { url, throttled } — throttled means we had no answer to apply.
   */
  function buildUrl(format) {
    let url;
    try {
      url = new URL(format.url);
    } catch (e) {
      return { url: format.url, throttled: true };
    }

    const ei = url.searchParams.get("ei");
    const answer = ei ? sessions.get(ei) : null;
    if (!answer) return { url: url.toString(), throttled: true };

    url.searchParams.set("n", answer);
    return { url: url.toString(), throttled: false };
  }

  // ─────────────────────────────────────────────────────────────
  // Loading formats
  // ─────────────────────────────────────────────────────────────
  async function loadFormats() {
    const payload = await YTX.yt.askPlayer("getFormats");
    if (!payload || !payload.ok) {
      meta = null;
      return (payload && payload.reason) || "unavailable";
    }

    sessions = new Map(payload.sessions || []);

    const usable = payload.formats
      .filter((f) => f.url && !f.ciphered)
      .map((f) => Object.assign({}, f, { kind: classify(f) }));

    meta = {
      title: payload.title,
      videoId: payload.videoId,
      isLive: payload.isLive,
      skipped: payload.formats.length - usable.length,
      both: usable
        .filter((f) => f.kind === "both")
        .sort((a, b) => (b.height || 0) - (a.height || 0)),
      video: usable
        .filter((f) => f.kind === "video")
        .sort((a, b) => (b.height || 0) - (a.height || 0) || b.bitrate - a.bitrate),
      audio: usable
        .filter((f) => f.kind === "audio")
        .sort((a, b) => b.bitrate - a.bitrate),
    };

    return null;
  }

  /** Best audio to pair with a video-only format — same container if possible. */
  function companionAudio(videoFormat) {
    if (!meta.audio.length) return null;
    const container = containerOf(videoFormat.mimeType);
    const matching = meta.audio.filter((a) => containerOf(a.mimeType) === container);
    return (matching.length ? matching : meta.audio)[0];
  }

  // ─────────────────────────────────────────────────────────────
  // Downloading
  // ─────────────────────────────────────────────────────────────
  function runDownload(format, sink, onProgress) {
    const built = buildUrl(format);
    if (built.throttled) YTX.log.warn("no deciphered n for this session — throttled");

    return YTX.downloadEngine.stream({
      url: built.url,
      total: format.contentLength,
      connections: Math.max(1, Number(YTX.settings.downloadConnections) || 6),
      chunkSize: CHUNK_SIZE,
      sink,
      onProgress,
      isCancelled: () => cancelled,
    });
  }

  /**
   * Live download state, readable by the popup over runtime messaging. The
   * download itself always runs here in the content script rather than in the
   * popup: a popup is destroyed the moment it loses focus, which would kill the
   * transfer, whereas the tab outlives it.
   */
  const status = {
    active: false,
    phase: "idle", // idle | running | done | error | merge
    label: "",
    written: 0,
    total: 0,
    speed: 0,
    message: "",
    mergeCommand: null,
  };

  /** Fans progress out to both the in-player panel and the shared status. */
  function makeReporter(label) {
    const ui = showProgress(label);

    status.active = true;
    status.phase = "running";
    status.label = label;
    status.written = 0;
    status.total = 0;
    status.speed = 0;
    status.message = "";
    status.mergeCommand = null;

    return {
      setLabel(text) { status.label = text; ui.setLabel(text); },
      update(written, total, speed) {
        status.written = written;
        status.total = total;
        status.speed = speed;
        ui.update(written, total, speed);
      },
      done() {
        status.active = false; status.phase = "done"; status.message = "Saved";
        ui.done();
      },
      fail(message) {
        status.active = false; status.phase = "error"; status.message = message;
        ui.fail(message);
      },
      merge(videoName, audioName, container) {
        status.active = false; status.phase = "merge";
        status.message = "Both files saved";
        status.mergeCommand = mergeCommandFor(videoName, audioName, container);
        ui.showMerge(videoName, audioName, container);
      },
    };
  }

  function mergeCommandFor(videoName, audioName, container) {
    return 'ffmpeg -i "' + videoName + '" -i "' + audioName + '" -c copy "' +
      safeFilename(meta.title) + "." + container + '"';
  }

  /**
   * @param usePicker false when started from the popup — showSaveFilePicker
   *   needs transient user activation in THIS page, and a runtime message does
   *   not carry any, so those downloads go through a blob instead.
   */
  async function download(format, usePicker) {
    if (busy) return;

    const filename = filenameFor(format);

    // showSaveFilePicker needs transient activation, so it has to be the very
    // first await after the click — anything before it spends the activation.
    const sink = usePicker === false
      ? null
      : await YTX.downloadEngine.fileSink(filename);
    if (sink === "cancelled") return;

    busy = true;
    cancelled = false;
    const progress = makeReporter(filename);

    try {
      await runDownload(
        format,
        sink || YTX.downloadEngine.blobSink(filename, format.mimeType),
        progress.update
      );

      // Video-only: fetch the matching audio too, then hand over the merge
      // command. The picker has no activation left by now, so audio always
      // goes through a blob — it is small enough that that is fine.
      const audio = format.kind === "video" && YTX.settings.downloadAutoAudio
        ? companionAudio(format)
        : null;

      if (audio && !cancelled) {
        const audioName = filenameFor(audio);
        progress.setLabel("Audio — " + audioName);
        await runDownload(
          audio,
          YTX.downloadEngine.blobSink(audioName, audio.mimeType),
          progress.update
        );
        progress.merge(filename, audioName, containerOf(format.mimeType));
      } else {
        progress.done();
      }
    } catch (error) {
      progress.fail(cancelled ? "Cancelled" : String((error && error.message) || error));
      YTX.log.warn("download failed", error);
    } finally {
      busy = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────────────────────
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  const NO_PANEL = {
    update() {}, done() {}, fail() {}, setLabel() {}, showMerge() {},
  };

  function showProgress(label) {
    if (!panel) return NO_PANEL;

    panel.textContent = "";
    panel.appendChild(element("div", "ytx-dl-title", "Downloading"));

    const name = element("div", "ytx-dl-name", label);
    const bar = element("div", "ytx-dl-bar");
    const fill = element("div", "ytx-dl-bar-fill");
    bar.appendChild(fill);
    const status = element("div", "ytx-dl-status", "Starting…");

    const action = element("button", "ytx-dl-action", "Cancel");
    action.type = "button";
    action.addEventListener("click", () => { cancelled = true; });

    panel.append(name, bar, status, action);

    function finish(text, isError) {
      status.textContent = text;
      if (isError) status.classList.add("ytx-dl-error");
      else fill.style.width = "100%";
      action.textContent = "Close";
      action.onclick = closePanel;
    }

    return {
      setLabel(text) { name.textContent = text; },

      update(written, total, bytesPerSecond) {
        const percent = total ? Math.min(100, (written / total) * 100) : 0;
        fill.style.width = percent.toFixed(1) + "%";
        status.textContent =
          sizeLabel(written) + " / " + sizeLabel(total) +
          "  ·  " + percent.toFixed(0) + "%" +
          (bytesPerSecond ? "  ·  " + speedLabel(bytesPerSecond) : "");
      },

      done() { finish("Saved", false); },

      fail(message) { finish(message, true); },

      showMerge(videoName, audioName, container) {
        finish("Both files saved. Merge them into one video:", false);

        const command = mergeCommandFor(videoName, audioName, container);

        const box = element("textarea", "ytx-dl-command", command);
        box.readOnly = true;
        box.rows = 3;

        const copy = element("button", "ytx-dl-copy", "Copy command");
        copy.type = "button";
        copy.addEventListener("click", () => {
          navigator.clipboard.writeText(command).then(
            () => { copy.textContent = "Copied"; },
            () => { box.select(); } // clipboard blocked — let them copy manually
          );
        });

        panel.insertBefore(box, action);
        panel.insertBefore(copy, action);
      },
    };
  }

  function addSection(title, formats, describe) {
    if (!formats.length) return;
    panel.appendChild(element("div", "ytx-dl-section", title));

    for (const format of formats) {
      const row = element("button", "ytx-dl-row");
      row.type = "button";
      row.append(
        element("span", "ytx-dl-quality", describe(format)),
        element("span", "ytx-dl-ext", extensionFor(format)),
        element("span", "ytx-dl-size", sizeLabel(format.contentLength))
      );
      row.addEventListener("click", () => download(format, true));
      panel.appendChild(row);
    }
  }

  function renderPanel(error) {
    panel.textContent = "";
    panel.appendChild(element("div", "ytx-dl-title", "Download"));

    if (error || !meta) {
      panel.appendChild(element("div", "ytx-dl-note",
        error === "no-streaming-data"
          ? "No downloadable streams on this page. Open a video and press play first."
          : "Could not read the stream list (" + error + ")."));
      return;
    }

    if (meta.isLive) {
      panel.appendChild(element("div", "ytx-dl-note", "Live streams cannot be downloaded."));
      return;
    }

    if (!meta.both.length && !meta.video.length && !meta.audio.length) {
      panel.appendChild(element("div", "ytx-dl-note", "No usable formats found."));
      return;
    }

    addSection("Video + audio", meta.both, videoLabel);
    addSection("Video only — needs merging", meta.video, videoLabel);
    addSection("Audio only", meta.audio, audioLabel);

    // Warn only when it actually applies — no answer captured for these URLs.
    const sample = meta.both[0] || meta.video[0] || meta.audio[0];
    if (buildUrl(sample).throttled) {
      panel.appendChild(element("div", "ytx-dl-note ytx-dl-warn",
        "Speed will be limited. Play the video for a second, then reopen this menu."));
    }

    if (meta.skipped) {
      panel.appendChild(element("div", "ytx-dl-note",
        meta.skipped + " protected format(s) skipped."));
    }
  }

  async function togglePanel() {
    if (panel) return closePanel();

    const player = YTX.yt.player();
    if (!player) return;

    // Live inside the player element so the panel survives fullscreen.
    panel = element("div", "ytx-dl-panel");
    panel.appendChild(element("div", "ytx-dl-title", "Download"));
    panel.appendChild(element("div", "ytx-dl-note", "Reading formats…"));
    player.appendChild(panel);

    const error = await loadFormats();
    if (panel) renderPanel(error);
  }

  function onDocumentClick(event) {
    if (!panel || busy) return;
    if (panel.contains(event.target)) return;
    if (button && button.contains(event.target)) return;
    closePanel();
  }

  function buildButton() {
    const node = element("button", "ytp-button " + BUTTON_CLASS);
    node.type = "button";
    node.title = "Download";
    node.setAttribute("aria-label", "Download");

    // Inline SVG on a 36×36 grid, matching YouTube's own control icons.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("fill", "#fff");
    for (const d of ["M18 22.5 11.5 16l1.4-1.4 4.1 4.1V8h2v10.7l4.1-4.1 1.4 1.4z", "M9 25h18v2H9z"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    node.appendChild(svg);

    node.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePanel();
    });
    return node;
  }

  function mountButton() {
    if (button && document.contains(button)) return;

    // Scoped to the watch player: YouTube keeps a hidden hover-preview player
    // mounted with its own .ytp-right-controls, and mounting into that one puts
    // the button somewhere the user can never see it.
    const controls = YTX.yt.rightControls();
    if (!controls) return;

    // insertBefore requires a DIRECT child as the reference node, but
    // querySelector searches the whole subtree — YouTube wraps the settings
    // button, so the gear it finds is a grandchild and the insert throws.
    // Walk up to whichever ancestor actually is a child of the control bar.
    let reference = controls.querySelector(".ytp-settings-button");
    while (reference && reference.parentNode !== controls) {
      reference = reference.parentNode;
    }

    const candidate = buildButton();
    try {
      if (reference) controls.insertBefore(candidate, reference);
      else controls.appendChild(candidate);
    } catch (error) {
      // Never let a DOM surprise turn the retry observer into a console flood.
      mountFailures++;
      if (mountFailures === 1) YTX.log.warn("download button insert failed", error);
      if (mountFailures >= MAX_MOUNT_FAILURES) stopMountObserver();
      return;
    }

    button = candidate;
    mountFailures = 0;
    YTX.log.info("download button mounted");
  }

  /**
   * Exposed for debugging: run YTX.debugDownload() in the console on a watch
   * page to see whether the feature is on, whether the button is in the DOM,
   * and whether it has been given a size by CSS.
   */
  YTX.debugDownload = function () {
    const controls = document.querySelector(".ytp-right-controls");
    const mounted = document.querySelector(".ytx-dl-button");
    const box = mounted ? mounted.getBoundingClientRect() : null;
    return {
      settingOn: Boolean(YTX.settings.download),
      masterOn: Boolean(YTX.settings.enabled),
      controlsFound: Boolean(controls),
      buttonInDom: Boolean(mounted),
      buttonSize: box ? Math.round(box.width) + "x" + Math.round(box.height) : null,
      cssApplied: Boolean(box && box.width > 0),
    };
  };

  /**
   * Keep the button mounted for as long as the feature is on.
   *
   * A one-shot wait is not enough: the control bar does not exist yet at
   * document_start, it does not exist at all on non-watch pages, and YouTube
   * rebuilds it often enough that an already-mounted button can vanish. So this
   * watches the document and re-checks — throttled to one cheap
   * `document.contains` test per frame, which is the same pattern the ad
   * skipper uses.
   */
  function stopMountObserver() {
    if (mountObserver) mountObserver.disconnect();
    mountObserver = null;
    clearTimeout(warnTimer);
    warnTimer = null;
  }

  function ensureMounted() {
    mountButton();
    if (mountObserver) return;

    let queued = false;
    mountObserver = new MutationObserver(() => {
      if (queued || !started) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (started) mountButton();
      });
    });
    mountObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Not debug-only: on a watch page this means the feature is silently
    // unreachable, and the usual cause is YouTube renaming the control bar.
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => {
      if (!started || (button && document.contains(button))) return;
      if (!YTX.yt.isWatchPage()) return;
      console.warn(
        "%c[ytx]%c download button could not mount — no .ytp-right-controls " +
        "inside the player. YouTube may have renamed it; update SEL.rightControls " +
        "in src/core/yt.js.",
        "color:#ff0033;font-weight:bold;", ""
      );
    }, 15000);
  }

  // ─────────────────────────────────────────────────────────────
  // Popup bridge
  //
  // Registered at load, not in init(), so the popup always gets an answer —
  // "the feature is off" is a useful reply, silence is not.
  // ─────────────────────────────────────────────────────────────
  function slimFormats() {
    if (!meta) return null;
    const describe = (format, group) => ({
      itag: format.itag,
      group,
      label: group === "audio" ? audioLabel(format) : videoLabel(format),
      ext: extensionFor(format),
      bytes: format.contentLength,
      size: sizeLabel(format.contentLength),
    });
    return {
      title: meta.title,
      videoId: meta.videoId,
      isLive: meta.isLive,
      throttled: buildUrl(meta.both[0] || meta.video[0] || meta.audio[0] || {}).throttled,
      formats: [].concat(
        meta.both.map((f) => describe(f, "both")),
        meta.video.map((f) => describe(f, "video")),
        meta.audio.map((f) => describe(f, "audio"))
      ),
    };
  }

  function findByItag(itag) {
    if (!meta) return null;
    return [].concat(meta.both, meta.video, meta.audio)
      .find((f) => String(f.itag) === String(itag)) || null;
  }

  // Guarded: this runs at file load, and a throw here would stop the module
  // before YTX.register() and take the whole feature out silently.
  try {
    chrome.runtime.onMessage.addListener(onPopupMessage);
  } catch (e) {
    YTX.log.warn("popup bridge unavailable", e);
  }

  function onPopupMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== "string") return;
    if (message.type.indexOf("ytx:dl:") !== 0) return;

    if (!YTX.settings.download || !YTX.settings.enabled) {
      sendResponse({ ok: false, reason: "disabled" });
      return;
    }

    switch (message.type) {
      case "ytx:dl:formats":
        loadFormats().then((error) => {
          sendResponse(error ? { ok: false, reason: error } : { ok: true, data: slimFormats() });
        });
        return true; // async reply

      case "ytx:dl:start": {
        const format = findByItag(message.itag);
        if (!format) {
          sendResponse({ ok: false, reason: "unknown-format" });
          return;
        }
        // Started from the popup, so there is no user activation here — the
        // file picker is skipped and the browser's download bar handles it.
        download(format, false);
        sendResponse({ ok: true });
        return;
      }

      case "ytx:dl:status":
        sendResponse({ ok: true, status, busy });
        return;

      case "ytx:dl:cancel":
        cancelled = true;
        sendResponse({ ok: true });
        return;

      default:
        sendResponse({ ok: false, reason: "unknown-message" });
    }
  }

  YTX.register({
    id: "download",
    setting: "download",

    init() {
      started = true;
      ensureMounted();
      document.addEventListener("click", onDocumentClick, true);
    },

    destroy() {
      started = false;
      stopMountObserver();
      mountFailures = 0;
      document.removeEventListener("click", onDocumentClick, true);
      cancelled = true;
      closePanel();
      if (button) button.remove();
      button = null;
      meta = null;
      sessions = new Map();
    },

    onNavigate() {
      // New video: the old format list and captured session are both stale.
      meta = null;
      sessions = new Map();
      if (!busy) closePanel();
      mountFailures = 0; // a new page layout deserves a fresh set of attempts
      ensureMounted();
    },
  });
})();
