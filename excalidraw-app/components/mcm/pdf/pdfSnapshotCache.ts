// In-memory PNG snapshot cache for PDF anchors. Same architecture as
// dxfSnapshotCache — many copies of the same PDF on the canvas (each
// possibly viewing a different page) need not each spin up a pdfjs
// document. The first anchor to display a given (fileId, page) renders
// live, drops a PNG into this cache, and unmounts; subsequent anchors
// with the same key paint a plain <img> for free.
//
// Cache key is `${fileId}::${pageNumber}` — PDFs don't have layer
// filters or pan/zoom state that needs to participate in the key
// (focus mode is a transient state, not persisted per anchor).

import { atom, appJotaiStore } from "../../../app-jotai";

const cache = new Map<string, string>();

/** Bumped on every set / clear. Components subscribed to this atom
 *  re-render so their cache reads pick up new entries. */
export const pdfSnapshotVersionAtom = atom(0);

export const pdfSnapshotKey = (fileId: string, page: number): string =>
  `${fileId}::${page}`;

export const getPdfSnapshot = (key: string): string | null =>
  cache.get(key) ?? null;

export const setPdfSnapshot = (key: string, dataUrl: string): void => {
  if (cache.get(key) === dataUrl) {
    return;
  }
  cache.set(key, dataUrl);
  appJotaiStore.set(
    pdfSnapshotVersionAtom,
    appJotaiStore.get(pdfSnapshotVersionAtom) + 1,
  );
};

export const clearPdfSnapshotsForFile = (fileId: string): void => {
  const prefix = `${fileId}::`;
  let changed = false;
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(prefix)) {
      cache.delete(k);
      changed = true;
    }
  }
  if (changed) {
    appJotaiStore.set(
      pdfSnapshotVersionAtom,
      appJotaiStore.get(pdfSnapshotVersionAtom) + 1,
    );
  }
};
