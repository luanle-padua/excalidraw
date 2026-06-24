// CANVAS REPLAY — time-ordered capture of how the whiteboard evolved during a
// meeting, so a finished meeting can be SCRUBBED/PLAYED BACK in review (a vector
// timeline of the canvas, NOT a video). The live canvas is reopenable, so rather
// than recording pixels we keep an append-only, time-ordered log of scene
// snapshots and replay the scene at any time T by reconstructing it from the
// deltas up to T.
//
// SAFETY: capture is a PASSIVE OBSERVER. `recordCanvasHistory(elements)` only
// READS the elements array Collab already hands it (in `syncElements`, the same
// place broadcast + save are queued) — it never mutates an element, never bumps
// a version, never touches the broadcast/save path. Everything is wrapped so a
// capture failure can never break live collaboration.
//
// STORAGE: mirrors the chat / transcript E2E blob pattern in `storage.ts` —
// encrypted client-side with the room key, server stores only ciphertext, gated
// by the worker `roomGate` at `/v1/canvas-history/:roomId` (R2 key
// `canvas-history/<roomId>/current`). E2E for this MVP: only a client holding the
// room key (the reviewer, via the room link) can decrypt and replay. A
// server-readable variant for AI / leadership is a LATER option tied to the
// event-log — intentionally NOT built here.
//
// PLAYBACK: the replay player drives the EXISTING review-mode Excalidraw canvas
// (no second <Excalidraw> mount) via `excalidrawAPI.updateScene({ elements })`,
// folding the deltas up to the scrubbed time T (`reconstructSceneAt`). Review is
// read-only/viewOnly so `updateScene` replaces the scene locally and never
// re-broadcasts.

import type { ExcalidrawElement } from "@excalidraw/element/types";

// One captured frame. `elements` is a DELTA: only the elements whose `version`
// changed (or that are newly deleted) since the previous captured frame, to keep
// the log bounded. The reconstruction folds deltas in order, so a frame need not
// be a full scene.
export type CanvasHistoryEntry = {
  /** wall-clock ms (Date.now) when the frame was captured */
  ts: number;
  /** changed/added/deleted elements since the previous captured frame */
  elements: ExcalidrawElement[];
};

// How often (at most) we snapshot during continuous activity. The live scene
// itself only autosaves on a ~20s throttle (SYNC_FULL_SCENE_INTERVAL_MS), so a
// few seconds is plenty granular for a replay and keeps the log small.
const MIN_CAPTURE_INTERVAL_MS = 3000;

// Hard caps so a marathon meeting can't grow the in-memory log unbounded. When
// exceeded we coalesce the two OLDEST frames (the reviewer cares most about
// recent evolution; old frames degrade to coarser steps, never lost entirely).
const MAX_ENTRIES = 1200;

// A lightweight projection of an element — enough to RENDER it on replay, with
// the `version` we key deltas off. We store the whole element (it's already a
// plain object); this type just documents the fields the reconstruction relies
// on.
type Versioned = ExcalidrawElement & { version: number };

class CanvasHistoryRecorder {
  private entries: CanvasHistoryEntry[] = [];
  // Last captured version per element id, so a delta carries only what changed.
  private lastVersion = new Map<string, number>();
  private lastCaptureAt = 0;
  // Set once a real frame is recorded, so an immediate End/flush still emits the
  // current state even within the throttle window.
  private pendingFull: ExcalidrawElement[] | null = null;

  reset() {
    this.entries = [];
    this.lastVersion = new Map();
    this.lastCaptureAt = 0;
    this.pendingFull = null;
  }

  /** Number of recorded frames (for callers that want to skip an empty save). */
  size() {
    return this.entries.length;
  }

  /** PASSIVE observe: compute the delta vs. the last captured frame and, if the
   *  throttle window has elapsed (or `force`), append it. Reads only; never
   *  mutates `elements`. Returns true if a frame was appended. */
  record(elements: readonly ExcalidrawElement[], force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastCaptureAt < MIN_CAPTURE_INTERVAL_MS) {
      // Remember the latest full scene so a forced flush within the window can
      // still emit it without waiting.
      this.pendingFull = elements as ExcalidrawElement[];
      return false;
    }

