# Changelog

All notable changes to this personal extension.

## [3.2.0] — Download from the popup

### Added
- **Download panel in the extension popup.** "Download this video" lists the
  same formats as the in-player button, so the feature is reachable even if the
  player button fails to mount. The transfer itself still runs in the content
  script — a popup is destroyed the moment it loses focus, and a download
  running inside it would die with it. Close the popup and the download keeps
  going; reopen it and it reattaches to the live progress.
- Content-script message bridge (`ytx:dl:formats` / `start` / `status` /
  `cancel`), registered at file load rather than in `init()` so the popup always
  gets an answer — "the feature is off" is useful, silence is not.
- `test/popup-bridge.test.js` — the messaging contract, format grouping and
  labelling, filename sanitising, and the deciphered-`n` splicing that the whole
  download speed depends on and which had never been verified.

### Fixed
- **The download button never mounted at all** — `insertBefore` threw
  `NotFoundError` on every attempt. `controls.querySelector(".ytp-settings-button")`
  searches the whole subtree, but YouTube wraps that gear, so the node it found
  was a grandchild — and `insertBefore` only accepts a direct child as its
  reference. The mount now walks up to whichever ancestor really is a child of
  the control bar. This was the actual cause of the missing button; the earlier
  CSS and lookup fixes were real but not the blocker.
- Mounting is wrapped in try/catch with a five-attempt cap. The persistent
  retry observer added in 3.1.2 turned that throw into hundreds of identical
  console errors per second.
- The mount-failure warning timer is cleared on teardown instead of firing
  fifteen seconds after the feature was destroyed.

### Notes
- Downloads started from the popup skip the "save as" dialog and use the
  browser's download bar: `showSaveFilePicker` needs transient user activation
  in the page doing the saving, and a runtime message carries none. Starting
  from the in-player button still gets the picker, which is also the path that
  streams to disk rather than buffering in memory — prefer it for large files.

## [3.1.2] — Mount robustness + diagnostics

### Fixed
- **`player()` could bind to the wrong player.** It took the first
  `.html5-video-player` in the document, but YouTube keeps a second, hidden one
  mounted for hover previews (`#inline-preview-player`) which has its own
  control bar. `#movie_player` is now preferred, so everything scoped to "the
  player" — the ad skipper, SponsorBlock, the download button — binds to the
  watch player. `yt.rightControls()` resolves the control bar the same way.
- **Download button mounting was a one-shot 15-second wait.** Open the home
  page, leave the tab a while, then start a video and the wait had already
  expired. It is now a persistent MutationObserver, throttled to one
  `document.contains` check per frame, so the button also comes back if YouTube
  rebuilds the control bar.

### Added
- **`window.__ytxDebug()`** — a diagnostic that runs in the PAGE world, so it
  works from the DevTools console on its default context. `YTX` lives in the
  isolated world and answers "YTX is not defined" until you change the console's
  context dropdown; this avoids that trap entirely. Reports whether the
  extension loaded, which features are active, whether the button reached the
  DOM and has a size, and how many deciphered sessions have been captured.
- **`data-ytx` / `data-ytx-active` on `<html>`** — the registry stamps the
  version and the live feature list where the page world and the Elements panel
  can both see them. This is what `__ytxDebug()` reads.
- An unconditional console warning when the download button fails to mount on a
  watch page — a silent failure there means the feature is unreachable.
- Test coverage for both fixes, including the hover-preview player. Verified by
  reintroducing each bug and watching the tests go red.

## [3.1.1] — Download button fix

### Fixed
- **Download button was invisible.** Two causes, both now closed:
  - The service worker only registered its stylesheets from `onInstalled` /
    `onStartup`, neither of which reliably fires when you hit **reload** on an
    unpacked extension — so `styles/download.css` could silently never register.
    `syncCssFeatures()` now also runs at the worker's top level, which happens on
    every wake.
  - The button had no size of its own and relied entirely on that conditional
    stylesheet. An `<svg width="100%">` inside an unsized `<button>` collapses to
    zero width, so it was in the DOM but 0px wide. Its styling moved to
    `styles/ytx-ui.css`, which is injected unconditionally by the manifest, with
    explicit dimensions. The button can no longer be hidden by a CSS-registration
    problem; only the panel styling stays conditional.

### Added
- `YTX.debugDownload()` — run it in the console on a watch page to see whether
  the feature is on, whether the button is in the DOM, and whether CSS gave it a
  size.
- `test/mount.test.js` — mounts the feature against a DOM stub with a real
  player and control bar, and checks the button lands exactly once, in the right
  place, and follows its setting. The earlier bundle test stubbed
  `querySelector` to always return null, so the mount path was never exercised.

## [3.1.0] — Downloads

### Added
- **Download button** in the player, listing every available format with its
  size. Progress, transfer speed, and cancel are shown inline.
