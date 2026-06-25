// CANVAS REPLAY — transport UI (play/pause, restart, scrubber, speed, exit).
//
// Pure presentational control bar. It owns no playback or canvas state: the
// parent (CanvasReplayPlayer) holds the ABSOLUTE-MS playhead clock and drives
// the EXISTING review canvas via excalidrawAPI.updateScene. This component only
// renders the controls and reports user intent back through callbacks. It is
// rendered as a single bottom-docked bar floating over the review canvas (no
// modal shell), so the reviewer always sees the board evolve behind it while
// scrubbing.
//
// ── SHARED CLOCK INTERFACE (unified-replay-ux.md §1, §6) ──────────────────────
// The transport reads/drives the SAME absolute-ms playhead bundle (`ReplayClock`
// below) that P2 (SpeakerLanes — a row sharing this exact x-axis) and P3 (media
// elements seeking to `playheadT`) will consume. Keeping the scrubber on a
// continuous `[T0, T1]` ms range (NOT a list of stop indices) is what lets a
// lane strip line up a vertical playhead with this scrubber pixel-for-pixel: the
// fraction is always `(playheadT - T0) / (T1 - T0)`.

import {
  Headphones,
  MonitorPlay,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  X,
} from "lucide-react";

import { useT } from "../../i18n/mcm";

import { SpeakerLanes } from "./SpeakerLanes";

import type { ReplayMediaMode } from "./useReplayMedia";
import type { SpeakerTimelineModel } from "../../data/replayTimeline";

// Playback speeds offered in the toolbar. The playhead advances by real elapsed
// wall time × speed (a continuous rAF clock), so these scale wall-clock pace.
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = typeof REPLAY_SPEEDS[number];

// ── ReplayClock: the play-state bundle P2/P3 plug into ────────────────────────
// CanvasReplayPlayer lifts this and hands it down. P2's SpeakerLanes and P3's
// media hook receive the SAME shape (or a read-only subset) so every surface is
// driven by one playhead on one absolute-ms axis. Times are EPOCH MS.
export type ReplayClock = {
  /** window start (epoch ms) — first reachable instant; widen-able by P3 */
  T0: number;
  /** window end (epoch ms) — last reachable instant; widen-able by P3 */
  T1: number;
  /** the single playhead instant (epoch ms), T0..T1 */
  playheadT: number;
  /** T1 - T0 (ms); 0 when there is nothing to play (guards divide-by-zero) */
  durationMs: number;
  /** true while the rAF clock is advancing the playhead */
  playing: boolean;
  /** current playback rate multiplier */
  speed: ReplaySpeed;
  /** seek to an absolute instant (epoch ms); pauses + clamps to [T0, T1] */
  onSeek: (t: number) => void;
  /** start/stop the rAF clock (restarts from T0 if parked at the end) */
  onTogglePlay: () => void;
  /** seek back to T0 and pause */
  onRestart: () => void;
  /** change the playback rate */
  onSpeed: (speed: ReplaySpeed) => void;
};

