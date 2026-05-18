// Client-side realtime speech-to-text session.
//
// Wires the local mic stream (already captured by AudioRoom for the
// audio call) through an AudioWorklet downsampler, then over a
// WebSocket to the server's /stt proxy, which forwards to Deepgram.
//
// Lifecycle:
//   start(stream, lang)   — open WS, load worklet, route audio
//   stop()                — close WS, tear down audio nodes
//
// Callbacks (passed at construction):
//   onInterim(text)    — partial transcript hypothesis. Replace any
//                        previous interim text for this session.
//   onFinal(text, ts)  — committed segment. Append to the log.
//   onReady()          — Deepgram opened upstream, audio can flow
//   onError(message)   — connection / config error; UI should surface
//   onClose()          — WS closed (graceful or not)

// `?url` makes Vite emit the worklet as a standalone asset and hand
// us the public URL — exactly what AudioContext.audioWorklet.addModule
// wants. `?worker&url` would wrap it as a Web Worker bundle (wrong
// scope for AudioWorklet globals).
import sttWorkletUrl from "./sttWorklet.ts?url";

export type STTLang = "vi" | "en" | "ko" | "ja" | "zh" | "multi";

export type STTSessionOptions = {
  lang: STTLang;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, segmentTs: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

// Deepgram "Results" payload shape (subset we care about).
type DeepgramResult = {
  type: "Results";
  is_final: boolean;
  speech_final: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
};

// Build the WS URL for /stt. Mirrors the dual-mode logic in Collab.tsx:
//   - Tunnel mode (VITE_DEV_TUNNEL=true) → current page origin. Both
//     vite and the room server sit behind the same Cloudflare tunnel
//     hostname, so relative routing Just Works.
//   - Direct dev → VITE_APP_WS_SERVER_URL (e.g. http://localhost:3002).
const buildSTTUrl = (lang: STTLang): string => {
  const tunnelMode = import.meta.env.VITE_DEV_TUNNEL === "true";
  const envBackend = import.meta.env.VITE_APP_WS_SERVER_URL;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const backend =
    !tunnelMode && envBackend
      ? envBackend.replace(/^http(s?):/, (_m: string, s: string) =>
          s ? "wss:" : "ws:",
        )
      : `${proto}//${window.location.host}`;
  const url = new URL(backend);
  url.pathname = "/stt";
  url.searchParams.set("lang", lang);
  return url.toString();
};

export class STTSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private opts: STTSessionOptions;
  private closed = false;

  constructor(opts: STTSessionOptions) {
    this.opts = opts;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.audioCtx) {
      // Already started — no-op.
      return;
    }

    const wsUrl = buildSTTUrl(this.opts.lang);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      // Server will follow up with a {type:"ready"} once Deepgram is
      // also open; that's when we let the caller know audio will start
      // producing transcripts.
    };

    this.ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.opts.onReady?.();
        return;
      }
      if (msg.type === "error") {
        this.opts.onError?.(msg.message ?? "STT error");
        return;
      }
      if (msg.type === "Results") {
        const result = msg as DeepgramResult;
        const alt = result.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) {
          return;
        }
        if (result.is_final) {
          this.opts.onFinal?.(text, Date.now());
        } else {
          this.opts.onInterim?.(text);
        }
      }
      // Other Deepgram message types (Metadata, SpeechStarted,
      // UtteranceEnd) are ignored — we don't need them for v1.
    };

    this.ws.onerror = () => {
      // Browsers don't expose details for security; surface generic.
      this.opts.onError?.("STT WebSocket error");
    };

    this.ws.onclose = () => {
      this.opts.onClose?.();
    };

    // AudioContext defaults to 48000 in modern browsers. The worklet
    // downsamples to 16000 at runtime so we don't need to force a rate.
    this.audioCtx = new AudioContext();
    try {
      await this.audioCtx.audioWorklet.addModule(sttWorkletUrl);
    } catch (err) {
      this.opts.onError?.(
        `Failed to load STT worklet: ${(err as Error).message}`,
      );
      await this.stop();
      return;
    }

    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, "stt-downsampler");

    this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const buf = e.data;
      if (!buf || buf.byteLength === 0) {
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(buf);
      }
    };

    this.sourceNode.connect(this.workletNode);
    // No need to connect to destination — we only want to capture,
    // not play back. Connecting to destination would echo the mic.
  }

  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // Polite shutdown so Deepgram emits any final hypothesis.
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        /* ignore */
      }
      this.ws.close();
      this.ws = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      this.sourceNode = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {
        /* ignore */
      }
      this.audioCtx = null;
    }
  }
}
