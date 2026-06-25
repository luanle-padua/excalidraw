// Client-side meeting recorders (06-24 pivot to PER-SOURCE / per-speaker, #23).
//
// We no longer mix mic + every peer + screen-audio into ONE file. Instead each
// source is recorded SEPARATELY so the downstream pipeline (STT / diarization /
// translate / summary) gets a clean per-speaker stream:
//
//   • MicRecorder        — EVERY participant records ONLY their own local mic
//                          (mono opus ~32 kbps, audio-only). This is the local,
//                          pre-network mic → the cleanest possible per-speaker
//                          audio. `stop()` returns null when the mic was silent
//                          the whole time (see skip-silent) so we upload nothing.
//   • ScreenAudioRecorder — the SESSION OWNER records a shared window's tab/system
//                          audio (Daily "screenAudio") as its own mono opus file
//                          (~48 kbps), when a share actually carries audio.
//   • ScreenVideoRecorder — the SESSION OWNER (opt-in) records the screen-share
//                          VIDEO via the CANVAS COMPOSITOR (VP8 ~1.5 Mbps). This is
//                          its own file now — NOT mixed with any mic. It may carry
//                          the screen-audio track too (so the video has sound), but
//                          the mics are never in it.
//
// All three recorders for one Record→Stop press share a single `sessionId` so the
// per-source files can be re-aligned on a timeline later. Each uploads with its
// own `kind` (mic / screen-audio / screen-video) via data/recordings.ts.
//
// THE CANVAS COMPOSITOR (fixes "share started after Record = no video").
//   MediaRecorder ONLY records the tracks that exist on its stream at the moment
//   start() was called — a track added later is ignored. So naively starting a
//   recorder and adding the screen track when a share begins silently drops any
//   mid-record share. The compositor sidesteps this:
//     - At start() we create an offscreen <canvas> and record a CONSTANT video
//       track from canvas.captureStream(fps). That single canvas track is on the
//       stream from start() → MediaRecorder always has a video track to record.
//     - A throttled rAF loop draws the CURRENT screen-share frame onto the canvas
//       (letterboxed/contain), or a neutral dark placeholder when nobody shares.
//     - The screen source is fed through an offscreen <video> (muted/autoplay/
//       playsInline) whose srcObject is the active screen stream. setScreenStream
//       just swaps that srcObject → starting/stopping a share mid-record is
//       SEAMLESS: the recorded canvas track never changes, only its content does.
//
// The result blobs are uploaded to R2 (data/recordings.ts → PUT upload route) and
// indexed in the `recording` D1 table (now with a `kind` + `session_id`), so
// review-mode (RecordingsSection) plays them back through the SAME gated stream
// route as before — only the container/kind changed.

import { fixWebmDuration } from "./fixWebmDuration";
import { makeWebmSeekable } from "./makeWebmSeekable";

// ---------------------------------------------------------------------------
// Codec selection (mirrors the old pickMime logic).
//
// AUDIO recorders (mic, screen-audio) want a plain audio/webm opus container.
// The VIDEO recorder wants a video/webm container whose VIDEO codec is VP8 —
// VP8 BEFORE VP9, ON PURPOSE. Recordings WITH the screen-compositor video track
// came out SILENT under VP9: Chromium's real-time VP9 encoder, under load, fails
// to interleave the Opus audio track into the muxed WebM → video-but-no-audio.
// The lighter VP8 encoder doesn't starve the audio path. (We keep vp9 as a
// last-ditch entry only if a browser somehow lacks vp8.)
const AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  // Some browsers only advertise opus under a video container; still records
  // audio-only fine (the container simply carries no video track).
  "video/webm;codecs=opus",
  "video/webm",
];

const VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

/** Pick the first supported mime from a preference list, or undefined if the
 *  platform has no MediaRecorder / supports none of them (UA default is used). */
