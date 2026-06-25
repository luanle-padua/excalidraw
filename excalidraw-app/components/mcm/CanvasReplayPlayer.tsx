// CANVAS REPLAY — review-mode player. Mounted directly as a bottom-docked
// control bar over the finished-meeting review canvas (the header's "Tua lại"
// button). Loads the E2E canvas-history blob (the time-ordered, delta-encoded
// log of how the whiteboard evolved), decrypts it with the room key the reviewer
// already holds, and lets them SCRUB / play back the canvas evolution — a vector
// timeline of the whiteboard, NOT a video.
//
// NATIVE PLAYER (no second <Excalidraw>): the previous version mounted its own
// review Excalidraw, which spawned phantom guests, a reload loop, and no working
// scrub. This version drives the EXISTING review-mode canvas (the one already on
// screen behind the bar) imperatively, via the live `excalidrawAPI`:
//
//   reconstructSceneAt(entries, T) -> restoreElements -> excalidrawAPI.updateScene
//
// Review is read-only / viewOnly, so `updateScene({ elements })` replaces the
// scene LOCALLY and never re-broadcasts (Collab.syncElements is gated off in
// review; updateScene itself does not broadcast). We snapshot the real review
// scene on entry and RESTORE it on exit, so scrubbing never leaves the canvas
// stuck at a replay frame. The bar floats over the live canvas at all times —
// there is no modal shell and no "peek" step: open the bar and you are watching.
//
// E2E (MVP): only a client with the room key can decrypt + replay. The server
// never reads the blob. A server-readable variant for AI / leadership is a later
// option tied to the event-log.
//
// ── TIME MODEL: ABSOLUTE-MS PLAYHEAD (unified-replay-ux.md §1, §4, §6 P1) ──────
// The single source of truth for "where are we" is `playheadT` — an ABSOLUTE
// epoch-ms instant on the same clock the canvas history (`entry.ts`), transcript
// (`segment.ts`) and recordings (`started_at_ms`) already live on. Playback is a
// continuous rAF clock that advances `playheadT` by `delta × speed`; the canvas
// is a STEP FUNCTION of `playheadT` (the scene visible at T is the fold of all
// deltas with `ts <= playheadT`), so we only `updateScene` when the resolved
// keyframe index actually changes — not on every rAF tick. The scrubber is a
// continuous `[T0, T1]` ms range, not a list of stop indices.
//
// This is the foundation P2 (speaker lanes sharing the same x-axis) and P3
// (audio/screen media seeking to `playheadT`) build on. The play state is lifted
// HERE and handed to the timeline as a single bundle (see `ReplayClock` in
// CanvasReplayTimeline) so a sibling row (lanes) or media hook can read/drive the
// exact same `playheadT` without re-architecting this component.

import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import {
  type CanvasHistoryEntry,
  reconstructSceneAt,
} from "../../data/canvasHistory";
import { buildSpeakerTimeline } from "../../data/replayTimeline";
import { loadCanvasHistoryFromStorage } from "../../data/storage";
import { transcriptionLogAtom } from "../../data/transcription";
import { useT } from "../../i18n/mcm";

import { CanvasReplayTimeline, type ReplaySpeed } from "./CanvasReplayTimeline";

import "./CanvasReplay.scss";

type LoadState = "loading" | "empty" | "ready" | "error";

// Extra time bounds a future phase can fold into the playhead range so the
// timeline can extend BEFORE the first canvas frame / AFTER the last one. P3
// media tracks may start before any drawing happened or run past the final
// stroke; passing their `started_at_ms` / end here WIDENS [T0, T1] without
// touching the canvas reconstruction (which still keys off `entry.ts`). Empty /
// undefined today → bounds are exactly the canvas span, i.e. identical behavior.
export type ReplayBoundsExtra = {
  /** epoch-ms instants that should be reachable at or before the start */
  starts?: readonly number[];
  /** epoch-ms instants that should be reachable at or after the end */
  ends?: readonly number[];
};

