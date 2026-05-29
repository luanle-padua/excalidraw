// In-memory PNG snapshot cache for IFC anchors. Mirrors
// dxfSnapshotCache: lets the canvas show MANY copies of the same IFC
// model (possibly at different camera views or hide/isolate states)
// without consuming one WebGL context per copy — the slot cap is 2,
// so >2 simultaneous live IFCRenderers would force later anchors into
// a capacity placeholder.
//
// Each unique (fileId, viewKey) combination resolves to a single PNG.
// The first anchor with that key mounts a live renderer, paints the
// model, and stores the rendered output here. Subsequent anchors with
// the same key display the cached PNG via <img> — cheap, no WebGL
// slot. Anchors with different keys get their own cache entries.
//
// `viewKey` encodes whatever distinguishes the rendered output for a
// given anchor (camera view + hidden/isolation state). Old entries
// stick around until the underlying file is deleted.
//
// Subscribers re-render via a Jotai version atom (bumped on every
// set/clear) — components can `useAtomValue(ifcSnapshotVersionAtom)`
// to be notified that cache contents changed.

import { atom, appJotaiStore } from "../../../app-jotai";

const cache = new Map<string, string>();

/** Bumped on every set / clear. Components subscribed to this atom
 *  re-render so their cache reads pick up new entries. */
export const ifcSnapshotVersionAtom = atom(0);

/** Build the cache key from the anchor's file id + a viewKey.
 *
 *  `viewKey` is "fit" for anchors using the default fit-to-model view
 *  (so they share a snapshot across multiple copies of the same model)
 *  or a serialised camera/state string for anchors with a persisted
 *  custom view (one snapshot per unique view). */
export const ifcSnapshotKey = (fileId: string, viewKey: string): string =>
  `${fileId}::${viewKey}`;

export const getIfcSnapshot = (key: string): string | null =>
  cache.get(key) ?? null;

export const setIfcSnapshot = (key: string, dataUrl: string): void => {
  // Skip if identical — avoid version-bump churn that would re-render
  // every anchor on the canvas for no reason.
  if (cache.get(key) === dataUrl) {
    return;
  }
  cache.set(key, dataUrl);
  appJotaiStore.set(
    ifcSnapshotVersionAtom,
    appJotaiStore.get(ifcSnapshotVersionAtom) + 1,
  );
};

/** Drop every snapshot tied to a given file id — used when the file is
 *  deleted from the library so we don't keep stale PNGs in memory. Key
 *  prefix matches the format produced by `ifcSnapshotKey`. */
export const clearIfcSnapshotsForFile = (fileId: string): void => {
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
      ifcSnapshotVersionAtom,
      appJotaiStore.get(ifcSnapshotVersionAtom) + 1,
    );
  }
};