const pickMime = (preferred: readonly string[]): string | undefined => {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  for (const t of preferred) {
    if (MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Bitrates per kind. Audio-only files are deliberately tiny (per-speaker voice,
// not music): mono opus is intelligible for STT at these rates. Video is the
// review-quality ~480p15 screen share.
const MIC_AUDIO_BPS = 32_000; // mono opus voice → small, STT-clean
const SCREEN_AUDIO_BPS = 48_000; // mono opus tab/system audio
const SCREEN_VIDEO_BPS = 1_500_000; // ~480p15 screen share (VP8)

// Compositor video config — deliberately small/low-fps to match the existing
// low-bitrate intent (review/docs-sized 480p files, not broadcast quality).
const COMPOSITOR_WIDTH = 854; // ~480p 16:9
const COMPOSITOR_HEIGHT = 480;
const COMPOSITOR_FPS = 15;

// ---------------------------------------------------------------------------
// Skip-silent heuristic (MicRecorder.stop()).
//
// A muted / never-spoke mic still produces a tiny opus stream (container header +
// keep-alive frames of near-silence). Opus encodes silence VERY cheaply, so a
// genuinely-silent recording stays far below the byte rate of any real speech.
// We therefore gate on the BLOB'S BYTES-PER-SECOND: if the file averaged fewer
// than MIC_SILENCE_BYTES_PER_SEC, treat it as "no meaningful audio" → return null
// so the Lead uploads NOTHING (no empty row). We also reject any blob under an
// absolute floor (header-only / 0-byte) regardless of duration.
//
// Threshold rationale: 32 kbps opus = 4000 bytes/sec at full voice. Silence/
// comfort-noise opus runs roughly an order of magnitude lower. 600 bytes/sec sits
// comfortably between the two — well under real speech, well over pure silence —
// so a brief utterance is KEPT while a whole-meeting-muted mic is DROPPED. The
// absolute floor (2048 bytes) catches very short clips where the per-second
// average is noisy.
const MIC_SILENCE_BYTES_PER_SEC = 600;
const MIC_MIN_BYTES = 2048;

/** Decide whether a finished mic blob carries meaningful audio. Exported so the
 *  heuristic is testable / inspectable; used by MicRecorder.stop(). */
export const micBlobHasAudio = (blob: Blob, durationMs: number): boolean => {
  if (blob.size < MIC_MIN_BYTES) {
    return false;
  }
  const seconds = Math.max(durationMs / 1000, 0.001);
  const bytesPerSec = blob.size / seconds;
  return bytesPerSec >= MIC_SILENCE_BYTES_PER_SEC;
};

// ---------------------------------------------------------------------------
// Shared helpers.

export type RecordingResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

/** Post-process a freshly stopped WebM blob into a SEEKABLE one (so the review
 *  player's slider can drag). Raced against a hard timeout + fail-soft to the raw
 *  blob — stopping must NEVER hang on post-processing. Shared by every recorder. */
const finalizeWebm = async (
  rawBlob: Blob,
  mimeType: string,
  durationMs: number,
): Promise<Blob> => {
  if (!mimeType.includes("webm") || rawBlob.size === 0) {
    return rawBlob;
  }
  try {
    return await Promise.race([
      (async () => {
        const seekable = await makeWebmSeekable(rawBlob);
        if (seekable) {
          return seekable;
        }
        // Seekable remux unavailable — at least patch the Duration readout.
        return fixWebmDuration(rawBlob, durationMs);
      })(),
      new Promise<Blob>((r) => window.setTimeout(() => r(rawBlob), 6000)),
    ]);
  } catch {
    return rawBlob;
  }
};

/**
 * Minimal MediaRecorder lifecycle shared by the audio recorders. Records ONE
 * given MediaStream, collects chunks, and resolves a finalized (seekable) blob
 * on stop(). The Stop flow can NEVER hang the UI: it resolves exactly once from
 * whichever path fires first (onstop / already-inactive / a throwing stop() / a
 * hard safety timeout).
 */
class StreamRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  // Absolute wall-clock instant (Date.now(), epoch ms) at which this recorder's
  // MediaRecorder.start() ACTUALLY fired — the true bytes-begin moment, used to
  // place the track on the unified-replay timeline (#28). null until start().
  private startedAtMs: number | null = null;
  private readonly mimeType: string | undefined;
  private readonly audioBps: number;

  constructor(audioBps: number, mimeType: string | undefined) {
    this.audioBps = audioBps;
    this.mimeType = mimeType;
  }

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== "inactive";
  }

  elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  /** Epoch-ms wall-clock instant capture actually began, or null before start(). */
  startedAtMsValue(): number | null {
    return this.startedAtMs;
  }

  /** Begin recording the given stream. Throws if MediaRecorder init fails. */
  start(stream: MediaStream): void {
    if (this.recorder) {
      return;
    }
    const options: MediaRecorderOptions = { audioBitsPerSecond: this.audioBps };
    if (this.mimeType) {
      options.mimeType = this.mimeType;
    }
    try {
      this.recorder = new MediaRecorder(stream, options);
    } catch (err) {
      throw new Error(
        `MediaRecorder init failed: ${(err as Error)?.message ?? err}`,
      );
    }
    this.chunks = [];
    this.startedAt = performance.now();
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };
    this.recorder.onerror = (e) => {
      console.error("[recorder] error", (e as any)?.error ?? e);
    };
    // chunk every second so a long recording doesn't pin one monolithic blob.
    // Stamp the absolute capture-start instant at the exact line start() fires —
    // this is the true bytes-begin moment for the replay timeline (#28).
    this.startedAtMs = Date.now();
    this.recorder.start(1000);
  }

  /** Stop and resolve the finalized blob (raw chunks → seekable WebM). */
  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new Error("recording was never started"));
        return;
      }
      let settled = false;
      const finish = async () => {
        if (settled) {
          return;
        }
        settled = true;
        const mimeType =
          recorder.mimeType || this.mimeType || "audio/webm";
        const rawBlob = new Blob(this.chunks, { type: mimeType });
        const durationMs = performance.now() - this.startedAt;
        const blob = await finalizeWebm(rawBlob, mimeType, durationMs);
        this.chunks = [];
        this.recorder = null;
        this.startedAt = 0;
        resolve({ blob, mimeType: blob.type || mimeType, durationMs });
      };
      recorder.onstop = () => void finish();
      if (recorder.state === "inactive") {
        // An already-inactive recorder (auto-stopped on error / ended track)
        // will NOT fire onstop when we call stop() → finish now.
        void finish();
      } else {
        try {
          recorder.stop();
        } catch {
          void finish();
        }
      }
      // Hard safety net: resolve even if onstop somehow never fires.
      window.setTimeout(() => void finish(), 8000);
    });
  }

  /** Synchronously stop the recorder (release the capture) without awaiting a
   *  blob — for unload/teardown. We never stop the caller's stream tracks; the
   *  stream's owner (audio room / screen-share controller) owns their lifecycle. */
  close(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.startedAtMs = null;
  }
}

