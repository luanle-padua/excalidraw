// Make a MediaRecorder WebM blob SEEKABLE.
//
// THE PROBLEM. Chromium's MediaRecorder produces a "streaming" WebM: it has
// SimpleBlocks but NO SeekHead, NO Cues, and (usually) NO Duration in Info.
// A streaming WebM plays from 0:00 but a `<video>`/`<audio>` element cannot
// SEEK it — the review player's slider won't drag, because the element has no
// index telling it which byte offset a given timestamp lives at. (Our hand-
// rolled fixWebmDuration only injects Duration, which fixes the *length* readout
// but NOT seeking — seeking needs Cues + SeekHead.)
//
// THE FIX. ts-ebml re-muxes the file: it decodes the EBML tree, the EBMLReader
// collects the cue points (one per Cluster) + the real duration while walking
// the blocks, then tools.makeMetadataSeekable() rebuilds the metadata header
// (everything before the first Cluster) WITH a SeekHead, a Cues index, and a
// Duration — and we splice that new header in front of the original cluster
// bytes. The result is a normal, seekable WebM.
//
// BROWSER GOTCHA — Buffer. ts-ebml's runtime is written for Node: it calls the
// global `Buffer` (Buffer.from / Buffer.alloc) all over tools.js and inside the
// decoder. Vite does NOT inject a Buffer global, so in the browser ts-ebml would
// throw `Buffer is not defined`. We install the `buffer` package's polyfill onto
// globalThis via ./bufferPolyfill, imported FIRST below. (We add `buffer` and
// `ts-ebml` as explicit excalidraw-app deps for exactly this.)
//
// SAFETY. This is best-effort: ANY failure (decode error, missing global, an
// unexpected file shape) returns null so the caller falls back to the raw /
// duration-patched blob — a recording is never lost to a remux hiccup. The
// caller also RACES this against a timeout so Stop can never hang on it.

// IMPORTANT: import the Buffer polyfill FIRST so the global is installed before
// ts-ebml (and its int64-buffer dep, which captures Buffer at module-eval) is
// evaluated. ESM evaluates imports in source order.
import "./bufferPolyfill";

import { Decoder, Reader, tools } from "ts-ebml";

/**
 * Re-mux a MediaRecorder WebM blob into a SEEKABLE WebM (adds SeekHead + Cues +
 * Duration). Returns a new Blob on success, or `null` on any failure so the
 * caller can fall back to the original blob.
 *
 * Only meaningful for webm blobs — pass anything else and you'll get null.
 */
export const makeWebmSeekable = async (source: Blob): Promise<Blob | null> => {
  try {
    if (source.size === 0 || !source.type.includes("webm")) {
      return null;
    }

    const buffer = await source.arrayBuffer();

    const decoder = new Decoder();
    const reader = new Reader();
    // Reader sums DefaultDuration into the duration by default, which can over-
    // report the tail; the real wall-clock duration comes from the last block's
    // timestamp. Keep ts-ebml's default behaviour (matches its own seekable
    // recipe) — the player only needs a duration that covers all the cues.

    const elements = decoder.decode(buffer);
    for (const element of elements) {
      reader.read(element);
    }
    reader.stop();

    // Without any cue points there is nothing to index — bail to the fallback.
    if (!reader.cues || reader.cues.length === 0) {
      return null;
    }

    const seekableMetadata = tools.makeMetadataSeekable(
      reader.metadatas,
      reader.duration,
      reader.cues,
    );

    // The original metadata header (everything before the first Cluster) is
    // replaced wholesale; the cluster bytes (the actual media) are kept as-is.
    const body = buffer.slice(reader.metadataSize);

    return new Blob([seekableMetadata, body], { type: source.type });
  } catch (err) {
    console.warn("[recorder] makeWebmSeekable failed, falling back", err);
    return null;
  }
};
