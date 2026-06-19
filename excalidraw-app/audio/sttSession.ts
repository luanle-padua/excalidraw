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

/** Realtime STT backend id, mirrors the Worker REGISTRY keys in
 *  worker/src/stt-provider.ts. Sent to /stt as ?provider=<id> so the PM can
 *  A/B-test accuracy per session; the Worker falls back to its env default
 *  (deepgram) for an unknown/absent value, so this is a safe live lever. */
export type STTProvider = "deepgram" | "openai" | "elevenlabs";

export type STTSessionOptions = {
  lang: STTLang;
  /** Meeting/room id — sent to /stt so the Worker can verify the opener is a
   *  member before opening the metered Deepgram stream (06-18 cross-review:
   *  without it the STT membership gate was a no-op). */
  meetingId?: string;
  /** Per-session provider override for A/B testing. Omit to use the Worker's
   *  STT_PROVIDER env default (deepgram). */
  provider?: STTProvider;
  /** An AudioContext that was already RESUMED inside a user gesture (DailyAudio
   *  unlocks one on the Join click). Reuse it instead of `new AudioContext()` —
   *  a context created here runs in a React effect with no user activation, so
   *  iOS Safari leaves it SUSPENDED and the worklet never emits PCM (06-18).
   *  When provided, the session does NOT close it on stop() (it's shared). */
  audioCtx?: AudioContext;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, segmentTs: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  /** Fired (throttled) for each PCM chunk reaching the worklet port, carrying
   *  the chunk's PEAK amplitude (0..1). The UI uses this as the GROUND-TRUTH
   *  "mic is being recorded" signal — but level matters: a session can be {ready}
   *  and even stream chunks yet be SILENT (iOS hands the mic exclusively to
   *  Daily's PeerConnection, so the STT clone delivers all-zero samples). Only a
   *  non-trivial `level` proves real audio is captured. Throttled to
   *  ~CAPTURE_PING_MS so it's a heartbeat, not a per-chunk firehose. */
  onCapture?: (level: number) => void;
};

/** How often onCapture is allowed to fire. PCM chunks arrive every few ms; the
 *  indicator only needs a periodic "still alive" heartbeat, so we coalesce to
 *  one call per this window — cheap for React, still well under the panel's
 *  ~2s "no audio" threshold so the dot reacts promptly. */
const CAPTURE_PING_MS = 300;

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
const buildSTTUrl = (
  lang: STTLang,
  meetingId?: string,
  provider?: STTProvider,
): string => {
  const url = new URL(sttBackendWsUrl());
  url.pathname = "/stt";
  url.searchParams.set("lang", lang);
  // The Worker gates the Deepgram stream on meeting membership keyed by this id.
  if (meetingId) {
    url.searchParams.set("meetingId", meetingId);
  }
  // Per-session provider override for A/B testing. Absent → Worker uses its
  // STT_PROVIDER env default.
  if (provider) {
    url.searchParams.set("provider", provider);
  }
  return url.toString();
};

export class STTSession {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  /** Muted (gain=0) sink that gives the worklet a path to the destination so the
   *  audio graph actually PULLS it. An AudioWorkletNode with no downstream route
   *  to AudioDestinationNode is not part of the render-pull path on several
   *  browsers (notably iOS/Safari + some Chromium): process() is never invoked,
   *  no PCM is posted, and Deepgram gets silence → {type:"ready"} but zero
   *  transcripts. Routing through a gain=0 node makes the graph render WITHOUT
   *  echoing the mic to the speakers (06-19). Disconnected in stop(). */
  private sinkNode: GainNode | null = null;
  /** Diagnostics: count PCM chunks posted from the worklet so we can tell
   *  "PCM not flowing" apart from "PCM flowing but Deepgram empty" from the
   *  console. Throttled logging — a few lines only, never a spam loop. */
  private pcmChunks = 0;
  private lastPcmLogAt = 0;
  /** Last time we pinged onCapture — throttle clock for the live indicator,
   *  independent of the (first-few-seconds-only) diagnostic log clock above. */
  private lastCapturePingAt = 0;
  private firstTranscriptLogged = false;
  /** Diagnostic counters: how many frames the SERVER sent back (any Deepgram
   *  type) — distinguishes "Deepgram silent / relay broken" from "Deepgram
   *  talking but no Results". Capped so it can't spam. */
  private rxMsgCount = 0;
  private opts: STTSessionOptions;
  private closed = false;
  /** true when WE created the AudioContext (so stop() must close it); false when
   *  it was handed in (DailyAudio owns + closes it). */
  private ownsCtx = false;
  /** Independent clones of the mic track that STT taps (iOS can't tap the live
   *  Daily-owned track); stopped on teardown so the extra capture is released. */
  private clonedTracks: MediaStreamTrack[] = [];
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

