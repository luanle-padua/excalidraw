// REPLAY MEDIA SYNC — the P3 "play-along" engine (unified-replay-ux.md §3, §4).
//
// Given the meeting's recordings and the single absolute-ms playhead clock, this
// hook keeps a small set of native <audio>/<video> elements in lockstep with the
// canvas timeline WITHOUT a Web Audio graph, a server mixdown, or a second
// transport. The canvas (P1) owns timekeeping — it advances `playheadT` via rAF;
// media here is a FOLLOWER that plays natively for smoothness and is only nudged
// back onto the playhead when it drifts past a threshold.
//
// ── ADDITIVE LAYERS, NOT AN EXCLUSIVE MODE (06-25 owner refinement) ──────────
// The canvas is ALWAYS the base. Audio and Screen are INDEPENDENT on/off layers
// stacked on top — any combination (Canvas alone, Canvas+Audio, Canvas+Screen,
// or all three) is valid. So instead of one `mode`, this hook takes two booleans
// `audioOn` + `screenOn`, and the two layers never gate each other.
//
//   • AUDIO layer  = per-speaker `mic` tracks ONLY (the meeting voices).
//   • SCREEN layer = `screen-video` (the floating pane) PLUS `screen-audio`
//     (the sound of the shared window). `screen-audio` is bound to the SCREEN
//     toggle — it is the screen's own sound, never folded into the mic mix.
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
// ── WHAT PLAYS, BY LAYER (§3) ────────────────────────────────────────────────
//   • AUDIO layer ON  → EVERY in-window `mic` element plays at once; the BROWSER
//     mixes them (no graph). SOLO: if a speakerId is soloed, only that speaker's
//     mic is audible (others paused). `screen-audio` is NOT here.
//   • SCREEN layer ON → the single `screen-video` track plays in a floating
//     <video> AND the `screen-audio` track plays through a hidden <audio>; both
//     seek to the same playhead. They live and die with `screenOn`.
//   • Both OFF        → nothing here; the parent renders the vector replay alone.
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
// `fetchRecordingObjectUrl` and REVOKED on teardown / layer-toggle-off /
// out-of-window so a 15-mic meeting never holds every speaker's blob at once.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchRecordingObjectUrl, type Recording } from "../../data/recordings";

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
  /** mic tracks → the chooser enables the "Audio" toggle only when > 0. */
  hasAudio: boolean;
  /** a screen-video track exists → enables the "Screen" toggle + drives the
   *  auto-show default (the parent flips screenOn on when this is true). */
  hasScreen: boolean;
  /** a screen-audio track exists (the shared window's sound) — informational; it
   *  is bound to the Screen layer, not surfaced as its own toggle. */
  hasScreenAudio: boolean;
  /** any track placed by the legacy null-started_at_ms fallback (label it). */
  hasLegacy: boolean;
  /** distinct mic speakers (id == transcript socketId where available), for the
   *  chooser/solo affordances. Empty when audio is off is fine. */
  audioSpeakers: { id: string; name: string }[];
  /** `started_at_ms` / end candidates to WIDEN the playhead window via
   *  computeReplayBounds(entries, { starts, ends }). Memoised + stable. */
  bounds: ReplayMediaBounds;
  /** object URL for the active screen-video (screen layer), else null — the
   *  parent binds this to the floating <video>. */
  screenUrl: string | null;
  /** true while the screen-video blob is still being fetched (show a spinner). */
  screenLoading: boolean;
  /** ref the parent attaches to the floating <video> so the sync loop can drive
   *  its currentTime / play / pause. */
  screenVideoRef: React.RefObject<HTMLVideoElement | null>;
  /** the resolved screen-video track (for its window / duration), or null. */
  screenTrack: MediaTrack | null;
  /** true when the playhead is currently INSIDE the screen-video window — the
   *  parent uses this to AUTO-SHOW / hide the floating pane while the Screen
   *  layer is on (§ 06-25 owner refinement 3). */
  screenInWindow: boolean;
};

const kindOf = (r: Recording): Recording["kind"] => r.kind ?? "mixed";
/** AUDIO layer source: per-speaker mic ONLY. screen-audio is deliberately NOT
 *  here — it belongs to the Screen layer (06-25 refinement 2). `mixed` legacy
 *  single-file rows are treated as mic-equivalent voices so old meetings still
 *  play their audio under the Audio toggle. */
