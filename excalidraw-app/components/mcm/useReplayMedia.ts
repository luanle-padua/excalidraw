// REPLAY MEDIA SYNC — the P3 "play-along" engine (unified-replay-ux.md §3, §4).
//
// Given the meeting's recordings and the single absolute-ms playhead clock, this
// hook keeps a small set of native <audio>/<video> elements in lockstep with the
// canvas timeline WITHOUT a Web Audio graph, a server mixdown, or a second
// transport. The canvas (P1) owns timekeeping — it advances `playheadT` via rAF;
// media here is a FOLLOWER that plays natively for smoothness and is only nudged
// back onto the playhead when it drifts past a threshold.
//
// ── HOW A TRACK MAPS TO THE TIMELINE (§4) ────────────────────────────────────
// Each recording row carries `started_at_ms` (the wall-clock instant its capture
// began) and `duration` (seconds). That gives an absolute window:
//
//     [trackStart, trackEnd] = [started_at_ms, started_at_ms + duration*1000]
//
// A track is ACTIVE when `playheadT ∈ [trackStart, trackEnd]`. Its element's
// local time is `(playheadT - trackStart) / 1000`, clamped to [0, duration].
// LEGACY rows with `started_at_ms == null` fall back to the window start `T0`
// (approximate placement — accepted, never a crash; surfaced via `legacy`).
//
// ── WHAT PLAYS, BY MODE (§3) ─────────────────────────────────────────────────
//   • "canvas"  → nothing here (the parent renders the vector replay alone).
//   • "audio"   → EVERY in-window `mic` (+ `screen-audio`) element plays at once;
//     the BROWSER mixes them (no graph). SOLO: if a speakerId is soloed, only
//     that speaker's mic is audible (others paused).
//   • "screen"  → the single `screen-video` track in a floating <video> (its own
//     audio on; mics off in this mode).
//
// ── SYNC LOOP (§4) ───────────────────────────────────────────────────────────
//   PLAY  : media plays NATIVE. Every ~500ms we compare `el.currentTime` to the
//           target and NUDGE (`el.currentTime = target`) only when |drift| > 250ms.
//           `el.playbackRate = speed`. Re-entering a window mid-play → play() at
//           the right offset; leaving a window → pause + park.
//   SCRUB : seek every active element to its target; everything stays paused.
//
// ── MEMORY (§4, §8) ──────────────────────────────────────────────────────────
// We only build elements for tracks whose window is near the playhead (current +
// a small look-ahead). Object URLs are fetched lazily via the gated
// `fetchRecordingObjectUrl` and REVOKED on teardown / mode-switch / out-of-window
// so a 15-mic meeting never holds every speaker's blob at once.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchRecordingObjectUrl, type Recording } from "../../data/recordings";

/** Which media plays ALONGSIDE the canvas. "canvas" = vector replay only. */
export type ReplayMediaMode = "canvas" | "audio" | "screen";

/** How far ahead of the playhead (ms) we pre-build + buffer a track's element so
 *  it is ready to play the instant the playhead enters its window. Kept small —
 *  a few seconds — so we never hold the whole meeting's blobs at once. */
const LOOKAHEAD_MS = 4000;
/** How far PAST a track's end we keep its element mounted before tearing it down
 *  (avoids thrash when scrubbing back and forth across a boundary). */
const LINGER_MS = 1500;
/** Drift tolerance: only re-seek a native element when it strays this far from
 *  the target (§4 "lệch > ~250ms mới nudge"). */
const NUDGE_THRESHOLD_MS = 250;
/** How often the drift check runs while playing (§4 "mỗi ~500ms"). */
const SYNC_INTERVAL_MS = 500;

