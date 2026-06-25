// SPEAKER LANES — the "who spoke when" strip (unified-replay-ux.md §2, §2.1).
//
// A COMPACT lane strip that lives UNDER the replay transport and shares its
// EXACT x-axis: every block is positioned by `(ms - T0) / (T1 - T0)`, the same
// fraction the transport scrubber uses, so the single vertical playhead lines up
// pixel-for-pixel across the transport and these lanes. Driven entirely from the
// transcript (the `SpeakerTimelineModel` the parent builds) — it works with NO
// recordings (audio is P3). Clicking a block or a lane seeks the shared clock.
//
// COLLAPSED BY DEFAULT (§1 "đừng lố quá"): the whole strip is hidden behind a
// chevron — opening the replay shows just the transport row, exactly as today.
// Expanding is opt-in and remembers nothing (per-session, intentionally simple).
//
// MANY-PEOPLE (§2.1):
//   • ≤ RIBBON_THRESHOLD speakers  → straight per-speaker lanes (thin rows).
//   • >  RIBBON_THRESHOLD speakers → default to ONE "conversation ribbon"
//     (each block tinted by the current speaker → turn-taking at a glance;
//     overlaps striped). A secondary toggle expands to per-speaker lanes:
//     top-N + one aggregated "Người khác (k)" lane; clicking that opens the
//     full scrollable list with sticky left names. The strip caps at ~40vh and
//     scrolls internally; the canvas stays interactive behind it.
//
// P3 SEAM — SOLO: clicking a speaker NAME today just seeks to their first block.
// The handler is funnelled through `onSoloSpeaker?` (passed the speaker id ==
// the transcript socketId). P3 will supply that callback to "solo" the person's
// audio track; until then we fall back to a seek so the name is never dead. The
// id is the stable contract — nothing else here changes for P3.

