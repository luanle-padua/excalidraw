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
// wants. It MUST point at the PLAIN-JS `.js` worklet: `?url` copies the
// file verbatim (no transpile/bundle), so a `.ts` source ships raw
// TypeScript served as video/mp2t and addModule() fails in the prod build.
import { beginAiActivity, endAiActivity } from "../data/aiActivity";
import { sttBackendWsUrl } from "../data/aiBackend";
import { supabase } from "../data/supabaseClient";

import sttWorkletUrl from "./sttWorklet.js?url";

// Protocol marker the server expects first on the /stt handshake, mirroring the
// realtime DO transport (`["mcm.v1", token]`). The Worker (worker/src/stt.ts)
// verifies the Supabase JWT carried as the second subprotocol segment.
const STT_PROTOCOL_MARKER = "mcm.v1";

export type STTLang = "vi" | "en" | "ko" | "ja" | "zh" | "multi";

export type STTSessionOptions = {
  lang: STTLang;
  /** Meeting/room id — sent to /stt so the Worker can verify the opener is a
   *  member before opening the metered Deepgram stream (06-18 cross-review:
   *  without it the STT membership gate was a no-op). */
  meetingId?: string;
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

// Build the WS URL for /stt. The /stt proxy moved off the Fly room server onto
// the Cloudflare Worker (DO migration I-1, worker/src/stt.ts), so the base is
// now the STORAGE backend, not VITE_APP_WS_SERVER_URL:
//   - Tunnel mode (VITE_DEV_TUNNEL=true) → current page origin (the Worker sits
//     behind the same Cloudflare tunnel hostname, so relative routing works).
//   - Direct dev → ws(s) form of VITE_APP_STORAGE_URL (see data/aiBackend.ts).
const buildSTTUrl = (lang: STTLang, meetingId?: string): string => {
  const url = new URL(sttBackendWsUrl());
  url.pathname = "/stt";
  url.searchParams.set("lang", lang);
  // The Worker gates the Deepgram stream on meeting membership keyed by this id.
  if (meetingId) {
    url.searchParams.set("meetingId", meetingId);
  }
  return url.toString();
};

export class STTSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private opts: STTSessionOptions;
  private closed = false;
  /** true while we're holding the AI-in-use indicator up for this STT
   *  session — so begin/end stay balanced even on an error/double-stop. */
  private aiActive = false;

  constructor(opts: STTSessionOptions) {
    this.opts = opts;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.audioCtx) {
      // Already started — no-op.
      return;
    }

    const wsUrl = buildSTTUrl(this.opts.lang, this.opts.meetingId);
    // Pass the Supabase access token via the WS subprotocol so the Worker can
    // verify it before opening the metered Deepgram stream (auth, B-AI 06-17).
    // Mirrors the realtime DO handshake: `["mcm.v1", <jwt>]`. Without a token
    // the server replies 401 and the browser fails the WS open (onerror fires).
    let token: string | undefined;
    if (supabase) {
      try {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token;
      } catch {
        // no session → open without a token; the Worker will 401.
      }
    }
    this.ws = token
      ? new WebSocket(wsUrl, [STT_PROTOCOL_MARKER, token])
      : new WebSocket(wsUrl, [STT_PROTOCOL_MARKER]);
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
        // Deepgram is live — raise the AI-in-use indicator for the duration
        // of the transcription session (cleared in stop()).
        if (!this.aiActive && !this.closed) {
          this.aiActive = true;
          beginAiActivity();
        }
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

    // Drop the AI-in-use indicator we raised on {type:"ready"}.
    if (this.aiActive) {
      this.aiActive = false;
      endAiActivity();
    }

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
