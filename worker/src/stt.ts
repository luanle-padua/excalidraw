// Realtime Speech-to-Text WebSocket proxy — Worker edition.
//
// Ported from the Fly room server (room/src/stt.ts) to the mcm-storage Worker
// as part of the Durable Objects migration (I-1, docs/plans/
// durable-objects-migration.md §2/§6). The route is split in the Worker's
// fetch() BEFORE the RoomDO route, so a /stt upgrade NEVER reaches RoomDO.
//
// Each browser tab opens 1 WebSocket to `/stt?lang=<vi|en|ko|...>`. The Worker
// opens a parallel WebSocket to Deepgram with the API key (server-side only,
// never shipped to the browser) and pipes:
//
//   client binary PCM frames ──▶ Deepgram (audio in)
//   Deepgram JSON transcripts ──▶ client (text out)
//
// Workers outbound WebSocket: there is no `ws` package — we open the upstream
// socket with `fetch(deepgramUrl, { headers: { Upgrade: "websocket", ... } })`
// and read `response.webSocket`, then call `.accept()`. Same teardown contract
// as the room server: 8s KeepAlive, CloseStream on shutdown, mutual close.
//
// Audio format on the wire: 16-bit signed little-endian PCM, 16kHz, mono — the
// client's AudioWorklet downsamples from the browser's native rate.

export type SttBindings = {
  // Deepgram API key — SECRET. Same name the room server used so config carries
  // over. Local: worker/.dev.vars · Prod: `wrangler secret put DEEPGRAM_API_KEY`.
  DEEPGRAM_API_KEY?: string;
  // Optional model override (plain var). Defaults to nova-3.
  DEEPGRAM_STT_MODEL?: string;
};

// Deepgram closes idle WS after ~10s; ping at 8s to keep alive when the user is
// silent (between sentences).
const KEEPALIVE_INTERVAL_MS = 8000;

// Languages we explicitly support. `multi` lets Deepgram auto-detect between
// en/ko/vi mid-stream — useful when a speaker code-switches.
const SUPPORTED_LANGS = new Set(["en", "vi", "ko", "ja", "zh", "multi"]);

const DEFAULT_MODEL = "nova-3";

// ---------------------------------------------------------------------
// Industry vocabulary boost — Deepgram Nova-3 `keyterms`. Architecture /
// construction / digital-design domain terms Deepgram tends to mishear out of
// the box (BIM → "beam", IFC → "IFCC", Korean tools romanised oddly). Listing
// them as `keyterms` tells the model "expect this exact phrase". Nova-3 accepts
// up to 100; we sit well under. Each appears as a repeated `?keyterms=…`.
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

// Per-language endpointing tuning. `endpointing` = how many ms of silence
// Deepgram waits before declaring an utterance final. Korean / Japanese are SOV
// (verb at the end + a brief pre-verb pause), so a short window chops the verb;
// SVO languages (en/vi) finalise faster. `utterance_end_ms` is a separate
// Deepgram signal that fires `UtteranceEnd` to flush trailing words.
const ENDPOINTING_BY_LANG: Record<
  string,
  { endpointing: number; utteranceEnd: number }
> = {
  ko: { endpointing: 1000, utteranceEnd: 1500 }, // Korean SOV — long verb tail
  ja: { endpointing: 1000, utteranceEnd: 1500 }, // Japanese SOV
  en: { endpointing: 300, utteranceEnd: 1000 }, // English SVO — fast finalisation
  vi: { endpointing: 300, utteranceEnd: 1000 }, // Vietnamese SVO
  zh: { endpointing: 500, utteranceEnd: 1200 }, // Chinese: middle ground
  // `multi` auto-detects per utterance — use the more permissive Korean numbers
  // as the floor so we don't chop Korean speakers.
  multi: { endpointing: 800, utteranceEnd: 1500 },
};

const buildDeepgramUrl = (lang: string, model: string): string => {
  const tuning = ENDPOINTING_BY_LANG[lang] ?? ENDPOINTING_BY_LANG.multi;
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
  for (const term of KEYTERMS) {
    params.append("keyterms", term);
  }
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
};

