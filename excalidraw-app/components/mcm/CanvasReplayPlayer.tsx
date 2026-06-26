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
import { GripVertical, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useAtomValue } from "../../app-jotai";
import {
  type CanvasHistoryEntry,
  reconstructSceneAt,
} from "../../data/canvasHistory";
import { listRecordings, type Recording } from "../../data/recordings";
import { buildSpeakerTimeline } from "../../data/replayTimeline";
import { loadCanvasHistoryFromStorage } from "../../data/storage";
import { transcriptionLogAtom } from "../../data/transcription";
import { useT } from "../../i18n/mcm";

import { CanvasReplayTimeline, type ReplaySpeed } from "./CanvasReplayTimeline";
import { type ScreenWindow } from "./SpeakerLanes";
import { useReplayMedia } from "./useReplayMedia";

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

// ── SCREEN floating pane (§3, 06-25 refinement 3) ────────────────────────────
// A small, draggable <video> over the review canvas. The Screen LAYER is an
// independent toggle (not an exclusive mode), and the pane AUTO-SHOWS whenever
// the playhead is inside a window where screen was shared — so the reviewer sees
// the shared content without hunting for a control. It is NOT a self-controlled
// player: the media hook owns its currentTime / play / pause (driven by the
// shared playhead), so the element carries no `controls` — the transport below
// is the single source of control. The video itself is MUTED; the shared
// window's sound is its own `screen-audio` track (also bound to this layer). We
// only own the chrome: a drag handle (pointer-events) + a close that turns the
// Screen layer off. The element ref comes from the hook so the sync loop can
// drive it.
// Minimum pane size (px). Resizing clamps to these floors; the ceiling is the
// viewport edge (computed live so the pane can never grow off-screen).
const SCREEN_PANE_MIN_W = 220;
const SCREEN_PANE_MIN_H = 140;

