// Realtime Speech-to-Text WebSocket proxy — Worker edition.
//
// Ported from the Fly room server (room/src/stt.ts) to the mcm-storage Worker
// as part of the Durable Objects migration (I-1, docs/plans/
// durable-objects-migration.md §2/§6). The route is split in the Worker's
// fetch() BEFORE the RoomDO route, so a /stt upgrade NEVER reaches RoomDO.
//
// Each browser tab opens 1 WebSocket to `/stt?lang=<vi|en|ko|...>`. The Worker
// opens a parallel WebSocket to the ACTIVE STT provider (Deepgram by default,
// see src/stt-provider.ts) with the server-side API key (never shipped to the
// browser) and pipes:
//
//   client binary PCM frames ──▶ provider (audio in)
//   provider JSON transcripts ──▶ client (text out)
//
// Provider selection is the STT_PROVIDER var (Admin Console P2): the proxy is
// provider-agnostic — it asks getActiveProvider(env) for an adapter, opens the
// adapter's upstream socket, and forwards frames. Deepgram frames are forwarded
// VERBATIM so the existing client schema (Results / SpeechStarted / UtteranceEnd)
// keeps working byte-for-byte; the adapter's normalizeMessage is the
// forward-looking seam other providers slot into.
//
// Workers outbound WebSocket: there is no `ws` package — the adapter opens the
// upstream socket with `fetch(url, { headers: { Upgrade: "websocket", ... } })`
// and returns `response.webSocket` already `.accept()`-ed. Same teardown
// contract as the room server: 8s KeepAlive, CloseStream on shutdown, mutual close.
//
// Audio format on the wire: 16-bit signed little-endian PCM, 16kHz, mono — the
// client's AudioWorklet downsamples from the browser's native rate.

import { createRemoteJWKSet, jwtVerify } from "jose";

import { getActiveProvider, SUPPORTED_LANGS } from "./stt-provider";
import { deepgramSttCostUsd, logUsageEvent } from "./usage";

import type { SttProviderEnv } from "./stt-provider";

export type SttBindings = SttProviderEnv & {
  // Deepgram API key — SECRET. Same name the room server used so config carries
  // over. Local: worker/.dev.vars · Prod: `wrangler secret put DEEPGRAM_API_KEY`.
  DEEPGRAM_API_KEY?: string;
  // Optional model override (plain var). Defaults to nova-3.
  DEEPGRAM_STT_MODEL?: string;
  // Supabase project URL — used to build the JWT issuer + JWKS endpoint so the
  // /stt upgrade can verify the user token (B-AI, 06-17). Without it auth can't
  // run, so the upgrade is rejected (fail closed — STT is metered cost).
  SUPABASE_URL?: string;
  // D1 — best-effort STT cost metering into usage_events (provider='deepgram').
  DB?: D1Database;
};

// Protocol marker the client always sends first on the WS handshake, mirroring
// the realtime DO transport: `Sec-WebSocket-Protocol: mcm.v1, <jwt>`. The TOKEN
// is the segment that is NOT this marker; the marker is what we echo back.
const STT_PROTOCOL_MARKER = "mcm.v1";

// Cached JWKS (one fetch per isolate; jose handles refresh/rotation).
let sttJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Verify the Supabase JWT carried in the WS subprotocol. Returns true iff a
 *  valid `authenticated` token is present. Mirrors verifyRealtimeJwt in
 *  index.ts (same offline ES256 JWKS verify, issuer + audience) — kept local to
 *  avoid a circular import with index.ts. */
