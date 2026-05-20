// In-memory PNG snapshot cache for DXF anchors. The point of this
// cache is to let the canvas show MANY copies of the same DXF (with
// possibly different per-anchor layer filters) without consuming one
// WebGL context per copy — the slot cap is 4, so >4 simultaneous
// live DXFRenderers would force later anchors into a capacity
// placeholder.
//
// Architecture: each unique (fileId, hiddenLayersKey) combination
// resolves to a single PNG. The first anchor with that key mounts a
// live renderer, paints the DXF (with its layer filter), and stores
// the rendered output here. Subsequent anchors with the same key
// display the cached PNG via <img> — cheap, no WebGL slot. Anchors
// with DIFFERENT keys (different layer filter or different file) get
// their own cache entries.
//
// Layer changes (local toggle OR peer broadcast) flip the anchor's
// hiddenLayersKey, which is part of the cache key — so the next
// display either hits a different cached entry or triggers a fresh
// live render to populate the new key. Old entries stick around
// (some other anchor may still reference them); we evict them only
// when the underlying file is deleted.
//
// Subscribers re-render via a Jotai version atom (bumped on every
// set/delete) — components can `useAtomValue(dxfSnapshotVersionAtom)`
// to be notified that cache contents changed.

import { atom, appJotaiStore } from "../../../app-jotai";

const cache = new Map<string, string>();

/** Bumped on every set / clear. Components subscribed to this atom
 *  re-render so their cache reads pick up new entries. */
export const dxfSnapshotVersionAtom = atom(0);

/** Build the cache key from the anchor's file id + its sorted hidden-
 *  layers join + a viewKey. Same joins used by DXFCanvasOverlay's
 *  `hiddenLayersKey` and `viewKey` so the three stay in lockstep.
 *
 *  `viewKey` is "fit" for anchors using the default fit-to-extent view
 *  (so they share a snapshot across multiple copies of the same DXF)
 *  or a `cx:cy:w` string for anchors with a persisted custom pan/zoom
 *  (one snapshot per unique view). */
export const dxfSnapshotKey = (
  fileId: string,
  hiddenLayersKey: string,
  viewKey: string,
): string => `${fileId}::${hiddenLayersKey}::${viewKey}`;

export const getDxfSnapshot = (key: string): string | null =>
  cache.get(key) ?? null;

export const setDxfSnapshot = (key: string, dataUrl: string): void => {
  // Skip if identical — avoid version-bump churn that would re-render
  // every anchor on the canvas for no reason.
  if (cache.get(key) === dataUrl) {
    return;
  }
  cache.set(key, dataUrl);
  appJotaiStore.set(
    dxfSnapshotVersionAtom,
    appJotaiStore.get(dxfSnapshotVersionAtom) + 1,
  );
};

/** Drop every snapshot tied to a given file id — used when the file
 *  is deleted from the library so we don't keep stale PNGs in memory.
 *  Key prefix matches the format produced by `dxfSnapshotKey`. */
export const clearDxfSnapshotsForFile = (fileId: string): void => {
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
      dxfSnapshotVersionAtom,
      appJotaiStore.get(dxfSnapshotVersionAtom) + 1,
    );
  }
};