/** A recording row resolved onto the absolute timeline. */
export type MediaTrack = {
  rec: Recording;
  /** epoch ms this track starts (started_at_ms, or T0 for legacy null rows). */
  startMs: number;
  /** epoch ms this track ends (startMs + duration*1000; >= startMs). */
  endMs: number;
  /** duration in seconds, clamped >= 0 (drives currentTime clamping). */
  durationSec: number;
  /** true when started_at_ms was null and we fell back to T0 (approximate). */
  legacy: boolean;
};

/** The bounds-widening inputs the parent folds into computeReplayBounds so the
 *  playhead window covers media that begins before the first stroke / ends after
 *  the last one. */
export type ReplayMediaBounds = {
  starts: number[];
  ends: number[];
};

/** What `useReplayMedia` hands back to the player + transport. */
export type ReplayMediaState = {
  /** mic / screen-audio tracks → the chooser enables "Audio" only when > 0. */
  hasAudio: boolean;
  /** a screen-video track exists → enables "Screen". */
  hasScreen: boolean;
  /** any track placed by the legacy null-started_at_ms fallback (label it). */
  hasLegacy: boolean;
  /** distinct mic speakers (id == transcript socketId where available), for the
   *  chooser/solo affordances. Empty in canvas/screen mode is fine. */
  audioSpeakers: { id: string; name: string }[];
  /** `started_at_ms` / end candidates to WIDEN the playhead window via
   *  computeReplayBounds(entries, { starts, ends }). Memoised + stable. */
  bounds: ReplayMediaBounds;
  /** object URL for the active screen-video (screen mode), else null — the
   *  parent binds this to the floating <video>. */
  screenUrl: string | null;
  /** true while the screen-video blob is still being fetched (show a spinner). */
  screenLoading: boolean;
  /** ref the parent attaches to the floating <video> so the sync loop can drive
   *  its currentTime / play / pause. */
  screenVideoRef: React.RefObject<HTMLVideoElement | null>;
  /** the resolved screen track (for its window / duration), or null. */
  screenTrack: MediaTrack | null;
};

const kindOf = (r: Recording): Recording["kind"] => r.kind ?? "mixed";
const isMicLike = (r: Recording): boolean => {
  const k = kindOf(r);
  return k === "mic" || k === "screen-audio";
};
const isScreenVideo = (r: Recording): boolean => kindOf(r) === "screen-video";

/** Resolve a recording row onto the absolute timeline. `t0` is the playhead
 *  window start used as the legacy fallback anchor (design §4 / §5). */
const toTrack = (rec: Recording, t0: number): MediaTrack => {
  const durationSec = Math.max(0, rec.duration ?? 0);
  const legacy =
    rec.started_at_ms == null || !Number.isFinite(rec.started_at_ms);
  const startMs = legacy ? t0 : (rec.started_at_ms as number);
  const endMs = startMs + durationSec * 1000;
  return { rec, startMs, endMs, durationSec, legacy };
};

/** Local element time (seconds) for a track at absolute `playheadT`, clamped to
 *  [0, duration]. */
const localTimeSec = (track: MediaTrack, playheadT: number): number => {
  const raw = (playheadT - track.startMs) / 1000;
  if (raw < 0) {
    return 0;
  }
  if (raw > track.durationSec) {
    return track.durationSec;
  }
  return raw;
};

/** Is the playhead inside a track's playable window? */
const inWindow = (track: MediaTrack, playheadT: number): boolean =>
  playheadT >= track.startMs && playheadT <= track.endMs;

/** Should we have the element MOUNTED (buffered) for this track? In-window, or
 *  within the small look-ahead before it / linger after it. Keeps memory bounded
 *  to the tracks actually near the playhead. */
const nearWindow = (track: MediaTrack, playheadT: number): boolean =>
  playheadT >= track.startMs - LOOKAHEAD_MS &&
  playheadT <= track.endMs + LINGER_MS;

/** One mounted audio element + its lazily-loaded object URL. */
type AudioSlot = {
  track: MediaTrack;
  el: HTMLAudioElement;
  /** object URL once the gated blob has loaded; null while loading. */
  url: string | null;
  /** guards against double-fetching the same slot. */
  loading: boolean;
};