import { ChevronDown, ChevronRight, Monitor, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { useT } from "../../i18n/mcm";

import {
  RIBBON_THRESHOLD,
  TOP_N_LANES,
  buildConversationRibbon,
  partitionSpeakers,
  type SpeakerInterval,
  type SpeakerTimeline,
  type SpeakerTimelineModel,
} from "../../data/replayTimeline";

import { shortDisplayName } from "./animalEmoji";
import { personColor } from "./meetingColors";

import type { ReplayClock } from "./CanvasReplayTimeline";

/** One shared-screen window on the timeline (#28b). `[startMs, endMs]` are epoch
 *  ms on the SAME clock as the speaker lanes + scrubber — i.e. a screen-video
 *  recording's `[started_at_ms, started_at_ms + duration*1000]`. The dedicated
 *  SCREEN lane draws one block per window. This is CONTENT (the shared screen),
 *  not a speaker — so it carries no person id / personColor. */
export type ScreenWindow = {
  startMs: number;
  endMs: number;
};

export type SpeakerLanesProps = {
  /** the shared play-state bundle — we read T0/T1/playheadT for layout and call
   *  onSeek on click. */
  clock: ReplayClock;
  /** the built per-speaker model (memoised by the parent from the transcript). */
  model: SpeakerTimelineModel;
  /** P3 SEAM: solo a speaker's audio. Given the speaker id (== socketId). When
   *  omitted (P2), a name click falls back to seeking to their first block. */
  onSoloSpeaker?: (speakerId: string) => void;
  /** #28b: the shared-screen windows (screen-video tracks) → a dedicated SCREEN
   *  lane so the reviewer can SEE when the screen was shared and scrub into it.
   *  Empty / omitted → no screen lane (transcript-only strip, exactly as before). */
  screenWindows?: readonly ScreenWindow[];
};

/** Position a [startMs, endMs] span as left% + width% within [T0, T1]. Clamped
 *  to [0, 100] so a block whose cosmetic end overruns T1 (or a transcript that
 *  starts before the canvas T0) never spills outside the track. */
const spanStyle = (
  startMs: number,
  endMs: number,
  T0: number,
  span: number,
): { left: string; width: string } => {
  if (span <= 0) {
    return { left: "0%", width: "0%" };
  }
  const l = Math.max(0, Math.min(1, (startMs - T0) / span));
  const r = Math.max(0, Math.min(1, (endMs - T0) / span));
  const w = Math.max(0, r - l);
  return { left: `${l * 100}%`, width: `${Math.max(w * 100, 0.4)}%` };
};

/** One track row with positioned blocks. Generic over both per-speaker lanes and
 *  the aggregated "others" heatmap (which passes a muted colour + no per-block
 *  tint override). */
const LaneTrack = ({
  intervals,
  color,
  T0,
  span,
  onSeek,
  label,
  striped,
}: {
  intervals: readonly SpeakerInterval[];
  color: string;
  T0: number;
  span: number;
  onSeek: (t: number) => void;
  label: string;
  striped?: boolean;
}) => (
  <div className="mcm-lanes__track">
    {intervals.map((iv, i) => {
      const s = spanStyle(iv.startMs, iv.endMs, T0, span);
      return (
        <button
          key={`${iv.startMs}-${i}`}
          type="button"
          className={`mcm-lanes__block${
            striped ? " mcm-lanes__block--striped" : ""
          }`}
          style={{ left: s.left, width: s.width, background: color }}
          onClick={() => onSeek(iv.startMs)}
          title={iv.preview ? `${label} · ${iv.preview}` : label}
          aria-label={label}
        />
      );
    })}
  </div>
);

/** A labelled per-speaker lane (sticky name at left + track at right). */
const SpeakerLane = ({
  speaker,
  T0,
  span,
  onSeek,
  onName,
}: {
  speaker: SpeakerTimeline;
  T0: number;
  span: number;
  onSeek: (t: number) => void;
  onName: (id: string) => void;
}) => (
  <div className="mcm-lanes__row">
    <button
      type="button"
      className="mcm-lanes__name"
      style={{ color: speaker.color }}
      onClick={() => onName(speaker.id)}
      title={speaker.name}
    >
      <span
        className="mcm-lanes__dot"
        style={{ background: speaker.color }}
        aria-hidden
      />
      {shortDisplayName(speaker.name)}
    </button>
    <LaneTrack
      intervals={speaker.intervals}
      color={speaker.color}
      T0={T0}
      span={span}
      onSeek={onSeek}
      label={speaker.name}
    />
  </div>
);

/** The dedicated SHARED-SCREEN lane (#28b). One row, one block per share window,
 *  on the SAME [T0, T1] x-axis as the speaker lanes + scrubber. It is CONTENT,
 *  not a speaker — so it gets a monitor icon + a neutral accent tint (NOT a
 *  personColor) and a "screen" class for the distinct look. Clicking a block
 *  seeks to that window's start, where the floating screen pane auto-shows. */
const ScreenLane = ({
  windows,
  T0,
  span,
  onSeek,
  label,
}: {
  windows: readonly ScreenWindow[];
  T0: number;
  span: number;
  onSeek: (t: number) => void;
  label: string;
}) => (
  <div className="mcm-lanes__row mcm-lanes__row--screen">
    <span className="mcm-lanes__name mcm-lanes__name--static mcm-lanes__name--screen">
      <Monitor size={12} aria-hidden />
      {label}
    </span>
    <div className="mcm-lanes__track">
      {windows.map((w, i) => {
        const s = spanStyle(w.startMs, w.endMs, T0, span);
        return (
          <button
            key={`${w.startMs}-${i}`}
            type="button"
            className="mcm-lanes__block mcm-lanes__block--screen"
            style={{ left: s.left, width: s.width }}
            onClick={() => onSeek(w.startMs)}
            title={label}
            aria-label={label}
          />
        );
      })}
    </div>
  </div>
);

export const SpeakerLanes = ({
  clock,
  model,
  onSoloSpeaker,
  screenWindows,
}: SpeakerLanesProps) => {
  const t = useT();
  const { T0, T1, playheadT, durationMs } = clock;
  const span = T1 - T0;

  // The strip is collapsed to nothing by default — open the lanes only on click.
  const [open, setOpen] = useState(false);
  // For crowded meetings: ribbon (default) vs expanded per-speaker lanes.
  const [expandedLanes, setExpandedLanes] = useState(false);
  // Inside the expanded crowded view: whether the aggregated "others" lane has
  // been opened into the full scrollable list.
  const [othersOpen, setOthersOpen] = useState(false);

  const crowded = model.speakerCount > RIBBON_THRESHOLD;
  const ribbon = useMemo(
    () => (crowded ? buildConversationRibbon(model) : []),
    [crowded, model],
  );
  const { top, others } = useMemo(
    () => partitionSpeakers(model, TOP_N_LANES),
    [model],
  );

  // #28b — the shared-screen windows as a stable list (each = one lane block).
  const screens = screenWindows ?? [];
  const hasScreenLane = screens.length > 0;

  // Nothing to show — no speakers AND no shared screen → no strip at all (the
  // transport already stands alone).
  if ((model.speakerCount === 0 && !hasScreenLane) || durationMs <= 0) {
    return null;
  }

  const playheadPct =
    span > 0 ? Math.max(0, Math.min(1, (playheadT - T0) / span)) * 100 : 0;

  // Header summary: lead with people when anyone spoke; otherwise (screen-only
  // meeting) say it's the shared screen so the chevron still reads sensibly.
  const summary =
    model.speakerCount > 0
      ? t("replay.lanes.summary", { count: model.speakerCount })
      : t("replay.lanes.screenOnly");

  return (
    <div className={`mcm-lanes${open ? " mcm-lanes--open" : ""}`}>
      {/* Chevron header — the single opt-in to reveal depth. */}
      <button
        type="button"
        className="mcm-lanes__toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? t("replay.lanes.collapse") : t("replay.lanes.expand")}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Users size={13} />
        <span className="mcm-lanes__toggle-label">{summary}</span>
      </button>

      {open && (
        <div className="mcm-lanes__body">
          {/* SHARED-SCREEN lane (#28b) — always at the top of the strip when the
              meeting has screen-video, regardless of the speaker-view mode. It is
              content (a monitor icon + neutral tint), so it sits apart from the
              speaker lanes; clicking a block seeks into that share window where
              the floating screen pane auto-shows. */}
          {hasScreenLane && (
            <ScreenLane
              windows={screens}
              T0={T0}
              span={span}
              onSeek={clock.onSeek}
              label={t("replay.lanes.screen")}
            />
          )}

          {/* Crowded → ribbon by default, with a switch to per-speaker lanes. */}
          {crowded && !expandedLanes ? (
            <>
              <div className="mcm-lanes__row mcm-lanes__row--ribbon">
                <span className="mcm-lanes__name mcm-lanes__name--static">
                  {t("replay.lanes.conversation")}
                </span>
                <div className="mcm-lanes__track">
                  {ribbon.map((b, i) => {
                    const s = spanStyle(b.startMs, b.endMs, T0, span);
                    return (
                      <button
                        key={`${b.startMs}-${i}`}
                        type="button"
                        className={`mcm-lanes__block${
                          b.overlap ? " mcm-lanes__block--striped" : ""
                        }`}
                        style={{
                          left: s.left,
                          width: s.width,
                          background: b.color,
                        }}
                        onClick={() => clock.onSeek(b.startMs)}
                        title={b.name}
                        aria-label={b.name}
                      />
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                className="mcm-lanes__more"
                onClick={() => setExpandedLanes(true)}
              >
                {t("replay.lanes.perSpeaker")}
              </button>
            </>
          ) : (
            <div className="mcm-lanes__scroll">
              {/* Per-speaker lanes (always for small meetings; opt-in expansion
                  for crowded ones). For crowded: top-N + aggregated others. */}
              {(crowded ? top : model.speakers).map((sp) => (
                <SpeakerLane
                  key={sp.id}
                  speaker={sp}
                  T0={T0}
                  span={span}
                  onSeek={clock.onSeek}
                  onName={(id) =>
                    onSoloSpeaker
                      ? onSoloSpeaker(id)
                      : clock.onSeek(
                          model.speakers.find((s) => s.id === id)?.intervals[0]
                            ?.startMs ?? T0,
                        )
                  }
                />
              ))}

              {crowded && others && (
                <>
                  {/* Aggregated "Người khác (k)" heatmap lane. Click opens the
                      full scrollable list of the long tail. */}
                  <div className="mcm-lanes__row mcm-lanes__row--others">
                    <button
                      type="button"
                      className="mcm-lanes__name"
                      onClick={() => setOthersOpen((v) => !v)}
                      title={t("replay.lanes.others", {
                        count: others.members.length,
                      })}
                    >
                      {othersOpen ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      {t("replay.lanes.others", {
                        count: others.members.length,
                      })}
                    </button>
                    <LaneTrack
                      intervals={others.intervals}
                      color="var(--mcm-text-soft)"
                      T0={T0}
                      span={span}
                      onSeek={clock.onSeek}
                      label={t("replay.lanes.others", {
                        count: others.members.length,
                      })}
                      striped
                    />
                  </div>

                  {othersOpen &&
                    others.members.map((sp) => (
                      <SpeakerLane
                        key={sp.id}
                        speaker={sp}
                        T0={T0}
                        span={span}
                        onSeek={clock.onSeek}
                        onName={(id) =>
                          onSoloSpeaker
                            ? onSoloSpeaker(id)
                            : clock.onSeek(sp.intervals[0]?.startMs ?? T0)
                        }
                      />
                    ))}
                </>
              )}

              {crowded && (
                <button
                  type="button"
                  className="mcm-lanes__more"
                  onClick={() => {
                    setExpandedLanes(false);
                    setOthersOpen(false);
                  }}
                >
                  {t("replay.lanes.conversationView")}
                </button>
              )}
            </div>
          )}

          {/* Single vertical playhead, shared x-axis with the transport. It is
              positioned inside a track-aligned overlay (offset past the sticky
              name column) so its fraction matches the blocks' fraction exactly —
              i.e. lines up with the transport scrubber. */}
          <div className="mcm-lanes__playhead-overlay" aria-hidden>
            <div
              className="mcm-lanes__playhead"
              style={{ left: `${playheadPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// Re-export the tint helper so callers tinting a chip outside a lane stay on the
// same hue source (keeps the dependency surface explicit).
export { personColor };

export default SpeakerLanes;