const isMicLike = (r: Recording): boolean => {
  const k = kindOf(r);
  return k === "mic" || k === "mixed";
};
const isScreenVideo = (r: Recording): boolean => kindOf(r) === "screen-video";
/** SCREEN layer's sound: the shared window's audio, bound to the screen toggle. */
const isScreenAudio = (r: Recording): boolean => kindOf(r) === "screen-audio";

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
 *                    or canvas-only meeting → both layers stay off + disabled).
 * @param audioOn     whether the AUDIO layer (per-speaker mics) is playing.
 * @param screenOn    whether the SCREEN layer (screen-video + screen-audio) is on.
 * @param soloId      speaker id to solo in the audio layer (null = mix everyone).
 * @param t0          playhead window start (epoch ms) — legacy fallback anchor.
 * @param playheadT   the single absolute-ms playhead (canvas-owned).
 * @param playing     whether the rAF clock is advancing.
 * @param speed       playback rate multiplier.
 */
export const useReplayMedia = ({
  recordings,
  audioOn,
  screenOn,
  soloId,
  t0,
  playheadT,
  playing,
  speed,
}: {
  recordings: readonly Recording[];
  audioOn: boolean;
  screenOn: boolean;
  soloId: string | null;
  t0: number;
  playheadT: number;
  playing: boolean;
  speed: number;
}): ReplayMediaState => {
  // --- resolve rows onto the timeline (only `ready` rows are playable) -------
  // AUDIO layer tracks = mic (+ legacy mixed) only.
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

  // SCREEN layer's own sound — its own track, bound to the screen toggle.
  const screenAudioTrack = useMemo<MediaTrack | null>(() => {
    const row = recordings.find(
      (r) => r.status === "ready" && isScreenAudio(r),
    );
    return row ? toTrack(row, t0) : null;
  }, [recordings, t0]);

  // Capabilities + bounds-widening candidates (stable: memoised on the tracks).
  const hasAudio = audioTracks.length > 0;
  const hasScreen = screenTrack !== null;
  const hasScreenAudio = screenAudioTrack !== null;
  const hasLegacy =
    audioTracks.some((tr) => tr.legacy) ||
    (screenTrack?.legacy ?? false) ||
    (screenAudioTrack?.legacy ?? false);

  const audioSpeakers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tr of audioTracks) {
      if (kindOf(tr.rec) !== "mic") {
        continue; // only mic rows carry a per-speaker identity
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
    if (screenAudioTrack) {
      starts.push(screenAudioTrack.startMs);
      ends.push(screenAudioTrack.endMs);
    }
    return { starts, ends };
  }, [audioTracks, screenTrack, screenAudioTrack]);

  // The playhead is inside the screen window → the parent auto-shows the pane.
  const screenInWindow = screenTrack
    ? inWindow(screenTrack, playheadT)
    : false;

  // --- audio elements: a map keyed by recording id -------------------------
  // We hold the live elements in a ref (imperative DOM, never React children) so
  // re-renders from the rAF-driven playhead don't tear them down. Each slot is
  // created on demand (near-window) and revoked when it leaves the window. The
  // map serves BOTH the Audio layer (mic slots) and the Screen layer's audio
  // (the single screen-audio slot); whether a slot is wanted is gated per kind.
  const audioSlotsRef = useRef<Map<string, AudioSlot>>(new Map());
  // Bump to force a re-render when a slot's loading state changes (so the player
  // can reflect e.g. a screen spinner). Audio slots don't need to surface state.
  const [, forceRerender] = useState(0);

  // Always-fresh mirrors for the interval loop (which closes over one render).
  const audioOnRef = useRef(audioOn);
  audioOnRef.current = audioOn;
  const screenOnRef = useRef(screenOn);
  screenOnRef.current = screenOn;
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

  // Tear down ALL audio slots (full unmount).
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

  // ── ensure the right media elements exist for the current layers + playhead ─
  // Runs whenever the playhead / layer toggles / tracks change. Builds the
  // near-window slots that the ON layers want (mic slots iff audioOn; the
  // screen-audio slot iff screenOn), lazily loads each gated blob, and destroys
  // slots no longer wanted (out of window OR their layer turned off). No element
  // plays here — the sync effect below owns play/pause/seek.
  useEffect(() => {
    const wanted = new Set<string>();

    // AUDIO layer → near-window mic slots.
    if (audioOn) {
      for (const track of audioTracks) {
        if (!nearWindow(track, playheadT)) {
          continue;
        }
        wanted.add(track.rec.id);
      }
    }
    // SCREEN layer's sound → the near-window screen-audio slot (if any).
    if (screenOn && screenAudioTrack && nearWindow(screenAudioTrack, playheadT)) {
      wanted.add(screenAudioTrack.rec.id);
    }

    // Build any wanted slot that doesn't yet exist.
    const buildSlot = (track: MediaTrack) => {
      if (audioSlotsRef.current.has(track.rec.id)) {
        return;
      }
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
    };

    if (audioOn) {
      for (const track of audioTracks) {
        if (nearWindow(track, playheadT)) {
          buildSlot(track);
        }
      }
    }
    if (screenOn && screenAudioTrack && nearWindow(screenAudioTrack, playheadT)) {
      buildSlot(screenAudioTrack);
    }

    // Destroy any slot no longer wanted (left the window OR its layer is off).
    for (const id of Array.from(audioSlotsRef.current.keys())) {
      if (!wanted.has(id)) {
        destroyAudioSlot(id);
      }
    }
  }, [
    audioOn,
    screenOn,
    audioTracks,
    screenAudioTrack,
    playheadT,
    destroyAudioSlot,
  ]);

  // ── load / unload the screen-video blob for the screen layer ─────────────
  useEffect(() => {
    if (!screenOn || !screenTrack) {
      // Screen layer off → revoke the buffered video blob.
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
  }, [screenOn, screenTrack]);

  // ── the SYNC heartbeat: position + play/pause every active element ───────
  // One function, called both on an interval (while playing, for drift nudges)
  // and synchronously on every playhead/layer change (so a scrub lands frames).
  const syncNow = useCallback(() => {
    const head = playheadRef.current;
    const isPlaying = playingRef.current;
    const rate = speedRef.current;
    const aOn = audioOnRef.current;
    const sOn = screenOnRef.current;
    const solo = soloRef.current;
    const screenAudioId = screenAudioTrack?.rec.id ?? null;

    // Every mounted <audio> slot — mic slots (Audio layer) + the screen-audio
    // slot (Screen layer). Each is gated by ITS layer's toggle.
    for (const slot of audioSlotsRef.current.values()) {
      const { el, track } = slot;
      if (!slot.url) {
        continue; // still loading — the loader will seed currentTime
      }
      const isScreenSound = track.rec.id === screenAudioId;
      const layerOn = isScreenSound ? sOn : aOn;
      const active = inWindow(track, head);
      // SOLO applies only to the Audio layer's mic tracks (not screen-audio).
      const isMic = !isScreenSound && kindOf(track.rec) === "mic";
      const soloed =
        solo && isMic
          ? (track.rec.speaker_id || track.rec.id) === solo
          : true;
      const shouldPlay = layerOn && active && isPlaying && soloed;
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

    // SCREEN layer's video (the floating pane element the parent renders).
    {
      const el = screenVideoRef.current;
      const track = screenTrack;
      if (sOn && el && track && screenUrlRef.current) {
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
        // The video carries NO sound (screen-audio is its own <audio> track);
        // mute it so it never double-plays the shared window's audio.
        el.muted = true;
        if (active && isPlaying) {
          if (el.paused) {
            void el.play().catch(() => {
              /* retried next tick */
            });
          }
        } else if (!el.paused) {
          el.pause();
        }
      } else if (el && !el.paused) {
        el.pause();
      }
    }
  }, [screenTrack, screenAudioTrack]);

  // Sync synchronously on every playhead / layer / solo / playing / speed change
  // (covers scrubs + play/pause/toggle/solo landing immediately).
  useEffect(() => {
    syncNow();
  }, [syncNow, playheadT, audioOn, screenOn, soloId, playing, speed, screenUrl]);

  // While playing with at least one media layer on, run the drift-correcting
  // heartbeat every SYNC_INTERVAL_MS. Native playback advances currentTime on
  // its own; this only nudges on drift.
  useEffect(() => {
    if (!playing || (!audioOn && !screenOn)) {
      return;
    }
    const id = window.setInterval(syncNow, SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, audioOn, screenOn, syncNow]);

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
    hasScreenAudio,
    hasLegacy,
    audioSpeakers,
    bounds,
    screenUrl,
    screenLoading,
    screenVideoRef,
    screenTrack,
    screenInWindow,
  };
};

export default useReplayMedia;