const fmtClock = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const CanvasReplayTimeline = ({
  T0,
  T1,
  playheadT,
  durationMs,
  playing,
  speed,
  onSeek,
  onTogglePlay,
  onRestart,
  onSpeed,
  onClose,
  speakerTimeline,
  onSoloSpeaker,
  mode = "canvas",
  onMode,
  canAudio = false,
  canScreen = false,
  soloId = null,
  legacyMedia = false,
}: ReplayClock & {
  /** Exit replay — restores the static finished-meeting view. */
  onClose: () => void;
  /** P2: the "who spoke when" model (built from the transcript by the parent).
   *  Renders the collapsible SpeakerLanes strip under the transport when there
   *  is anything to show; omit / empty → transport stays a single row. */
  speakerTimeline?: SpeakerTimelineModel;
  /** P3 seam — solo a speaker's audio. Threaded straight to SpeakerLanes. */
  onSoloSpeaker?: (speakerId: string) => void;
  // ── P3 "Play along" chooser (unified-replay-ux.md §3) ──────────────────
  /** which media plays alongside the canvas (parent-owned). */
  mode?: ReplayMediaMode;
  /** switch the play-along mode (keeps the playhead). */
  onMode?: (mode: ReplayMediaMode) => void;
  /** enable the Audio segment — true only when a mic / screen-audio row exists. */
  canAudio?: boolean;
  /** enable the Screen segment — true only when a screen-video row exists. */
  canScreen?: boolean;
  /** the soloed speaker id (audio mode), for an "× clear solo" affordance. */
  soloId?: string | null;
  /** any media track placed by the legacy null-started_at_ms fallback — surfaces
   *  an "approximate sync" hint so a reviewer isn't surprised by the offset. */
  legacyMedia?: boolean;
}) => {
  const t = useT();
  if (durationMs <= 0) {
    return null;
  }
  // The chooser only appears when there is SOMETHING to play along (a mic or a
  // screen-video). A canvas-only meeting / non-authority viewer ([] recordings)
  // → no chooser at all, i.e. the transport is exactly the P1 single mode.
  const hasMedia = canAudio || canScreen;
  // Clamp for display so a parked / mid-load playhead never overflows the range.
  const curTs = Math.max(T0, Math.min(playheadT, T1));

  return (
    <div className="mcm-replay__transport">
      <div className="mcm-replay__controls">
        <button
          type="button"
          className="mcm-replay__btn mcm-replay__btn--play"
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

        {/* Continuous absolute-ms scrubber over [T0, T1]. A fine step keeps the
            drag smooth without re-introducing keyframe stops; the canvas stays a
            step function via the parent's keyframe-index guard. P2's lane strip
            aligns to this exact range. */}
        {/* eslint-disable-next-line react/forbid-elements */}
        <input
          className="mcm-replay__scrubber"
          type="range"
          min={T0}
          max={T1}
          step={Math.max(1, Math.round(durationMs / 1000))}
          value={curTs}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label={t("replay.scrubAria")}
        />

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

        {/* P3 "Play along" chooser (§3). Canvas is always present; Audio /
            Screen appear only when the meeting has that media (and the viewer is
            authorised — non-authority → [] recordings → neither flag set, so
            this collapses to a lone Canvas segment, i.e. P1 behaviour). Switching
            keeps the playhead — the parent rebuilds + reseeks the media. */}
        {hasMedia && onMode && (
          <div
            className="mcm-replay__along"
            role="group"
            aria-label={t("replay.chooser.label")}
          >
            <button
              type="button"
              className={`mcm-replay__along-seg${
                mode === "canvas" ? " mcm-replay__along-seg--active" : ""
              }`}
              onClick={() => onMode("canvas")}
              title={t("replay.chooser.canvas")}
              aria-pressed={mode === "canvas" ? "true" : "false"}
            >
              <PenLine size={14} />
              <span className="mcm-replay__along-text">
                {t("replay.chooser.canvas")}
              </span>
            </button>
            <button
              type="button"
              className={`mcm-replay__along-seg${
                mode === "audio" ? " mcm-replay__along-seg--active" : ""
              }`}
              onClick={() => onMode("audio")}
              disabled={!canAudio}
              title={t("replay.chooser.audio")}
              aria-pressed={mode === "audio" ? "true" : "false"}
            >
              <Headphones size={14} />
              <span className="mcm-replay__along-text">
                {t("replay.chooser.audio")}
              </span>
            </button>
            <button
              type="button"
              className={`mcm-replay__along-seg${
                mode === "screen" ? " mcm-replay__along-seg--active" : ""
              }`}
              onClick={() => onMode("screen")}
              disabled={!canScreen}
              title={t("replay.chooser.screen")}
              aria-pressed={mode === "screen" ? "true" : "false"}
            >
              <MonitorPlay size={14} />
              <span className="mcm-replay__along-text">
                {t("replay.chooser.screen")}
              </span>
            </button>
          </div>
        )}

        {/* Exit replay — the only "close" affordance now that the bar floats
            directly over the canvas (no modal chrome to host a × button). */}
        <button
          type="button"
          className="mcm-replay__btn mcm-replay__btn--close"
          onClick={onClose}
          aria-label={t("replay.exit")}
          title={t("replay.exit")}
        >
          <X size={16} />
        </button>
      </div>

      <div className="mcm-replay__hint">
        {t("replay.spanLabel")} {fmtClock(T0)} → {fmtClock(T1)}
        {legacyMedia && mode !== "canvas" && (
          <span
            className="mcm-replay__approx"
            title={t("replay.approxSyncHint")}
          >
            {" · "}
            {t("replay.approxSync")}
          </span>
        )}
      </div>

      {/* SOLO chip — only in audio mode with a speaker soloed. Shows who is
          isolated + a one-click clear (re-solo'ing the same name in the lanes
          also clears it). Keeps the "only this person" state visible so a
          reviewer never wonders why they hear one voice. */}
      {mode === "audio" && soloId && onSoloSpeaker && (
        <div className="mcm-replay__solo">
          <span className="mcm-replay__solo-label">
            {t("replay.soloOnly", {
              name:
                speakerTimeline?.speakers.find((s) => s.id === soloId)?.name ??
                soloId,
            })}
          </span>
          <button
            type="button"
            className="mcm-replay__solo-clear"
            onClick={() => onSoloSpeaker(soloId)}
            title={t("replay.soloClear")}
            aria-label={t("replay.soloClear")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* P2 — "who spoke when" lane strip. Collapsed to nothing by default; the
          chevron inside opts into depth. Shares this transport's exact [T0, T1]
          x-axis so its playhead lines up with the scrubber. */}
      {speakerTimeline && speakerTimeline.speakerCount > 0 && (
        <SpeakerLanes
          clock={{
            T0,
            T1,
            playheadT,
            durationMs,
            playing,
            speed,
            onSeek,
            onTogglePlay,
            onRestart,
            onSpeed,
          }}
          model={speakerTimeline}
          onSoloSpeaker={onSoloSpeaker}
        />
      )}
    </div>
  );
};

export default CanvasReplayTimeline;