    const wsUrl = buildSTTUrl(
      this.opts.lang,
      this.opts.meetingId,
      this.opts.provider,
    );
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
      // Diagnostic: log EVERY frame the server relays back (capped). Tells apart
      // "Deepgram silent / relay broken" (nothing after ready) from "Deepgram
      // talking but no Results" (SpeechStarted/UtteranceEnd/Metadata arrive, or
      // Results with empty transcript). Capped so it can't spam the console.
      this.rxMsgCount++;
      if (this.rxMsgCount <= 50) {
        const alt0 = msg?.channel?.alternatives?.[0];
        console.info(
          `[stt] rx #${this.rxMsgCount} type=${msg?.type}` +
            (msg?.type === "Results"
              ? ` is_final=${msg?.is_final} text="${(alt0?.transcript ?? "").slice(0, 40)}"`
              : // For non-Results frames (notably Deepgram's `{type:"Error"}`,
                // capital E — which our `=== "error"` check below never matched,
                // so the failure was swallowed) dump the raw payload so the
                // console shows Deepgram's actual complaint (description/code).
                ` raw=${JSON.stringify(msg).slice(0, 300)}`),
        );
      }
      // Deepgram signals stream problems with `{type:"Error"}` (capital E);
      // surface it through the same error path as our own lowercase "error"
      // frames so it stops being silently dropped.
      if (msg.type === "Error") {
        this.opts.onError?.(
          msg.description || msg.message || "Deepgram stream error",
        );
        return;
      }
      if (msg.type === "ready") {
        // Diagnostic: handshake reached Deepgram. If transcripts never follow,
        // pair this with the "[stt] PCM flowing" line to localise the fault
        // (no PCM line ⇒ mic→worklet broke; PCM but no transcript ⇒ upstream).
        console.info(
          `[stt] ready — Deepgram upstream open (lang=${this.opts.lang}, sampleRate=${this.audioCtx?.sampleRate ?? "?"})`,
        );
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
        if (!this.firstTranscriptLogged) {
          // Diagnostic: proves the FULL path (mic→worklet→WS→Deepgram→back) is
          // alive. Logged once; the live UI shows every segment thereafter.
          this.firstTranscriptLogged = true;
          console.info(
            `[stt] first transcript received after ${this.pcmChunks} PCM chunks`,
          );
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

    // Reuse the AudioContext DailyAudio unlocked inside the Join gesture (see
    // STTSessionOptions.audioCtx). A context we'd create HERE runs in a React
    // effect with no user activation, so iOS/iPadOS Safari leaves it SUSPENDED
    // and the worklet never pulls samples → Deepgram gets silence → empty
    // transcript (06-18). Only fall back to our own context when none is handed
    // in (desktop test/upload path, where there's no Daily call).
    if (this.opts.audioCtx) {
      this.audioCtx = this.opts.audioCtx;
      this.ownsCtx = false;
    } else {
      this.audioCtx = new AudioContext();
      this.ownsCtx = true;
    }
    // Best-effort resume — a no-op if already running (the shared context is),
    // and the only hope for a self-owned one (may be blocked off-gesture).
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        // ignore — capture may stay idle on a browser that blocks resume
      }
    }
    try {
      await this.audioCtx.audioWorklet.addModule(sttWorkletUrl);
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      // A SHARED context reused across STT sessions already has the processor
      // registered — that's success, not failure. Only a real load error
      // (bad asset / unsupported) should abort.
      if (!/already.*regist/i.test(msg)) {
        this.opts.onError?.(`Failed to load STT worklet: ${msg}`);
        await this.stop();
        return;
      }
    }

