// LIVE CAPTION DOCK — a thin glass subtitle strip pinned to the BOTTOM of the
// surface that owns the viewport while someone is presenting / sharing (the
// viewer pane, the presenter PiP, or — when neither is mounted — an overlay on
// the canvas). It shows the 1–3 NEWEST lines of whoever is currently speaking,
// each viewer in THEIR preferred language, and auto-hides after a few seconds of
// silence. It must never cover content, so it's a slim bottom band that collapses
// to a small "CC" puck when there's nothing to say.
//
// This is a LIVE-GLANCE layer only — the full scrollable history lives in
// SpeechToTextPanel, which is untouched. Both read the same atoms:
//   • liveTranscriptsAtom   (data/transcription.ts)  — per-speaker INTERIM line.
//   • transcriptionLogAtom  (data/transcription.ts)  — finalized segments.
//   • activeSpeakerAtom     (audio/videoPerf.ts)      — who's talking right now.
//   • useTranslate / preferredLanguageAtom (data/translation.ts) — per-viewer
//     translation of FINAL lines.
//
// Interim vs final:
//   • Interim hypotheses change word-by-word, so translating them would thrash
//     the API and flicker. We render the interim ORIGINAL, dimmed + italic.
//   • A finalized segment is stable, so it runs `useTranslate(seg.text, {
//     assumedSource: seg.lang })` and shows the viewer's language. The hook is
//     per-line (its own component) because hooks can't be called inside .map —
//     the exact pattern SpeechToTextPanel's SegmentRow uses.

