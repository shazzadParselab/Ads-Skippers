/**
 * Parallel range downloader.
 * --------------------------
 * A single connection to googlevideo is slow — the server paces one stream.
 * Pulling N byte ranges concurrently is what makes this fast; 6 connections is
 * typically 4–6× a plain browser download of the same file.
 *
 * WHY THE `range` QUERY PARAM, NOT THE `Range` HEADER: a custom header turns
 * the request into a CORS preflight, which googlevideo does not answer. The
 * query form keeps every chunk a "simple request", so it just works from the
 * page's origin — the same way the player fetches its own segments.
 *
 * Chunks are fetched out of order but WRITTEN in order, through a sliding
 * window: at most `connections` requests are in flight, and the writer always
 * waits for the next sequential chunk. That keeps memory bounded and lets the
 * output go straight to disk when the File System Access API is available.
 */
(function () {
  "use strict";
  const YTX = window.YTX;

  const RETRIES = 3;
  const RETRY_BASE_MS = 400;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withRange(url, start, end) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "range=" + start + "-" + end;
  }

  async function fetchRange(url, start, end, attempt) {
    try {
      // credentials:"omit" — these URLs are signed, cookies add nothing and
      // would complicate the CORS handshake.
      const response = await fetch(withRange(url, start, end), {
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= RETRIES) throw error;
      await delay(RETRY_BASE_MS * (attempt + 1));
      return fetchRange(url, start, end, attempt + 1);
    }
  }

  /**
   * Stream `url` into `sink`.
   *
   * sink      { write(Uint8Array), close(), abort() } — write is awaited
   * onProgress(bytesWritten, total, bytesPerSecond)
   * isCancelled() — polled between chunks; true aborts the transfer
   */
  async function stream({ url, total, connections, chunkSize, sink, onProgress, isCancelled }) {
    // Unknown length (live streams, some formats): one plain request, no
    // chunking possible.
    if (!total || total <= 0) {
      const response = await fetch(url, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await sink.write(bytes);
      await sink.close();
      if (onProgress) onProgress(bytes.length, bytes.length, 0);
      return bytes.length;
    }

    const ranges = [];
    for (let start = 0; start < total; start += chunkSize) {
      ranges.push([start, Math.min(start + chunkSize, total) - 1]);
    }

    // Settled wrappers: a rejected promise sitting in the map while we await an
    // earlier chunk would surface as an unhandled rejection.
    const inflight = new Map();
    let nextToLaunch = 0;

    function launch() {
      while (inflight.size < connections && nextToLaunch < ranges.length) {
        const index = nextToLaunch++;
        const [start, end] = ranges[index];
        inflight.set(
          index,
          fetchRange(url, start, end, 0).then(
            (bytes) => ({ bytes }),
            (error) => ({ error })
          )
        );
      }
    }

    const startedAt = Date.now();
    let written = 0;
    launch();

    try {
      for (let index = 0; index < ranges.length; index++) {
        const result = await inflight.get(index);
        inflight.delete(index);

        if (result.error) throw result.error;
        if (isCancelled && isCancelled()) throw new Error("cancelled");

        await sink.write(result.bytes);
        written += result.bytes.length;

        if (onProgress) {
          const seconds = (Date.now() - startedAt) / 1000;
          onProgress(written, total, seconds > 0 ? written / seconds : 0);
        }

        launch(); // top the window back up now that a slot is free
      }
    } catch (error) {
      // Drain the outstanding promises so none of them rejects unobserved.
      await Promise.all(Array.from(inflight.values()));
      sink.abort();
      throw error;
    }

    await sink.close();
    return written;
  }

  // ─────────────────────────────────────────────────────────────
  // Sinks
  // ─────────────────────────────────────────────────────────────

  /**
   * Streams straight to disk. Nothing is held in memory, so this is the only
   * option that handles multi-gigabyte files safely.
   *
   * MUST be called synchronously from a click handler: showSaveFilePicker needs
   * transient user activation, and any await before it spends that.
   * Returns null when the API is unavailable (caller should fall back to a
   * blob), or the string "cancelled" when the user dismissed the save dialog.
   */
  async function fileSink(suggestedName) {
    if (typeof window.showSaveFilePicker !== "function") return null;
    try {
      const handle = await window.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      return {
        kind: "file",
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
        abort: () => { writable.abort().catch(() => {}); },
      };
    } catch (error) {
      // Dismissing the picker is a deliberate "never mind" — do not silently
      // fall back to a memory download the user did not ask for.
      if (error && error.name === "AbortError") return "cancelled";
      return null; // API blocked or unavailable here
    }
  }

  /**
   * Buffers in memory, then hands the browser a blob: URL to save. Chrome backs
   * large blobs with disk, but this still costs far more memory than fileSink —
   * it is the fallback, and the right choice for small companion files.
   */
  function blobSink(filename, mimeType) {
    let parts = [];
    return {
      kind: "blob",
      write: (bytes) => { parts.push(bytes); },
      close: () => {
        const blob = new Blob(parts, { type: mimeType || "application/octet-stream" });
        parts = [];

        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        // Revoking immediately can cancel the save on slower machines.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      },
      abort: () => { parts = []; },
    };
  }

  YTX.downloadEngine = { stream, fileSink, blobSink };
})();
