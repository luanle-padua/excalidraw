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

import { SpeakerLanes, type ScreenWindow } from "./SpeakerLanes";

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
  screenWindows,
  onSoloSpeaker,
  audioOn = false,
  screenOn = false,
  onToggleAudio,
  onToggleScreen,
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
  /** #28b — the shared-screen windows (screen-video tracks) for the dedicated
   *  SCREEN lane in the strip. Empty / omitted → no screen lane. */
  screenWindows?: readonly ScreenWindow[];
  /** P3 seam — solo a speaker's audio. Threaded straight to SpeakerLanes. */
  onSoloSpeaker?: (speakerId: string) => void;
  // ── P3 "Play along" chooser (unified-replay-ux.md §3, 06-25 additive) ───
  // Canvas is ALWAYS on (a static label). Audio + Screen are INDEPENDENT
  // toggles ADDED on top — any subset can be on at once.
  /** is the Audio layer (per-speaker mics) on? (parent-owned). */
  audioOn?: boolean;
  /** is the Screen layer (screen-video + screen-audio) on? (parent-owned). */
  screenOn?: boolean;
  /** toggle the Audio layer (keeps the playhead). */
  onToggleAudio?: () => void;
  /** toggle the Screen layer (keeps the playhead). */
  onToggleScreen?: () => void;
  /** enable the Audio chip — true only when a mic (or legacy mixed) row exists. */
  canAudio?: boolean;
  /** enable the Screen chip — true only when a screen-video row exists. */
  canScreen?: boolean;
  /** the soloed speaker id (audio layer), for an "× clear solo" affordance. */
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

        {/* "Play along" chooser (§3, 06-25 additive layers). Canvas is ALWAYS
            on — shown as a static label, no toggle. Audio + Screen are
            INDEPENDENT on/off chips ADDED on top, each enabled only when the
            meeting has that media (and the viewer is authorised — non-authority
            → [] recordings → neither flag set, so the chooser disappears and the
            transport is exactly the canvas-only behaviour). Toggling a chip keeps
            the playhead — the parent rebuilds + reseeks that layer's media. */}
        {hasMedia && (onToggleAudio || onToggleScreen) && (
          <div
            className="mcm-replay__along"
            role="group"
            aria-label={t("replay.chooser.label")}
          >
            {/* Canvas is the always-on base — a static label, never toggled. */}
            <span
              className="mcm-replay__along-base"
              title={t("replay.chooser.canvasAlways")}
            >
              <PenLine size={14} />
              <span className="mcm-replay__along-text">
                {t("replay.chooser.canvas")}
              </span>
            </span>
            <button
              type="button"
              className={`mcm-replay__along-chip${
                audioOn ? " mcm-replay__along-chip--on" : ""
              }`}
              onClick={onToggleAudio}
              disabled={!canAudio || !onToggleAudio}
              title={t("replay.chooser.audio")}
              aria-pressed={audioOn}
            >
              <Headphones size={14} />
              <span className="mcm-replay__along-text">
                {t("replay.chooser.audio")}
              </span>
            </button>
            <button
              type="button"
              className={`mcm-replay__along-chip${
                screenOn ? " mcm-replay__along-chip--on" : ""
              }`}
              onClick={onToggleScreen}
              disabled={!canScreen || !onToggleScreen}
              title={t("replay.chooser.screen")}
              aria-pressed={screenOn}
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
        {legacyMedia && (audioOn || screenOn) && (
          <span
            className="mcm-replay__approx"
            title={t("replay.approxSyncHint")}
          >
            {" · "}
            {t("replay.approxSync")}
          </span>
        )}
      </div>

      {/* SOLO chip — only while the Audio layer is on with a speaker soloed.
          Shows who is isolated + a one-click clear (re-solo'ing the same name in
          the lanes also clears it). Keeps the "only this person" state visible so
          a reviewer never wonders why they hear one voice. */}
      {audioOn && soloId && onSoloSpeaker && (
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

      {/* P2 — "who spoke when" lane strip + #28b SHARED-SCREEN lane. Collapsed to
          nothing by default; the chevron inside opts into depth. Shares this
          transport's exact [T0, T1] x-axis so its playhead lines up with the
          scrubber. Renders when there are speakers OR a shared-screen window (a
          screen-only meeting still gets the strip so the screen lane is visible). */}
      {((speakerTimeline && speakerTimeline.speakerCount > 0) ||
        (screenWindows && screenWindows.length > 0)) && (
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
          model={
            speakerTimeline ?? {
              speakers: [],
              transcriptT0: 0,
              transcriptT1: 0,
              speakerCount: 0,
            }
          }
          screenWindows={screenWindows}
          onSoloSpeaker={onSoloSpeaker}
        />
      )}
    </div>
  );
};

export default CanvasReplayTimeline;