import { useEffect, useMemo, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { activeSpeakerAtom } from "../../audio/videoPerf";
import {
  CAPTION_FONT_SCALES,
  CAPTION_FONT_SCALE_VALUE,
  CAPTION_LINE_COUNTS,
  captionDockEnabledAtom,
  captionFontScaleAtom,
  captionLineCountAtom,
  setCaptionDockEnabled,
  setCaptionFontScale,
  setCaptionLineCount,
  type CaptionFontScale,
  type CaptionLineCount,
} from "../../data/captionState";
import { collabAPIAtom } from "../../collab/Collab";
import {
  liveTranscriptsAtom,
  setSttDualLanguage,
  sttDualLanguageAtom,
  sttTranslateEnabledAtom,
  transcriptionLogAtom,
} from "../../data/transcription";
import {
  preferredLanguageAtom,
  translationDegradedAtom,
  useTranslate,
} from "../../data/translation";
import { peerProfilesAtom, userProfileAtom } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { shortDisplayName } from "./animalEmoji";

import "./LiveCaptionDock.scss";

import type { InterimEntry, TranscriptSegment } from "../../data/transcription";
import type { SupportedLanguage } from "../../data/translation";

// How long after the last new interim/final before the dock collapses to the CC
// puck. ~4s reads as "the speaker paused / finished a thought" without yanking
// captions away mid-sentence (Deepgram finals can lag the audio by ~1s).
const SILENCE_HIDE_MS = 4000;

// Deterministic speaker colour — same palette + hash as SpeechToTextPanel's
// SegmentRow and the avatar gradient, so a given socketId is the same colour
// everywhere ("this person said that" recognition).
const PALETTE = [
  "#34d399",
  "#f472b6",
  "#fbbf24",
  "#60a5fa",
  "#a78bfa",
  "#22d3ee",
  "#fb7185",
  "#84cc16",
];
const colorFor = (key: string): string => {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
};

/** Where the dock is mounted — drives ONLY the wrapper class (positioning).
 *  - embedded: absolutely pinned to the bottom of a parent pane (viewer pane /
 *    presenter PiP body). The parent must be `position: relative`.
 *  - overlay:  fixed band over the canvas, used when no pane exists (the
 *    presenter sharing without the PiP open). */
export type CaptionDockVariant = "embedded" | "overlay";

// A line ready to render: either a finalized segment (translatable) or the live
// interim (original only). Normalised so the render path is uniform.
type CaptionLine =
  | { kind: "final"; seg: TranscriptSegment }
  | { kind: "interim"; entry: InterimEntry };

// ----- speaker label ------------------------------------------------
// Resolve a speaker's display name from their profile (self reads its own atom,
// peers read the last USER_PROFILE we received) and fall back to the raw socket
// username — same resolution as SegmentRow.
const useSpeakerName = (socketId: string, fallbackName: string): string => {
  const myProfile = useAtomValue(userProfileAtom);
  const peerProfiles = useAtomValue(peerProfilesAtom);
  const selfSocketId = useAtomValue(collabAPIAtom)?.portal.socket?.id;
  const profile =
    socketId === selfSocketId
      ? myProfile ?? undefined
      : peerProfiles.get(socketId);
  return profile?.username || fallbackName;
};

// ----- one FINAL line (translated per viewer) -----------------------
// Its own component so it can call useTranslate — you can't call a hook inside
// the parent's .map(). `assumedSource = seg.lang` lets the hook short-circuit
// when Deepgram's detected language already matches the viewer's preferred one
// (no "translate Korean → Korean" round-trip).
const FinalCaptionLine = ({ seg }: { seg: TranscriptSegment }) => {
  const t = useT();
  // The caption MUST follow the SAME translate toggle the STT panel uses
  // (`sttTranslateEnabledAtom`), not useTranslate's internal chat toggle
  // (`translationEnabledAtom`). Otherwise the dock could translate while the
  // panel doesn't (or vice-versa) — anh Luân case 4: "dù ở dạng nào ngôn ngữ
  // phải đúng user". When OFF we render the ORIGINAL spoken text verbatim.
  const translateOn = useAtomValue(sttTranslateEnabledAtom);
  // Dual-language view (shared with the STT panel): show BOTH the original
  // spoken line AND the translation. Only meaningful while translation is ON.
  const dualOn = useAtomValue(sttDualLanguageAtom);
  const preferredLang = useAtomValue(preferredLanguageAtom);
  // `seg.lang === "multi"` means Deepgram detected mixed/unknown language — we
  // can't trust it as the source, so pass `undefined` and let the backend
  // auto-detect (passing a wrong assumedSource would mis-translate). A concrete
  // lang lets useTranslate short-circuit "ko → ko" round-trips.
  const assumedSource =
    seg.lang && seg.lang !== "multi"
      ? (seg.lang as SupportedLanguage)
      : undefined;
  // `batched: true` routes caption translation through the debounced
  // /translate-batch batcher instead of one /translate per line — the load fix
  // for busy meetings (plan §5, data/translation.ts).
  const { translated, isSameLanguage, loading } = useTranslate(seg.text, {
    assumedSource,
    batched: true,
  });
  const name = useSpeakerName(seg.socketId, seg.username);
  // Translate OFF → original, no hook output used. Translate ON → translated,
  // but while a (different-language) translation is still in flight show the
  // original rather than an empty line — captions must never blank out.
  const showTranslation = translateOn && !isSameLanguage;
  const text = !translateOn
    ? seg.text
    : loading && !isSameLanguage
    ? seg.text
    : translated;
  // Dual view pairs the ORIGINAL spoken text under the translated line, but only
  // when there genuinely IS a translation to pair (translate on + different
  // language). When the spoken language already matches the viewer's preferred
  // one there's nothing to add, so we collapse back to a single line.
  const secondary =
    dualOn && showTranslation && !loading ? seg.text : undefined;
  return (
    <CaptionLineRow
      socketId={seg.socketId}
      name={name}
      text={text}
      primaryTag={secondary ? preferredLang.toUpperCase() : undefined}
      secondary={secondary}
      secondaryTag={
        secondary ? (seg.lang || "").toUpperCase() || undefined : undefined
      }
      interim={false}
      translating={showTranslation && loading}
      translatingLabel={t("caption.translating")}
    />
  );
};

// ----- one INTERIM line (original, dimmed) --------------------------
const InterimCaptionLine = ({ entry }: { entry: InterimEntry }) => {
  const name = useSpeakerName(entry.socketId, entry.username);
  return (
    <CaptionLineRow
      socketId={entry.socketId}
      name={name}
      text={entry.text}
      interim
    />
  );
};

// ----- shared line renderer -----------------------------------------
const CaptionLineRow = ({
  socketId,
  name,
  text,
  primaryTag,
  secondary,
  secondaryTag,
  interim,
  translating,
  translatingLabel,
}: {
  socketId: string;
  name: string;
  text: string;
  /** Language-code chip shown before `text` — set only in the dual view so the
   *  viewer can tell the primary (translated) line's language. */
  primaryTag?: string;
  /** Second line under the primary (the ORIGINAL spoken text) — dual view only.
   *  Rendered dimmer/smaller so the primary stays the focus. */
  secondary?: string;
  /** Language-code chip for the `secondary` line. */
  secondaryTag?: string;
  interim: boolean;
  translating?: boolean;
  translatingLabel?: string;
}) => (
  <div
    className={`mcm-caption__line${
      interim ? " mcm-caption__line--interim" : ""
    }${secondary ? " mcm-caption__line--dual" : ""}`}
  >
    <span
      className="mcm-caption__spk"
      // per-speaker colour from the shared avatar palette
      // eslint-disable-next-line react/forbid-dom-props
      style={{ color: colorFor(socketId) }}
    >
      {shortDisplayName(name)}
      {interim && (
        // pulsing dot = "this person is speaking right now"
        <span className="mcm-caption__live-dot" aria-hidden="true" />
      )}
    </span>
    <span className="mcm-caption__body">
      <span className="mcm-caption__text">
        {primaryTag && !translating && (
          <span className="mcm-caption__tag">{primaryTag}</span>
        )}
        {translating ? translatingLabel : text}
      </span>
      {secondary && (
        <span className="mcm-caption__text mcm-caption__text--secondary">
          {secondaryTag && (
            <span className="mcm-caption__tag">{secondaryTag}</span>
          )}
          {secondary}
        </span>
      )}
    </span>
  </div>
);

export const LiveCaptionDock = ({
  variant = "embedded",
}: {
  variant?: CaptionDockVariant;
}) => {
  const t = useT();
  const enabled = useAtomValue(captionDockEnabledAtom);
  const log = useAtomValue(transcriptionLogAtom);
  const interims = useAtomValue(liveTranscriptsAtom);
  const activeSpeaker = useAtomValue(activeSpeakerAtom);
  const lineCount = useAtomValue(captionLineCountAtom);
  const fontScale = useAtomValue(captionFontScaleAtom);
  // Translation overloaded (429/502) — show a subtle, debounced hint instead of
  // silently dropping to the original text (plan §5). Only meaningful while
  // caption translation is ON.
  const translateOn = useAtomValue(sttTranslateEnabledAtom);
  const degraded = useAtomValue(translationDegradedAtom);

  const interimEntries = useMemo(() => Object.values(interims), [interims]);

  // ----- pick the lines to show -----------------------------------
  // Prefer the ACTIVE speaker; if Daily hasn't reported one yet (or it's stale),
  // fall back to whoever produced the most recent interim/final so captions
  // still appear. We take the newest `lineCount` lines overall, with any live
  // interim for the chosen speaker pinned LAST (it's the freshest, still-growing
  // line). Final lines carry a stable `id`; interim is keyed by speaker.
  const lines = useMemo<CaptionLine[]>(() => {
    // Who are we captioning? Active speaker wins; else the speaker of the most
    // recent activity (last interim, else last final).
    const lastFinal = log.length > 0 ? log[log.length - 1] : null;
    const newestInterim = interimEntries.reduce<InterimEntry | null>(
      (newest, e) => (!newest || e.ts > newest.ts ? e : newest),
      null,
    );
    const speakerId =
      activeSpeaker ?? newestInterim?.socketId ?? lastFinal?.socketId ?? null;
    if (!speakerId) {
      return [];
    }

    const result: CaptionLine[] = [];
    // Newest finals from this speaker, oldest-first so they read top-to-bottom.
    const speakerFinals = log.filter((s) => s.socketId === speakerId);
    const interim =
      interimEntries.find((e) => e.socketId === speakerId) ?? null;
    // Reserve the last slot for the live interim when present.
    const finalSlots = interim ? Math.max(0, lineCount - 1) : lineCount;
    for (const seg of speakerFinals.slice(-finalSlots)) {
      result.push({ kind: "final", seg });
    }
    if (interim && interim.text.trim()) {
      result.push({ kind: "interim", entry: interim });
    }
    return result.slice(-lineCount);
  }, [log, interimEntries, activeSpeaker, lineCount]);

  // ----- silence auto-hide ----------------------------------------
  // Collapse to the CC puck after SILENCE_HIDE_MS with no NEW content. We key the
  // "activity" timestamp off the concatenated line text + count so it advances on
  // every interim word, not just when a new line appears.
  const activitySig = useMemo(
    () =>
      lines
        .map((l) => (l.kind === "final" ? l.seg.id + l.seg.text : l.entry.text))
        .join("|"),
    [lines],
  );
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    if (lines.length === 0) {
      return; // nothing to show — stay collapsed (no timer needed)
    }
    setCollapsed(false);
    const id = window.setTimeout(() => setCollapsed(true), SILENCE_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [activitySig, lines.length]);

  if (!enabled) {
    // CC is off: render nothing but the toggle so the user can turn it back on
    // from wherever the dock lives.
    return (
      <div
        className={`mcm-caption mcm-caption--${variant} mcm-caption--off`}
        // eslint-disable-next-line react/forbid-dom-props
        style={{ ["--mcm-caption-scale" as string]: 1 }}
      >
        <CaptionControls compact />
      </div>
    );
  }

  const showStrip = lines.length > 0 && !collapsed;

  return (
    <div
      className={`mcm-caption mcm-caption--${variant}${
        showStrip ? " mcm-caption--active" : " mcm-caption--idle"
      }`}
      // Font scale is a single CSS multiplier so S/M/L resizes the whole strip
      // (and propagates into the pop-out window, which copies these styles).
      // eslint-disable-next-line react/forbid-dom-props
      style={{
        ["--mcm-caption-scale" as string]: CAPTION_FONT_SCALE_VALUE[fontScale],
      }}
      role="region"
      aria-label={t("caption.label")}
    >
      {/* While the strip is up, expose a quick-hide (×) that just collapses the
          current strip (without disabling captions) — it reappears on the next
          utterance. Hidden when there's nothing showing, so it never adds a
          dangling control to the empty/idle state. */}
      <CaptionControls
        onHide={showStrip ? () => setCollapsed(true) : undefined}
      />
      {showStrip && (
        <div className="mcm-caption__strip" aria-live="polite">
          {translateOn && degraded && (
            // Transient "translation paused (overloaded)" hint — captions still
            // fall back to the original spoken text below it (plan §5).
            <div className="mcm-caption__degraded" role="status">
              {t("caption.degraded")}
            </div>
          )}
          {lines.map((line) =>
            line.kind === "final" ? (
              <FinalCaptionLine key={line.seg.id} seg={line.seg} />
            ) : (
              <InterimCaptionLine
                key={`interim-${line.entry.socketId}`}
                entry={line.entry}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
};

// ----- controls: CC toggle + line count + font size -----------------
// Rendered both in the active strip and (compact) when CC is off. Kept inline on
// the dock — the pane/presenter header also exposes a CC button (see mounts), but
// having the controls on the dock itself means the overlay variant (no pane
// header) is still fully configurable.
const CaptionControls = ({
  compact,
  onHide,
}: {
  compact?: boolean;
  /** When provided, render a quick-hide (×) that collapses the live strip
   *  without disabling captions. Absent → no hide button (idle/compact). */
  onHide?: () => void;
}) => {
  const t = useT();
  const [enabled, setEnabled] = useAtom(captionDockEnabledAtom);
  const [lineCount, setLineCount] = useAtom(captionLineCountAtom);
  const [fontScale, setFontScale] = useAtom(captionFontScaleAtom);
  // Dual-language toggle is only meaningful while caption translation is ON
  // (there's no second language to pair the original with otherwise), so it's
  // shown disabled when translate is off. Shared atom = same state as the panel.
  const translateOn = useAtomValue(sttTranslateEnabledAtom);
  const [dual, setDual] = useAtom(sttDualLanguageAtom);

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    setCaptionDockEnabled(next);
  };
  const toggleDual = () => {
    const next = !dual;
    setDual(next);
    setSttDualLanguage(next);
  };
  const pickLines = (n: CaptionLineCount) => {
    setLineCount(n);
    setCaptionLineCount(n);
  };
  const pickScale = (s: CaptionFontScale) => {
    setFontScale(s);
    setCaptionFontScale(s);
  };

  return (
    <div
      className={`mcm-caption__controls${
        compact ? " mcm-caption__controls--compact" : ""
      }`}
    >
      <button
        type="button"
        className={`mcm-caption__cc${enabled ? " mcm-caption__cc--on" : ""}`}
        onClick={toggleEnabled}
        title={
          enabled ? t("caption.toggleOnTitle") : t("caption.toggleOffTitle")
        }
        aria-pressed={enabled}
      >
        CC
      </button>

      {/* The line-count + font-size pickers only make sense while captions are
          ON — hide them in the compact (CC-off) state to keep the puck tiny. */}
      {enabled && !compact && (
        <>
          <span
            className="mcm-caption__ctl-group"
            title={t("caption.linesTitle")}
          >
            {CAPTION_LINE_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                className={`mcm-caption__ctl${
                  lineCount === n ? " mcm-caption__ctl--on" : ""
                }`}
                onClick={() => pickLines(n)}
                aria-pressed={lineCount === n}
                aria-label={t("caption.linesN", { count: n })}
              >
                {n}
              </button>
            ))}
          </span>

          <span
            className="mcm-caption__ctl-group"
            title={t("caption.fontSizeTitle")}
          >
            {CAPTION_FONT_SCALES.map((s) => (
              <button
                key={s}
                type="button"
                className={`mcm-caption__ctl mcm-caption__ctl--font mcm-caption__ctl--font-${s}${
                  fontScale === s ? " mcm-caption__ctl--on" : ""
                }`}
                onClick={() => pickScale(s)}
                aria-pressed={fontScale === s}
                aria-label={t(`caption.fontSize.${s}` as "caption.fontSize.m")}
              >
                A
              </button>
            ))}
          </span>

          {/* Dual-language toggle: show BOTH the original spoken text and the
              translation per line. Disabled when caption translation is off
              (no second language to pair). The "文A" glyph (CJK + Latin) signals
              "two languages" without needing a localized label. */}
          <button
            type="button"
            className={`mcm-caption__ctl mcm-caption__ctl--dual${
              dual && translateOn ? " mcm-caption__ctl--on" : ""
            }`}
            disabled={!translateOn}
            onClick={toggleDual}
            aria-pressed={dual && translateOn}
            title={
              !translateOn
                ? t("caption.dualDisabledTitle")
                : dual
                ? t("caption.dualOnTitle")
                : t("caption.dualOffTitle")
            }
          >
            文A
          </button>
        </>
      )}

      {/* Quick-hide: collapse the strip now (captions stay ON, reappear on the
          next line). Only shown while a strip is up — the dock passes onHide
          then. Glyph "×" instead of an icon import to keep the dock dependency-
          free; aria-label carries the meaning for AT. */}
      {enabled && !compact && onHide && (
        <button
          type="button"
          className="mcm-caption__hide"
          onClick={onHide}
          // Dedicated "Hide captions for now" string — distinct from the CC
          // toggle (which disables the feature); this just collapses the current
          // strip until the next utterance.
          title={t("caption.hideTitle")}
          aria-label={t("caption.hideTitle")}
        >
          ×
        </button>
      )}
    </div>
  );
};

export default LiveCaptionDock;