    // Tap an INDEPENDENT clone of the mic track, not the live stream itself.
    // On iOS/iPadOS Safari a track already being sent by Daily's PeerConnection
    // delivers SILENCE to a second MediaStreamAudioSourceNode — so STT got no
    // audio even with a running context (06-18). clone() gives STT its own tap
    // off the same mic source; we stop the clones in stop().
    const micTracks = stream.getAudioTracks();
    if (micTracks.length > 0) {
      this.clonedTracks = micTracks.map((tr) => tr.clone());
      // Diagnostic: a clone that came back ended/muted would silently starve STT
      // even with a healthy graph. We KEEP the clone path (it's the iOS fix — a
      // live Daily-owned track delivers silence to a 2nd source node), but warn
      // if the clone looks dead so the fault is visible in the console (06-19).
      const dead = this.clonedTracks.filter(
        (tr) => tr.readyState !== "live" || tr.muted,
      );
      if (this.clonedTracks.length === 0) {
        console.warn("[stt] mic track clone produced no tracks");
      } else if (dead.length > 0) {
        console.warn(
          `[stt] cloned mic track not live/unmuted (readyState=${this.clonedTracks
            .map((tr) => tr.readyState)
            .join(",")}, muted=${this.clonedTracks.map((tr) => tr.muted).join(",")})`,
        );
      }
      const sttStream = new MediaStream(this.clonedTracks);
      this.sourceNode = this.audioCtx.createMediaStreamSource(sttStream);
    } else {
      // No audio track (shouldn't happen — STT only starts with a mic) — fall
      // back to the raw stream rather than crashing.
      this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    }
    this.workletNode = new AudioWorkletNode(this.audioCtx, "stt-downsampler");

    this.workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const buf = e.data;
      if (!buf || buf.byteLength === 0) {
        return;
      }
      // Peak amplitude (0..1) of this chunk — the discriminator between a LIVE
      // mic and a SILENT clone. iOS gives the mic exclusively to Daily's
      // PeerConnection, so the STT clone can deliver all-zero samples: chunks
      // still "flow" but carry no audio → Deepgram returns nothing. peak≈0 here
      // = silent clone; a real mic tracks the voice. Cheap (~4 chunks/s).
      const samples = new Int16Array(buf);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const a = samples[i] < 0 ? -samples[i] : samples[i];
        if (a > peak) {
          peak = a;
        }
      }
      const level = peak / 0x8000;
      // Diagnostic: confirm PCM keeps flowing AND carries signal. Logged
      // CONTINUOUSLY every 3s (no cap) so we can SEE whether capture is steady or
      // dies after a moment — the iOS failure where the cloned mic goes silent a
      // few seconds in (Daily reclaims the mic) shows up as peak→0 or the line
      // stopping entirely. Temporary while diagnosing 06-19.
      this.pcmChunks++;
      const now = Date.now();
      if (now - this.lastPcmLogAt >= 3000) {
        this.lastPcmLogAt = now;
        console.info(
          `[stt] PCM flowing: ${this.pcmChunks} chunks, lang=${this.opts.lang}, sampleRate=${this.audioCtx?.sampleRate ?? "?"}, peak=${level.toFixed(3)}`,
        );
      }
      // Heartbeat for the live "capturing" indicator, carrying the level so the
      // UI can tell real audio from a silent clone (chunks flowing at peak≈0).
      if (now - this.lastCapturePingAt >= CAPTURE_PING_MS) {
        this.lastCapturePingAt = now;
        this.opts.onCapture?.(level);
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(buf);
      }
    };

    // Route source → worklet → muted sink → destination. The worklet MUST have a
    // path to AudioDestinationNode or the audio graph won't PULL it on several
    // browsers (iOS/Safari + some Chromium): process() never runs, no PCM is
    // posted, and Deepgram receives silence — connected but no transcript. The
    // gain=0 sink makes the graph render this branch WITHOUT echoing the mic to
    // the speakers (capture-only). This is the standard capture-worklet pattern
    // and is the root-cause fix for "{type:'ready'} but no transcript" (06-19).
    this.sinkNode = this.audioCtx.createGain();
    this.sinkNode.gain.value = 0;
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.sinkNode);
    this.sinkNode.connect(this.audioCtx.destination);
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
    // Release the cloned mic track(s) STT was tapping.
    for (const tr of this.clonedTracks) {
      try {
        tr.stop();
      } catch {
        /* ignore */
      }
    }
    this.clonedTracks = [];
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this.workletNode = null;
    }
    // Disconnect the muted sink. On a SHARED context (DailyAudio's, reused across
    // sessions) leaving it connected would leak a node into the call's graph.
    if (this.sinkNode) {
      try {
        this.sinkNode.disconnect();
      } catch {
        /* ignore */
      }
      this.sinkNode = null;
    }
    if (this.audioCtx) {
      // Only close a context WE created. A shared one belongs to DailyAudio
      // (it unlocked it in the Join gesture and may still be using it for other
      // STT sessions / the call); closing it here would break them.
      if (this.ownsCtx) {
        try {
          await this.audioCtx.close();
        } catch {
          /* ignore */
        }
      }
      this.audioCtx = null;
    }
  }
}