    const delta: ExcalidrawElement[] = [];
    const seen = new Set<string>();
    for (const el of elements as readonly Versioned[]) {
      seen.add(el.id);
      const prev = this.lastVersion.get(el.id);
      if (prev === undefined || prev !== el.version) {
        // Clone so a later in-place mutation of the live element can't rewrite
        // a frame we already captured.
        delta.push({ ...el } as ExcalidrawElement);
        this.lastVersion.set(el.id, el.version);
      }
    }
    // An element that vanished entirely from the scene (e.g. hard reset) — record
    // a synthetic deletion so reconstruction drops it at this T.
    for (const id of this.lastVersion.keys()) {
      if (!seen.has(id)) {
        const tombstone = this.entries
          .flatMap((e) => e.elements)
          .find((e) => e.id === id);
        if (tombstone && !tombstone.isDeleted) {
          delta.push({ ...tombstone, isDeleted: true } as ExcalidrawElement);
        }
        this.lastVersion.delete(id);
      }
    }

    this.lastCaptureAt = now;
    this.pendingFull = null;

    // Nothing actually changed — don't append an empty frame.
    if (delta.length === 0) {
      return false;
    }

    this.entries.push({ ts: now, elements: delta });
    if (this.entries.length > MAX_ENTRIES) {
      this.coalesceOldest();
    }
    return true;
  }

  /** Force-capture whatever is pending (called on End / leave / before a save)
   *  so the last burst of edits inside the throttle window is not lost. */
  flush() {
    if (this.pendingFull) {
      this.record(this.pendingFull, true);
    }
  }

  /** Snapshot of the full log for persistence. */
  snapshot(): CanvasHistoryEntry[] {
    return this.entries;
  }

  /** Seed the recorder from a previously persisted log (so a reopen continues
   *  appending instead of starting blank). Rebuilds the per-id version map from
   *  the folded final state. */
  hydrate(entries: CanvasHistoryEntry[]) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    this.entries = entries.slice();
    this.lastVersion = new Map();
    for (const entry of entries) {
      for (const el of entry.elements as Versioned[]) {
        if (el.isDeleted) {
          this.lastVersion.delete(el.id);
        } else {
          this.lastVersion.set(el.id, el.version);
        }
      }
    }
    this.lastCaptureAt = entries[entries.length - 1]?.ts ?? 0;
  }

  // Merge the two oldest frames into one (keeping the newer ts) so the log stays
  // bounded without dropping evolution wholesale.
  private coalesceOldest() {
    if (this.entries.length < 2) {
      return;
    }
    const [a, b, ...rest] = this.entries;
    const byId = new Map<string, ExcalidrawElement>();
    for (const el of a.elements) {
      byId.set(el.id, el);
    }
    for (const el of b.elements) {
      byId.set(el.id, el); // newer wins
    }
    this.entries = [{ ts: b.ts, elements: Array.from(byId.values()) }, ...rest];
  }
}

// One recorder per browser session. Collab.reset()/start can call reset() on
// room change.
export const canvasHistory = new CanvasHistoryRecorder();

/** PASSIVE capture entry point — call from Collab.syncElements with the SAME
 *  elements array already being broadcast/saved. Swallows all errors so a
 *  capture bug can never break live collaboration. */
export const recordCanvasHistory = (
  elements: readonly ExcalidrawElement[],
): void => {
  try {
    canvasHistory.record(elements);
  } catch (error) {
    console.error("canvasHistory.record failed (ignored)", error);
  }
};

// --- replay reconstruction ------------------------------------------------

/** Fold the delta log up to (and including) time T into the full set of
 *  elements visible at T. Deleted elements are dropped. Pure — used by the
 *  replay player to render the canvas state at a scrubbed time. */
export const reconstructSceneAt = (
  entries: readonly CanvasHistoryEntry[],
  t: number,
): ExcalidrawElement[] => {
  const byId = new Map<string, ExcalidrawElement>();
  for (const entry of entries) {
    if (entry.ts > t) {
      break;
    }
    for (const el of entry.elements) {
      if (el.isDeleted) {
        byId.delete(el.id);
      } else {
        byId.set(el.id, el);
      }
    }
  }
  return Array.from(byId.values());
};

/** The distinct capture timestamps (the scrubber's keyframe stops), ascending. */
export const historyTimeline = (
  entries: readonly CanvasHistoryEntry[],
): number[] => entries.map((e) => e.ts);
