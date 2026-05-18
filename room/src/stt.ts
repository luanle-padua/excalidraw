// Realtime Speech-to-Text WebSocket proxy.
//
// Each browser tab opens 1 WebSocket to `/stt?lang=<vi|en|ko>`. The
// server opens a parallel WebSocket to Deepgram with the API key
// (server-side only — never shipped to the browser) and pipes:
//
//   client binary PCM frames ──▶ Deepgram (audio in)
//   Deepgram JSON transcripts ──▶ client (text out)
//
// Per-speaker model: every tab transcribes its own mic → speaker
// attribution is 100% accurate (we know which user opened the
// connection). No diarization needed.
//
// Audio format on the wire: 16-bit signed little-endian PCM, 16kHz,
// mono. The client's AudioWorklet handles downsampling from the
// browser's native 48kHz / 44.1kHz.
//
// Lifecycle:
//   - Client opens → server opens Deepgram WS → server sends
//     KeepAlive every 8s (Deepgram closes idle WS after ~10s)
//   - Client sends binary frame → server forwards to Deepgram
//   - Deepgram sends Results JSON → server forwards to client
//   - Client closes (audio call ended / page navigation) →
//     server sends CloseStream → Deepgram closes → server cleans up

import debug from "debug";
import type http from "http";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";

const sttDebug = debug("server:stt");

// Deepgram closes idle WS after ~10s; ping at 8s to keep alive when
// the user is silent (between sentences).
const KEEPALIVE_INTERVAL_MS = 8000;

// Languages we explicitly support. `multi` lets Deepgram auto-detect
// between en/ko/vi mid-stream — useful when speaker code-switches.
const SUPPORTED_LANGS = new Set(["en", "vi", "ko", "ja", "zh", "multi"]);

const DEFAULT_MODEL = "nova-3";

// ---------------------------------------------------------------------
// Industry vocabulary boost — Deepgram Nova-3 `keyterms`.
//
// Architecture / construction / digital-design domain terms that
// Deepgram tends to mishear out of the box (BIM → "beam", IFC → "IFCC",
// Korean tools romanised oddly). Listing them as `keyterms` tells the
// model "expect this exact phrase" and dramatically improves recall.
//
// Limit: Nova-3 accepts up to 100 keyterms per session — we sit well
// under that. Each appears as a repeated `?keyterms=…` query param.
//
// Multi-word phrases work fine (e.g. "Digital Twin"). We keep brand
// names exact-case because Deepgram's smart_format normalises casing
// based on the boosted token's casing.
// ---------------------------------------------------------------------
const KEYTERMS = [
  // --- BIM / digital workflow ---
  "BIM",
  "Digital Twin",
  "IFC",
  "COBie",
  "LOD",
  "clash detection",
  "Navisworks",
  "Revit",
  "AutoCAD",
  "ArchiCAD",
  "SketchUp",
  "Rhino",
  "Grasshopper",
  "Dynamo",
  "parametric design",
  "generative design",
  "computational design",

  // --- Rendering / visualisation ---
  "rendering",
  "real-time rendering",
  "ray tracing",
  "V-Ray",
  "Lumion",
  "Enscape",
  "D5 Render",
  "Twinmotion",
  "Unreal Engine",

  // --- AI / capture ---
  "AI",
  "machine learning",
  "neural network",
  "LLM",
  "ChatGPT",
  "Stable Diffusion",
  "photogrammetry",
  "LiDAR",
  "point cloud",
  "3D scan",
  "VR",
  "AR",
  "XR",

  // --- Architecture / design vocabulary ---
  "facade",
  "curtain wall",
  "cladding",
  "mullion",
  "cantilever",
  "massing",
  "site plan",
  "floor plan",
  "elevation",
  "section",
  "perspective",
  "concept design",
  "schematic design",
  "design development",
  "construction documents",
  "RFI",
  "shop drawing",

  // --- Construction / engineering ---
  "RC",
  "reinforced concrete",
  "rebar",
  "formwork",
  "slab",
  "load-bearing wall",
  "shear wall",
  "MEP",
  "HVAC",

  // --- Korean tooling + construction terms ---
  // (Deepgram romanises Hangul oddly without boosting; listing
  //  Hangul directly catches the actual spoken word.)
  "내력벽", // load-bearing wall
  "전단벽", // shear wall
  "철근콘크리트", // reinforced concrete
  "철근", // rebar
  "콘크리트", // concrete
  "거푸집", // formwork
  "슬래브", // slab
  "기둥", // column
  "보", // beam
  "도면", // drawing
  "평면도", // floor plan
  "입면도", // elevation
  "단면도", // section
  "배치도", // site plan
  "투시도", // perspective
  "파사드", // facade
  "커튼월", // curtain wall
  "캔틸레버", // cantilever
  "디지털 트윈", // Digital Twin
  "렌더링", // rendering
  "인공지능", // AI
  "머신러닝", // machine learning
  "레빗", // Revit
  "라이노", // Rhino
  "스케치업", // SketchUp
  "그라스호퍼", // Grasshopper
  "루미온", // Lumion
  "언리얼 엔진", // Unreal Engine
  "트윈모션", // Twinmotion
  "감리", // construction supervision
  "준공", // project completion
  "시방서", // specification
  "견적", // estimate
  "설계", // design
  "시공", // construction
];