// ===========================================================================
// MicRecorder — EVERY participant records ONLY their own local mic.
// ===========================================================================

/**
 * Records ONLY the local mic stream: mono opus ~32 kbps, audio-only (no canvas /
 * no video). Used by every participant for the duration of a recording session.
 *
 * Usage:
 *   const mic = new MicRecorder();
 *   mic.start(localMicStream);   // the device mic stream from the audio room
 *   ...
 *   const blob = await mic.stop(); // Blob | null  (null = nothing meaningful)
 *
 * On stop() the captured audio is run through the SKIP-SILENT heuristic
 * (micBlobHasAudio): if the mic was muted / silent the whole time the blob is
 * dropped and stop() resolves NULL so the Lead uploads NOTHING (no empty row).
 *
 * We force MONO by wrapping the mic stream's first audio track in a fresh
 * single-track MediaStream — a stereo mic still encodes mono opus at the chosen
 * bitrate. (Channel count is also implicitly mono for a typical device mic.)
 */
export class MicRecorder {
  private readonly inner = new StreamRecorder(
    MIC_AUDIO_BPS,
    pickMime(AUDIO_MIME_TYPES),
  );

  isRecording(): boolean {
    return this.inner.isRecording();
  }

  elapsedMs(): number {
    return this.inner.elapsedMs();
  }

