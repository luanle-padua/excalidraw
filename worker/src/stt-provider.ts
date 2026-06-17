// STT provider seam (Admin Console P2 — "STT provider swap").
//
// One INTERFACE every realtime speech-to-text backend implements, so the /stt
// proxy (stt.ts) is provider-agnostic: it opens the active adapter's upstream
// socket, then forwards normalized {interim|final} text frames to the client.
// Today Deepgram is the working default; ElevenLabs + OpenAI Realtime are
// skeletons that throw "provider not configured" until wired up. Swapping is a
// config change (STT_PROVIDER var), not a code change.
//
// Design notes:
//   - open(env,lang,model) returns an ALREADY-CONNECTED, .accept()-ed outbound
//     WebSocket (Workers style: fetch(url,{Upgrade:websocket}) → res.webSocket).
//   - The adapter SNAPSHOTS its config at open-time (the URL it built, the key
//     it read) — normalizeMessage must not re-read env per message.
//   - normalizeMessage maps the provider's raw frame onto a common shape, or
//     null for frames the client doesn't need (keepalive acks, metadata, etc.).
//   - The proxy keeps forwarding the provider's RAW frames too for the legacy
//     Deepgram client schema; normalizeMessage is the forward-looking seam other
//     providers slot into without changing the client. (Deepgram stays verbatim
//     so the existing client keeps working byte-for-byte.)

// ---- Common types ----------------------------------------------------------

/** Bindings any adapter may read at open-time. Superset of the worker env. */
export type SttProviderEnv = {
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_STT_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  OPENAI_API_KEY?: string;
  STT_PROVIDER?: string;
  STT_PROVIDER_CONFIG?: string;
};

/** Normalized transcript frame the proxy/client can consume from ANY provider. */
export type NormalizedSttMessage = {
  type: "interim" | "final";
  text: string;
  confidence?: number;
  /** Segment timestamp (provider's, or Date.now() when absent), ms epoch. */
  segmentTs: number;
};

/** Static description of a provider for the admin console + cost metering. */
export type ProviderMetadata = {
  id: string;
  name: string;
  cost: { unit: "minute" | "token" | "second"; usdPerUnit: number };
  requiredApiKey: string;
  defaultModel: string;
};

/** The seam every STT backend implements. */
export interface SttAdapter {
  readonly meta: ProviderMetadata;
  /**
   * Open an upstream realtime STT socket for `lang`/`model`. Returns a
   * connected, accepted WebSocket. Throws if the provider isn't configured
   * (missing key) or the upstream upgrade fails — the proxy surfaces that to
   * the client as an `{type:"error"}` frame, then closes.
   */
  open(env: SttProviderEnv, lang: string, model: string): Promise<WebSocket>;
  /**
   * Map a raw upstream frame (string JSON or binary) to a normalized message,
   * or null to drop it. MUST NOT read env — snapshot config at open-time.
   */
  normalizeMessage(raw: unknown): NormalizedSttMessage | null;
}

// ---- Shared config ---------------------------------------------------------

/** Languages we explicitly support; `multi` lets the provider auto-detect. */
export const SUPPORTED_LANGS = new Set(["en", "vi", "ko", "ja", "zh", "multi"]);

// ---- Deepgram (working default) -------------------------------------------

const DEEPGRAM_DEFAULT_MODEL = "nova-3";

