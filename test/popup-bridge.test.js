// Exercises the content script's popup bridge: format listing, the grouping and
// labelling the popup renders from, and the deciphered-`n` splicing that keeps
// downloads off the 50 KB/s throttle.
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

let messageListener = null;
const storage = { sync: {}, local: {} };

function stubNode() {
  const n = {
    className: '', style: { setProperty() {}, removeProperty() {} }, dataset: {},
    childNodes: [], get firstChild() { return null; },
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    textContent: '', appendChild(c) { return c; }, append() {}, insertBefore(c) { return c; },
    remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], contains: () => false,
    getBoundingClientRect: () => ({ height: 0, width: 0 }),
  };
  return n;
}

const sandbox = {
  console, setTimeout: testSetTimeout, clearTimeout, Promise, Math, Date, JSON, Error, Map, Set, WeakMap,
  URL, Number, Boolean, String, Object, Array, TextEncoder, crypto, Uint8Array, ArrayBuffer,
  Blob: class {}, fetch: async () => ({ ok: false }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  MutationObserver: class { observe() {} disconnect() {} },
  PerformanceObserver: class { observe() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; Object.assign(this, i); } },
  AudioContext: class { createMediaElementSource() { return { connect() {} }; }
                        createGain() { return { connect() {}, gain: {} }; } },
  location: { href: 'https://www.youtube.com/watch?v=abc123', hostname: 'www.youtube.com' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  navigator: { clipboard: { writeText: async () => {} } },
  chrome: {
    runtime: {
      id: 'test', getManifest: () => manifest, sendMessage() {}, lastError: null,
      onMessage: { addListener(cb) { messageListener = cb; } },
    },
    storage: {
      sync:  { get: (d, cb) => cb({ ...d, ...storage.sync }), set(v, cb) { Object.assign(storage.sync, v); cb && cb(); } },
      local: { get: (d, cb) => cb({ ...d, ...storage.local }), set(v, cb) { Object.assign(storage.local, v); cb && cb(); } },
      onChanged: { addListener() {} },
    },
  },
};
sandbox.document = Object.assign(stubNode(), {
  documentElement: stubNode(), head: stubNode(), body: stubNode(),
  createElement: () => stubNode(), createElementNS: () => stubNode(),
  getElementById: () => null, addEventListener() {}, removeEventListener() {},
  dispatchEvent() {}, contains: () => false,
});
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const f of manifest.content_scripts[0].js) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}

// ── a realistic getFormats() payload ────────────────────
const SESSION = 'SESSION_ONE';
const url = (itag) =>
  `https://rr3.googlevideo.com/videoplayback?expire=1&ei=${SESSION}&itag=${itag}&n=CHALLENGE&sig=x`;

const PAYLOAD = {
  ok: true,
  title: 'Sharp: a/b "quoted" | piped',
  videoId: 'abc123',
  isLive: false,
  formats: [
    { itag: 18,  url: url(18),  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      bitrate: 500000, contentLength: 10485760, width: 640, height: 360, fps: 30, qualityLabel: '360p' },
    { itag: 137, url: url(137), mimeType: 'video/mp4; codecs="avc1.640028"',
      bitrate: 4000000, contentLength: 104857600, width: 1920, height: 1080, fps: 60, qualityLabel: '1080p' },
    { itag: 248, url: url(248), mimeType: 'video/webm; codecs="vp9"',
      bitrate: 3000000, contentLength: 94371840, width: 1920, height: 1080, fps: 30, qualityLabel: '1080p' },
    { itag: 140, url: url(140), mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 128000, contentLength: 3145728 },
    { itag: 251, url: url(251), mimeType: 'audio/webm; codecs="opus"',
      bitrate: 160000, contentLength: 3932160 },
    { itag: 399, url: null, ciphered: true, mimeType: 'video/mp4; codecs="av01"', bitrate: 1 },
  ],
  sessions: [[SESSION, 'DECIPHERED_ANSWER']],
};

const YTX = sandbox.window.YTX;
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; };
const send = (msg) => new Promise((resolve) => {
  const async_ = messageListener(msg, {}, resolve);
  if (!async_) return; // handler replied synchronously
});

