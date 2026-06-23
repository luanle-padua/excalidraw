// Client-side meeting recorder (06-23 pivot OFF Daily cloud recording).
//
// Records, IN THE HOST'S BROWSER, a single WebM file containing:
//   • MIXED AUDIO — the local mic + every remote participant's audio, mixed
//     through a Web Audio graph (the exact approach proven in MeetingRecorder.ts,
//     reused here). Streams can be added/removed live as peers join/leave.
//   • SCREEN-SHARE VIDEO — the live screen video TRACK, when a share is active
//     (the host's own share via the controller's localStream, or the remote
//     presenter's remoteStream the host is viewing). When no one is sharing the
//     output is audio-only; the track can be attached/detached mid-record without
//     restarting the recorder (we add it to the SAME canonical output stream).
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

// Prefer VIDEO webm (vp8/opus) so a screen track is recordable; fall back down
// to plain audio webm if the browser only supports audio (so an audio-only
// meeting still records). MediaRecorder happily records an audio-only stream
// under a video/* mime — the container simply carries no video track.
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
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

const LOCAL_KEY = "__local__";

export class ClientMeetingRecorder {
  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  /** The canonical stream handed to MediaRecorder: one mixed audio track plus
   *  (optionally) one screen-share video track. We keep a stable reference so a
   *  screen track can be attached/removed mid-record without re-creating it. */
  private outputStream: MediaStream | null = null;
  /** The video track currently attached to outputStream (if any). */
  private videoTrack: MediaStreamTrack | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;

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

  // ---- screen video track -----------------------------------------------

  /**
   * Attach a screen-share VIDEO track to the recording (or swap the existing
   * one). Pass a MediaStream that carries a video track — the host's own share
   * (screenShareMediaAtom.localStream) or the remote presenter's stream
   * (remoteStream). Safe to call before OR during recording: the track is added
   * to the canonical output stream that MediaRecorder is already recording, so a
   * share that starts mid-meeting is captured without restarting.
   *
   * Only ONE screen video track is recorded at a time (the active share). A null
   * / track-less stream detaches the current video track (audio-only from then
   * on). We never STOP the underlying track here — the screen-share controller
   * owns its lifecycle; we only add/remove it from our output stream.
   */
  setScreenStream(stream: MediaStream | null): void {
    const nextTrack = stream?.getVideoTracks()[0] ?? null;
    if (nextTrack === this.videoTrack) {
      return; // no change
    }
    // Detach the previous video track from the output stream (if any).
    if (this.videoTrack && this.outputStream) {
      try {
        this.outputStream.removeTrack(this.videoTrack);
      } catch {
        // ignore
      }
    }
    this.videoTrack = nextTrack;
    if (nextTrack && this.outputStream) {
      try {
        this.outputStream.addTrack(nextTrack);
      } catch (err) {
        console.warn("[client-recorder] failed to add screen track", err);
      }
    }
  }

  /** True when a screen video track is currently attached. */
  hasScreen(): boolean {
    return this.videoTrack !== null;
  }

  // ---- recorder lifecycle ------------------------------------------------

  async start(): Promise<void> {
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
    // Build the canonical output stream = mixed audio + (optional) screen video.
    const audioTrack = this.destination.stream.getAudioTracks()[0];
    const tracks: MediaStreamTrack[] = [];
    if (audioTrack) {
      tracks.push(audioTrack);
    }
    if (this.videoTrack) {
      tracks.push(this.videoTrack);
    }
    this.outputStream = new MediaStream(tracks);

    const mimeType = pickMimeType();
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.outputStream, { mimeType })
        : new MediaRecorder(this.outputStream);
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
        // Patch the WebM duration so players can seek — but RACE it against a
        // short timeout and fall back to the raw blob, because fixWebmDuration
        // (written for audio) can be slow / hang on a large video webm. Never
        // let it block Stop.
        let blob = rawBlob;
        if (mimeType.includes("webm") && rawBlob.size > 0) {
          try {
            blob = await Promise.race([
              fixWebmDuration(rawBlob, durationMs),
              new Promise<Blob>((r) => window.setTimeout(() => r(rawBlob), 4000)),
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
   *  source nodes, and our output-stream wrapper (we never stop the screen
   *  track; the screen-share controller owns it). */
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
    // Detach (do NOT stop) the screen track + drop the output-stream wrapper.
    if (this.videoTrack && this.outputStream) {
      try {
        this.outputStream.removeTrack(this.videoTrack);
      } catch {
        // ignore
      }
    }
    this.videoTrack = null;
    this.outputStream = null;
    this.ctx.close().catch(() => undefined);
  }
}