// Industry vocabulary boost — Deepgram Nova-3 `keyterms`. Architecture /
// construction / digital-design terms Deepgram tends to mishear (BIM → "beam",
// IFC → "IFCC", Korean tools romanised oddly). Nova-3 accepts up to 100; we sit
// well under. Each appears as a repeated `?keyterms=…`.
const DEEPGRAM_KEYTERMS = [
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

// Per-language endpointing tuning. `endpointing` = ms of silence Deepgram waits
// before declaring an utterance final. Korean/Japanese are SOV (verb at the end
// + a brief pre-verb pause), so a short window chops the verb; SVO (en/vi)
// finalises faster. `utterance_end_ms` is a separate Deepgram flush signal.
const DEEPGRAM_ENDPOINTING_BY_LANG: Record<
  string,
  { endpointing: number; utteranceEnd: number }
> = {
  ko: { endpointing: 1000, utteranceEnd: 1500 },
  ja: { endpointing: 1000, utteranceEnd: 1500 },
  en: { endpointing: 300, utteranceEnd: 1000 },
  vi: { endpointing: 300, utteranceEnd: 1000 },
  zh: { endpointing: 500, utteranceEnd: 1200 },
  multi: { endpointing: 800, utteranceEnd: 1500 },
};

const buildDeepgramUrl = (lang: string, model: string): string => {
  const tuning =
    DEEPGRAM_ENDPOINTING_BY_LANG[lang] ?? DEEPGRAM_ENDPOINTING_BY_LANG.multi;
  const params = new URLSearchParams({
    model,
    language: lang,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    numerals: "true",
    endpointing: String(tuning.endpointing),
    utterance_end_ms: String(tuning.utteranceEnd),
    vad_events: "true",
  });
  // Nova-3 keyterm prompting uses the SINGULAR param `keyterm` (one per term).
  // `keyterms`/`keywords` are NOT recognized on nova-3 streaming → Deepgram
  // silently ignores them, so the whole BIM/Korean vocab boost would no-op.
  for (const term of DEEPGRAM_KEYTERMS) {
    params.append("keyterm", term);
  }
  // Cloudflare Workers' fetch()-based WebSocket upgrade requires an http(s)
  // scheme, NOT ws(s) (CF treats the request as HTTP and upgrades it). This was
  // ported from the Node `ws` room server which wanted wss://; on the Worker
  // wss:// fails the upgrade → no transcripts. Must be https://.
  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
};

export class DeepgramAdapter implements SttAdapter {
  readonly meta: ProviderMetadata = {
    id: "deepgram",
    name: "Deepgram",
    cost: { unit: "minute", usdPerUnit: 0.0043 },
    requiredApiKey: "DEEPGRAM_API_KEY",
    defaultModel: DEEPGRAM_DEFAULT_MODEL,
  };

  async open(
    env: SttProviderEnv,
    lang: string,
    model: string,
  ): Promise<WebSocket> {
    const apiKey = (env.DEEPGRAM_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("provider not configured");
    }
    const url = buildDeepgramUrl(lang, model || DEEPGRAM_DEFAULT_MODEL);
    const upstream = await fetch(url, {
      headers: { Upgrade: "websocket", Authorization: `Token ${apiKey}` },
    });
    const ws = upstream.webSocket;
    if (!ws) {
      throw new Error("Deepgram did not accept the WebSocket upgrade");
    }
    ws.accept();
    return ws;
  }

  normalizeMessage(raw: unknown): NormalizedSttMessage | null {
    if (typeof raw !== "string") {
      return null;
    }
    let json: {
      type?: string;
      is_final?: boolean;
      channel?: {
        alternatives?: Array<{ transcript?: string; confidence?: number }>;
      };
      start?: number;
    };
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    if (json.type !== "Results") {
      return null; // SpeechStarted / UtteranceEnd / Metadata — not a transcript
    }
    const alt = json.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!text) {
      return null;
    }
    return {
      type: json.is_final ? "final" : "interim",
      text,
      confidence:
        typeof alt?.confidence === "number" ? alt.confidence : undefined,
      segmentTs:
        typeof json.start === "number" ? json.start * 1000 : Date.now(),
    };
  }
}

// ---- Skeleton adapters (not yet configured) --------------------------------

export class ElevenLabsAdapter implements SttAdapter {
  readonly meta: ProviderMetadata = {
    id: "elevenlabs",
    name: "ElevenLabs",
    cost: { unit: "minute", usdPerUnit: 0 },
    requiredApiKey: "ELEVENLABS_API_KEY",
    defaultModel: "scribe_v1",
  };

  async open(): Promise<WebSocket> {
    // Skeleton — wire up the ElevenLabs realtime STT socket here.
    throw new Error("provider not configured");
  }

  normalizeMessage(): NormalizedSttMessage | null {
    return null;
  }
}

export class OpenAIRealtimeAdapter implements SttAdapter {
  readonly meta: ProviderMetadata = {
    id: "openai",
    name: "OpenAI Realtime",
    cost: { unit: "minute", usdPerUnit: 0 },
    requiredApiKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-transcribe",
  };

  async open(): Promise<WebSocket> {
    // Skeleton — wire up the OpenAI Realtime transcription socket here.
    throw new Error("provider not configured");
  }

  normalizeMessage(): NormalizedSttMessage | null {
    return null;
  }
}

// ---- Registry + selection --------------------------------------------------

const REGISTRY: Record<string, () => SttAdapter> = {
  deepgram: () => new DeepgramAdapter(),
  elevenlabs: () => new ElevenLabsAdapter(),
  openai: () => new OpenAIRealtimeAdapter(),
};

export const DEFAULT_STT_PROVIDER = "deepgram";

/**
 * Resolve the active STT adapter from STT_PROVIDER (default 'deepgram'). An
 * unknown value falls back to Deepgram so a typo can't take STT down — the
 * working default is always reachable.
 */
export const getActiveProvider = (env: SttProviderEnv): SttAdapter => {
  const id =
    (env.STT_PROVIDER ?? "").trim().toLowerCase() || DEFAULT_STT_PROVIDER;
  const make = REGISTRY[id] ?? REGISTRY[DEFAULT_STT_PROVIDER];
  return make();
};

/** Provider metadata list — for the admin console's provider picker. */
export const listProviders = (): ProviderMetadata[] =>
  Object.values(REGISTRY).map((make) => make().meta);
