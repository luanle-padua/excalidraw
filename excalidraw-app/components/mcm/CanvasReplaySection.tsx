// CANVAS REPLAY — review-mode surface. Shown inside the finished-meeting review
// (MeetingLogModal "Replay" tab). Loads the E2E canvas-history blob (the
// time-ordered, delta-encoded log of how the whiteboard evolved), decrypts it
// with the room key the reviewer already holds, and lets them SCRUB / play back
// the canvas evolution in a read-only Excalidraw instance — a vector timeline of
// the whiteboard, NOT a video.
//
// E2E (MVP): only a client with the room key can decrypt + replay. The server
// never reads the blob. A server-readable variant for AI / leadership is a later
// option tied to the event-log.
//
// RENDER: a standalone read-only <Excalidraw> (viewModeEnabled). We reconstruct
// the scene at the scrubbed time T by folding the deltas up to T
// (reconstructSceneAt), run them through restoreElements so arbitrary persisted
// elements are safe to render, and push them via the imperative updateScene. We
// fit-to-content once on first paint so the reviewer sees the whole board.

import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  type CanvasHistoryEntry,
  historyTimeline,
  reconstructSceneAt,
} from "../../data/canvasHistory";
import { loadCanvasHistoryFromStorage } from "../../data/storage";
import { useT } from "../../i18n/mcm";

// Playback speeds offered in the toolbar. 1× walks the real keyframe stops at a
// fixed cadence (replay is a sequence of stops, not real-time wall-clock).
const SPEEDS = [0.5, 1, 2, 4] as const;
// Wall-clock ms between keyframe stops at 1× during playback.
const STEP_MS_AT_1X = 900;

const fmtClock = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

type LoadState = "loading" | "empty" | "ready" | "error";

export const CanvasReplaySection = ({
  roomId,
  roomKey,
}: {
  roomId: string | null;
  roomKey: string | null;
}) => {
  const t = useT();
  const [entries, setEntries] = useState<CanvasHistoryEntry[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // Index into the timeline of keyframe stops (0..entries.length-1).
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<typeof SPEEDS[number]>(1);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const fittedRef = useRef(false);
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

  // --- render the reconstructed scene at the scrubbed stop ----------------
  const renderAt = useCallback(
    (stopIdx: number) => {
      const api = apiRef.current;
      if (!api || timeline.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(stopIdx, timeline.length - 1));
      const t0 = timeline[clamped];
      const raw = reconstructSceneAt(entries, t0);
      // restoreElements makes arbitrary persisted elements safe to render
      // (fills defaults, drops invalid). Read-only — we never write back.
      const elements = restoreElements(raw, null, {
        deleteInvisibleElements: true,
      });
      api.updateScene({ elements });
      if (!fittedRef.current && elements.length > 0) {
        fittedRef.current = true;
        try {
          api.scrollToContent(elements, { fitToContent: true });
        } catch {
          /* fit is best-effort */
        }
      }
    },
    [entries, timeline],
  );

  // Re-render whenever the scrub index changes or the API mounts.
  useEffect(() => {
    renderAt(idx);
  }, [idx, renderAt]);

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

  const togglePlay = () => {
    if (timeline.length === 0) {
      return;
    }
    // Restart from the beginning if we're parked at the end.
    if (!playing && idx >= timeline.length - 1) {
      setIdx(0);
    }
    setPlaying((p) => !p);
  };

  const restart = () => {
    setPlaying(false);
    setIdx(0);
  };

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

  const startTs = timeline[0];
  const curTs = timeline[Math.min(idx, timeline.length - 1)];

  return (
    <div className="mcm-replay">
      <div className="mcm-replay__stage">
        <Excalidraw
          onExcalidrawAPI={(api) => {
            apiRef.current = api;
            // initial paint once the API is live
            renderAt(idx);
          }}
          viewModeEnabled
          // No collaboration, no UI chrome we don't need — this is a passive
          // viewer over a reconstructed snapshot.
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              saveAsImage: false,
            },
          }}
        />
      </div>

      <div className="mcm-replay__controls">
        <button
          type="button"
          className="mcm-replay__btn"
          onClick={togglePlay}
          aria-label={playing ? t("replay.pause") : t("replay.play")}
          title={playing ? t("replay.pause") : t("replay.play")}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="mcm-replay__btn"
          onClick={restart}
          aria-label={t("replay.restart")}
          title={t("replay.restart")}
        >
          <RotateCcw size={16} />
        </button>

        <span className="mcm-replay__time">{fmtClock(curTs)}</span>

        {/* eslint-disable-next-line react/forbid-elements */}
        <input
          className="mcm-replay__scrubber"
          type="range"
          min={0}
          max={Math.max(0, timeline.length - 1)}
          step={1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          aria-label={t("replay.scrubAria")}
        />

        <span className="mcm-replay__meta">
          {t("replay.stepOf", {
            cur: Math.min(idx + 1, timeline.length),
            total: timeline.length,
          })}
        </span>

        <div
          className="mcm-replay__speeds"
          role="group"
          aria-label={t("replay.speed")}
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`mcm-replay__speed${
                speed === s ? " mcm-replay__speed--active" : ""
              }`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="mcm-replay__hint">
        {t("replay.spanLabel")} {fmtClock(startTs)} →{" "}
        {fmtClock(timeline[timeline.length - 1])}
      </div>
    </div>
  );
};

export default CanvasReplaySection;
