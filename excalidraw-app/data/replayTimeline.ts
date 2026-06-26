// REPLAY TIMELINE — pure "who spoke when" builder (unified-replay-ux.md §2, §2.1).
//
// Turns the flat, append-only transcript log (`transcriptionLogAtom`) into a
// per-speaker lane model the SpeakerLanes strip renders on the SAME absolute-ms
// x-axis as the transport scrubber. It is the only place that decides:
//
//   • who is a "speaker" (grouping key = the transcript segment's socketId, the
//     one identity field every segment is guaranteed to carry — `username` is
//     the display name, `personColor(socketId)` the tint, matching the avatars
//     and the MeetingLogModal transcript rows);
//   • how a point-in-time utterance (a segment has a single `ts`, no duration)
//     becomes a drawable interval `[startMs, endMs]` — width is COSMETIC, derived
//     from the gap to the speaker's next segment, clamped + bounded by text
//     length so a lone segment still shows a readable block;
//   • how near-adjacent intervals of the SAME speaker merge into one block (so a
//     run of short segments reads as one turn, not confetti).
//
// PURE + TESTABLE: no React, no atoms, no DOM, no colour side effects beyond the
// deterministic `personColor`. Feed it a `TranscriptSegment[]`, get a plain data
// model back.
//
// ── STABLE IDENTITY GROUPING (reconnect-lane-split fix) ──────────────────────
// The transcript's `socketId` is per-CONNECTION: it changes every time a person
// drops + rejoins, so grouping on it raw splits ONE person into several lanes on
// reconnect — while the recording panel (which groups by the authenticated EMAIL
// stamped server-side as `speaker_id`) correctly shows ONE merged channel. To
// match the recording panel — and so per-speaker SOLO keys on the SAME id the
// media layer compares against (`track.rec.speaker_id`) — the caller can pass a
// `resolveIdentity(seg)` that maps a segment to a STABLE identity (the email).
// At REPLAY TIME the live peer atom is empty (those peers are gone), so the only
// source that survives a finished meeting is the recordings list: each `mic` row
// carries `speaker_id` (email) + `speaker_name` (the join display name == the
// transcript's `username`). The caller builds a username→email map from those
// rows and hands it in. When no resolver is given (or it returns nothing for a
// segment — e.g. an anonymous link-join with no recording), grouping falls back
// to the raw `socketId`, i.e. byte-for-byte today's behaviour.

import { personColor } from "../components/mcm/meetingColors";

import type { TranscriptSegment } from "./transcription";

/** A merged talk block on one speaker's lane. Both bounds are epoch ms on the
 *  same clock as the canvas history + the transport scrubber. `endMs` is a
 *  COSMETIC estimate (see `estimateWidthMs`) — load-bearing data is `startMs`
 *  (== the first segment's `ts`), which is what a click seeks to. */
export type SpeakerInterval = {
  startMs: number;
  endMs: number;
  /** how many transcript segments folded into this block (tooltip / debug). */
  segmentCount: number;
  /** first segment's text, trimmed — a cheap hover snippet, no PII beyond what
   *  the transcript already shows. */
  preview: string;
};

/** One lane: a person and every block they spoke. */
export type SpeakerTimeline = {
  /** grouping identity. With a `resolveIdentity` resolver this is the STABLE
   *  identity (the authenticated email == the recording row's `speaker_id`), so
   *  a reconnected person is ONE lane and per-speaker SOLO matches the audio
   *  layer's `track.rec.speaker_id`. Without a resolver it is the raw segment
   *  socketId (legacy / anonymous fallback). */
  id: string;
  /** display name (latest `username` seen for this id). */
  name: string;
  /** deterministic tint, identical to the avatar / transcript-row hue. */
  color: string;
  /** merged talk blocks, ascending by startMs. */
  intervals: SpeakerInterval[];
  /** total spoken ms across all blocks — the sort key for "busiest first" and
   *  the many-people top-N cut. */
  talkMs: number;
};

export type SpeakerTimelineModel = {
  /** lanes sorted by talkMs descending (busiest speaker first). */
  speakers: SpeakerTimeline[];
  /** window the transcript itself spans (min first ts → max last block end).
   *  The strip still renders against the transport's [T0, T1]; these are handy
   *  for callers wanting to WIDEN the canvas bounds with transcript reach. */
  transcriptT0: number;
  transcriptT1: number;
  /** convenience: speakers.length (how many distinct people spoke). */
  speakerCount: number;
};