- **Parallel range downloader** (`src/core/download-engine.js`) — 6 concurrent
  byte-range requests by default, configurable 1–16. Chunks arrive out of order
  and are written in order through a sliding window, so memory stays bounded.
  Failed chunks retry three times with backoff.
- **Streams to disk** via the File System Access API when available, so file
  size is not limited by memory; falls back to an in-memory blob.
- **Throttle workaround without base.js parsing.** Stream URLs carry an `n`
  challenge that caps transfers at ~50 KB/s until it is deciphered. Rather than
  extracting the transform from YouTube's player code — the fragile approach —
  `src/main-world.js` reads the already-deciphered answer out of the player's own
  segment requests with a `PerformanceObserver`, keyed by `ei` so an ad's value
  is never applied to the wrong URL.
- **HD handling.** Above 720p, video and audio are separate streams and a browser
  has no muxer; those download both files and put an `ffmpeg -c copy` command on
  the clipboard.
- **`askPlayer()`** — round-trip calls into the page world, replacing the
  previous fire-and-forget-only bridge. Payloads are JSON strings, which cross
  the isolated/main world boundary reliably where objects do not.
- **`test/`** — plain node scripts, no framework: content scripts load in
  manifest order and every feature registers and tears down cleanly; the download
  engine reassembles byte-exact under out-of-order arrival, retries, and cancel.
  Run with `node test/run.js`.

### Notes
- Downloading violates YouTube's Terms of Service, and Chrome Web Store policy
  prohibits media-downloader extensions. The feature is confined to
  `src/features/download.js`, `src/core/download-engine.js`, and
  `styles/download.css` so it can be removed in one step — see the README's
  Publishing section.
- Live streams and DRM-protected rentals are not downloadable and are not listed.

## [3.0.0] — Modular rewrite

Foundation refactor plus three feature packs. The single 359-line `content.js`
is gone; features are now independent modules behind a registry, so adding one
is a new file plus two lines rather than an edit to shared logic.

### Added
- **Feature registry** (`src/core/registry.js`) — `init` / `destroy` /
  `onNavigate` / `onSettings` lifecycle. Features start and stop live as
  settings change; open tabs never need a reload.
- **Service worker** (`src/background.js`) — registers CSS-only features with
  `chrome.scripting` and proxies SponsorBlock requests.
- **Main-world bridge** (`src/main-world.js`) — reaches YouTube's own player
  object for quality control, which the isolated world cannot see.
- **Options page** — full settings, rendered from a schema so a new option is
  one entry, not a block of HTML.
- **SponsorBlock** — sponsor / self-promo / intro / outro / recap / filler
  segment skipping, with `mute`-type segments muted rather than skipped. Uses
  the hash-prefix privacy API: the video id is never sent.
- **Player pack** — default quality (to 4K), default speed, audio-only,
  volume boost to 500%, loop, picture-in-picture, and Alt-based hotkeys.
- **Distraction-free pack** — hide Shorts / comments / recommendations /
  end-screen cards, turn off autoplay, and auto-dismiss
  "Video paused. Continue watching?".
- **YouTube Music** support (`music.youtube.com` ad selectors).
- Stats now track sponsor segments and total time saved, not just an ad count.

### Changed
- Settings moved to `chrome.storage.sync` (they follow you across devices);
  stats stay in `chrome.storage.local`.
- Content scripts run at `document_start` instead of `document_idle`.
- **Page-ad hiding no longer flashes.** Element-hiding CSS is registered by the
  service worker at `document_start` per setting, rather than injected by JS
  after an async storage read — the page used to paint the ad during that wait.
- Anti-adblock dismissal moved to its own file, `src/features/antiadblock.js`,
  so it can be deleted in one step before a store submission.
- Skip-button styling dropped the forced red background; only the
  visibility/pointer rules needed to click it remain.

### Removed
- `content.js` — split into `src/core/` and `src/features/`.
- The `CONFIG` block — replaced by `src/core/defaults.js` plus the options page.

## [2.0.0] — Production rewrite

### Fixed
- **SPA navigation bug**: the script no longer bails out when the first
  page loaded isn't a watch page. A persistent observer now keeps skipping
  ads after in-app navigation (home → video, video → video).
- Corrected/removed the broken `host_permissions` entry.

### Changed
- Renamed `background.js` → `content.js` (it was always a content script,
  never a service worker).
- Trimmed permissions down to `storage` only (removed `tabs`, `activeTab`).
- Skip logic now tries multiple known button selectors instead of one,
  and re-checks the current URL at click time.

### Added
- Popup UI with an on/off toggle and an "ads skipped" counter,
  synced via `chrome.storage.local`.
- `CONFIG` block at the top of `content.js` for easy future tweaks.
- README, CHANGELOG, and `.gitignore`.

### Removed
- Fork leftovers: `readme-pt.md`, old `readme.md`, `images/` banner assets,
  and the `.DS_Store` file.

## [1.0.0] — Initial

- Clicked `.ytp-skip-ad-button` on `youtube.com/watch` via a content script.
