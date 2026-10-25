// Exercises src/core/download-engine.js against a fake googlevideo server.
const fs = require('fs');
const vm = require('vm');

const TOTAL = 10 * 1024 * 1024 + 1234;   // deliberately not chunk-aligned
const CHUNK = 1024 * 1024;

// Deterministic "file" so we can verify byte-exact reassembly.
const source = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) source[i] = (i * 31 + (i >> 8)) & 0xff;

let requests = 0;
let maxConcurrent = 0;
let concurrent = 0;
let failuresLeft = 3;   // force the retry path

function makeSandbox() {
  const sandbox = {
    window: {},
    setTimeout, clearTimeout, Date, Math, Promise, Error, Blob: class {}, URL,
    Uint8Array, ArrayBuffer, console,
    async fetch(url) {
      const match = /[?&]range=(\d+)-(\d+)/.exec(url);
      const seq = ++requests;   // this request's own index, not the live counter
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 5 + Math.random() * 25)); // jittered, so chunks finish out of order
      concurrent--;

      if (failuresLeft > 0 && seq % 4 === 0) {
        failuresLeft--;
        return { ok: false, status: 503 };
      }
      const [, s, e] = match;
      const slice = source.subarray(Number(s), Number(e) + 1);
      return { ok: true, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    },
  };
  sandbox.window.YTX = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('src/core/download-engine.js', 'utf8'), sandbox);
  return sandbox;
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
    ok ? pass++ : fail++;
  };

  // ── 1. correctness + ordering + concurrency ──
  {
    const sandbox = makeSandbox();
    const parts = [];
    let lastPercent = -1, monotonic = true, finalWritten = 0;

    const written = await sandbox.window.YTX.downloadEngine.stream({
      url: 'https://rr1.googlevideo.com/videoplayback?id=x',
      total: TOTAL,
      connections: 6,
      chunkSize: CHUNK,
      sink: { write: b => { parts.push(Buffer.from(b)); }, close: () => {}, abort: () => {} },
      onProgress: (w, t) => {
        const p = w / t;
        if (p < lastPercent) monotonic = false;
        lastPercent = p; finalWritten = w;
      },
      isCancelled: () => false,
    });

    const assembled = Buffer.concat(parts);
    check('reassembles byte-exact', assembled.equals(source),
          `${assembled.length}/${TOTAL} bytes`);
    check('returns total written', written === TOTAL, `${written}`);
    check('progress is monotonic', monotonic);
    check('progress ends at 100%', finalWritten === TOTAL);
    check('respected connection cap of 6', maxConcurrent <= 6, `peak=${maxConcurrent}`);
    check('actually parallelised', maxConcurrent > 1, `peak=${maxConcurrent}`);
    check('retried transient 503s', requests > Math.ceil(TOTAL / CHUNK), `${requests} requests for ${Math.ceil(TOTAL/CHUNK)} chunks`);
  }

  // ── 2. cancellation ──
  {
    const sandbox = makeSandbox();
    let aborted = false, cancel = false, writes = 0;
    const promise = sandbox.window.YTX.downloadEngine.stream({
      url: 'https://rr1.googlevideo.com/videoplayback?id=x',
      total: TOTAL, connections: 4, chunkSize: CHUNK,
      sink: { write: () => { writes++; }, close: () => {}, abort: () => { aborted = true; } },
      onProgress: () => {},
      isCancelled: () => cancel,
    });
    setTimeout(() => { cancel = true; }, 40);
    let threw = null;
    try { await promise; } catch (e) { threw = e; }
    check('cancel throws', threw && /cancelled/.test(threw.message), threw ? threw.message : 'no throw');
    check('cancel aborts the sink', aborted);
    check('cancel stops early', writes < Math.ceil(TOTAL / CHUNK), `${writes} chunks written`);
  }

  // ── 3. unknown content length ──
  {
    const sandbox = makeSandbox();
    sandbox.fetch = async () => ({ ok: true, arrayBuffer: async () => source.buffer.slice(0, 4096) });
    const parts = [];
    const written = await sandbox.window.YTX.downloadEngine.stream({
      url: 'https://rr1.googlevideo.com/videoplayback?id=x',
      total: 0, connections: 6, chunkSize: CHUNK,
      sink: { write: b => parts.push(Buffer.from(b)), close: () => {}, abort: () => {} },
      onProgress: () => {}, isCancelled: () => false,
    });
    check('falls back to a single request when length is unknown', written === 4096 && parts.length === 1);
  }

  // ── 4. permanent failure surfaces, no unhandled rejections ──
  {
    const sandbox = makeSandbox();
    sandbox.fetch = async () => ({ ok: false, status: 403 });
    let aborted = false, threw = null;
    try {
      await sandbox.window.YTX.downloadEngine.stream({
        url: 'https://rr1.googlevideo.com/videoplayback?id=x',
        total: TOTAL, connections: 6, chunkSize: CHUNK,
        sink: { write: () => {}, close: () => {}, abort: () => { aborted = true; } },
        onProgress: () => {}, isCancelled: () => false,
      });
    } catch (e) { threw = e; }
    check('permanent HTTP error propagates', threw && /403/.test(threw.message), threw ? threw.message : 'no throw');
    check('sink aborted on failure', aborted);
  }

  process.on('unhandledRejection', (e) => {
    console.log('  ✗ UNHANDLED REJECTION:', e && e.message);
    process.exitCode = 1;
  });

  await new Promise(r => setTimeout(r, 400)); // let any stray rejection surface
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