// Per-language endpointing tuning. `endpointing` = how many ms of
// silence Deepgram waits before declaring an utterance final.
//
// Korean / Japanese are SOV (subject-object-verb) — the verb arrives
// AT THE END of the sentence, and speakers commonly pause briefly
// before delivering it. A short endpointing window (e.g. 300ms) cuts
// the sentence off before the verb arrives, producing fragmented
// transcripts like "이 부분은…" without the actual action.
// SVO languages (en/vi) don't have this problem — the verb comes
// early, so a shorter window keeps the UI snappy.
//
// `utterance_end_ms` is a separate Deepgram signal that fires the
// `UtteranceEnd` event after this much silence — we use it to flush
// any trailing words Deepgram is still pondering.
const ENDPOINTING_BY_LANG: Record<string, { endpointing: number; utteranceEnd: number }> = {
  ko: { endpointing: 1000, utteranceEnd: 1500 }, // Korean SOV — long verb tail
  ja: { endpointing: 1000, utteranceEnd: 1500 }, // Japanese SOV
  en: { endpointing: 300, utteranceEnd: 1000 }, // English SVO — fast finalisation
  vi: { endpointing: 300, utteranceEnd: 1000 }, // Vietnamese SVO
  zh: { endpointing: 500, utteranceEnd: 1200 }, // Chinese: middle ground
  // `multi` auto-detects per utterance — use the more permissive
  // Korean numbers as the floor so we don't chop Korean speakers.
  multi: { endpointing: 800, utteranceEnd: 1500 },
};

const buildDeepgramUrl = (lang: string): string => {
  const model = process.env.DEEPGRAM_STT_MODEL || DEFAULT_MODEL;
  const tuning = ENDPOINTING_BY_LANG[lang] ?? ENDPOINTING_BY_LANG.multi;
  const params = new URLSearchParams({
    model,
    language: lang,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    // Stream interim hypotheses so the UI can show text appearing
    // as the user speaks. Final results overwrite the interim line.
    interim_results: "true",
    // Punctuation + capitalisation + smart formatting (dates,
    // numbers) so transcript reads naturally without post-processing.
    smart_format: "true",
    // Spell out numbers as digits — important for architecture
    // meetings where dimensions / quantities / counts are constant
    // ("two hundred millimeters" → "200 millimeters").
    numerals: "true",
    // Silence duration before an utterance is finalised. Tuned per
    // language above to avoid cutting Korean/Japanese sentences
    // before the trailing verb arrives.
    endpointing: String(tuning.endpointing),
    // Separate signal: emit `UtteranceEnd` after this much silence
    // so the client can confidently flush the interim line.
    utterance_end_ms: String(tuning.utteranceEnd),
    // Voice-activity events let the client know when the user starts
    // / stops speaking — useful for "speaking now" indicator.
    vad_events: "true",
  });
  // Domain vocabulary boost — appended as repeated `?keyterms=…`.
  // Deepgram Nova-3 understands these as exact phrases to listen for,
  // dramatically reducing mishears on industry jargon and Korean
  // technical terms that the model otherwise breaks into syllables.
  for (const term of KEYTERMS) {
    params.append("keyterms", term);
  }
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
};