  /** Epoch-ms wall-clock instant this mic's capture actually began (the moment
   *  MediaRecorder.start() fired), or null before start(). Used to align the
   *  per-speaker track on the unified-replay timeline (#28). */
  startedAtMs(): number | null {
    return this.inner.startedAtMsValue();
  }

  /** Start recording the participant's local mic. Pass the SAME device mic
   *  stream the audio room captured (we read its first audio track only). Throws
   *  if the stream has no audio track or MediaRecorder init fails. */
  start(localMicStream: MediaStream): void {
    const track = localMicStream.getAudioTracks()[0] ?? null;
    if (!track) {
      throw new Error("MicRecorder: stream has no audio track");
    }
    // Record exactly one audio track in its own MediaStream (audio-only, mono).
    this.inner.start(new MediaStream([track]));
  }

  /**
   * Stop and return the mic blob, or NULL when the captured audio has no
   * meaningful content (skip-silent). The Lead uploads only a non-null result.
   */
  async stop(): Promise<Blob | null> {
    const { blob, durationMs } = await this.inner.stop();
    if (!micBlobHasAudio(blob, durationMs)) {
      return null;
    }
    return blob;
  }

  /** Best-effort synchronous stop (unload) — discards any blob. */
  close(): void {
    this.inner.close();
  }
}

// ===========================================================================
// ScreenAudioRecorder — owner records a shared window's tab/system audio.
// ===========================================================================

/**
 * Records the shared window's AUDIO (Daily "screenAudio" — tab/system audio) as
 * its own file: mono opus ~48 kbps, audio-only. Owner-side, used only when a
 * share actually carries audio.
 *
 * Usage:
 *   const sa = new ScreenAudioRecorder();
 *   sa.start(screenAudioStream);   // the screenAudio MediaStream
 *   const blob = await sa.stop();  // Blob | null  (null = no audio track / empty)
 */
export class ScreenAudioRecorder {
  private readonly inner = new StreamRecorder(
    SCREEN_AUDIO_BPS,
    pickMime(AUDIO_MIME_TYPES),
  );

  isRecording(): boolean {
    return this.inner.isRecording();
  }

  elapsedMs(): number {
    return this.inner.elapsedMs();
  }

  /** Epoch-ms wall-clock instant this screen-audio capture actually began (the
   *  moment MediaRecorder.start() fired), or null before start(). Aligns the
   *  track on the unified-replay timeline (#28). */
  startedAtMs(): number | null {
    return this.inner.startedAtMsValue();
  }

  /** Start recording the shared window's audio. Throws if the stream has no
   *  audio track or MediaRecorder init fails. */
  start(screenAudioStream: MediaStream): void {
    const track = screenAudioStream.getAudioTracks()[0] ?? null;
    if (!track) {
      throw new Error("ScreenAudioRecorder: stream has no audio track");
    }
    this.inner.start(new MediaStream([track]));
  }

  /** Stop and return the screen-audio blob, or NULL if nothing was captured. */
  async stop(): Promise<Blob | null> {
    const { blob } = await this.inner.stop();
    return blob.size > 0 ? blob : null;
  }

  close(): void {
    this.inner.close();
  }
}

// ===========================================================================
// ScreenVideoRecorder — owner (opt-in) records the screen-share VIDEO.
// ===========================================================================

/** Options for a screen-video recording. */
export type ScreenVideoOptions = {
  /** Seed the compositor with whatever is being shared at start() (or null). The
   *  active share can also be (re)attached live via setScreenStream(). */
  initialScreenStream?: MediaStream | null;
  /** Optionally mux the shared window's audio INTO the video file so the video
   *  has sound (the mics are NEVER in it — they are separate per-speaker files).
   *  Pass null / omit for a silent (or screen-audio-recorded-separately) video. */
  screenAudioStream?: MediaStream | null;
};

