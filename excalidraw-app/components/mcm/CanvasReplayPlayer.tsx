// CANVAS REPLAY — review-mode player. Shown inside the finished-meeting review
// (MeetingLogModal "Replay" tab). Loads the E2E canvas-history blob (the
// time-ordered, delta-encoded log of how the whiteboard evolved), decrypts it
// with the room key the reviewer already holds, and lets them SCRUB / play back
// the canvas evolution — a vector timeline of the whiteboard, NOT a video.
//
// NATIVE PLAYER (no second <Excalidraw>): the previous version mounted its own
// review Excalidraw, which spawned phantom guests, a reload loop, and no working
// scrub. This version drives the EXISTING review-mode canvas (the one already on
// screen behind the modal) imperatively, via the live `excalidrawAPI`:
//
//   reconstructSceneAt(entries, T) -> restoreElements -> excalidrawAPI.updateScene
//
// Review is read-only / viewOnly, so `updateScene({ elements })` replaces the
// scene LOCALLY and never re-broadcasts (Collab.syncElements is gated off in
// review; updateScene itself does not broadcast). We snapshot the real review
// scene on entry and RESTORE it on exit, so scrubbing never leaves the canvas
// stuck at a replay frame. A "peek" toggle collapses the modal to a floating
// control bar so the reviewer can watch the canvas behind it.
//
// E2E (MVP): only a client with the room key can decrypt + replay. The server
// never reads the blob. A server-readable variant for AI / leadership is a later
// option tied to the event-log.

import {
  CaptureUpdateAction,
  restoreElements,
} from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  type CanvasHistoryEntry,
  historyTimeline,
  reconstructSceneAt,
} from "../../data/canvasHistory";
import { loadCanvasHistoryFromStorage } from "../../data/storage";
import { useT } from "../../i18n/mcm";

import {
  CanvasReplayTimeline,
  type ReplaySpeed,
} from "./CanvasReplayTimeline";

import "./CanvasReplay.scss";

// Wall-clock ms between keyframe stops at 1× during playback.
const STEP_MS_AT_1X = 900;

// Body class that collapses the log modal to a floating control bar so the
// canvas being replayed (behind the modal) is visible. Styled in CanvasReplay.scss.
const PEEK_BODY_CLASS = "mcm-replay-peek";

type LoadState = "loading" | "empty" | "ready" | "error";

export const CanvasReplayPlayer = ({
  roomId,
  roomKey,
  excalidrawAPI,
}: {
  roomId: string | null;
  roomKey: string | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const t = useT();
  const [entries, setEntries] = useState<CanvasHistoryEntry[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // Index into the timeline of keyframe stops (0..entries.length-1).
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [peeking, setPeeking] = useState(false);
  // The real review scene as it was when the Replay tab opened — restored on
  // exit so scrubbing never permanently clobbers the canvas the reviewer sees.
  const originalSceneRef = useRef<readonly ExcalidrawElement[] | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const timeline = useMemo(() => historyTimeline(entries), [entries]);

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
        setIdx(sorted.length - 1); // start fully built (last frame)
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
  // can put it back when the reviewer leaves the Replay tab. updateScene with
  // CaptureUpdateAction.NEVER keeps these swaps out of the undo stack.
  useEffect(() => {
    if (!excalidrawAPI || state !== "ready") {
      return;
    }
    if (originalSceneRef.current === null) {
      originalSceneRef.current = excalidrawAPI.getSceneElementsIncludingDeleted();
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

  // --- render the reconstructed scene at the scrubbed stop ----------------
  // Drive the EXISTING review canvas: fold the deltas up to the stop's
  // timestamp, run them through restoreElements (fills defaults / drops invalid
  // so arbitrary persisted elements are safe), and push them imperatively.
  // Read-only review — updateScene replaces locally and never re-broadcasts.
  const renderAt = useCallback(
    (stopIdx: number) => {
      const api = excalidrawAPI;
      if (!api || timeline.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(stopIdx, timeline.length - 1));
      const t0 = timeline[clamped];
      const raw = reconstructSceneAt(entries, t0);
      const elements = restoreElements(raw, null, {
        deleteInvisibleElements: true,
      });
      api.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    [entries, excalidrawAPI, timeline],
  );

  // Fit-to-content ONCE on first paint so the reviewer sees the whole board.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (state !== "ready" || !excalidrawAPI || timeline.length === 0) {
      return;
    }
    renderAt(idx);
    if (!fittedRef.current) {
      fittedRef.current = true;
      try {
        const built = restoreElements(
          reconstructSceneAt(entries, timeline[timeline.length - 1]),
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
    // idx + renderAt cover re-render on every scrub / playback step.
  }, [idx, renderAt, state, excalidrawAPI, timeline, entries]);

  // --- playback loop ------------------------------------------------------
  useEffect(() => {
    if (!playing || timeline.length === 0) {
      return;
    }
    if (idx >= timeline.length - 1) {
      setPlaying(false);
      return;
    }
    playTimerRef.current = setTimeout(() => {
      setIdx((prev) => Math.min(prev + 1, timeline.length - 1));
    }, STEP_MS_AT_1X / speed);
    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [playing, idx, speed, timeline.length]);

  // --- peek: collapse the modal so the canvas behind is visible -----------
  useEffect(() => {
    if (peeking) {
      document.body.classList.add(PEEK_BODY_CLASS);
    } else {
      document.body.classList.remove(PEEK_BODY_CLASS);
    }
    return () => document.body.classList.remove(PEEK_BODY_CLASS);
  }, [peeking]);

  const handleScrub = useCallback((next: number) => {
    setPlaying(false);
    setIdx(next);
  }, []);

  const togglePlay = useCallback(() => {
    if (timeline.length === 0) {
      return;
    }
    // Auto-peek when playback starts so the reviewer sees the canvas evolve.
    setPeeking(true);
    // Restart from the beginning if we're parked at the end.
    setIdx((prev) => (prev >= timeline.length - 1 ? 0 : prev));
    setPlaying((p) => !p);
  }, [timeline.length]);

  const restart = useCallback(() => {
    setPlaying(false);
    setIdx(0);
  }, []);

  if (state === "loading") {
    return (
      <div className="mcm-replay__status">
        <span className="mcm-log-modal__spinner" /> {t("replay.loading")}
      </div>
    );
  }
  if (state === "error") {
    return <div className="mcm-replay__status">{t("replay.error")}</div>;
  }
  if (state === "empty") {
    return <div className="mcm-replay__status">{t("replay.empty")}</div>;
  }

  return (
    <div className="mcm-replay">
      <p className="mcm-replay__lead">{t("replay.lead")}</p>
      <CanvasReplayTimeline
        timeline={timeline}
        idx={idx}
        playing={playing}
        speed={speed}
        peeking={peeking}
        onScrub={handleScrub}
        onTogglePlay={togglePlay}
        onRestart={restart}
        onSpeed={setSpeed}
        onTogglePeek={() => setPeeking((p) => !p)}
      />
    </div>
  );
};

export default CanvasReplayPlayer;