/**
 * Attach a WebSocket server at path `/stt` to the existing http server.
 * Returns the wss instance for testing / shutdown hooks.
 */
export const mountSTT = (server: http.Server): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only intercept our STT path — leave everything else for socket.io.
    if (!req.url || !req.url.startsWith("/stt")) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (clientWs, req) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      sttDebug("rejecting STT connection — DEEPGRAM_API_KEY not set");
      clientWs.send(
        JSON.stringify({
          type: "error",
          code: "no-provider",
          message: "STT not configured on this server",
        }),
      );
      clientWs.close(1011, "STT not configured");
      return;
    }

    // ?lang=vi|en|ko|multi — falls back to multi if missing/invalid.
    const url = new URL(req.url ?? "/stt", "ws://placeholder");
    const langParam = url.searchParams.get("lang") ?? "multi";
    const lang = SUPPORTED_LANGS.has(langParam) ? langParam : "multi";

    sttDebug(`STT session opened (lang=${lang})`);

    const deepgramUrl = buildDeepgramUrl(lang);
    const deepgramWs = new WebSocket(deepgramUrl, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    let keepaliveTimer: NodeJS.Timeout | null = null;
    let closed = false;

    const cleanup = (reason: string) => {
      if (closed) {
        return;
      }
      closed = true;
      sttDebug(`STT session closing — ${reason}`);
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (
        deepgramWs.readyState === WebSocket.OPEN ||
        deepgramWs.readyState === WebSocket.CONNECTING
      ) {
        try {
          if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
          }
        } catch {
          /* ignore */
        }
        deepgramWs.close();
      }
      if (
        clientWs.readyState === WebSocket.OPEN ||
        clientWs.readyState === WebSocket.CONNECTING
      ) {
        clientWs.close();
      }
    };

    deepgramWs.on("open", () => {
      sttDebug("Deepgram upstream connected");
      // Confirm the session is live to the client so the UI can show
      // "Đang nghe…" instead of a spinner.
      clientWs.send(JSON.stringify({ type: "ready", lang }));
      keepaliveTimer = setInterval(() => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    deepgramWs.on("message", (data) => {
      // Deepgram sends JSON text frames. Forward verbatim — the client
      // already speaks Deepgram's "Results" / "SpeechStarted" /
      // "UtteranceEnd" schema, no transformation needed here.
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString());
      }
    });

    deepgramWs.on("error", (err) => {
      sttDebug(`Deepgram WS error: ${err.message}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: "error",
            code: "upstream",
            message: err.message,
          }),
        );
      }
      cleanup("deepgram-error");
    });

    deepgramWs.on("close", () => {
      cleanup("deepgram-closed");
    });

    clientWs.on("message", (data, isBinary) => {
      if (deepgramWs.readyState !== WebSocket.OPEN) {
        return;
      }
      if (isBinary) {
        // Raw PCM audio frame — forward as-is.
        deepgramWs.send(data);
      } else {
        // Text frame from client = control message (e.g.,
        // {"type":"CloseStream"}). Forward to Deepgram so it can
        // flush the final transcript before tear-down.
        deepgramWs.send(data.toString());
      }
    });

    clientWs.on("close", () => {
      cleanup("client-closed");
    });

    clientWs.on("error", (err) => {
      sttDebug(`Client WS error: ${err.message}`);
      cleanup("client-error");
    });
  });

  return wss;
};
