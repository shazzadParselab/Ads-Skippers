/**
 * Options page — rendered from SCHEMA, not hand-written HTML.
 * -----------------------------------------------------------
 * ADDING A SETTING: add the default in src/core/defaults.js, then add one entry
 * to SCHEMA below. The row, the wiring, and the persistence come for free.
 *
 * Control types: "toggle" | "select" | "range" | "checks".
 */
(function () {
  "use strict";

  const SCHEMA = [
    {
      title: "General",
      master: true,
      fields: [
        { key: "enabled", type: "toggle", label: "Extension enabled",
          help: "Master switch. Everything below is ignored while this is off." },
        { key: "debug", type: "toggle", label: "Debug logging",
          help: "Prints what the extension does to the browser console." },
      ],
    },
    {
      title: "Ad blocking",
      fields: [
        { key: "hidePageAds", type: "toggle", label: "Hide page ads",
          help: "Banners, feed ads, masthead. Injected before the page paints, so nothing flashes." },
        { key: "skipVideoAds", type: "toggle", label: "Fast-forward video ads",
          help: "Seeks straight to the end of the ad clip, skippable or not." },
        { key: "clickSkipButtons", type: "toggle", label: "Click “Skip Ad” buttons" },
        { key: "muteAds", type: "toggle", label: "Mute during ads",
          help: "Your own mute state is restored when the ad ends." },
        { key: "adPlaybackRate", type: "select", label: "Ad playback speed",
          options: [[2, "2×"], [4, "4×"], [8, "8×"], [16, "16× (max)"]], numeric: true },
      ],
    },
    {
      title: "Anti-adblock",
      note: "<strong>Publishing note:</strong> this dismisses YouTube’s “Ad blocker detected” dialog, which the Chrome Web Store treats as circumvention. Delete <code>src/features/antiadblock.js</code> before submitting.",
      fields: [
        { key: "dismissAntiAdblock", type: "toggle", label: "Dismiss the “Ad blocker detected” dialog" },
      ],
    },
    {
      title: "SponsorBlock",
      note: "Segment data comes from the community database at sponsor.ajay.app. Your video id is never sent — only the first 4 characters of its hash, filtered locally.",
      fields: [
        { key: "sponsorblock", type: "toggle", label: "Skip sponsor segments" },
        { key: "sponsorblockNotify", type: "toggle", label: "Show a toast when skipping" },
        { key: "sponsorblockCategories", type: "checks", label: "Categories",
          options: [
            ["sponsor", "Sponsor"],
            ["selfpromo", "Self-promo"],
            ["interaction", "Interaction reminder"],
            ["intro", "Intro / intermission"],
            ["outro", "Endcards / credits"],
            ["preview", "Recap / preview"],
            ["music_offtopic", "Non-music section"],
            ["filler", "Filler tangent"],
          ] },
      ],
    },
    {
      title: "Player",
      fields: [
        { key: "defaultQuality", type: "select", label: "Default quality",
          options: [
            ["auto", "Auto (leave to YouTube)"],
            ["highres", "Highest available"],
            ["hd2160", "2160p (4K)"],
            ["hd1440", "1440p"],
            ["hd1080", "1080p"],
            ["hd720", "720p"],
            ["large", "480p"],
            ["medium", "360p"],
            ["small", "240p"],
            ["tiny", "144p"],
          ] },
        { key: "defaultSpeed", type: "select", label: "Default speed",
          options: [[0.5, "0.5×"], [0.75, "0.75×"], [1, "Normal"], [1.25, "1.25×"],
                    [1.5, "1.5×"], [1.75, "1.75×"], [2, "2×"], [3, "3×"]], numeric: true },
        { key: "audioOnly", type: "toggle", label: "Audio-only",
          help: "Forces 144p and blanks the picture. Overrides the quality setting above." },
        { key: "volumeBoost", type: "range", label: "Volume boost",
          min: 100, max: 500, step: 25, unit: "%",
          help: "Above 100% the audio is routed through Web Audio. Very high values can clip." },
        { key: "loopVideo", type: "toggle", label: "Loop videos by default" },
        { key: "hotkeys", type: "toggle", label: "Keyboard shortcuts" },
      ],
      keys: [
        ["Picture-in-picture", "Alt + P"],
        ["Toggle loop", "Alt + L"],
        ["Toggle audio-only", "Alt + A"],
        ["Speed up / down", "Alt + ] / Alt + ["],
        ["Reset speed", "Alt + \\"],
        ["Volume boost up / down", "Alt + ↑ / Alt + ↓"],
      ],
    },
    {
      title: "Download",
      note: "Downloads pull many byte ranges at once, which is what makes them fast. Above 720p YouTube serves video and audio as separate streams — those save as two files plus an <code>ffmpeg</code> command to merge them, because a browser has no muxer. Live streams and DRM-protected rentals cannot be downloaded at all.",
      fields: [
        { key: "download", type: "toggle", label: "Show the download button in the player" },
        { key: "downloadConnections", type: "range", label: "Parallel connections",
          min: 1, max: 16, step: 1,
          help: "More is faster up to a point; past 8 the server usually stops rewarding it." },
        { key: "downloadAutoAudio", type: "toggle", label: "Auto-download matching audio",
          help: "After a video-only file, fetch its audio track too and hand you the merge command." },
      ],
    },
    {
      title: "Distraction-free",
      fields: [
        { key: "hideShorts", type: "toggle", label: "Hide Shorts everywhere" },
        { key: "hideComments", type: "toggle", label: "Hide comments" },
        { key: "hideRelated", type: "toggle", label: "Hide the recommendations sidebar" },
        { key: "hideEndScreen", type: "toggle", label: "Hide end-screen cards and the pause overlay" },
        { key: "disableAutoplay", type: "toggle", label: "Turn off autoplay" },
        { key: "dismissContinueWatching", type: "toggle", label: "Auto-dismiss “Continue watching?”",
          help: "Keeps long videos playing when you leave them unattended." },
      ],
    },
  ];

  const form = document.getElementById("form");
  const savedBadge = document.getElementById("saved");
  const controls = new Map(); // key → (value) => void, for external updates

  document.getElementById("version").textContent =
    "Version " + chrome.runtime.getManifest().version;

  // ── Persistence ─────────────────────────────────────
  let savedTimer = null;

  function save(patch) {
    chrome.storage.sync.set(patch, () => {
      savedBadge.classList.add("show");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => savedBadge.classList.remove("show"), 1200);
    });
  }

  function setMasterState(isOn) {
    document.body.classList.toggle("off", !isOn);
  }

  // ── Control builders ────────────────────────────────
  function buildToggle(field, settings) {
    const wrap = document.createElement("label");
    wrap.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(settings[field.key]);
    input.addEventListener("change", () => {
      save({ [field.key]: input.checked });
      if (field.key === "enabled") setMasterState(input.checked);
    });

    const slider = document.createElement("span");
    slider.className = "slider";

    wrap.append(input, slider);
    controls.set(field.key, (value) => { input.checked = Boolean(value); });
    return wrap;
  }

  function buildSelect(field, settings) {
    const select = document.createElement("select");
    for (const [value, label] of field.options) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = String(settings[field.key]);
    select.addEventListener("change", () => {
      save({ [field.key]: field.numeric ? Number(select.value) : select.value });
    });
    controls.set(field.key, (value) => { select.value = String(value); });
    return select;
  }

  function buildRange(field, settings) {
    const fragment = document.createDocumentFragment();

    const input = document.createElement("input");
    input.type = "range";
    input.min = field.min;
    input.max = field.max;
    input.step = field.step;
    input.value = settings[field.key];

    const readout = document.createElement("span");
    readout.className = "range-value";
    const render = (value) => { readout.textContent = value + (field.unit || ""); };
    render(input.value);

    input.addEventListener("input", () => render(input.value));
    input.addEventListener("change", () => save({ [field.key]: Number(input.value) }));

    fragment.append(input, readout);
    controls.set(field.key, (value) => { input.value = value; render(value); });
    return fragment;
  }

  function buildChecks(field, settings, section) {
    const container = document.createElement("div");
    container.className = "checks";
    const boxes = new Map();

    const selected = new Set(settings[field.key] || []);

    for (const [value, label] of field.options) {
      const wrap = document.createElement("label");
      wrap.className = "check";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(value);
      input.addEventListener("change", () => {
        const next = field.options
          .map(([v]) => v)
          .filter((v) => boxes.get(v).checked);
        save({ [field.key]: next });
      });

      const text = document.createElement("span");
      text.textContent = label;

      wrap.append(input, text);
      container.appendChild(wrap);
      boxes.set(value, input);
    }

    controls.set(field.key, (value) => {
      const set = new Set(value || []);
      for (const [key, input] of boxes) input.checked = set.has(key);
    });

    // Checks render as their own block under the section, not inside a row.
    section.appendChild(container);
    return null;
  }

  // ── Render ──────────────────────────────────────────
  function render(settings) {
    form.textContent = "";
    controls.clear();

    for (const group of SCHEMA) {
      const section = document.createElement("section");
      section.className = "section" + (group.master ? " section--master" : "");

      const title = document.createElement("h2");
      title.className = "section-title";
      title.textContent = group.title;
      section.appendChild(title);

      if (group.note) {
        const note = document.createElement("p");
        note.className = "section-note";
        note.innerHTML = group.note; // static strings from SCHEMA only
        section.appendChild(note);
      }

      for (const field of group.fields) {
        if (field.type === "checks") {
          const label = document.createElement("div");
          label.className = "field";
          label.innerHTML = '<div class="field-text"><span class="field-label"></span></div>';
          label.querySelector(".field-label").textContent = field.label;
          section.appendChild(label);
          buildChecks(field, settings, section);
          continue;
        }

        const row = document.createElement("div");
        row.className = "field";

        const text = document.createElement("div");
        text.className = "field-text";

        const label = document.createElement("span");
        label.className = "field-label";
        label.textContent = field.label;
        text.appendChild(label);

        if (field.help) {
          const help = document.createElement("span");
          help.className = "field-help";
          help.textContent = field.help;
          text.appendChild(help);
        }

        const control = document.createElement("div");
        control.className = "field-control";

        if (field.type === "toggle") control.appendChild(buildToggle(field, settings));
        else if (field.type === "select") control.appendChild(buildSelect(field, settings));
        else if (field.type === "range") control.appendChild(buildRange(field, settings));

        row.append(text, control);
        section.appendChild(row);
      }

      if (group.keys) {
        const list = document.createElement("div");
        list.className = "keys";
        for (const [action, combo] of group.keys) {
          const row = document.createElement("div");
          const name = document.createElement("span");
          name.textContent = action;
          const kbd = document.createElement("kbd");
          kbd.textContent = combo;
          row.append(name, kbd);
          list.appendChild(row);
        }
        section.appendChild(list);
      }

      form.appendChild(section);
    }

    setMasterState(settings.enabled !== false);
  }

  chrome.storage.sync.get(self.YTX_DEFAULTS, render);

  // ── Wiring ──────────────────────────────────────────
  document.getElementById("reset").addEventListener("click", () => {
    if (!confirm("Reset every setting to its default?")) return;
    chrome.storage.sync.set({ ...self.YTX_DEFAULTS }, () => {
      chrome.storage.sync.get(self.YTX_DEFAULTS, render);
    });
  });

  // Reflect changes made in the popup while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      const apply = controls.get(key);
      if (apply) apply(change.newValue);
      if (key === "enabled") setMasterState(change.newValue !== false);
    }
  });
})();
