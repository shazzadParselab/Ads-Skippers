// Drives src/features/download.js against a DOM stub that actually has a
// player and .ytp-right-controls, to see whether the button really mounts.
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


// ── tiny but real tree-tracking DOM ─────────────────────
let idSeq = 0;
function el(tag = 'div', className = '') {
  const n = {
    _id: ++idSeq, tagName: tag.toUpperCase(), className, parentNode: null,
    childNodes: [], style: { setProperty(){}, removeProperty(){} }, dataset: {},
    attrs: {}, listeners: {},
    get firstChild() { return this.childNodes[0] || null; },
    get classList() {
      const self = this;
      return {
        contains: (c) => self.className.split(/\s+/).includes(c),
        add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter(x => x !== c).join(' '); },
        toggle() {},
      };
    },
    set textContent(v) { this.childNodes = []; this._text = v; },
    get textContent() { return this._text || ''; },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    append(...cs) { cs.forEach(c => this.appendChild(c)); },
    insertBefore(c, ref) {
      if (ref && !this.childNodes.includes(ref)) {
        const e = new Error("Failed to execute 'insertBefore' on 'Node': The node " +
          "before which the new node is to be inserted is not a child of this node.");
        e.name = 'NotFoundError';
        throw e;
      }
      c.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i === -1) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      return c;
    },
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.childNodes.indexOf(this);
      if (i !== -1) this.parentNode.childNodes.splice(i, 1);
      this.parentNode = null;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, cb) { (this.listeners[t] ||= []).push(cb); },
    removeEventListener() {},
    contains(other) { let p = other; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    getBoundingClientRect: () => ({ height: 0 }),
    querySelector(sel) { return descendants(this).find(n => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(this).filter(n => matches(n, sel)); },
    click() { (this.listeners.click || []).forEach(cb => cb({ stopPropagation(){}, target: this })); },
  };
  return n;
}
function descendants(root, out = []) {
  for (const c of root.childNodes) { out.push(c); descendants(c, out); }
  return out;
}
function matches(node, sel) {
  return sel.split(',').map(s => s.trim()).some(s => {
    if (s.startsWith('.')) return node.className.split(/\s+/).includes(s.slice(1));
    if (s.startsWith('#')) return node.attrs.id === s.slice(1);
    return node.tagName === s.toUpperCase();
  });
}

// ── build a realistic watch-page player ─────────────────
const html = el('html');
const body = el('body');
html.appendChild(body);

// A hover-preview player sits earlier in the DOM than the real one and has its
// own .ytp-right-controls — mounting into it hides the button completely.
const preview = el('div', 'html5-video-player');
preview.setAttribute('id', 'inline-preview-player');
const previewControls = el('div', 'ytp-right-controls');
preview.appendChild(previewControls);
body.appendChild(preview);

const player = el('div', 'html5-video-player');
player.setAttribute('id', 'movie_player');
const video = el('video', 'html5-main-video');
const chrome_ = el('div', 'ytp-chrome-controls');
const rightControls = el('div', 'ytp-right-controls');
rightControls.appendChild(el('button', 'ytp-subtitles-button ytp-button'));
// The settings gear sits inside a wrapper, so it is a grandchild of the control
// bar — insertBefore(button, gear) throws NotFoundError for exactly this reason.
const settingsWrap = el('div', 'ytp-settings-wrapper');
settingsWrap.appendChild(el('button', 'ytp-settings-button ytp-button'));
rightControls.appendChild(settingsWrap);
rightControls.appendChild(el('button', 'ytp-fullscreen-button ytp-button'));
chrome_.appendChild(rightControls);
player.append(video, chrome_);
body.appendChild(player);

// ── sandbox ─────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const storage = { sync: {}, local: {} };
const sandbox = {
  console, setTimeout: testSetTimeout, clearTimeout, Promise, Math, Date, JSON, Error, Map, Set, WeakMap,
  URL, Number, Boolean, String, Object, Array, TextEncoder, crypto, Uint8Array, ArrayBuffer,
  Blob: class {}, fetch: async () => ({ ok: false }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  MutationObserver: class { observe() {} disconnect() {} },
  PerformanceObserver: class { observe() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; Object.assign(this, i); } },
  AudioContext: class { createMediaElementSource() { return { connect(){} }; } createGain() { return { connect(){}, gain: {} }; } },
  location: { href: 'https://www.youtube.com/watch?v=abc123', hostname: 'www.youtube.com' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  navigator: { clipboard: { writeText: async () => {} } },
  chrome: {
    runtime: { id: 'test', getManifest: () => manifest, sendMessage() {}, lastError: null,
                 onMessage: { addListener() {} } },
    storage: {
      sync:  { get: (d, cb) => cb({ ...d, ...storage.sync }), set(v, cb) { Object.assign(storage.sync, v); cb && cb(); } },
      local: { get: (d, cb) => cb({ ...d, ...storage.local }), set(v, cb) { Object.assign(storage.local, v); cb && cb(); } },
      onChanged: { addListener() {} },
    },
  },
};
sandbox.document = Object.assign(el('#document'), {
  documentElement: html, head: el('head'), body,
  childNodes: [html],
  createElement: (t) => el(t),
  createElementNS: (ns, t) => el(t),
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
});
html.parentNode = sandbox.document;   // so document.contains() actually works
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok?'  ✓ ':'  ✗ ')+n+(extra?'  '+extra:'')); ok?pass++:fail++; };

for (const f of manifest.content_scripts[0].js) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}

(async () => {
  const YTX = sandbox.window.YTX;
  await YTX.settings$.load();
  check('download setting defaults to on', YTX.settings.download === true);

  YTX.registry.sync();
  await new Promise(r => setTimeout(r, 50));

  const btn = rightControls.querySelector('.ytx-dl-button');
  check('button was inserted into .ytp-right-controls', !!btn);
  check('mounted in the watch player, not the hover-preview player',
    !previewControls.querySelector('.ytx-dl-button'));
  check('yt.player() resolves #movie_player over the preview',
    YTX.yt.player() === player);

  if (btn) {
    const order = rightControls.childNodes.map(c =>
      c.className.includes('ytx-dl-button') ? 'ytx-dl-button' : c.className.split(' ')[0]);
    check('exactly one button, no duplicates',
      rightControls.querySelectorAll('.ytx-dl-button').length === 1,
      order.join(' | '));
    check('sits immediately left of the wrapper holding the settings gear',
      order.indexOf('ytx-dl-button') === order.indexOf('ytp-settings-wrapper') - 1, order.join(' | '));
    check('carries the ytp-button class so YouTube sizes it', btn.className.includes('ytp-button'), btn.className);
    check('has an accessible label', btn.getAttribute('aria-label') === 'Download');
    check('contains an svg icon', btn.childNodes.some(c => c.tagName === 'SVG'));
  }

  // Turning the setting off must remove it; back on must restore it.
  YTX.settings.download = false;
  YTX.registry.sync(['download']);
  check('setting off removes the button', !rightControls.querySelector('.ytx-dl-button'));

  YTX.settings.download = true;
  YTX.registry.sync(['download']);
  await new Promise(r => setTimeout(r, 20));
  check('setting on restores it', !!rightControls.querySelector('.ytx-dl-button'));

  // The <html> marker is what window.__ytxDebug() reads to report the
  // isolated world's state from the page world.
  const marker = html.getAttribute('data-ytx-active') || '';
  check('marks active features on <html>', marker.includes('download'), 'data-ytx-active="' + marker + '"');
  check('marks the version on <html>', html.getAttribute('data-ytx') === manifest.version,
        String(html.getAttribute('data-ytx')));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