export type BuildSpeakerTimelineOptions = {
  /** Merge two same-speaker intervals when the gap between them is below this
   *  (ms). Keeps a burst of short finalised segments reading as one turn.
   *  Default 4000 (§2: "merge gaps < ~4s"). */
  mergeGapMs?: number;
  /** Per-segment block width when there is no closer signal (ms). The real width
   *  is min(gap-to-next, this) but at least `minWidthMs`; this just caps a long
   *  trailing block so a final utterance before a long silence isn't a giant
   *  bar. Default 6000. */
  maxSegmentWidthMs?: number;
  /** Floor on a block's drawn width so a lone short segment is still clickable.
   *  Default 1200. */
  minWidthMs?: number;
  /** ms of estimated talk time per character of segment text — lets a long
   *  sentence read as a slightly longer block than a two-word one, bounded by
   *  [minWidthMs, maxSegmentWidthMs]. Purely cosmetic. Default 55 (~18 cps). */
  msPerChar?: number;
  /** Map a segment to its STABLE grouping identity (the authenticated email ==
   *  the recording's `speaker_id`), so reconnect lanes merge and SOLO matches
   *  the audio layer. Return a non-empty string to override; return null /
   *  undefined / "" to let THIS segment fall back to its raw socketId (the
   *  anonymous / no-recording case). Omitting the whole resolver reproduces the
   *  legacy "group by socketId" behaviour exactly. Must be pure + deterministic
   *  (it feeds `personColor`, the lane tint). */
  resolveIdentity?: (seg: TranscriptSegment) => string | null | undefined;
};

const DEFAULTS = {
  mergeGapMs: 4000,
  maxSegmentWidthMs: 6000,
  minWidthMs: 1200,
  msPerChar: 55,
} as const;

/** Cosmetic width for a single segment: take the gap to the speaker's next
 *  segment (so blocks butt up against real silence), but never longer than
 *  `maxSegmentWidthMs`, never shorter than a text-length estimate floored at
 *  `minWidthMs`. `nextTs` undefined → no following segment, use the text/cap. */
const estimateWidthMs = (
  text: string,
  ts: number,
  nextTs: number | undefined,
  opts: Required<Omit<BuildSpeakerTimelineOptions, "resolveIdentity">>,
): number => {
  const byText = Math.min(
    opts.maxSegmentWidthMs,
    Math.max(opts.minWidthMs, text.trim().length * opts.msPerChar),
  );
  if (nextTs === undefined) {
    return byText;
  }
  const gap = Math.max(0, nextTs - ts);
  // Don't draw past where the next utterance begins; but if the gap is tiny
  // (rapid-fire segments), still show at least the floor so it's visible — the
  // merge pass will usually fuse these anyway.
  return Math.max(opts.minWidthMs, Math.min(byText, gap || byText));
};

/**
 * Build the per-speaker lane model from the raw transcript log.
 *
 * Grouping key is the STABLE identity from `options.resolveIdentity(segment)`
 * (the authenticated email == the recording's `speaker_id`) when supplied, else
 * the raw `segment.socketId` (legacy / anonymous fallback). `username` supplies
 * the display name and `personColor(id)` the tint, so colour is stable per
 * identity (a reconnected person keeps one hue). Each segment becomes an interval
 * starting at its `ts` with a cosmetic width (see `estimateWidthMs`); consecutive
 * intervals of the SAME speaker whose gap is `< mergeGapMs` fuse into one block.
 * Lanes come back sorted by total talk time descending.
 *
 * Defensive: tolerates an unsorted log (sorts a copy), empty/missing fields, and
 * a single segment. Never throws. Returns an empty model for an empty log.
 */
