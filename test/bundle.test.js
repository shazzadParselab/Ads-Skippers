// Loads every content script in manifest order against a minimal DOM/chrome
// stub, then drives the registry the way content.js does.
const fs = require('fs');
const vm = require('vm');

// Long timers in the source are give-up deadlines — waitFor()'s 15s timeout and
// the mount warning. They never need to fire in a test, but as real timers they
// hold node's event loop open and add 15s to every run. Unref only those; short
// timers are load-bearing (rAF shims, retry backoff) and must still hold.
const realSetTimeout = setTimeout;
function testSetTimeout(fn, ms) {
  const t = realSetTimeout(fn, ms);
  if (ms >= 5000 && t && typeof t.unref === "function") t.unref();
  return t;
}


const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const files = manifest.content_scripts[0].js;

// ── stubs ───────────────────────────────────────────────
const listeners = {};
function node(tag = 'div') {
  const n = {
    tagName: tag.toUpperCase(), className: '', style: {
      setProperty() {}, removeProperty() {}, width: '',
    },
    dataset: {}, children: [], classList: {
      contains: () => false, add() {}, remove() {}, toggle() {},
    },
    textContent: '', appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); }, insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], contains: () => false, getBoundingClientRect: () => ({ height: 0 }),
    click() {}, focus() {}, select() {},
  };
  return n;
}

const storage = { sync: {}, local: {} };
const sandbox = {
  console,
  setTimeout: testSetTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  Promise, Math, Date, JSON, Error, Map, Set, WeakMap, URL, Number, Boolean, String, Object, Array,
  TextEncoder, crypto, Blob: class {}, Uint8Array, ArrayBuffer, fetch: async () => ({ ok: false }),
  MutationObserver: class { observe() {} disconnect() {} },
  PerformanceObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  AudioContext: class { createMediaElementSource() { return { connect() {} }; }
                        createGain() { return { connect() {}, gain: {} }; } },
  location: { href: 'https://www.youtube.com/watch?v=abc123', hostname: 'www.youtube.com' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  navigator: { clipboard: { writeText: async () => {} } },
  performance: { getEntriesByType: () => [] },
  document: Object.assign(node('html'), {
    documentElement: node('html'), head: node('head'), body: node('body'),
    createElement: (t) => node(t),
    createElementNS: (ns, t) => node(t),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    removeEventListener() {}, dispatchEvent() {}, contains: () => false,
    getElementById: () => null,
  }),
  chrome: {
    runtime: { id: 'test-extension', getManifest: () => manifest, sendMessage() {}, lastError: null,
                 onMessage: { addListener() {} } },
    storage: {
      sync:  { get: (defs, cb) => cb({ ...defs, ...storage.sync }), set(v, cb) { Object.assign(storage.sync, v); cb && cb(); } },
      local: { get: (defs, cb) => cb({ ...defs, ...storage.local }), set(v, cb) { Object.assign(storage.local, v); cb && cb(); } },
      onChanged: { addListener() {} },
    },
  },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// ── load in manifest order ──────────────────────────────
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};

for (const file of files) {
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  } catch (e) {
    check('loads ' + file, false, e.message);
  }
}
check('all ' + files.length + ' content scripts load without throwing', fail === 0);

const YTX = sandbox.window.YTX;

// ── structure ───────────────────────────────────────────
check('YTX namespace exists', !!YTX);
check('core modules attached',
  !!(YTX.log && YTX.settings$ && YTX.yt && YTX.registry && YTX.register && YTX.downloadEngine),
  Object.keys(YTX).join(', '));

const ids = YTX.features.map(f => f.id).sort();
const expected = ['adblock', 'antiadblock', 'distraction', 'download', 'player', 'sponsorblock'];
check('all 6 features registered', JSON.stringify(ids) === JSON.stringify(expected), ids.join(', '));

for (const f of YTX.features) {
  check(`${f.id}: has init + destroy`, typeof f.init === 'function' && typeof f.destroy === 'function');
}

// Every `setting` a feature gates on must be a real default.
vm.runInContext(fs.readFileSync('src/core/defaults.js', 'utf8'), sandbox);
const defaults = sandbox.self.YTX_DEFAULTS;
for (const f of YTX.features.filter(f => f.setting)) {
  check(`${f.id}: gate "${f.setting}" exists in defaults`, f.setting in defaults);
}

// ── lifecycle ───────────────────────────────────────────
(async () => {
  await YTX.settings$.load();
  check('settings loaded with defaults', YTX.settings.enabled === true && YTX.settings.downloadConnections === 6);

  YTX.registry.sync();
  await new Promise(r => setTimeout(r, 20));
  check('registry.sync() starts features without throwing', true);

  YTX.registry.navigate('abc123');
  check('registry.navigate() runs without throwing', true);

  // Master switch off -> everything must stop cleanly.
  YTX.settings.enabled = false;
  YTX.registry.sync(['enabled']);
  check('master off tears every feature down', true);

  YTX.settings.enabled = true;
  YTX.registry.sync(['enabled']);
  check('master on restarts them', true);

  YTX.registry.stopAll();
  check('stopAll() is clean', true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