/**
 * Handle a `/stt` WebSocket upgrade on the Worker. Accepts the client socket,
 * opens an outbound WS to Deepgram with the server-side key, and pipes PCM
 * up / transcripts down. Returns the 101 response carrying the client socket,
 * or a non-101 error response when the upgrade / config is wrong.
 *
 * STT is default-OFF behaviour preserved: with no DEEPGRAM_API_KEY the proxy
 * still accepts the client socket, emits an `{type:"error", code:"no-provider"}`
 * frame, and closes — identical to the room server (so the client UI shows the
 * same "not configured" path instead of a hard handshake failure).
 */
export const handleSttUpgrade = async (
  request: Request,
  env: SttBindings,
): Promise<Response> => {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    // STT not configured (default OFF). Tell the client the same way the room
    // server did, then close. Still a 101 so the browser's WS open() succeeds
    // and the onmessage error handler fires (matches client expectations).
    try {
      server.send(
        JSON.stringify({
          type: "error",
          code: "no-provider",
          message: "STT not configured on this server",
        }),
      );
    } catch {
      /* ignore */
    }
    server.close(1011, "STT not configured");
    return new Response(null, { status: 101, webSocket: client });
  }

  // ?lang=vi|en|ko|multi — falls back to multi if missing/invalid.
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang") ?? "multi";
  const lang = SUPPORTED_LANGS.has(langParam) ? langParam : "multi";

  const model = env.DEEPGRAM_STT_MODEL || DEFAULT_MODEL;
  const deepgramUrl = buildDeepgramUrl(lang, model);

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let deepgramWs: WebSocket | null = null;
  let closed = false;

  const cleanup = (reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    void reason;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      try {
        deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    try {
      deepgramWs?.close();
    } catch {
      /* ignore */
    }
    try {
      if (server.readyState === WebSocket.OPEN) {
        server.close();
      }
    } catch {
      /* ignore */
    }
  };

  // Connect to Deepgram OUTSIDE the request lifetime — the upgrade response
  // (101 + client socket) must return immediately. We open the upstream socket
  // asynchronously; the client socket buffers any PCM frames the AudioWorklet
  // sends before Deepgram is ready (we drop them until OPEN, mirroring the room
  // server which forwarded only when Deepgram readyState === OPEN).
  (async () => {
    let upstream: Response;
    try {
      upstream = await fetch(deepgramUrl, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Token ${apiKey}`,
        },
      });
    } catch (err) {
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(
            JSON.stringify({
              type: "error",
              code: "upstream",
              message: (err as Error).message,
            }),
          );
        }
      } catch {
        /* ignore */
      }
      cleanup("deepgram-connect-failed");
      return;
    }

    const ws = upstream.webSocket;
    if (!ws) {
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(
            JSON.stringify({
              type: "error",
              code: "upstream",
              message: "Deepgram did not accept the WebSocket upgrade",
            }),
          );
        }
      } catch {
        /* ignore */
      }
      cleanup("deepgram-no-socket");
      return;
    }

    deepgramWs = ws;
    // Handle this socket here in JS (proxy), rather than passing it to a client.
    ws.accept();

    // Deepgram is connected. Confirm to the client so the UI can show
    // "listening" instead of a spinner, and start the keepalive.
    try {
      server.send(JSON.stringify({ type: "ready", lang }));
    } catch {
      /* ignore */
    }
    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {
          /* ignore */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Deepgram → client: forward JSON transcript frames verbatim. The client
    // already speaks Deepgram's Results / SpeechStarted / UtteranceEnd schema.
    ws.addEventListener("message", (event) => {
      if (server.readyState !== WebSocket.OPEN) {
        return;
      }
      const data = event.data;
      try {
        server.send(typeof data === "string" ? data : data);
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener("close", () => cleanup("deepgram-closed"));
    ws.addEventListener("error", () => {
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(
            JSON.stringify({
              type: "error",
              code: "upstream",
              message: "Deepgram WS error",
            }),
          );
        }
      } catch {
        /* ignore */
      }
      cleanup("deepgram-error");
    });
  })();

  // Client → Deepgram. Binary = raw PCM audio (forward as-is). Text = control
  // message (e.g. {"type":"CloseStream"}) — forward so Deepgram can flush the
  // final transcript before tear-down. Drop until Deepgram is OPEN.
  server.addEventListener("message", (event) => {
    if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      deepgramWs.send(event.data);
    } catch {
      /* ignore */
    }
  });

  server.addEventListener("close", () => cleanup("client-closed"));
  server.addEventListener("error", () => cleanup("client-error"));

  return new Response(null, { status: 101, webSocket: client });
};
