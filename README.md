# YouTube Ad Skipper

A small, personal Chrome/Edge extension that automatically clicks the
**"Skip Ad"** button on YouTube watch pages (`youtube.com/watch`).

Built for personal use, Manifest V3, no external dependencies, no data
collection, no network requests.

---

## Features

- **Auto-skips ads** the moment the "Skip" button becomes clickable.
- **Survives SPA navigation** — keeps working as you move between videos
  without a full page reload (the common failure mode of naive skippers).
- **Resilient selectors** — tries several known skip-button class names,
  so a YouTube UI rename is a one-line fix instead of a rewrite.
- **Popup** with an on/off toggle and a running "ads skipped" counter.
- **Minimal permissions** — only `storage` (to remember the toggle and
  counter). No `tabs`, no host permissions, no background worker.

---

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `addSkiper` folder.
4. Pin the extension and open any `youtube.com/watch` video.

To use it in a normal (non-dev) profile without the "Developer mode"
warning, you can pack it into a `.crx` via the **Pack extension** button on
the same page — but loading unpacked is fine for personal use.

---

## Project structure

```
addSkiper/
├── manifest.json      # MV3 config: matches, permissions, popup
├── content.js         # main logic — CONFIG block at the top
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js       # reads/writes settings via chrome.storage
├── icons/
├── CHANGELOG.md
├── README.md
└── license            # BSD-3 (see "Credits")
```

---

## How to update it

Almost everything you'll want to change lives in the **`CONFIG` block at
the top of [`content.js`](content.js)**:

- **Skip stopped working?** YouTube probably renamed the button. During an
  ad, right-click the "Skip" button → *Inspect*, copy its class, and add a
  new selector to the **top** of `CONFIG.skipButtonSelectors`.
- **Turn off the red highlight** → set `highlightSkipButton: false`.
- **Change match scope** → edit `watchPathMatch`.

After editing any file, go to `chrome://extensions` and click the **reload**
(↻) icon on the extension card. Bump the `version` in `manifest.json` and
add a note to `CHANGELOG.md` so you can track your own changes over time.

---

## Notes / limitations

- Only clicks the **skippable** "Skip Ad" button. Truly unskippable ads
  (short bumpers) have no skip button to click.
- Uses YouTube's own DOM, so it depends on YouTube's markup — expect the
  occasional selector update (see above).
- For personal use. Not published to any store.

---

## Credits

Originally based on the BSD-3-licensed
[`youtube-auto-like`](https://github.com/melchisedech333/youtube-auto-like)
project by melchisedech333, then rewritten as an ad skipper. The original
license is retained in [`license`](license).
