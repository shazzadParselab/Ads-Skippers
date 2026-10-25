# YouTube Ad Skipper

A personal Chrome/Edge extension (Manifest V3, no build step, no dependencies)
that skips YouTube ads and adds the player and distraction-free controls the
web player is missing.

Works on `youtube.com` and `music.youtube.com`.

---

## Features

### Ad blocking
- **Video ads** — fast-forwards to the end of the ad clip at 16×, skippable or
  not, and clicks every known "Skip Ad" button on the way.
- **Page ads** — banners, feed ads, masthead, promo bars. Injected at
  `document_start`, so the ad is never painted rather than hidden after the fact.
- **Anti-adblock** — dismisses the "Ad blocker detected" dialog.
  ⚠ Store-unsafe, isolated in one file — see [Publishing](#publishing).
- Your mute state and playback speed are restored exactly as they were when the
  ad ends.

### SponsorBlock
Auto-skips sponsor, self-promo, intro, outro, recap, and filler segments using
the community database at [sponsor.ajay.app](https://sponsor.ajay.app).
Segments marked `mute` are muted instead of skipped.

Your video id is never transmitted — the service worker sends the first 4 hex
characters of its SHA-256 hash and filters the response locally.

### Download
Available two ways — a button in the player controls, and **"Download this
video" in the extension popup**. Both list every format and pull it with
**parallel byte-range requests**, typically 4–6× a plain browser download.
Progress, speed, and cancel are shown inline.

The transfer always runs in the content script, never in the popup: a popup is
destroyed the moment it loses focus. So a download started from the popup keeps
going after you close it, and reopening it reattaches to the live progress. The
one difference is that popup-started downloads skip the "save as" dialog and use
the browser's download bar — `showSaveFilePicker` needs transient user
activation in the saving page, and a runtime message carries none. The in-player
button keeps the picker, and is also the path that streams to disk instead of
buffering in memory, so prefer it for large files.

Two things are worth knowing:

- **Throttling.** Stream URLs carry an `n` challenge; served as-is, YouTube caps
  the transfer at roughly 50 KB/s. This extension does not parse `base.js` to
  solve it (that is what yt-dlp does, and it breaks every few weeks) — instead
  it captures the deciphered answer from the player's *own* segment requests via
  a `PerformanceObserver` and splices it in, matched on the `ei` session id. If
  no answer has been seen yet the panel says so: play the video for a second and
  reopen the menu.
- **No muxer.** Above 720p YouTube serves video and audio as separate streams,
  and merging them needs ffmpeg, which a browser does not have. Those formats
  save as two files plus an `ffmpeg -c copy` command on the clipboard.
  Progressive (≤720p) and audio-only formats save as one finished file.

Files stream straight to disk via the File System Access API where available, so
size is not limited by memory. Live streams and DRM-protected rentals are not
downloadable and are not offered.

### Player
Default quality (up to 4K), default speed, audio-only mode, volume boost up to
500%, loop, picture-in-picture, and keyboard shortcuts:

| Shortcut | Action |
|---|---|
| <kbd>Alt</kbd>+<kbd>P</kbd> | Picture-in-picture |
| <kbd>Alt</kbd>+<kbd>L</kbd> | Toggle loop |
| <kbd>Alt</kbd>+<kbd>A</kbd> | Toggle audio-only |
| <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>[</kbd> | Speed up / down |
| <kbd>Alt</kbd>+<kbd>\\</kbd> | Reset speed to 1× |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Volume boost up / down |

### Distraction-free
Hide Shorts everywhere, hide comments, hide the recommendations list, hide
end-screen cards and the pause overlay, turn off autoplay, and auto-dismiss the
**"Video paused. Continue watching?"** dialog — the desktop equivalent of the
mobile app's background-play problem.

---

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder.
4. Pin it, then open any YouTube page. Existing tabs need one reload.

Requires Chrome/Edge **111+** (for `world: "MAIN"` content scripts).

---

## Project structure

```
manifest.json
src/
  core/
    ns.js          shared YTX namespace — must load first
    log.js         debug logging (silent unless the `debug` setting is on)
    defaults.js    ★ every setting + its default, loaded in all four contexts
    settings.js    storage access, live change watching, dead-context teardown
    yt.js          ★ every YouTube selector, SPA navigation, page-world bridge
    registry.js    feature lifecycle (init / destroy / onNavigate / onSettings)
    download-engine.js  parallel range downloader (sink-agnostic)
  features/
    adblock.js     video ads
    antiadblock.js ⚠ store-unsafe, isolated on purpose
    sponsorblock.js
    player.js      quality, speed, audio-only, boost, loop, PiP, hotkeys
    distraction.js autoplay + "Continue watching?"
    download.js    format panel + download orchestration
  content.js       bootstrap — must be LAST in the manifest's js list
  main-world.js    page-world bridge (quality needs YouTube's own player object)
  background.js    service worker: CSS registration + SponsorBlock proxy
styles/            one stylesheet per CSS-only feature
popup/             master switch, stats, quick toggles, download panel
options/           full settings, rendered from a schema
test/              node scripts — `node test/run.js`
```

★ = the two files you will edit most.

---

## How it works

**Feature registry.** Each feature module calls `YTX.register({ id, setting,
init, destroy, onNavigate, onSettings })` at load time. The registry starts and
stops them based on settings, and re-evaluates on every storage change — so
toggles take effect on open tabs with no reload.

**CSS-only features are registered, not injected.** Anything that is purely
"hide this element" is a stylesheet in `styles/`, mapped from its setting key in
`YTX_CSS_FEATURES`. The service worker registers and unregisters those with
`chrome.scripting` as the setting flips. That is what makes them flash-free: a
JS content script has to `await` storage before it knows what to hide, and the
page renders during that wait.

**The main-world bridge.** Content scripts run in an isolated world and cannot
see JS properties the page attached to DOM nodes — including YouTube's player
API on `#movie_player`. `src/main-world.js` runs in the page world and relays a
fixed set of calls over a `CustomEvent`. Only video quality needs it; everything
else works on the plain `<video>` element.

---

## Adding a feature

**A CSS-only one** (hide something) — two lines:
1. Add the stylesheet to `styles/`.
2. Add `settingKey: "styles/your-file.css"` to `YTX_CSS_FEATURES` in
   [`src/core/defaults.js`](src/core/defaults.js), plus its default and an
   options-page entry.

**A behavioural one:**
1. Add the setting + default to [`src/core/defaults.js`](src/core/defaults.js).
2. Create `src/features/your-feature.js` calling `YTX.register({...})`.
   `destroy()` must fully undo whatever `init()` did.
3. Add the file to `content_scripts.js` in `manifest.json`, **before**
   `src/content.js`.
4. Add one entry to `SCHEMA` in [`options/options.js`](options/options.js) — the
   row, wiring, and persistence are generated from it.

Reload the extension at `chrome://extensions`, then reload the YouTube tab.

---

## Maintenance

**Skip stopped working?** YouTube renamed the button. Right-click it during an
ad → *Inspect*, copy the class, and add it to `SEL.skipButtons` at the top of
[`src/core/yt.js`](src/core/yt.js). Every YouTube-specific selector lives in
that one block.

**Something got hidden that shouldn't be?** Check `styles/` — one file per
feature, so it is obvious which sheet to narrow.

**No download button?** Reload the extension at `chrome://extensions`, then
reload the YouTube tab — both are needed. If it still is not there, open a video
and run this in the console:

```js
__ytxDebug()
```

It reports whether the extension loaded, which features are active, whether the
button reached the DOM, and whether CSS gave it a size. `extensionLoaded: false`
means the content scripts are not running at all — check the **Errors** button
on the extension's card at `chrome://extensions`.

Note that `__ytxDebug()` deliberately lives in the page world. `YTX` and
everything else in `src/core/` run in the isolated world, so the console answers
`YTX is not defined` until you switch its context dropdown from **top** to the
extension. The same state is also on `<html>` as `data-ytx` and
`data-ytx-active`, visible in the Elements panel.

**Downloads suddenly slow?** The `n` answer is not being captured. Play the
video for a second first. If it never works, YouTube changed how segment URLs
are requested — check the `PerformanceObserver` block in
[`src/main-world.js`](src/main-world.js).

**Tests.** `node test/run.js` — no framework, no install. It checks that every
content script loads in manifest order, that every feature registers and tears
down cleanly, and that the download engine reassembles chunks byte-exact under
out-of-order arrival, retries, and cancellation. Everything else needs a real
browser.

---

## Publishing

Currently built for personal use. Before submitting to the Chrome Web Store:

1. Delete `src/features/antiadblock.js` and remove it from `manifest.json`.
2. Remove `dismissAntiAdblock` from `src/core/defaults.js` and the
   "Anti-adblock" section from `options/options.js`.
3. Delete `src/features/download.js`, `src/core/download-engine.js`, and
   `styles/download.css`. Chrome Web Store policy prohibits extensions that
   download media from a site against its terms — a download button will get the
   listing rejected or removed.
4. Write a privacy policy covering the SponsorBlock request.

Nothing else references that module — keeping it alone in one file is the whole
reason it lives there.

---

## Notes / limitations

- Depends on YouTube's own markup; expect the occasional selector update.
- Volume boost routes audio through Web Audio. The routing cannot be undone once
  established for a given `<video>` element — turning the boost off sets the gain
  back to 1×, which is audibly identical.
- Screen-off playback and Premium/Movies content are **not** here: the first is an
  OS feature a browser extension has no access to, the second is DRM.
- Downloading from YouTube is against its Terms of Service. This is a personal
  tool; see [Publishing](#publishing) before distributing it.

---

## Credits

Originally based on the BSD-3-licensed
[`youtube-auto-like`](https://github.com/melchisedech333/youtube-auto-like) by
melchisedech333. The original license is retained in [`license`](license).