/** Derive the absolute-ms playhead window [T0, T1].
 *
 *  Today this is just the canvas span (first frame `ts` → last frame `ts`).
 *  It is written as a pure function taking the canvas entries PLUS an optional
 *  `extra` so P3 can WIDEN the window to cover media that begins before the
 *  first stroke or ends after the last one — the only change there is to thread
 *  real `starts` / `ends` in; callers and the canvas step function are
 *  unaffected. Returns a degenerate [t, t] window for a single frame and
 *  [0, 0] when there is nothing to show (guards downstream divide-by-zero). */
export const computeReplayBounds = (
  entries: readonly CanvasHistoryEntry[],
  extra?: ReplayBoundsExtra,
): { T0: number; T1: number } => {
  const candidatesStart: number[] = [];
  const candidatesEnd: number[] = [];
  if (entries.length > 0) {
    candidatesStart.push(entries[0].ts);
    candidatesEnd.push(entries[entries.length - 1].ts);
  }
  if (extra?.starts) {
    candidatesStart.push(...extra.starts);
  }
  if (extra?.ends) {
    candidatesEnd.push(...extra.ends);
  }
  if (candidatesStart.length === 0 || candidatesEnd.length === 0) {
    return { T0: 0, T1: 0 };
  }
  const T0 = Math.min(...candidatesStart);
  const T1 = Math.max(...candidatesEnd, T0);
  return { T0, T1 };
};

/** The keyframe index for an absolute time T = the index of the LAST entry with
 *  `ts <= T` (the canvas is a step function of T). −1 before the first frame
 *  (nothing drawn yet). Entries are ascending, so a linear scan from the end is
 *  fine for our bounded log; this is only called when the index might change. */
const keyframeIndexAt = (
  entries: readonly CanvasHistoryEntry[],
  t: number,
): number => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].ts <= t) {
      return i;
    }
  }
  return -1;
};