const ScreenReplayPane = ({
  videoRef,
  src,
  loading,
  onClose,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string | null;
  loading: boolean;
  onClose: () => void;
}) => {
  const t = useT();
  // Pane size (viewport px). Resizable via the bottom-right grip; clamped to a
  // sensible MIN and a MAX that keeps it inside the viewport. Seeded to the old
  // fixed 360×202 (≈16:9) so the default look is unchanged.
  const [size, setSize] = useState<{ w: number; h: number }>(() => ({
    w: 360,
    h: 202,
  }));
  // Pane position (top-left, viewport px). Seeded once near the top-centre so it
  // doesn't cover the dock; dragging updates it. Clamped into the viewport so it
  // can never be dragged fully off-screen.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(16, Math.round(window.innerWidth / 2 - 180)),
    y: 84,
  }));
  // Always-fresh mirrors so the dep-free pointer callbacks read the LIVE pos/size
  // (drag clamps against the current width; resize anchors to the current
  // top-left) without re-binding handlers every render.
  const posRef = useRef(pos);
  posRef.current = pos;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // Resize grabs the offset from the pointer to the pane's bottom-right corner
  // so the corner tracks the cursor without jumping.
  const resizeRef = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [pos.x, pos.y],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      return;
    }
    // Clamp against the LIVE size (read via the size ref) so the pane stays fully
    // on-screen whatever it's been resized to.
    const { w } = sizeRef.current;
    const x = Math.min(
      Math.max(8, e.clientX - d.dx),
      Math.max(8, window.innerWidth - w - 8),
    );
    const y = Math.min(
      Math.max(8, e.clientY - d.dy),
      Math.max(8, window.innerHeight - 40),
    );
    setPos({ x, y });
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // --- RESIZE (bottom-right grip) — mirrors the drag pattern -----------------
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        dx: e.clientX - (pos.x + size.w),
        dy: e.clientY - (pos.y + size.h),
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [pos.x, pos.y, size.w, size.h],
  );
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) {
      return;
    }
    // Desired corner → desired size; clamp to [MIN, viewport-bound MAX] so the
    // pane can't grow off-screen (top-left stays put while resizing, so MAX =
    // viewport edge − top-left − 8px margin). Reads the live top-left via posRef.
    const { x, y } = posRef.current;
    const maxW = Math.max(SCREEN_PANE_MIN_W, window.innerWidth - x - 8);
    const maxH = Math.max(SCREEN_PANE_MIN_H, window.innerHeight - y - 8);
    const w = Math.min(Math.max(SCREEN_PANE_MIN_W, e.clientX - r.dx - x), maxW);
    const h = Math.min(Math.max(SCREEN_PANE_MIN_H, e.clientY - r.dy - y), maxH);
    setSize({ w, h });
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent) => {
    resizeRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <div
      className="mcm-replay__screen-pane"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      role="dialog"
      aria-label={t("replay.chooser.screen")}
    >
      <div
        className="mcm-replay__screen-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <GripVertical size={14} aria-hidden />
        <span className="mcm-replay__screen-title">
          {t("replay.chooser.screen")}
        </span>
        <button
          type="button"
          className="mcm-replay__screen-close"
          onClick={onClose}
          aria-label={t("replay.exit")}
          title={t("replay.exit")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="mcm-replay__screen-body">
        {loading && (
          <div className="mcm-replay__screen-loading">
            <span className="mcm-replay__spinner" /> {t("replay.loading")}
          </div>
        )}
        {/* No `controls`: the transport drives this element's time. MUTED —
            the shared window's sound is a separate `screen-audio` track (so it
            never double-plays); playsInline keeps it in the pane on mobile. */}
        <video
          ref={videoRef}
          className="mcm-replay__screen-video"
          src={src ?? undefined}
          preload="auto"
          muted
          playsInline
        />
      </div>
      {/* Bottom-right resize grip — pointer-captured, mirrors the drag handler.
          Decorative pointer affordance (the pane is sized by pointer, not
          keyboard), so it's aria-hidden + non-focusable rather than carrying a
          misleading duplicate label. */}
      <span
        className="mcm-replay__screen-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        aria-hidden
      />
    </div>
  );
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

  // ── P3 PLAY-ALONG state (06-25: ADDITIVE LAYERS, not an exclusive mode) ──
  // Canvas is ALWAYS the base. Audio + Screen are INDEPENDENT on/off layers
  // stacked on top — any subset is valid. Toggling a layer KEEPS playheadT (§3)
  // — no restart. With no recordings both stay off + disabled, so this is
  // byte-for-byte the canvas-only P1 behaviour. `soloId` isolates one speaker in
  // the Audio layer (null = mix everyone).
  const [audioOn, setAudioOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [soloId, setSoloId] = useState<string | null>(null);
  // AUTO-SHOW default: once we know the meeting has screen-video, default the
  // Screen layer ON so the reviewer sees shared content without hunting for a
  // toggle (06-25 refinement 3). Run-once per discovery; the user can still turn
  // it off, and we don't re-force it on every recordings refresh.
  const screenAutoDefaultedRef = useRef(false);
  // Recordings for this room (auth-gated; a non-authority reviewer gets [] →
  // chooser collapses to Canvas, lanes/transcript still work). Fetched once when
  // the room id is known; fail-soft ([]) so a hiccup never breaks the replay.
  const [recordings, setRecordings] = useState<Recording[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!roomId) {
      setRecordings([]);
      return;
    }
    void (async () => {
      const list = await listRecordings(roomId);
      if (!cancelled) {
        setRecordings(list);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Canvas-only span first, so we have a T0 to anchor legacy (null
  // started_at_ms) tracks before they widen the window. The media hook resolves
  // every track against THIS t0; we then fold its start/end candidates back in
  // to WIDEN [T0, T1] to cover media that begins before the first stroke or runs
  // past the last (computeReplayBounds(entries, { starts, ends })).
  const canvasBounds = useMemo(() => computeReplayBounds(entries), [entries]);

  // The play-along engine. With both layers off it builds nothing (layer-gated),
  // so this is inert until the reviewer toggles Audio/Screen. It still reports
  // capabilities + bounds candidates so the chooser knows what to offer, and
  // `screenInWindow` so we can auto-show the floating pane.
  const media = useReplayMedia({
    recordings,
    audioOn,
    screenOn,
    soloId,
    t0: canvasBounds.T0,
    playheadT,
    playing,
    speed,
  });

  // AUTO-SHOW (06-25 refinement 3): default the Screen layer ON the first time we
  // learn the meeting has any screen-video, so shared content appears for free.
  useEffect(() => {
    if (media.hasScreen && !screenAutoDefaultedRef.current) {
      screenAutoDefaultedRef.current = true;
      setScreenOn(true);
    }
  }, [media.hasScreen]);

  // [T0, T1] — the absolute-ms window the playhead travels. The canvas span
  // WIDENED by every media track's window so a mic that started before the first
  // stroke (or a screen-video running past the last) is fully reachable.
  const { T0, T1 } = useMemo(
    () =>
      computeReplayBounds(entries, {
        starts: media.bounds.starts,
        ends: media.bounds.ends,
      }),
    [entries, media.bounds],
  );
  const durationMs = Math.max(0, T1 - T0);
  const t1Ref = useRef(T1);
  t1Ref.current = T1;

  // RECONNECT-LANE-SPLIT FIX: map a transcript segment to the SAME stable
  // identity the recording panel groups by — the authenticated email
  // (`speaker_id`) — so a person who left + rejoined (new socketId per
  // connection) is ONE lane, not several. The live peer atom is empty at replay
  // time (those peers are gone), so the only identity source that survives a
  // FINISHED meeting is the recordings list: each `mic` row carries
  // `speaker_id` (email) + `speaker_name` (the display name the speaker joined
  // with — the SAME value the transcript stamps as `username`, both server-
  // sourced from the meeting_participant row). We build a display-name→email map
  // from those rows and resolve each segment by its `username`. Unmatched
  // segments (STT but no mic recording, or anonymous link-joins) fall back to
  // socketId inside buildSpeakerTimeline — exactly today's behaviour.
  //
  // Names are normalised (trim + lower-case) to absorb cosmetic casing/spacing
  // differences. Display-name collisions (two distinct people, same name) would
  // merge — but the recording panel's own grouping (`speaker_name||speaker_id`)
  // has the identical limitation, so the replay stays CONSISTENT with it.
  const speakerIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of recordings) {
      if ((r.kind ?? "mixed") !== "mic" || r.status !== "ready") {
        continue; // only per-speaker mic rows carry a (name, email) identity
      }
      const email = r.speaker_id?.trim().toLowerCase();
      const name = r.speaker_name?.trim().toLowerCase();
      if (email && name && !map.has(name)) {
        map.set(name, email);
      }
    }
    return map;
  }, [recordings]);

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
    () =>
      buildSpeakerTimeline(transcriptLog, {
        // Resolve to the stable email when a matching mic recording exists; an
        // empty map (no recordings / non-authority viewer) makes every segment
        // fall back to socketId, i.e. the canvas-only behaviour is unchanged.
        resolveIdentity: (seg) =>
          speakerIdByName.get((seg.username ?? "").trim().toLowerCase()),
      }),
    [transcriptLog, speakerIdByName],
  );

  // SCREEN LANE (06-25 #28b): the shared-screen windows for the dedicated lane in
  // the timeline strip. Each screen-video track is one window [startMs, endMs] on
  // the SAME [T0, T1] x-axis the speaker lanes + scrubber use. This is content,
  // not a speaker — rendered with a monitor icon + neutral tint, NOT a
  // personColor. Clicking a block seeks to that window's start (handleSeek).
  // Empty when no screen was shared → the lane simply doesn't render.
  const screenWindows = useMemo<ScreenWindow[]>(
    () =>
      media.screenTracks.map((tr) => ({
        startMs: tr.startMs,
        endMs: tr.endMs,
      })),
    [media.screenTracks],
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

  // CHOOSER (§3, additive): toggle the Audio / Screen layers independently. Keep
  // playheadT (no restart); the media hook tears down / builds + seeks the layer's
  // elements to the current playhead and resumes if we were playing. Turning the
  // Audio layer off drops any solo so it doesn't silently apply when re-enabled.
  const toggleAudio = useCallback(() => {
    setAudioOn((on) => {
      if (on) {
        setSoloId(null);
      }
      return !on;
    });
  }, []);
  const toggleScreen = useCallback(() => {
    setScreenOn((on) => !on);
  }, []);

  // P3 SEAM (SpeakerLanes onSoloSpeaker): clicking a speaker name solos that
  // mic. Toggle off when the same speaker is clicked again. A solo click ensures
  // the Audio layer is on (the reviewer clearly wants to hear that person),
  // keeping the playhead where it is.
  const handleSolo = useCallback((speakerId: string) => {
    setAudioOn(true);
    setSoloId((cur) => (cur === speakerId ? null : speakerId));
  }, []);

  // The bar is bottom-docked at every state: loading / empty / error show a
  // compact status row with a close button so the reviewer is never trapped
  // (there is no surrounding modal × to fall back on).
  //
  // PORTAL TO <body> (06-25 fix): the `.mcm-replay-dock` mount point lives INSIDE
  // <header.mcm-header>, and the dock is `position: fixed` (bottom-anchored). A
  // fixed element only anchors to the VIEWPORT when no ancestor is a containing
  // block — but the Glass Desk header is a glass-family surface that can carry
  // `backdrop-filter`/`transform`, EITHER of which makes the header the containing
  // block for the fixed dock. `bottom: 18px` then resolves against the HEADER's
  // box, slamming the bar UP over the header (the reported overlap). We escape the
  // header by rendering the whole dock under <body> — exactly what ScreenReplayPane
  // already does (same root cause). The `.mcm-replay-dock` div in MeetingHeader is
  // now just an (empty) React host; the visible, viewport-anchored bar lives here.
  const dockBar = (children: React.ReactNode) =>
    createPortal(
      <div className="mcm-replay-dock" role="region" aria-label={t("header.replay")}>
        {children}
      </div>,
      document.body,
    );

  if (state !== "ready") {
    return dockBar(
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
      </div>,
    );
  }

  return dockBar(
    <div className="mcm-replay">
      {/* Screen layer: a small draggable floating <video> over the canvas. The
          Screen toggle gates its blob (fetch/revoke in the hook); the pane only
          APPEARS when the playhead is inside a screen-share window (auto-show /
          auto-hide). Its currentTime is driven by the same playhead via the media
          hook's ref; the shared window's sound plays via the separate
          screen-audio track. Closing the pane turns the Screen layer off. */}
      {screenOn &&
        media.hasScreen &&
        media.screenInWindow &&
        // Portal to <body> so the floating pane ESCAPES the dock: the dock is
        // position:fixed WITH transform: translateX(-50%) + overflow:hidden, and
        // a fixed child of a TRANSFORMED ancestor is positioned relative to that
        // ancestor (not the viewport) — which trapped the pane inside the dock.
        // On <body> it floats freely over the whole page, draggable anywhere.
        createPortal(
          <ScreenReplayPane
            videoRef={media.screenVideoRef}
            src={media.screenUrl}
            loading={media.screenLoading}
            onClose={() => setScreenOn(false)}
          />,
          document.body,
        )}

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
        screenWindows={screenWindows}
        onSoloSpeaker={handleSolo}
        audioOn={audioOn}
        screenOn={screenOn}
        onToggleAudio={toggleAudio}
        onToggleScreen={toggleScreen}
        canAudio={media.hasAudio}
        canScreen={media.hasScreen}
        soloId={soloId}
        legacyMedia={media.hasLegacy}
      />
    </div>,
  );
};

export default CanvasReplayPlayer;
