/**
 * Shared namespace for every content-script file.
 * ------------------------------------------------
 * All files listed in manifest `content_scripts.js` run in the SAME isolated
 * world, so they share one global scope. This file must load FIRST — it is the
 * only place `YTX` is created. Every other file does `window.YTX.x = ...`.
 */
window.YTX = window.YTX || {
  features: [],   // registered feature modules
  settings: {},   // resolved settings (filled by settings.js)
  stats: {},      // resolved stats
};