export const CanvasReplayPlayer = ({
  roomId,
  roomKey,
  excalidrawAPI,
  onClose,
}: {
  roomId: string | null;
  roomKey: string | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** Exit the replay — the parent unmounts the bar and the snapshot of the
   *  static finished-meeting scene is restored on cleanup. */
  onClose: () => void;
}) => {
  const t = useT();
  const [entries, setEntries] = useState<CanvasHistoryEntry[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // ── ABSOLUTE-MS PLAYHEAD: the single time state (epoch ms). Everything the
  // user sees (canvas frame, clock, scrubber thumb) is derived from this. ──
  const [playheadT, setPlayheadT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  // The real review scene as it was when Replay opened — restored on exit so
  // scrubbing never permanently clobbers the canvas the reviewer sees.
  const originalSceneRef = useRef<readonly ExcalidrawElement[] | null>(null);
  // rAF handle for the playback clock + the timestamp of the previous frame, so
  // we can advance the playhead by real elapsed wall time × speed.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  // The keyframe index currently pushed to the canvas. The canvas is a step
  // function of `playheadT`; we only call updateScene when THIS changes, so a
  // 60fps playback clock does not re-render the scene every frame.
  const renderedIdxRef = useRef<number | null>(null);
  // Always-fresh mirrors for the rAF loop (which closes over a single render).
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // [T0, T1] — the absolute-ms window the playhead travels. Derived purely from
  // the canvas entries today; widen-able by P3 via computeReplayBounds(extra).
  const { T0, T1 } = useMemo(() => computeReplayBounds(entries), [entries]);
  const durationMs = Math.max(0, T1 - T0);
  const t1Ref = useRef(T1);
  t1Ref.current = T1;

  // P2 — "who spoke when": the live transcript log for THIS room (seeded from
  // localStorage on join, kept in sync by the collab layer) is the lane source.
  // Works with NO recording — STT runs independently. We build the per-speaker
  // model purely (no React inside) and hand it to the timeline, which renders a
  // COLLAPSED-by-default lane strip sharing this exact [T0, T1] axis. Bounds stay
  // the canvas span for P2 (the design says transcript-only widening is fine to
  // skip here); a chairman who scrubs before the first stroke still sees lanes
  // because each block is clamped into [T0, T1] by the strip.
  const transcriptLog = useAtomValue(transcriptionLogAtom);
  const speakerTimeline = useMemo(
    () => buildSpeakerTimeline(transcriptLog),
    [transcriptLog],
  );

  // --- load + decrypt the history blob -----------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!roomId || !roomKey) {
      setState("empty");
      return;
    }
    setState("loading");
    void (async () => {
      try {
        const history = await loadCanvasHistoryFromStorage<CanvasHistoryEntry>(
          roomId,
          roomKey,
        );
        if (cancelled) {
          return;
        }
        if (!history?.length) {
          setState("empty");
          return;
        }
        // Defensive: keep entries time-ordered even if a writer raced.
        const sorted = history.slice().sort((a, b) => a.ts - b.ts);
        setEntries(sorted);
        // Start fully built (parked at the end), as before — now expressed as an
        // absolute instant rather than a stop index.
        setPlayheadT(sorted[sorted.length - 1].ts);
        setState("ready");
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, roomKey]);

  // --- snapshot the real scene on entry, restore it on exit ---------------
  // Capture the live review scene ONCE (when the API + history are ready) so we
  // can put it back when the reviewer closes the bar. updateScene with
  // CaptureUpdateAction.NEVER keeps these swaps out of the undo stack.
  useEffect(() => {
    if (!excalidrawAPI || state !== "ready") {
      return;
    }
    if (originalSceneRef.current === null) {
      originalSceneRef.current =
        excalidrawAPI.getSceneElementsIncludingDeleted();
    }
    return () => {
      const original = originalSceneRef.current;
      if (excalidrawAPI && original) {
        try {
          excalidrawAPI.updateScene({
            elements: original,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        } catch (error) {
          console.error("canvas replay: restore failed (ignored)", error);
        }
      }
      originalSceneRef.current = null;
    };
  }, [excalidrawAPI, state]);

  // --- render the reconstructed scene at an ABSOLUTE time T ----------------
  // Drive the EXISTING review canvas: fold the deltas up to T, run them through
  // restoreElements (fills defaults / drops invalid so arbitrary persisted
  // elements are safe), and push them imperatively. Read-only review —
  // updateScene replaces locally and never re-broadcasts.
  //
  // STEP FUNCTION: the canvas only changes at keyframe boundaries, so we resolve
  // the keyframe index for T and SKIP the updateScene entirely when it matches
  // what is already on the canvas (`force` overrides this, e.g. first paint /
  // after a fresh load). This is what keeps a 60fps playhead cheap.
  const renderAt = useCallback(
    (absT: number, force = false) => {
      const api = excalidrawAPI;
      if (!api || entries.length === 0) {
        return;
      }
      const targetIdx = keyframeIndexAt(entries, absT);
      if (!force && targetIdx === renderedIdxRef.current) {
        return;
      }
      renderedIdxRef.current = targetIdx;
      // Before the first frame nothing has been drawn — show an empty scene
      // (matches "the board at T" being empty). reconstructSceneAt with a T
      // earlier than entries[0].ts already returns []; use it for symmetry.
      const raw = reconstructSceneAt(entries, absT);
      const elements = restoreElements(raw, null, {
        deleteInvisibleElements: true,
      });
      api.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    [entries, excalidrawAPI],
  );

  // Fit-to-content ONCE on first paint so the reviewer sees the whole board,
  // then keep the canvas in sync with the playhead. `force` on the playhead
  // render so a fresh load (renderedIdxRef still null/stale) always paints.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (state !== "ready" || !excalidrawAPI || entries.length === 0) {
      return;
    }
    renderAt(playheadT);
    if (!fittedRef.current) {
      fittedRef.current = true;
      // Force the very first paint regardless of the cached keyframe index.
      renderAt(playheadT, true);
      try {
        const built = restoreElements(
          reconstructSceneAt(entries, entries[entries.length - 1].ts),
          null,
          { deleteInvisibleElements: true },
        );
        if (built.length > 0) {
          excalidrawAPI.scrollToContent(built, { fitToContent: true });
        }
      } catch {
        /* fit is best-effort */
      }
    }
    // playheadT + renderAt cover re-render on every scrub / playback step. The
    // step-function guard in renderAt makes the per-tick cost a cheap compare.
  }, [playheadT, renderAt, state, excalidrawAPI, entries]);

  // --- playback loop: a continuous rAF clock ------------------------------
  // While playing, advance `playheadT` by (real elapsed ms × speed) each frame.
  // The canvas step-function guard (renderAt) means only keyframe crossings hit
  // updateScene. Stop (park) at T1, as the index loop did at the last stop.
  useEffect(() => {
    if (!playing || state !== "ready" || durationMs === 0) {
      return;
    }
    lastTickRef.current = null;
    const tick = (now: number) => {
      const prev = lastTickRef.current;
      lastTickRef.current = now;
      if (prev !== null) {
        const dt = (now - prev) * speedRef.current;
        setPlayheadT((cur) => {
          const next = cur + dt;
          if (next >= t1Ref.current) {
            return t1Ref.current; // park at the end
          }
          return next;
        });
      }
      // Re-read the latest playhead via the functional setState above; schedule
      // the next frame only while still short of the end.
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickRef.current = null;
    };
  }, [playing, state, durationMs]);

  // Stop playing the instant the playhead reaches the end (the rAF loop parks it
  // at T1; flip `playing` off so the transport shows Play and rAF unsubscribes).
  useEffect(() => {
    if (playing && durationMs > 0 && playheadT >= T1) {
      setPlaying(false);
    }
  }, [playing, playheadT, T1, durationMs]);

  // --- transport intent ---------------------------------------------------
  // SCRUB: continuous seek to an absolute ms instant. Pause first (a drag while
  // playing would otherwise fight the rAF clock), clamp into the window.
  const handleSeek = useCallback(
    (nextT: number) => {
      setPlaying(false);
      setPlayheadT(Math.max(T0, Math.min(nextT, T1)));
    },
    [T0, T1],
  );

  const togglePlay = useCallback(() => {
    if (durationMs === 0) {
      return;
    }
    // Restart from the beginning if we're parked at (or past) the end.
    setPlayheadT((cur) => (cur >= T1 ? T0 : cur));
    setPlaying((p) => !p);
  }, [durationMs, T0, T1]);

  const restart = useCallback(() => {
    setPlaying(false);
    setPlayheadT(T0);
  }, [T0]);

  // The bar is bottom-docked at every state: loading / empty / error show a
  // compact status row with a close button so the reviewer is never trapped
  // (there is no surrounding modal × to fall back on).
  if (state !== "ready") {
    return (
      <div className="mcm-replay mcm-replay--status-only">
        <div className="mcm-replay__status">
          {state === "loading" && (
            <>
              <span className="mcm-replay__spinner" /> {t("replay.loading")}
            </>
          )}
          {state === "error" && t("replay.error")}
          {state === "empty" && t("replay.empty")}
        </div>
        <button
          type="button"
          className="mcm-replay__btn mcm-replay__btn--close"
          onClick={onClose}
          aria-label={t("replay.exit")}
          title={t("replay.exit")}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="mcm-replay">
      <CanvasReplayTimeline
        T0={T0}
        T1={T1}
        playheadT={playheadT}
        durationMs={durationMs}
        playing={playing}
        speed={speed}
        onSeek={handleSeek}
        onTogglePlay={togglePlay}
        onRestart={restart}
        onSpeed={setSpeed}
        onClose={onClose}
        speakerTimeline={speakerTimeline}
      />
    </div>
  );
};

export default CanvasReplayPlayer;