const sttAuthOk = async (
  request: Request,
  env: SttBindings,
): Promise<{ ok: boolean; email?: string }> => {
  if (!env.SUPABASE_URL) {
    return { ok: false };
  }
  const proto = request.headers.get("Sec-WebSocket-Protocol");
  if (!proto) {
    return { ok: false };
  }
  const token =
    proto
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .find((s) => s !== STT_PROTOCOL_MARKER) ?? "";
  if (!token) {
    return { ok: false };
  }
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  if (!sttJwks) {
    sttJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  try {
    const { payload } = await jwtVerify(token, sttJwks, {
      issuer,
      audience: "authenticated",
    });
    const email =
      typeof payload.email === "string"
        ? payload.email.toLowerCase()
        : undefined;
    return { ok: true, email };
  } catch {
    return { ok: false };
  }
};

// Deepgram closes idle WS after ~10s; ping at 8s to keep alive when the user is
// silent (between sentences).
const KEEPALIVE_INTERVAL_MS = 8000;

/**
 * Handle a `/stt` WebSocket upgrade on the Worker. Accepts the client socket,
 * asks the active provider adapter to open an outbound WS with the server-side
 * key, and pipes PCM up / transcripts down. Returns the 101 response carrying
 * the client socket, or a non-101 error response when the upgrade is wrong.
 *
 * STT is default-OFF behaviour preserved: when the active provider isn't
 * configured (e.g. no DEEPGRAM_API_KEY) the adapter's open() throws "provider
 * not configured"; the proxy still accepts the client socket, emits an
 * `{type:"error", code:"no-provider"}` frame, and closes — identical to the
 * room server (so the client UI shows the same "not configured" path instead of
 * a hard handshake failure).
 */
export const handleSttUpgrade = async (
  request: Request,
  env: SttBindings,
  ctx?: ExecutionContext,
): Promise<Response> => {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  // Auth gate (B-AI, 06-17): /stt opens a metered provider stream with the
  // server-side key, so it MUST require a valid Supabase user token. The client
  // (audio/sttSession.ts) sends it via the WS subprotocol exactly like the DO
  // handshake: `Sec-WebSocket-Protocol: mcm.v1, <jwt>`. Fail closed → 401 (the
  // browser surfaces this as a failed WS open, which the client's onerror
  // handler already reports). STT is also default-OFF, so this only adds auth.
  const auth = await sttAuthOk(request, env);
  if (!auth.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  // Cost metering context: who + which meeting + when the stream opened. The
  // Deepgram bill is per-second of audio streamed, so we time the session and
  // write one usage_events row on teardown (see cleanup). meetingId is best-
  // effort from ?meetingId=.
  const callerEmail = auth.email;
  const meetingId =
    new URL(request.url).searchParams.get("meetingId") ?? undefined;
  const sessionStart = Date.now();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  // Active provider (STT_PROVIDER var, default 'deepgram'). The adapter snapshots
  // its config at open-time; we don't re-read env per message below.
  const adapter = getActiveProvider(env);

  // ?lang=vi|en|ko|multi — falls back to multi if missing/invalid.
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang") ?? "multi";
  const lang = SUPPORTED_LANGS.has(langParam) ? langParam : "multi";

  const model = env.DEEPGRAM_STT_MODEL || adapter.meta.defaultModel;

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let providerWs: WebSocket | null = null;
  let closed = false;

  const cleanup = (reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    void reason;
    // Meter the session — best-effort, never blocks teardown. Deepgram bills per
    // second of streamed audio; we approximate it as the open→close wall time of
    // the proxied socket (the client streams continuously while STT is on). One
    // row per session, provider='deepgram', so the admin Cost tab stops reading 0.
    const seconds = (Date.now() - sessionStart) / 1000;
    if (env.DB && seconds >= 1) {
      const row = logUsageEvent(
        env.DB,
        "deepgram",
        "stt",
        0,
        0,
        seconds,
        deepgramSttCostUsd(seconds),
        meetingId,
        callerEmail,
      );
      if (ctx) {
        ctx.waitUntil(row);
      } else {
        void row;
      }
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (providerWs && providerWs.readyState === WebSocket.OPEN) {
      try {
        providerWs.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    try {
      providerWs?.close();
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

  // Connect to the provider OUTSIDE the request lifetime — the upgrade response
  // (101 + client socket) must return immediately. We open the upstream socket
  // asynchronously; the client socket buffers any PCM frames the AudioWorklet
  // sends before the provider is ready (we drop them until OPEN, mirroring the
  // room server which forwarded only when the upstream readyState === OPEN).
  (async () => {
    let ws: WebSocket;
    try {
      ws = await adapter.open(env, lang, model);
    } catch (err) {
      const message = (err as Error)?.message ?? "STT open failed";
      // "provider not configured" → default-OFF path (no-provider frame); any
      // other failure is an upstream error. Both still 101'd to the client.
      const notConfigured = message === "provider not configured";
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(
            JSON.stringify(
              notConfigured
                ? {
                    type: "error",
                    code: "no-provider",
                    message: "STT not configured on this server",
                  }
                : { type: "error", code: "upstream", message },
            ),
          );
        }
      } catch {
        /* ignore */
      }
      cleanup(notConfigured ? "no-provider" : "provider-connect-failed");
      return;
    }

    providerWs = ws;

    // Provider is connected. Confirm to the client so the UI can show
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

    // Provider → client: forward JSON transcript frames VERBATIM. The Deepgram
    // client already speaks the Results / SpeechStarted / UtteranceEnd schema;
    // keeping the raw passthrough preserves it byte-for-byte. (adapter.normalize-
    // Message is the seam other providers map onto without changing the client.)
    ws.addEventListener("message", (event) => {
      if (server.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        server.send(event.data);
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener("close", () => cleanup("provider-closed"));
    ws.addEventListener("error", () => {
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(
            JSON.stringify({
              type: "error",
              code: "upstream",
              message: "STT provider WS error",
            }),
          );
        }
      } catch {
        /* ignore */
      }
      cleanup("provider-error");
    });
  })();

  // Client → provider. Binary = raw PCM audio (forward as-is). Text = control
  // message (e.g. {"type":"CloseStream"}) — forward so the provider can flush the
  // final transcript before tear-down. Drop until the provider is OPEN.
  server.addEventListener("message", (event) => {
    if (!providerWs || providerWs.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      providerWs.send(event.data);
    } catch {
      /* ignore */
    }
  });

  server.addEventListener("close", () => cleanup("client-closed"));
  server.addEventListener("error", () => cleanup("client-error"));

  // Echo the agreed subprotocol on the 101 (RFC 6455). The client always opens
  // with `Sec-WebSocket-Protocol: mcm.v1[, <jwt>]`, and per the spec the browser
  // FAILS the WS open unless the server echoes back exactly one offered
  // subprotocol. The realtime DO route (index.ts) does this; this proxy was
  // ported without it, so every authenticated /stt handshake was rejected before
  // any audio could flow — i.e. transcription silently never started.
  const respHeaders = new Headers();
  respHeaders.set("Sec-WebSocket-Protocol", STT_PROTOCOL_MARKER);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: respHeaders,
  });
};
