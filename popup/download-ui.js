/**
 * Popup download panel.
 * ---------------------
 * The popup is only a launcher and a status view. The transfer itself runs in
 * the content script, because a popup is destroyed the instant it loses focus —
 * anything downloading inside it would die with it. Started from here, the
 * download keeps going after the popup closes, and reopening it reattaches to
 * the same progress.
 *
 * One tradeoff: `showSaveFilePicker` needs transient user activation in the page
 * doing the saving, and a runtime message carries none. So popup-started
 * downloads go through the browser's normal download bar rather than a "save
 * as" dialog. Starting from the in-player button still gets the picker.
 */
(function () {
  "use strict";

  const POLL_MS = 400;

  const toggle = document.getElementById("download-toggle");
  const toggleLabel = document.getElementById("download-toggle-label");
  const body = document.getElementById("download-body");

  let tabId = null;
  let pollTimer = null;
  let open = false;

  // ── messaging ───────────────────────────────────────
  /**
   * Resolves with the content script's reply, or null when it cannot be
   * reached — an unreloaded tab, a non-YouTube page, or a torn-down extension
   * context. Callers treat null as "not available here".
   */
  function ask(type, extra) {
    return new Promise((resolve) => {
      if (tabId == null) return resolve(null);
      chrome.tabs.sendMessage(tabId, Object.assign({ type }, extra), (response) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(response || null);
      });
    });
  }

  // ── rendering helpers ───────────────────────────────
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function note(text, kind) {
    return element("div", "download-note" + (kind ? " " + kind : ""), text);
  }

  function formatSize(bytes) {
    if (!bytes) return "—";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond) return "";
    if (bytesPerSecond < 1024 * 1024) return Math.round(bytesPerSecond / 1024) + " KB/s";
    return (bytesPerSecond / 1024 / 1024).toFixed(1) + " MB/s";
  }

  // ── views ───────────────────────────────────────────
  const GROUP_TITLES = {
    both: "Video + audio",
    video: "Video only — needs merging",
    audio: "Audio only",
  };

  function renderFormats(data) {
    body.textContent = "";

    if (data.isLive) return body.appendChild(note("Live streams cannot be downloaded."));
    if (!data.formats.length) return body.appendChild(note("No downloadable formats found."));

    if (data.throttled) {
      body.appendChild(note(
        "Speed will be limited. Play the video for a second, then reopen this.", "warn"));
    }

    const list = element("div", "download-list");
    let lastGroup = null;

    for (const format of data.formats) {
      if (format.group !== lastGroup) {
        lastGroup = format.group;
        list.appendChild(element("div", "download-group", GROUP_TITLES[format.group]));
      }

      const row = element("button", "download-row");
      row.type = "button";
      row.append(
        element("span", "download-quality", format.label),
        element("span", "download-ext", format.ext),
        element("span", "download-size", format.size)
      );
      row.addEventListener("click", () => start(format.itag));
      list.appendChild(row);
    }

    body.appendChild(list);
  }

  function renderProgress(status) {
    body.textContent = "";
    body.appendChild(element("div", "download-name", status.label));

    const bar = element("div", "download-bar");
    const fill = element("div", "download-bar-fill");
    const percent = status.total ? Math.min(100, (status.written / status.total) * 100) : 0;
    fill.style.width = percent.toFixed(1) + "%";
    bar.appendChild(fill);
    body.appendChild(bar);

    if (status.phase === "running") {
      body.appendChild(element("div", "download-status",
        formatSize(status.written) + " / " + formatSize(status.total) +
        "  ·  " + percent.toFixed(0) + "%" +
        (status.speed ? "  ·  " + formatSpeed(status.speed) : "")));
    } else {
      body.appendChild(element("div",
        "download-status" + (status.phase === "error" ? " download-note error" : ""),
        status.message || (status.phase === "done" ? "Saved" : "")));
    }

    const actions = element("div", "download-actions");

    if (status.phase === "running") {
      const cancel = element("button", "link", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => ask("ytx:dl:cancel"));
      actions.appendChild(cancel);
    } else {
      const back = element("button", "link primary", "Back to formats");
      back.type = "button";
      back.addEventListener("click", loadFormats);
      actions.appendChild(back);
    }

    if (status.mergeCommand) {
      const box = element("textarea", "download-command", status.mergeCommand);
      box.readOnly = true;
      box.rows = 3;
      body.appendChild(box);

      const copy = element("button", "link", "Copy ffmpeg command");
      copy.type = "button";
      copy.addEventListener("click", () => {
        navigator.clipboard.writeText(status.mergeCommand).then(
          () => { copy.textContent = "Copied"; },
          () => { box.select(); }
        );
      });
      actions.appendChild(copy);
    }

    body.appendChild(actions);
  }

  function renderUnavailable(reason) {
    body.textContent = "";
    if (reason === "disabled") {
      body.appendChild(note("The download feature is turned off. Enable it in All settings."));
    } else if (reason === "no-streaming-data") {
      body.appendChild(note("No streams on this page. Open a video and press play."));
    } else if (reason === "unreachable") {
      body.appendChild(note(
        "Cannot reach the page. If you just reloaded the extension, reload the YouTube tab too."));
    } else {
      body.appendChild(note("Could not read the stream list (" + reason + ")."));
    }
  }

  // ── flow ────────────────────────────────────────────
  async function start(itag) {
    const response = await ask("ytx:dl:start", { itag });
    if (!response || !response.ok) return renderUnavailable(
      response ? response.reason : "unreachable");
    poll();
  }

  async function poll() {
    const response = await ask("ytx:dl:status");
    if (!response || !response.ok) return;

    if (response.status.phase !== "idle") renderProgress(response.status);

    clearTimeout(pollTimer);
    if (open && response.status.active) pollTimer = setTimeout(poll, POLL_MS);
  }

  async function loadFormats() {
    body.textContent = "";
    body.appendChild(note("Reading formats…"));

    const response = await ask("ytx:dl:formats");
    if (!response) return renderUnavailable("unreachable");
    if (!response.ok) return renderUnavailable(response.reason);
    renderFormats(response.data);
  }

  async function openPanel() {
    open = true;
    body.hidden = false;
    toggleLabel.textContent = "Hide formats";

    // Reattach to a transfer already running in the tab.
    const response = await ask("ytx:dl:status");
    if (response && response.ok && response.status.phase !== "idle") return poll();
    loadFormats();
  }

  function closePanel() {
    open = false;
    body.hidden = true;
    body.textContent = "";
    toggleLabel.textContent = "Download this video";
    clearTimeout(pollTimer);
  }

  toggle.addEventListener("click", () => (open ? closePanel() : openPanel()));

  // ── boot ────────────────────────────────────────────
  // tabs.query without the "tabs" permission still returns the id, which is all
  // sendMessage needs; the host permission covers reaching the content script.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return;
    tabId = tab.id;

    // Only offer it where it can work. tab.url needs the "tabs" permission, so
    // fall back to asking the content script whether it is there at all.
    ask("ytx:dl:status").then((response) => {
      if (response) return; // content script answered — we are on YouTube
      toggle.disabled = true;
      toggleLabel.textContent = "Open a YouTube video to download";
    });
  });
})();