/**
 * The play-along sync engine.
 *
 * @param recordings  rows from `listRecordings` ([] for a non-authority viewer
 *                    or canvas-only meeting → the chooser collapses to Canvas).
 * @param mode        which media plays alongside the canvas.
 * @param soloId      speaker id to solo in audio mode (null = mix everyone).
 * @param t0          playhead window start (epoch ms) — legacy fallback anchor.
 * @param playheadT   the single absolute-ms playhead (canvas-owned).
 * @param playing     whether the rAF clock is advancing.
 * @param speed       playback rate multiplier.
 */
export const useReplayMedia = ({
  recordings,
  mode,
  soloId,
  t0,
  playheadT,
  playing,
  speed,
}: {
  recordings: readonly Recording[];
  mode: ReplayMediaMode;
  soloId: string | null;
  t0: number;
  playheadT: number;
  playing: boolean;
  speed: number;
}): ReplayMediaState => {
  // --- resolve rows onto the timeline (only `ready` rows are playable) -------
  const audioTracks = useMemo<MediaTrack[]>(
    () =>
      recordings
        .filter((r) => r.status === "ready" && isMicLike(r))
        .map((r) => toTrack(r, t0))
        .sort((a, b) => a.startMs - b.startMs),
    [recordings, t0],
  );

  const screenTrack = useMemo<MediaTrack | null>(() => {
    const row = recordings.find(
      (r) => r.status === "ready" && isScreenVideo(r),
    );
    return row ? toTrack(row, t0) : null;
  }, [recordings, t0]);

  // Capabilities + bounds-widening candidates (stable: memoised on the tracks).
  const hasAudio = audioTracks.length > 0;
  const hasScreen = screenTrack !== null;
  const hasLegacy =
    audioTracks.some((tr) => tr.legacy) || (screenTrack?.legacy ?? false);

  const audioSpeakers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tr of audioTracks) {
      if (kindOf(tr.rec) !== "mic") {
        continue; // screen-audio is not a "speaker"
      }
      const id = tr.rec.speaker_id || tr.rec.id;
      if (!seen.has(id)) {
        seen.set(id, tr.rec.speaker_name || tr.rec.speaker_id || id);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [audioTracks]);

  const bounds = useMemo<ReplayMediaBounds>(() => {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const tr of audioTracks) {
      starts.push(tr.startMs);
      ends.push(tr.endMs);
    }
    if (screenTrack) {
      starts.push(screenTrack.startMs);
      ends.push(screenTrack.endMs);
    }
    return { starts, ends };
  }, [audioTracks, screenTrack]);

  // --- audio elements: a map keyed by recording id -------------------------
  // We hold the live elements in a ref (imperative DOM, never React children) so
  // re-renders from the rAF-driven playhead don't tear them down. Each slot is
  // created on demand (near-window) and revoked when it leaves the window.
  const audioSlotsRef = useRef<Map<string, AudioSlot>>(new Map());
  // Bump to force a re-render when a slot's loading state changes (so the player
  // can reflect e.g. a screen spinner). Audio slots don't need to surface state.
  const [, forceRerender] = useState(0);

  // Always-fresh mirrors for the interval loop (which closes over one render).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const soloRef = useRef(soloId);
  soloRef.current = soloId;
  const playheadRef = useRef(playheadT);
  playheadRef.current = playheadT;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Tear down + revoke a single audio slot.
  const destroyAudioSlot = useCallback((id: string) => {
    const slot = audioSlotsRef.current.get(id);
    if (!slot) {
      return;
    }
    try {
      slot.el.pause();
      slot.el.removeAttribute("src");
      slot.el.load();
    } catch {
      /* element teardown is best-effort */
    }
    if (slot.url) {
      URL.revokeObjectURL(slot.url);
    }
    audioSlotsRef.current.delete(id);
  }, []);

  // Tear down ALL audio slots (mode switch / unmount).
  const destroyAllAudio = useCallback(() => {
    for (const id of Array.from(audioSlotsRef.current.keys())) {
      destroyAudioSlot(id);
    }
  }, [destroyAudioSlot]);

  // --- screen video: a single element the PARENT renders (floating pane) ----
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenLoading, setScreenLoading] = useState(false);
  const screenUrlRef = useRef<string | null>(null);
  screenUrlRef.current = screenUrl;
  // The screen-video id currently loaded (so we don't refetch on every render).
  const loadedScreenIdRef = useRef<string | null>(null);

  // ── ensure the right elements exist for the current mode + playhead ───────
  // Runs whenever the playhead / mode / tracks change. Builds near-window slots,
  // lazily loads their gated blob, and destroys slots that have left the window.
  // No element plays here — the sync effect below owns play/pause/seek.
  useEffect(() => {
    if (mode !== "audio") {
      // Leaving audio mode → drop every mic element + blob immediately.
      if (audioSlotsRef.current.size > 0) {
        destroyAllAudio();
      }
      return;
    }

    const wanted = new Set<string>();
    for (const track of audioTracks) {
      if (!nearWindow(track, playheadT)) {
        continue;
      }
      wanted.add(track.rec.id);
      if (audioSlotsRef.current.has(track.rec.id)) {
        continue;
      }
      // Create the element now; fetch its gated blob lazily.
      const el = new Audio();
      el.preload = "auto";
      el.playbackRate = speedRef.current;
      const slot: AudioSlot = { track, el, url: null, loading: true };
      audioSlotsRef.current.set(track.rec.id, slot);
      void (async () => {
        const url = await fetchRecordingObjectUrl(track.rec.id);
        const current = audioSlotsRef.current.get(track.rec.id);
        // The slot may have been torn down while the fetch was in flight.
        if (!current || current !== slot) {
          if (url) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        if (!url) {
          current.loading = false;
          return;
        }
        current.url = url;
        current.loading = false;
        current.el.src = url;
        // Let the next sync tick position + play it; nudge to target now so a
        // freshly-loaded in-window track starts at the right offset.
        current.el.currentTime = localTimeSec(track, playheadRef.current);
        forceRerender((n) => n + 1);
      })();
    }

    // Destroy any slot no longer near the playhead window.
    for (const id of Array.from(audioSlotsRef.current.keys())) {
      if (!wanted.has(id)) {
        destroyAudioSlot(id);
      }
    }
  }, [mode, audioTracks, playheadT, destroyAllAudio, destroyAudioSlot]);

  // ── load / unload the screen-video blob for screen mode ──────────────────
  useEffect(() => {
    if (mode !== "screen" || !screenTrack) {
      // Leaving screen mode → revoke the buffered video blob.
      if (screenUrlRef.current) {
        URL.revokeObjectURL(screenUrlRef.current);
        setScreenUrl(null);
      }
      loadedScreenIdRef.current = null;
      setScreenLoading(false);
      return;
    }
    // Only (re)load when the active screen track changes.
    if (loadedScreenIdRef.current === screenTrack.rec.id) {
      return;
    }
    let cancelled = false;
    loadedScreenIdRef.current = screenTrack.rec.id;
    setScreenLoading(true);
    void (async () => {
      const url = await fetchRecordingObjectUrl(screenTrack.rec.id);
      if (cancelled) {
        if (url) {
          URL.revokeObjectURL(url);
        }
        return;
      }
      // Revoke a previously-loaded screen blob, then swap in the new one.
      if (screenUrlRef.current) {
        URL.revokeObjectURL(screenUrlRef.current);
      }
      setScreenUrl(url);
      setScreenLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, screenTrack]);

  // ── the SYNC heartbeat: position + play/pause every active element ───────
  // One function, called both on an interval (while playing, for drift nudges)
  // and synchronously on every playhead/mode change (so a scrub lands frames).
  const syncNow = useCallback(() => {
    const head = playheadRef.current;
    const isPlaying = playingRef.current;
    const rate = speedRef.current;
    const m = modeRef.current;
    const solo = soloRef.current;

    if (m === "audio") {
      for (const slot of audioSlotsRef.current.values()) {
        const { el, track } = slot;
        if (!slot.url) {
          continue; // still loading — the loader will seed currentTime
        }
        const active = inWindow(track, head);
        // SOLO: a mic that isn't the soloed speaker is silenced (paused). Only
        // applies to mic kind; screen-audio always follows the window.
        const isMic = kindOf(track.rec) === "mic";
        const soloed =
          solo && isMic
            ? (track.rec.speaker_id || track.rec.id) === solo
            : true;
        const shouldPlay = active && isPlaying && soloed;
        const target = localTimeSec(track, head);

        if (el.playbackRate !== rate) {
          el.playbackRate = rate;
        }
        // Nudge only on meaningful drift so native playback stays smooth.
        if (Math.abs(el.currentTime - target) * 1000 > NUDGE_THRESHOLD_MS) {
          try {
            el.currentTime = target;
          } catch {
            /* seeking a not-yet-ready element is a no-op */
          }
        }
        if (shouldPlay) {
          if (el.paused) {
            void el.play().catch(() => {
              /* autoplay can reject; the next tick retries */
            });
          }
        } else if (!el.paused) {
          el.pause();
        }
      }
      return;
    }

    if (m === "screen") {
      const el = screenVideoRef.current;
      const track = screenTrack;
      if (!el || !track || !screenUrlRef.current) {
        return;
      }
      const active = inWindow(track, head);
      const target = localTimeSec(track, head);
      if (el.playbackRate !== rate) {
        el.playbackRate = rate;
      }
      if (Math.abs(el.currentTime - target) * 1000 > NUDGE_THRESHOLD_MS) {
        try {
          el.currentTime = target;
        } catch {
          /* not ready yet */
        }
      }
      if (active && isPlaying) {
        if (el.paused) {
          void el.play().catch(() => {
            /* retried next tick */
          });
        }
      } else if (!el.paused) {
        el.pause();
      }
    }
  }, [screenTrack]);

  // Sync synchronously on every playhead / mode / solo / playing / speed change
  // (covers scrubs + play/pause/solo toggles landing immediately).
  useEffect(() => {
    syncNow();
  }, [syncNow, playheadT, mode, soloId, playing, speed, screenUrl]);

  // While playing, run the drift-correcting heartbeat every SYNC_INTERVAL_MS.
  // Native playback advances currentTime on its own; this only nudges on drift.
  useEffect(() => {
    if (!playing || mode === "canvas") {
      return;
    }
    const id = window.setInterval(syncNow, SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, mode, syncNow]);

  // Pause everything the moment the playhead stops advancing (covers reaching
  // the end / an external pause that the heartbeat would otherwise miss).
  useEffect(() => {
    if (playing) {
      return;
    }
    for (const slot of audioSlotsRef.current.values()) {
      if (!slot.el.paused) {
        slot.el.pause();
      }
    }
    const sv = screenVideoRef.current;
    if (sv && !sv.paused) {
      sv.pause();
    }
  }, [playing]);

  // Teardown on unmount: pause + revoke every blob so nothing leaks.
  useEffect(
    () => () => {
      destroyAllAudio();
      if (screenUrlRef.current) {
        URL.revokeObjectURL(screenUrlRef.current);
      }
    },
    [destroyAllAudio],
  );

  return {
    hasAudio,
    hasScreen,
    hasLegacy,
    audioSpeakers,
    bounds,
    screenUrl,
    screenLoading,
    screenVideoRef,
    screenTrack,
  };
};

export default useReplayMedia;
