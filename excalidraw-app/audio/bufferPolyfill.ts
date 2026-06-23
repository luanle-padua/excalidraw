// Install the Node `Buffer` global for browser code that expects it.
//
// ts-ebml (and its `int64-buffer` dependency) are written for Node and read the
// global `Buffer` — int64-buffer even CAPTURES it at module-eval time. Vite does
// not inject a Buffer global, so without this they'd see `undefined`. This module
// is kept SEPARATE and imported BEFORE ts-ebml so ESM import-ordering guarantees
// the global is set before any ts-ebml-chain module is evaluated.
//
// Guarded so we never clobber a real Buffer (Node tests / SSR).

import { Buffer as BufferPolyfill } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof BufferPolyfill };
if (typeof g.Buffer === "undefined") {
  g.Buffer = BufferPolyfill;
}

export {};