export const buildSpeakerTimeline = (
  log: readonly TranscriptSegment[] | null | undefined,
  options?: BuildSpeakerTimelineOptions,
): SpeakerTimelineModel => {
  // Cosmetic width/merge knobs only — `resolveIdentity` is a function, kept out
  // of this `Required<…>`-typed numeric bag and read directly below.
  const opts: Required<Omit<BuildSpeakerTimelineOptions, "resolveIdentity">> = {
    mergeGapMs: options?.mergeGapMs ?? DEFAULTS.mergeGapMs,
    maxSegmentWidthMs: options?.maxSegmentWidthMs ?? DEFAULTS.maxSegmentWidthMs,
    minWidthMs: options?.minWidthMs ?? DEFAULTS.minWidthMs,
    msPerChar: options?.msPerChar ?? DEFAULTS.msPerChar,
  };
  const resolveIdentity = options?.resolveIdentity;

  const empty: SpeakerTimelineModel = {
    speakers: [],
    transcriptT0: 0,
    transcriptT1: 0,
    speakerCount: 0,
  };
  if (!log || log.length === 0) {
    return empty;
  }

  // Sort a COPY ascending by ts (the source is append-only chronological, but a
  // race could reorder; keep the builder robust). Drop entries with a non-finite
  // ts — they can't be placed on the axis.
  const sorted = log
    .filter((s) => s && Number.isFinite(s.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    return empty;
  }

  // Bucket segments by STABLE identity, preserving chronological order within
  // each bucket. The key is `resolveIdentity(seg)` (the email == recording
  // `speaker_id`) when the resolver supplies one, else the raw `socketId` — so a
  // reconnected person (new socketId, same email) lands in ONE bucket, matching
  // the recording panel, while anonymous link-joins with no recording keep their
  // per-connection socketId. Track the latest username for the display label.
  type Bucket = { name: string; segs: TranscriptSegment[] };
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    // Stable identity first; fall back to socketId (then "unknown") so a missing
    // resolver / unmatched segment behaves exactly as before.
    const resolved = resolveIdentity?.(seg);
    const id = (resolved && resolved.trim()) || seg.socketId || "unknown";
    let b = buckets.get(id);
    if (!b) {
      b = { name: seg.username || id, segs: [] };
      buckets.set(id, b);
    }
    if (seg.username) {
      b.name = seg.username; // latest wins
    }
    b.segs.push(seg);
  }

  let transcriptT0 = Infinity;
  let transcriptT1 = -Infinity;

  const speakers: SpeakerTimeline[] = [];
  for (const [id, bucket] of buckets) {
    const intervals: SpeakerInterval[] = [];
    for (let i = 0; i < bucket.segs.length; i++) {
      const seg = bucket.segs[i];
      const nextTs = bucket.segs[i + 1]?.ts;
      const width = estimateWidthMs(seg.text ?? "", seg.ts, nextTs, opts);
      const startMs = seg.ts;
      const endMs = seg.ts + width;
      const last = intervals[intervals.length - 1];
      // Merge into the previous block when the silent gap between THIS segment's
      // start and the previous block's drawn end is below the threshold.
      if (last && startMs - last.endMs < opts.mergeGapMs) {
        last.endMs = Math.max(last.endMs, endMs);
        last.segmentCount += 1;
        // keep the first preview (the turn's opening line)
      } else {
        intervals.push({
          startMs,
          endMs,
          segmentCount: 1,
          preview: (seg.text ?? "").trim().slice(0, 140),
        });
      }
    }

    let talkMs = 0;
    for (const iv of intervals) {
      talkMs += iv.endMs - iv.startMs;
      if (iv.startMs < transcriptT0) {
        transcriptT0 = iv.startMs;
      }
      if (iv.endMs > transcriptT1) {
        transcriptT1 = iv.endMs;
      }
    }

    speakers.push({
      id,
      name: bucket.name,
      color: personColor(id),
      intervals,
      talkMs,
    });
  }

  // Busiest speaker first (the top-N cut + lane order both key off this). Ties
  // broken by earliest first interval so the order is stable across rebuilds.
  speakers.sort(
    (a, b) =>
      b.talkMs - a.talkMs ||
      (a.intervals[0]?.startMs ?? 0) - (b.intervals[0]?.startMs ?? 0),
  );

  return {
    speakers,
    transcriptT0: Number.isFinite(transcriptT0) ? transcriptT0 : 0,
    transcriptT1: Number.isFinite(transcriptT1) ? transcriptT1 : 0,
    speakerCount: speakers.length,
  };
};

// ── MANY-PEOPLE PRESENTATION HELPERS (§2.1) ──────────────────────────────────
// Pure shaping the view uses to decide ribbon-vs-lanes and to fold the "Người
// khác (k)" aggregate. Kept here (not in the component) so they're unit-testable
// and the component stays declarative.

/** Above this many distinct speakers the strip defaults to the single
 *  "conversation ribbon" instead of per-speaker lanes (§2.1: "≤ ~5 → lanes;
 *  > threshold → ribbon"). */
export const RIBBON_THRESHOLD = 5;

/** When expanded into per-speaker lanes for a crowded meeting, show at most this
 *  many real lanes; the rest fold into one aggregated "others" lane. */
export const TOP_N_LANES = 6;

