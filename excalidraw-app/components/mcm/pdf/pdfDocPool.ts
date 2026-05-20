// Reference-counted pool of pdfjs document handles, keyed by library
// file id. Without it every <PDFRenderer /> instance opens its own
// document — and the cold-start cost of parsing a multi-megabyte PDF
// (~500ms + worker init) hits every passive anchor on every page
// change. With N anchors of the same file on the canvas (or N peers
// receiving a page-change broadcast), that scales to N parses.
//
// Pool semantics:
//   • acquire(fileId, dataURL) → resolves to a shared PdfDocHandle.
//     If we're already opening this file, callers wait on the same
//     promise rather than starting a parallel parse.
//   • release(fileId) → decrements the refcount; the underlying
//     document is destroyed only when the last user releases it.
//
// What the pool does NOT do:
//   • per-page caching — that's the snapshot cache's job.
//   • TTL / eviction — refcount is the only lifecycle signal. If you
//     keep an anchor mounted, you keep its document parsed.

import { openPdf } from "./pdfRendering";

import type { PdfDocHandle } from "./pdfRendering";

type Entry = {
  promise: Promise<PdfDocHandle>;
  refCount: number;
};

const pool = new Map<string, Entry>();

/** Acquire a shared handle. Multiple callers using the same fileId
 *  resolve to the SAME PdfDocHandle instance, so a single pdfjs parse
 *  serves them all. Each acquire MUST be paired with a release once
 *  the caller stops using the handle. */
export const acquireDoc = async (
  fileId: string,
  dataURL: string,
): Promise<PdfDocHandle> => {
  const existing = pool.get(fileId);
  if (existing) {
    existing.refCount++;
    return existing.promise;
  }
  const promise = openPdf(dataURL);
  pool.set(fileId, { promise, refCount: 1 });
  // Surface the parse error so callers can react, but keep the entry
  // around so a follow-up acquire doesn't trigger ANOTHER bad parse
  // (the doc would just throw again). The caller will release and
  // the next acquire after deletion below can retry.
  try {
    return await promise;
  } catch (err) {
    pool.delete(fileId);
    throw err;
  }
};

/** Drop one reference. When the count reaches zero we destroy the
 *  underlying document so the worker thread releases its memory.
 *  Calling release for an unknown fileId is a no-op (safe to call
 *  from cleanup paths even if acquire failed). */
export const releaseDoc = async (fileId: string): Promise<void> => {
  const entry = pool.get(fileId);
  if (!entry) {
    return;
  }
  entry.refCount--;
  if (entry.refCount > 0) {
    return;
  }
  pool.delete(fileId);
  try {
    const handle = await entry.promise;
    await handle.destroy();
  } catch {
    // openPdf may have thrown; nothing to destroy in that case.
  }
};