(async () => {
  await YTX.settings$.load();
  YTX.registry.sync();
  check('bridge listener registered', typeof messageListener === 'function');

  YTX.yt.askPlayer = async () => PAYLOAD;

  // ── format listing ────────────────────────────────────
  const listed = await send({ type: 'ytx:dl:formats' });
  check('formats reply is ok', listed && listed.ok === true, JSON.stringify(listed && listed.reason));

  const data = listed.data;
  check('ciphered format excluded', data.formats.length === 5, data.formats.length + ' listed');
  check('grouped video+audio, then video, then audio',
    data.formats.map(f => f.group).join(',') === 'both,video,video,audio,audio',
    data.formats.map(f => f.group).join(','));

  const byItag = Object.fromEntries(data.formats.map(f => [f.itag, f]));
  check('progressive 360p labelled and typed', byItag[18].label === '360p' && byItag[18].ext === 'mp4',
    byItag[18].label + ' / ' + byItag[18].ext);
  check('high-fps video shows its frame rate', byItag[137].label === '1080p 60fps', byItag[137].label);
  check('webm video keeps its container', byItag[248].ext === 'webm', byItag[248].ext);
  check('m4a audio labelled by bitrate', byItag[140].label === '128 kbps m4a' && byItag[140].ext === 'm4a',
    byItag[140].label + ' / ' + byItag[140].ext);
  check('opus audio labelled by bitrate', byItag[251].label === '160 kbps opus' && byItag[251].ext === 'webm',
    byItag[251].label + ' / ' + byItag[251].ext);
  check('sizes are human readable', byItag[137].size === '100.0 MB', byItag[137].size);
  check('not reported as throttled when a session answer exists', data.throttled === false);

  // ── the throttle workaround ───────────────────────────
  let captured = null;
  YTX.downloadEngine.stream = async (opts) => {
    captured = opts;
    opts.onProgress(opts.total, opts.total, 1024);
    await opts.sink.close();
    return opts.total;
  };
  YTX.downloadEngine.fileSink = async () => null; // force the blob path
  YTX.downloadEngine.blobSink = () => ({ write() {}, close() {}, abort() {} });

  const started = await send({ type: 'ytx:dl:start', itag: 18 });
  check('start accepted', started && started.ok === true);
  await new Promise(r => setTimeout(r, 30));

  check('deciphered n spliced into the download URL',
    captured && /[?&]n=DECIPHERED_ANSWER(&|$)/.test(captured.url),
    captured ? captured.url.slice(captured.url.indexOf('&n=')) : 'no url');
  check('challenge n is gone', captured && !/n=CHALLENGE/.test(captured.url));
  check('every other query param survives',
    captured && /expire=1/.test(captured.url) && /sig=x/.test(captured.url) && /itag=18/.test(captured.url));
  check('uses the configured connection count', captured && captured.connections === 6, String(captured && captured.connections));

  // ── status ────────────────────────────────────────────
  const status = await send({ type: 'ytx:dl:status' });
  check('status reports the finished transfer',
    status.ok && status.status.phase === 'done', status.status && status.status.phase);
  check('filename sanitised for shell and filesystem',
    !/["|]/.test(status.status.label) && status.status.label.endsWith('.mp4'), status.status.label);

  // ── throttled path ────────────────────────────────────
  YTX.yt.askPlayer = async () => Object.assign({}, PAYLOAD, { sessions: [] });
  const noSession = await send({ type: 'ytx:dl:formats' });
  check('reports throttled when no answer was captured', noSession.data.throttled === true);

  // ── error paths ───────────────────────────────────────
  const unknown = await send({ type: 'ytx:dl:start', itag: 12345 });
  check('unknown itag rejected', unknown.ok === false && unknown.reason === 'unknown-format');

  YTX.settings.download = false;
  const off = await send({ type: 'ytx:dl:formats' });
  check('reports disabled when the feature is off', off.ok === false && off.reason === 'disabled');

  YTX.registry.stopAll(); // clears the mount observer and its warning timer

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