/** One block on the single conversation ribbon: a contiguous span coloured by
 *  the CURRENT speaker, so turn-taking reads at a glance regardless of headcount
 *  (§2.1). `overlap` marks spans where >1 person talked at once (render striped /
 *  split). The dominant speaker drives `color`/`name`/`id`. */
export type RibbonBlock = {
  startMs: number;
  endMs: number;
  /** dominant speaker for the span (the one to seek / label). */
  id: string;
  name: string;
  color: string;
  /** true when another speaker's interval overlaps this span. */
  overlap: boolean;
};

/** Flatten all speaker intervals into a single ordered ribbon of "who held the
 *  floor", merging touching same-speaker spans and flagging overlaps. Pure.
 *
 *  Algorithm: collect every interval tagged with its speaker, sort by start,
 *  then sweep — each new interval either extends the current block (same speaker,
 *  contiguous/overlapping) or starts a new one; an interval that starts before
 *  the current block ends but belongs to a DIFFERENT speaker marks both as
 *  overlap (two people talking). This is O(n log n) and allocation-light. */
export const buildConversationRibbon = (
  model: SpeakerTimelineModel,
): RibbonBlock[] => {
  type Tagged = {
    startMs: number;
    endMs: number;
    id: string;
    name: string;
    color: string;
  };
  const all: Tagged[] = [];
  for (const sp of model.speakers) {
    for (const iv of sp.intervals) {
      all.push({
        startMs: iv.startMs,
        endMs: iv.endMs,
        id: sp.id,
        name: sp.name,
        color: sp.color,
      });
    }
  }
  if (all.length === 0) {
    return [];
  }
  all.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const blocks: RibbonBlock[] = [];
  for (const t of all) {
    const cur = blocks[blocks.length - 1];
    if (cur && t.startMs < cur.endMs) {
      // Overlapping span: another voice over the current block.
      if (t.id === cur.id) {
        cur.endMs = Math.max(cur.endMs, t.endMs);
      } else {
        cur.overlap = true;
        // The interrupting voice continues as its own block after the overlap
        // start, so the ribbon still shows the hand-off. Extend current to the
        // overlap region, then append the new speaker's tail.
        const tailStart = Math.max(t.startMs, cur.endMs);
        if (t.endMs > tailStart) {
          blocks.push({
            startMs: tailStart,
            endMs: t.endMs,
            id: t.id,
            name: t.name,
            color: t.color,
            overlap: false,
          });
        }
      }
    } else if (cur && t.id === cur.id && t.startMs - cur.endMs < 1) {
      // Contiguous same speaker — coalesce.
      cur.endMs = Math.max(cur.endMs, t.endMs);
    } else {
      blocks.push({
        startMs: t.startMs,
        endMs: t.endMs,
        id: t.id,
        name: t.name,
        color: t.color,
        overlap: false,
      });
    }
  }
  return blocks;
};

/** Split a sorted speaker list into the top-N visible lanes and an aggregated
 *  "others" group (the remainder), for the expanded crowded view (§2.1). The
 *  aggregate's intervals are the UNION of every remaining speaker's intervals
 *  (a heatmap of "anyone in the long tail spoke"), so no information is lost.
 *  Returns `others: null` when nothing is left over. Pure. */
export const partitionSpeakers = (
  model: SpeakerTimelineModel,
  topN: number = TOP_N_LANES,
): {
  top: SpeakerTimeline[];
  others: {
    /** the speakers folded into the aggregate (for the expand-to-full list). */
    members: SpeakerTimeline[];
    /** merged "any of them spoke" intervals, ascending. */
    intervals: SpeakerInterval[];
    talkMs: number;
  } | null;
} => {
  const top = model.speakers.slice(0, Math.max(0, topN));
  const rest = model.speakers.slice(Math.max(0, topN));
  if (rest.length === 0) {
    return { top, others: null };
  }
  // Union all rest intervals into a heatmap of "someone in the tail talking".
  const flat: SpeakerInterval[] = [];
  for (const sp of rest) {
    for (const iv of sp.intervals) {
      flat.push(iv);
    }
  }
  flat.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: SpeakerInterval[] = [];
  for (const iv of flat) {
    const cur = merged[merged.length - 1];
    if (cur && iv.startMs <= cur.endMs) {
      cur.endMs = Math.max(cur.endMs, iv.endMs);
      cur.segmentCount += iv.segmentCount;
    } else {
      merged.push({ ...iv });
    }
  }
  let talkMs = 0;
  for (const iv of merged) {
    talkMs += iv.endMs - iv.startMs;
  }
  return { top, others: { members: rest, intervals: merged, talkMs } };
};
