// Client-side meeting recorder (06-23 pivot OFF Daily cloud recording).
//
// Records, IN THE HOST'S BROWSER, a single WebM file containing:
//   • MIXED AUDIO — the local mic + every remote participant's audio, mixed
//     through a Web Audio graph (the exact approach proven in MeetingRecorder.ts,
//     reused here). Streams can be added/removed live as peers join/leave.
//   • SCREEN-SHARE VIDEO via a CANVAS COMPOSITOR (when the host opts into screen
//     capture). See the compositor note below — this is what lets a share that
//     starts AFTER Record was pressed still land in the file.
//
// THE CANVAS COMPOSITOR (fixes "share started after Record = audio-only file").
//   MediaRecorder ONLY records the tracks that exist on its stream at the moment
//   start() was called — a track added later is ignored. So the old approach
//   (start audio-only, then outputStream.addTrack(screen) when a share begins)
//   silently dropped any mid-record share. The compositor sidesteps this:
//     - At start() we create an offscreen <canvas> and record a CONSTANT video
//       track from canvas.captureStream(fps). That single canvas track is on the
//       stream from start() → MediaRecorder always has a video track to record.
//     - A throttled rAF loop draws the CURRENT screen-share frame onto the canvas
//       (letterboxed/contain), or a neutral dark placeholder when nobody shares.
//     - The screen source is fed through an offscreen <video> (muted/autoplay/
//       playsInline) whose srcObject is the active screen stream. setScreenStream
//       just swaps that srcObject → starting/stopping a share mid-record is
//       SEAMLESS: the recorded canvas track never changes, only its content does.
//   Audio stays the existing Web Audio mix (one audio track). Output = audio +
//   the constant canvas-video track.
//
//   AUDIO-ONLY path: if the host did NOT opt into screen capture (start({screen:
//   false})) we skip the compositor entirely and record audio-only (a smaller
//   file). When screen IS opted in we ALWAYS run the compositor so a later share
//   is captured. The choice is explicit — see start()'s `screen` option.
//
// The result blob is uploaded to R2 (data/recordings.ts → PUT upload route) and
// indexed in the `recording` D1 table, so review-mode (RecordingsSection) plays
// it back exactly like the old Daily MP4 — same table, same R2, same gated
// stream route, just a .webm instead of an .mp4.
//
// WHY a separate class from MeetingRecorder: MeetingRecorder records only the
// AudioContext destination stream (audio-only, with a download-to-disk UX). This
// recorder composes an audio+video MediaStream and is driven by the cloud-record
// control (host-only, broadcast, upload-to-R2). We keep MeetingRecorder untouched
// (it is still wired behind RecordingControls) and reuse its audio-mix recipe.

import { fixWebmDuration } from "./fixWebmDuration";
import { makeWebmSeekable } from "./makeWebmSeekable";

// Prefer VIDEO webm (vp8/opus) so a screen track is recordable; fall back down
// to plain audio webm if the browser only supports audio (so an audio-only
// meeting still records). MediaRecorder happily records an audio-only stream
// under a video/* mime — the container simply carries no video track.
//
// VP8 BEFORE VP9 — ON PURPOSE. Audio-only recordings (no video encoder) capture
// audio fine, but recordings WITH the screen-compositor video track came out
// SILENT. Root cause: Chromium's real-time VP9 encoder, under load, fails to
// interleave the Opus audio track into the muxed WebM → video-but-no-audio. The
// lighter VP8 encoder doesn't starve the audio path, so the SAME mixed-audio
// track that worked audio-only now survives alongside video. (We keep vp9 as a
// last-ditch entry only if a browser somehow lacks vp8.)
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "audio/webm;codecs=opus",
  "audio/webm",
];

const pickMimeType = (): string | undefined => {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  for (const t of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return undefined;
};

export type ClientRecordingResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
};

/** Options for a recording session, chosen by the host's pre-record picker. */
export type ClientRecordingOptions = {
  /** When true, run the canvas compositor so a screen-share (now OR started
   *  later) is captured. When false, record audio-only (smaller file). */
  screen: boolean;
};

const LOCAL_KEY = "__local__";
// Mix key for the shared window's tab/system audio (Daily "screenAudio"). Kept
// distinct from the mic/peer keys so it can be (re)attached/detached on its own
// as a share's audio starts/stops mid-record.
const SCREEN_AUDIO_KEY = "__screen_audio__";

// Compositor video config — deliberately small/low-fps to match the existing
// low-bitrate intent (review/docs-sized 480p files, not broadcast quality).
const COMPOSITOR_WIDTH = 854; // ~480p 16:9
const COMPOSITOR_HEIGHT = 480;
const COMPOSITOR_FPS = 15;

export class ClientMeetingRecorder {
  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  /** The canonical stream handed to MediaRecorder: one mixed audio track plus
   *  (optionally) the CONSTANT canvas-video track. We keep a stable reference so
   *  the recorder is never re-created mid-session. */
  private outputStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;

