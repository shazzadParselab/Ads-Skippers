/**
 * Service worker — two jobs.
 * --------------------------
 * 1. CSS FEATURE REGISTRATION. Anything that is purely "hide this element" is a
 *    stylesheet, registered/unregistered here with chrome.scripting as its
 *    setting flips. Because registered scripts inject at document_start, the ad
 *    or Short is never painted at all — a JS content script cannot match that,
 *    since reading storage is async and the page renders during the wait.
 *
 * 2. SPONSORBLOCK PROXY. Keeps the host permission out of the content script
 *    and shares one cache across tabs. The video id is never transmitted: we
 *    send the first 4 hex chars of its SHA-256 and filter the response locally,
 *    which is the API's documented privacy mode.
 */
"use strict";

importScripts("core/defaults.js");

const SB_API = "https://sponsor.ajay.app/api/skipSegments";
const SB_CACHE_MS = 30 * 60 * 1000;
const SB_ACTIONS = ["skip", "mute"]; // poi_highlight / full are not skippable

/** videoId → { at, categories, segments } */
const sbCache = new Map();

// ─────────────────────────────────────────────────────────────
// 1. CSS features
// ─────────────────────────────────────────────────────────────
function scriptIdFor(key) {
  return "ytx-css-" + key;
}

async function syncCssFeatures() {
  const settings = await chrome.storage.sync.get(self.YTX_DEFAULTS);

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (e) {
    existing = [];
  }
  const registered = new Set(existing.map((s) => s.id));

  const toRegister = [];
  const toUnregister = [];

  // Drop registrations left behind by an older version whose setting key no
  // longer exists — otherwise a removed feature's CSS would inject forever.
  const known = new Set(Object.keys(self.YTX_CSS_FEATURES).map(scriptIdFor));
  for (const id of registered) {
    if (id.startsWith("ytx-css-") && !known.has(id)) toUnregister.push(id);
  }

  for (const [key, file] of Object.entries(self.YTX_CSS_FEATURES)) {
    const id = scriptIdFor(key);
    const want = Boolean(settings.enabled && settings[key]);

    if (want && !registered.has(id)) {
      toRegister.push({
        id,
        css: [file],
        matches: ["*://*.youtube.com/*"],
        runAt: "document_start",
        allFrames: false,
        persistAcrossSessions: true,
      });
    } else if (!want && registered.has(id)) {
      toUnregister.push(id);
    }
  }

  if (toUnregister.length) {
    try { await chrome.scripting.unregisterContentScripts({ ids: toUnregister }); } catch (e) { /* ignore */ }
  }
  if (toRegister.length) {
    try { await chrome.scripting.registerContentScripts(toRegister); } catch (e) { /* ignore */ }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Seed any setting the user has never seen (fresh install, or a new option
  // added by an update) without clobbering existing choices.
  const current = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [key, value] of Object.entries(self.YTX_DEFAULTS)) {
    if (!(key in current)) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  await syncCssFeatures();
});

chrome.runtime.onStartup.addListener(syncCssFeatures);

// Runs on every worker wake, including an unpacked "reload" — which does not
// reliably fire onInstalled. Without this the stylesheets can silently never
// register, and CSS-only features (and the download button) just never appear.
// registerContentScripts is reconciled against what is already there, so
// running this more often than needed is a no-op.
syncCssFeatures();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const relevant = "enabled" in changes ||
    Object.keys(self.YTX_CSS_FEATURES).some((key) => key in changes);
  if (relevant) syncCssFeatures();
});

// ─────────────────────────────────────────────────────────────
// 2. SponsorBlock
// ─────────────────────────────────────────────────────────────
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSegments(videoId, categories) {
  const key = JSON.stringify(categories);
  const cached = sbCache.get(videoId);
  if (cached && cached.categories === key && Date.now() - cached.at < SB_CACHE_MS) {
    return cached.segments;
  }

  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const url =
    SB_API + "/" + prefix +
    "?categories=" + encodeURIComponent(JSON.stringify(categories)) +
    "&actionTypes=" + encodeURIComponent(JSON.stringify(SB_ACTIONS));

  const response = await fetch(url);
  // 404 just means nobody has submitted segments for anything in this bucket.
  if (response.status === 404) {
    sbCache.set(videoId, { at: Date.now(), categories: key, segments: [] });
    return [];
  }
  if (!response.ok) throw new Error("SponsorBlock HTTP " + response.status);

  const body = await response.json();
  const entry = Array.isArray(body) ? body.find((v) => v.videoID === videoId) : null;

  const segments = (entry && entry.segments ? entry.segments : [])
    .filter((s) => SB_ACTIONS.includes(s.actionType) && categories.includes(s.category))
    .sort((a, b) => a.segment[0] - b.segment[0]);

  sbCache.set(videoId, { at: Date.now(), categories: key, segments });
  return segments;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "sponsorblock:segments") return;

  getSegments(message.videoId, message.categories || [])
    .then((segments) => sendResponse({ ok: true, segments }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true; // keep the message channel open for the async response
});
