// CANVAS REPLAY — transport UI (play/pause, restart, scrubber, speed, span).
//
// Pure presentational control bar. It owns no playback or canvas state: the
// parent (CanvasReplayPlayer) holds the timeline + index and drives the EXISTING
// review canvas via excalidrawAPI.updateScene. This component only renders the
// controls and reports user intent back through callbacks, so the same bar can
// sit inside the modal body or float over a peeked-back canvas.

import { Eye, EyeOff, Pause, Play, RotateCcw } from "lucide-react";

import { useT } from "../../i18n/mcm";

// Playback speeds offered in the toolbar. 1× walks the real keyframe stops at a
// fixed cadence (replay is a sequence of stops, not real-time wall-clock).
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

const fmtClock = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const CanvasReplayTimeline = ({
  timeline,
  idx,
  playing,
  speed,
  peeking,
  onScrub,
  onTogglePlay,
  onRestart,
  onSpeed,
  onTogglePeek,
}: {
  /** ascending capture timestamps (the scrubber's keyframe stops) */
  timeline: number[];
  /** current stop index (0..timeline.length-1) */
  idx: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** whether the modal is collapsed so the live canvas behind is visible */
  peeking: boolean;
  onScrub: (idx: number) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onTogglePeek: () => void;
}) => {
  const t = useT();
  if (timeline.length === 0) {
    return null;
  }
  const startTs = timeline[0];
  const endTs = timeline[timeline.length - 1];
  const curTs = timeline[Math.min(idx, timeline.length - 1)];

  return (
    <div className="mcm-replay__transport">
      <div className="mcm-replay__controls">
        <button
          type="button"
          className="mcm-replay__btn"
          onClick={onTogglePlay}
          aria-label={playing ? t("replay.pause") : t("replay.play")}
          title={playing ? t("replay.pause") : t("replay.play")}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="mcm-replay__btn"
          onClick={onRestart}
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
          onChange={(e) => onScrub(Number(e.target.value))}
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
          {REPLAY_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`mcm-replay__speed${
                speed === s ? " mcm-replay__speed--active" : ""
              }`}
              onClick={() => onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>

        <button
          type="button"
          className="mcm-replay__btn mcm-replay__btn--peek"
          onClick={onTogglePeek}
          aria-label={peeking ? t("replay.hideCanvas") : t("replay.showCanvas")}
          title={peeking ? t("replay.hideCanvas") : t("replay.showCanvas")}
        >
          {peeking ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>

      <div className="mcm-replay__hint">
        {t("replay.spanLabel")} {fmtClock(startTs)} → {fmtClock(endTs)}
      </div>
    </div>
  );
};

export default CanvasReplayTimeline;