/**
 * Records the screen-share VIDEO as its own file via the CANVAS COMPOSITOR
 * (VP8 ~1.5 Mbps, ~480p15). This is the EXISTING compositor path, preserved: a
 * share that starts/stops AFTER start() is still captured, because the recorded
 * track is a CONSTANT canvas track whose CONTENT we swap.
 *
 * This file is the VIDEO only (plus, optionally, the shared window's OWN audio so
 * the video has sound). It NEVER contains any mic — mics are separate per-speaker
 * MicRecorder files. Owner-side, opt-in.
 *
 * Usage:
 *   const sv = new ScreenVideoRecorder();
 *   await sv.start({ initialScreenStream, screenAudioStream });
 *   sv.setScreenStream(stream);       // live attach/detach the active share
 *   sv.setScreenAudioStream(stream);  // live attach/detach the shared audio
 *   const blob = await sv.stop();     // Blob | null  (null = nothing captured)
 */
export class ScreenVideoRecorder {
  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  /** The single screen-audio source feeding the (optional) muxed audio track. */
  private screenAudioSource: MediaStreamAudioSourceNode | null = null;

  private outputStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  // Absolute wall-clock instant (Date.now(), epoch ms) at which this recorder's
  // MediaRecorder.start() ACTUALLY fired — used to place the screen-video track
  // on the unified-replay timeline (#28). null until start().
  private startedAtMsValue: number | null = null;
  private mimeType: string | undefined;

  // ---- canvas compositor -------------------------------------------------
  private compositorOn = false;
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private canvasStream: MediaStream | null = null;
  private screenVideo: HTMLVideoElement | null = null;
  private hasActiveScreen = false;
  private rafId = 0;
  private lastDrawAt = 0;

