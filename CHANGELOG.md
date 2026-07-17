# Changelog

All notable changes to this personal extension.

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