  // ---- canvas compositor (screen capture) -------------------------------
  /** Whether this session captures screen (runs the compositor). Set in start(). */
  private compositorOn = false;
  /** The offscreen canvas we draw the active share onto + record from. */
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  /** The CONSTANT video track recorded from the canvas (present from start()). */
  private canvasStream: MediaStream | null = null;
  /** Offscreen <video> playing the CURRENT screen stream; the loop draws it. */
  private screenVideo: HTMLVideoElement | null = null;
  /** True when a screen stream is currently feeding the offscreen <video>. */
  private hasActiveScreen = false;
  /** rAF handle for the draw loop. */
  private rafId = 0;
  /** Timestamp (ms) of the last drawn frame, for fps throttling. */
  private lastDrawAt = 0;

  constructor() {
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    this.destination = this.ctx.createMediaStreamDestination();
  }

  /** True from start() until stop() resolves. */
  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state !== "inactive";
  }

  /** Milliseconds since start() began; 0 if not recording. */
  elapsedMs(): number {
    if (!this.startedAt) {
      return 0;
    }
    return performance.now() - this.startedAt;
  }

  // ---- audio mix (reused recipe from MeetingRecorder) --------------------

  /** Add an audio stream to the mix. Idempotent on the given key. */
  addStream(key: string, stream: MediaStream): void {
    if (this.sources.has(key)) {
      return;
    }
    // A stream with no audio tracks (e.g. a video-only screen stream passed in
    // by mistake) cannot feed a MediaStreamSource — skip it defensively.
    if (stream.getAudioTracks().length === 0) {
      return;
    }
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.destination);
      this.sources.set(key, src);
    } catch (err) {
      console.warn(`[client-recorder] failed to add stream ${key}`, err);
    }
  }

  /** Remove an audio stream from the mix. Idempotent. */
  removeStream(key: string): void {
    const src = this.sources.get(key);
    if (!src) {
      return;
    }
    try {
      src.disconnect();
    } catch {
      // already disconnected
    }
    this.sources.delete(key);
  }

  addLocalStream(stream: MediaStream): void {
    this.addStream(LOCAL_KEY, stream);
  }

  removeLocalStream(): void {
    this.removeStream(LOCAL_KEY);
  }

  /**
   * Mix the shared window's audio (Daily "screenAudio" — tab/system audio) into
   * the recording, or detach it (pass null / an audio-less stream). Safe to call
   * before OR during recording: the Web Audio mix feeds the SAME output track the
   * MediaRecorder is already recording, so a share whose audio starts/stops
   * mid-record is captured live. Independent of the video compositor — a host
   * with NO mic still records the meeting's screen-share audio.
   */
  setScreenAudioStream(stream: MediaStream | null): void {
    // Re-attach cleanly: drop any prior screen-audio source first so a new share
    // (or a track swap) replaces it rather than being skipped as a dup key.
    this.removeStream(SCREEN_AUDIO_KEY);
    if (stream && stream.getAudioTracks().length > 0) {
      this.addStream(SCREEN_AUDIO_KEY, stream);
    }
  }

  // ---- screen video via the canvas compositor ----------------------------

  /**
   * Point the compositor at the CURRENT screen-share stream (or null when nobody
   * is sharing). Safe to call before OR during recording — it only swaps the
   * srcObject of the offscreen <video> the draw loop reads, so a share that
   * starts/stops mid-record is SEAMLESS: the recorded canvas track never changes,
   * only its on-screen content does. No-op when the compositor isn't running
   * (audio-only session). We never STOP the underlying track — the screen-share
   * controller owns its lifecycle.
   */
  setScreenStream(stream: MediaStream | null): void {
    if (!this.compositorOn || !this.screenVideo) {
      return;
    }
    const track = stream?.getVideoTracks()[0] ?? null;
    if (!track) {
      // Detach — the draw loop will paint the placeholder from now on.
      this.hasActiveScreen = false;
      if (this.screenVideo.srcObject) {
        this.screenVideo.srcObject = null;
      }
      return;
    }
    // Feed the (single-video-track) stream into the offscreen <video>. Wrap in a
    // fresh MediaStream so we never mutate the controller's stream.
    const next = new MediaStream([track]);
    this.screenVideo.srcObject = next;
    // play() may reject if interrupted by a rapid swap — harmless; the loop only
    // draws once readyState is high enough.
    this.screenVideo.play().catch(() => undefined);
    this.hasActiveScreen = true;
  }

  /** True when a live screen stream is currently feeding the compositor. */
  hasScreen(): boolean {
    return this.hasActiveScreen;
  }

  /** Build the offscreen canvas + <video> + constant capture track. Called from
   *  start() only when screen capture is opted in. */
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
      console.warn("[client-recorder] compositor init failed", err);
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

  // ---- recorder lifecycle ------------------------------------------------

  async start(
    options: ClientRecordingOptions = { screen: false },
  ): Promise<void> {
    if (this.recorder) {
      return;
    }
    // Browsers commonly start an AudioContext in `suspended` state (autoplay
    // policy / focus-loss). A suspended context's destination produces no
    // samples → every ondataavailable fires size:0 → a 0-byte/silent file.
    // Resuming inside the user gesture that calls start() guarantees the graph
    // is clocking before we record. (Same fix as MeetingRecorder.start().)
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn("[client-recorder] failed to resume AudioContext", err);
      }
    }
    // Build the canonical output stream = mixed audio + (optionally) the CONSTANT
    // canvas-video track. When screen capture is opted in we ALWAYS attach the
    // canvas track from the start so a share that begins later is recorded
    // (MediaRecorder ignores tracks added after start()). When not, we record
    // audio-only for a smaller file.
    const audioTrack = this.destination.stream.getAudioTracks()[0];
    const tracks: MediaStreamTrack[] = [];
    if (audioTrack) {
      tracks.push(audioTrack);
    }
    if (options.screen) {
      const canvasTrack = this.initCompositor();
      if (canvasTrack) {
        tracks.push(canvasTrack);
      }
      // If the compositor failed to init we fall through to audio-only rather
      // than aborting the whole recording.
    }
    this.outputStream = new MediaStream(tracks);

    const mimeType = pickMimeType();
    // Explicit bitrates. The software VP9 path enforces NO peak bitrate and
    // overshoots ~4x, which is one of the ways the video encoder saturates and
    // starves the Opus audio interleave (the silent-with-screen bug). Capping the
    // video rate keeps the encoder out of runaway mode, and pinning the audio
    // rate guarantees the muxer always allocates an Opus stream. Audio only;
    // video bitrate is set only when we actually carry the canvas video track.
    const recorderOptions: MediaRecorderOptions = {
      audioBitsPerSecond: 128_000,
    };
    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }
    if (options.screen && this.compositorOn) {
      recorderOptions.videoBitsPerSecond = 1_500_000; // ~480p15 screen share
    }
    try {
      this.recorder = new MediaRecorder(this.outputStream, recorderOptions);
    } catch (err) {
      throw new Error(
        `MediaRecorder init failed: ${(err as Error)?.message ?? err}`,
      );
    }
    // Diagnostic: surface the codec actually negotiated. If a browser lacks VP8
    // and fell through to a UA-default (possibly VP9) container, this is where a
    // silent-audio recording would originate — log it so it's visible in support.
    if (this.outputStream.getAudioTracks().length === 0) {
      console.warn(
        "[client-recorder] no audio track on output stream at start — recording will be silent",
      );
    }
    console.info(
      `[client-recorder] recording mimeType=${this.recorder.mimeType} ` +
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
      console.error("[client-recorder] error", (e as any)?.error ?? e);
    };
    // chunk every second so a long recording doesn't pin one monolithic blob.
    this.recorder.start(1000);
  }

  stop(): Promise<ClientRecordingResult> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new Error("recording was never started"));
        return;
      }
      // The Stop flow MUST NEVER hang the UI. We resolve exactly once, from
      // whichever path fires first: `onstop`, an already-inactive recorder (which
      // would NOT fire onstop), a throwing stop(), or a hard safety timeout.
      let settled = false;
      const finish = async () => {
        if (settled) {
          return;
        }
        settled = true;
        const mimeType = recorder.mimeType || pickMimeType() || "video/webm";
        const rawBlob = new Blob(this.chunks, { type: mimeType });
        const durationMs = performance.now() - this.startedAt;
        // Make the WebM SEEKABLE so the review player's slider can drag.
        // MediaRecorder emits a streaming WebM (no SeekHead/Cues, often no
        // Duration) → unseekable. makeWebmSeekable (ts-ebml) re-muxes in a
        // SeekHead + Cues + Duration. If that returns null (decode hiccup /
        // odd file), fall back to fixWebmDuration which at least injects the
        // Duration (fixes the length readout). Both steps are RACED against a
        // hard timeout + fail-soft to the raw blob — Stop must NEVER hang on
        // post-processing.
        let blob = rawBlob;
        if (mimeType.includes("webm") && rawBlob.size > 0) {
          try {
            blob = await Promise.race([
              (async () => {
                const seekable = await makeWebmSeekable(rawBlob);
                if (seekable) {
                  return seekable;
                }
                // Seekable remux unavailable — at least patch the Duration.
                return fixWebmDuration(rawBlob, durationMs);
              })(),
              new Promise<Blob>((r) =>
                window.setTimeout(() => r(rawBlob), 6000),
              ),
            ]);
          } catch {
            blob = rawBlob;
          }
        }
        this.chunks = [];
        this.recorder = null;
        this.startedAt = 0;
        resolve({ blob, mimeType: blob.type || mimeType, durationMs });
      };
      recorder.onstop = () => void finish();
      // A recorder already 'inactive' (auto-stopped on an error / an ended
      // screen track) will NOT fire onstop when we call stop() → finish now.
      if (recorder.state === "inactive") {
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

  /** Tear everything down. Safe after stop() — releases the AudioContext, the
   *  source nodes, the canvas compositor (loop + canvas + our capture stream),
   *  and the output-stream wrapper. We never stop the screen-share track; the
   *  screen-share controller owns it. */
  close(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    for (const src of this.sources.values()) {
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.sources.clear();
    // Stop the draw loop + release the canvas/video/capture stream (never the
    // screen-share track itself).
    this.teardownCompositor();
    this.outputStream = null;
    this.ctx.close().catch(() => undefined);
  }
}