  constructor() {
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    this.destination = this.ctx.createMediaStreamDestination();
  }

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== "inactive";
  }

  elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  hasScreen(): boolean {
    return this.hasActiveScreen;
  }

  /** Epoch-ms wall-clock instant this screen-video capture actually began (the
   *  moment MediaRecorder.start() fired), or null before start(). Aligns the
   *  track on the unified-replay timeline (#28). */
  startedAtMs(): number | null {
    return this.startedAtMsValue;
  }

  /**
   * Point the compositor at the CURRENT screen-share stream (or null when nobody
   * is sharing). Safe before OR during recording — only swaps the srcObject of
   * the offscreen <video> the draw loop reads, so a share that starts/stops
   * mid-record is SEAMLESS. We never STOP the underlying track — the screen-share
   * controller owns its lifecycle.
   */
  setScreenStream(stream: MediaStream | null): void {
    if (!this.compositorOn || !this.screenVideo) {
      return;
    }
    const track = stream?.getVideoTracks()[0] ?? null;
    if (!track) {
      this.hasActiveScreen = false;
      if (this.screenVideo.srcObject) {
        this.screenVideo.srcObject = null;
      }
      return;
    }
    // Wrap in a fresh MediaStream so we never mutate the controller's stream.
    const next = new MediaStream([track]);
    this.screenVideo.srcObject = next;
    // play() may reject if interrupted by a rapid swap — harmless; the loop only
    // draws once readyState is high enough.
    this.screenVideo.play().catch(() => undefined);
    this.hasActiveScreen = true;
  }

  /**
   * (Re)attach or detach the shared window's audio muxed INTO the video file.
   * Feeds the SAME output audio track the MediaRecorder is already recording, so
   * a share whose audio starts/stops mid-record is captured live. Pass null / an
   * audio-less stream to detach. Mics are NEVER added here.
   */
  setScreenAudioStream(stream: MediaStream | null): void {
    if (this.screenAudioSource) {
      try {
        this.screenAudioSource.disconnect();
      } catch {
        // already disconnected
      }
      this.screenAudioSource = null;
    }
    if (stream && stream.getAudioTracks().length > 0) {
      try {
        const src = this.ctx.createMediaStreamSource(stream);
        src.connect(this.destination);
        this.screenAudioSource = src;
      } catch (err) {
        console.warn("[screen-video-recorder] failed to add screen audio", err);
      }
    }
  }

  async start(options: ScreenVideoOptions = {}): Promise<void> {
    if (this.recorder) {
      return;
    }
    // Resume a suspended AudioContext inside the user gesture so the muxed audio
    // track clocks (a suspended context's destination produces no samples).
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn(
          "[screen-video-recorder] failed to resume AudioContext",
          err,
        );
      }
    }
    const canvasTrack = this.initCompositor();
    if (!canvasTrack) {
      throw new Error("ScreenVideoRecorder: compositor init failed");
    }
    // Seed the (optional) shared-window audio + the initial share frame.
    if (options.screenAudioStream !== undefined) {
      this.setScreenAudioStream(options.screenAudioStream);
    }
    if (options.initialScreenStream !== undefined) {
      this.setScreenStream(options.initialScreenStream);
    }

    // Output = the CONSTANT canvas-video track + (optionally) the muxed screen-
    // audio track. The audio track always exists on the destination stream; if no
    // screen audio is connected it simply carries silence (negligible bytes).
    const tracks: MediaStreamTrack[] = [canvasTrack];
    const audioTrack = this.destination.stream.getAudioTracks()[0];
    if (audioTrack) {
      tracks.push(audioTrack);
    }
    this.outputStream = new MediaStream(tracks);

    this.mimeType = pickMime(VIDEO_MIME_TYPES);
    // Cap the video bitrate so the encoder stays out of runaway mode (one of the
    // ways a video encoder saturates and starves the Opus interleave) and pin the
    // audio rate so the muxer always allocates an Opus stream.
    const recorderOptions: MediaRecorderOptions = {
      videoBitsPerSecond: SCREEN_VIDEO_BPS,
      audioBitsPerSecond: SCREEN_AUDIO_BPS,
    };
    if (this.mimeType) {
      recorderOptions.mimeType = this.mimeType;
    }
    try {
      this.recorder = new MediaRecorder(this.outputStream, recorderOptions);
    } catch (err) {
      this.teardownCompositor();
      throw new Error(
        `MediaRecorder init failed: ${(err as Error)?.message ?? err}`,
      );
    }
    console.info(
      `[screen-video-recorder] recording mimeType=${this.recorder.mimeType} ` +
        `audioTracks=${this.outputStream.getAudioTracks().length} ` +
        `videoTracks=${this.outputStream.getVideoTracks().length}`,
    );
    this.chunks = [];
    this.startedAt = performance.now();
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };
    this.recorder.onerror = (e) => {
      console.error("[screen-video-recorder] error", (e as any)?.error ?? e);
    };
    // Stamp the absolute capture-start instant at the exact line start() fires —
    // the true bytes-begin moment for the replay timeline (#28).
    this.startedAtMsValue = Date.now();
    this.recorder.start(1000);
  }

  /** Stop and return the finalized screen-video blob, or NULL if nothing was
   *  captured. */
  stop(): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new Error("recording was never started"));
        return;
      }
      let settled = false;
      const finish = async () => {
        if (settled) {
          return;
        }
        settled = true;
        const mimeType = recorder.mimeType || this.mimeType || "video/webm";
        const rawBlob = new Blob(this.chunks, { type: mimeType });
        const durationMs = performance.now() - this.startedAt;
        const blob = await finalizeWebm(rawBlob, mimeType, durationMs);
        this.chunks = [];
        this.recorder = null;
        this.startedAt = 0;
        resolve(blob.size > 0 ? blob : null);
      };
      recorder.onstop = () => void finish();
      if (recorder.state === "inactive") {
        void finish();
      } else {
        try {
          recorder.stop();
        } catch {
          void finish();
        }
      }
      window.setTimeout(() => void finish(), 8000);
    });
  }

  /** Tear everything down. Safe after stop() — releases the AudioContext, the
   *  screen-audio source, the canvas compositor (loop + canvas + our capture
   *  stream), and the output-stream wrapper. We never stop the screen-share
   *  track; the screen-share controller owns it. */
  close(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.startedAtMsValue = null;
    if (this.screenAudioSource) {
      try {
        this.screenAudioSource.disconnect();
      } catch {
        // ignore
      }
      this.screenAudioSource = null;
    }
    this.teardownCompositor();
    this.outputStream = null;
    this.ctx.close().catch(() => undefined);
  }

  // ---- compositor internals (preserved from ClientMeetingRecorder) -------

  /** Build the offscreen canvas + <video> + constant capture track. */
  private initCompositor(): MediaStreamTrack | null {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = COMPOSITOR_WIDTH;
      canvas.height = COMPOSITOR_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return null;
      }
      const video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      // Off-DOM elements still decode frames in modern browsers; keep them out of
      // layout/AT.
      video.setAttribute("aria-hidden", "true");

      const stream = canvas.captureStream(COMPOSITOR_FPS);
      const track = stream.getVideoTracks()[0] ?? null;
      if (!track) {
        return null;
      }

      this.canvas = canvas;
      this.canvasCtx = ctx;
      this.canvasStream = stream;
      this.screenVideo = video;
      this.compositorOn = true;

      // Paint one placeholder frame immediately so the very first recorded frame
      // is valid even before the loop's first tick.
      this.drawPlaceholder();
      this.startDrawLoop();
      return track;
    } catch (err) {
      console.warn("[screen-video-recorder] compositor init failed", err);
      this.teardownCompositor();
      return null;
    }
  }

  /** Throttled rAF loop: draw the active screen frame (contain-fit) or a neutral
   *  placeholder. Throttled to COMPOSITOR_FPS so we don't burn CPU. */
  private startDrawLoop(): void {
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - this.lastDrawAt < 1000 / COMPOSITOR_FPS) {
        return;
      }
      this.lastDrawAt = now;
      this.drawFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private drawFrame(): void {
    const ctx = this.canvasCtx;
    const canvas = this.canvas;
    const video = this.screenVideo;
    if (!ctx || !canvas) {
      return;
    }
    if (
      this.hasActiveScreen &&
      video &&
      video.readyState >= 2 && // HAVE_CURRENT_DATA
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      // Letterbox/contain the screen frame onto the canvas.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(
        canvas.width / video.videoWidth,
        canvas.height / video.videoHeight,
      );
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;
      try {
        ctx.drawImage(video, x, y, w, h);
      } catch {
        // A transient decode error — keep the previous frame.
      }
    } else {
      this.drawPlaceholder();
    }
  }

  /** Neutral dark frame with a small hint — shown whenever nobody is sharing. */
  private drawPlaceholder(): void {
    const ctx = this.canvasCtx;
    const canvas = this.canvas;
    if (!ctx || !canvas) {
      return;
    }
    ctx.fillStyle = "#0f1115";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#5b616e";
    ctx.font =
      "16px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No screen shared", canvas.width / 2, canvas.height / 2);
  }

  /** Stop the loop + release the compositor's canvas/video/capture stream. We do
   *  NOT stop the screen-share track (the controller owns it); we only null our
   *  srcObject reference to it. */
  private teardownCompositor(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.screenVideo) {
      try {
        this.screenVideo.srcObject = null;
        this.screenVideo.pause();
      } catch {
        // ignore
      }
      this.screenVideo = null;
    }
    if (this.canvasStream) {
      // This stream is OURS (the canvas capture) — stopping it is correct.
      for (const t of this.canvasStream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
      this.canvasStream = null;
    }
    this.canvas = null;
    this.canvasCtx = null;
    this.compositorOn = false;
    this.hasActiveScreen = false;
    this.lastDrawAt = 0;
  }
}
