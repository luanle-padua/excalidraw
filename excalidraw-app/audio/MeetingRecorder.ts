// Mixes the local mic plus every remote peer stream through Web Audio
// into a single MediaStream, then records that stream to a single file.
// Streams can be added/removed live (when peers join / leave mid-record)
// without restarting the recorder — the AudioContext keeps running, we
// just connect/disconnect source nodes.
//
// Output is whatever `audio/webm;codecs=opus` (or fallback) produces,
// with a post-stop duration-metadata injection so strict players like
// VLC can seek and report length (Chromium MediaRecorder leaves that
// element out — see fixWebmDuration.ts for context).
//
// Listener-only mode is supported — pass localStream = null and the
// recording will contain just the remote peers' audio.

import { fixWebmDuration } from "./fixWebmDuration";

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
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

export type RecordingResult = {
  blob: Blob;
  url: string;
  mimeType: string;
  durationMs: number;
};

const LOCAL_KEY = "__local__";

export class MeetingRecorder {
  private readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly sources = new Map<string, MediaStreamAudioSourceNode>();
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt: number = 0;

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

  /** Add a stream to the mix. Idempotent on the given key. */
  addStream(key: string, stream: MediaStream): void {
    if (this.sources.has(key)) {
      return;
    }
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.destination);
      this.sources.set(key, src);
    } catch (err) {
      console.warn(`[recorder] failed to add stream ${key}`, err);
    }
  }

  /** Remove a stream from the mix. Idempotent. */
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

  async start(): Promise<void> {
    if (this.recorder) {
      return;
    }
    // Browsers commonly start an AudioContext in `suspended` state
    // (autoplay policy, or focus-loss auto-suspend) even when the
    // context was constructed during a user gesture. If we hand a
    // suspended context's destination stream to MediaRecorder, the
    // recorder runs but every `ondataavailable` event fires with
    // `size: 0` — leaving us with a 0-byte .webm on stop. Resuming
    // first guarantees the audio graph is actually clocking samples
    // before recording begins. The resume() promise reliably
    // resolves inside a user gesture (the only place start() is
    // called from), so this is safe to await.
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn("[recorder] failed to resume AudioContext", err);
      }
    }
    const mimeType = pickMimeType();
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.destination.stream, { mimeType })
        : new MediaRecorder(this.destination.stream);
    } catch (err) {
      throw new Error(
        `Không thể khởi tạo MediaRecorder: ${(err as Error)?.message ?? err}`,
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
    // chunk every second so a long-lived recording doesn't keep one
    // monolithic blob in memory the whole time
    this.recorder.start(1000);
  }

  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new Error("Chưa bắt đầu ghi"));
        return;
      }
      const finish = async () => {
        const mimeType = recorder.mimeType || pickMimeType() || "audio/webm";
        const rawBlob = new Blob(this.chunks, { type: mimeType });
        const durationMs = performance.now() - this.startedAt;
        // Patch the WebM container so VLC / ffprobe / etc. can read
        // the duration. Failure here is non-fatal — fixWebmDuration
        // returns the original blob untouched on any parse error.
        const blob = mimeType.startsWith("audio/webm")
          ? await fixWebmDuration(rawBlob, durationMs)
          : rawBlob;
        const url = URL.createObjectURL(blob);
        const result: RecordingResult = {
          blob,
          url,
          mimeType: blob.type,
          durationMs,
        };
        this.chunks = [];
        this.recorder = null;
        this.startedAt = 0;
        resolve(result);
      };
      recorder.onstop = finish;
      try {
        recorder.stop();
      } catch (err) {
        // recorder was already stopped — flush whatever we have
        finish();
      }
    });
  }

  /** Tear everything down. Safe to call after stop() — only the
   *  AudioContext + source nodes get released here. */
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
    this.ctx.close().catch(() => undefined);
  }
}
