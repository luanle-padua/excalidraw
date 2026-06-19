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

import { getProviderByIdOrActive, SUPPORTED_LANGS } from "./stt-provider";
import { logUsageEvent } from "./usage";

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
  // Cost kill-switch (audit). Plain var defaulting to "on"; flip to "off" via
  // `wrangler secret put STT_ENABLED off` to stop Deepgram spend cold with no
  // redeploy — the upgrade is rejected 503 before any provider socket opens.
  // Unset / anything-but-"off" leaves STT ON.
  STT_ENABLED?: string;
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
): Promise<{ ok: boolean; email?: string; role?: string }> => {
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
    const appMeta = payload.app_metadata as { role?: unknown } | undefined;
    const role =
      typeof appMeta?.role === "string" ? appMeta.role : undefined;
    return { ok: true, email, role };
  } catch {
    return { ok: false };
  }
};

// Deepgram closes idle WS after ~10s; ping at 8s to keep alive when the user is
// silent (between sentences).
const KEEPALIVE_INTERVAL_MS = 8000;

// STT real-money guards (audit). Each /stt upgrade opens a Deepgram stream that
// bills per audio-second, so a leaked/forgotten socket leaks $.
//   - OPEN_LIMIT: max opens per user per window — caps a reconnect/spam storm.
//   - MAX_SESSION_MS: hard cap on one session — a forgotten tab can't stream
//     Deepgram forever (auto-close at 90 min).
//   - AUDIO_IDLE_MS: close if no audio frame arrives for ~60s — a tab that
//     stopped sending PCM (muted, backgrounded) stops billing.
const STT_OPEN_LIMIT = 3;
const STT_OPEN_WINDOW_MS = 60_000;
const STT_MAX_SESSION_MS = 90 * 60_000;
const STT_AUDIO_IDLE_MS = 60_000;

// Per-user open rate-limit. PER-ISOLATE (in-memory Map): it resets on isolate
// rotation and isn't shared across colos, so it's a soft cost cap, not a hard
// quota — good enough to blunt a single tab's reconnect storm. Keyed by JWT
// email; value is the list of open timestamps inside the current window.
const sttOpenLog = new Map<string, number[]>();
const sttOpenRateLimited = (email: string | undefined): boolean => {
  const key = email ?? "anon";
  const nowMs = Date.now();
  const recent = (sttOpenLog.get(key) ?? []).filter(
    (t) => nowMs - t < STT_OPEN_WINDOW_MS,
  );
  if (recent.length >= STT_OPEN_LIMIT) {
    sttOpenLog.set(key, recent);
    return true;
  }
  recent.push(nowMs);
  sttOpenLog.set(key, recent);
  return false;
};

// Membership gate — mirrors canSeeMeeting() in index.ts (kept local to avoid a
// circular import: index.ts imports handleSttUpgrade from this file). Returns
// true when the caller may open a metered stream for `roomId`: admins always;
// an unregistered room (no `meeting` row) is REJECTED here (security 06-19 —
// STT is metered and meeting-bound, no ad-hoc grace); otherwise the same
// owner/invitee/member/authority arms, with confidential = invitee-only.
const sttCanSeeMeeting = async (
  db: D1Database,
  email: string | undefined,
  role: string | undefined,
  roomId: string,
): Promise<boolean> => {
  if (role === "admin" || role === "owner") {
    return true;
  }
  if (!email) {
    return false;
  }
  const e = email.toLowerCase();
  const row = await db
    .prepare(
      `SELECT
         (SELECT 1 FROM meeting WHERE id = ?1) AS registered,
         (SELECT confidentiality FROM meeting WHERE id = ?1) AS conf,
         (SELECT 1 FROM meeting
            WHERE id = ?1
              AND (lower(organizer_email) = ?2 OR lower(host_email) = ?2))
           AS owner,
         (SELECT 1 FROM meeting_invitee
            WHERE meeting_id = ?1 AND email = ?2 AND status <> 'revoked')
           AS invited,
         (SELECT 1 FROM project_member pm
            JOIN meeting m ON m.project_id = pm.project_id
            WHERE m.id = ?1 AND pm.email = ?2
              AND pm.role IN ('owner','manager')) AS member,
         (SELECT 1 FROM meeting m
            JOIN project p ON p.id = m.project_id
            LEFT JOIN division d ON d.id = p.lead_division_id
            WHERE m.id = ?1
              AND (lower(p.leader_email) = ?2 OR lower(d.head_email) = ?2))
           AS authority`,
    )
    .bind(roomId, e)
    .first<{
      registered: number | null;
      conf: string | null;
      owner: number | null;
      invited: number | null;
      member: number | null;
      authority: number | null;
    }>();
  if (!row?.registered) {
    // FAIL CLOSED on an unregistered room (security 06-19). Unlike the blob/AI
    // path — where canSeeMeeting() stays permissive so the owner's pre-register
    // writes survive the registerMeeting race — STT opens a METERED Deepgram
    // stream with the server key and is always meeting-bound (meetingId is
    // required by the caller). There is no legit "ad-hoc pre-register" STT, so a
    // room that has no registry row (register never landed) must NOT mint a
    // billable stream that anyone with the leaked roomId could open. Mirrors the
    // realtime-upgrade roomIsRegistered gate in index.ts.
    return false;
  }
  if ((row.conf ?? "").toLowerCase() === "confidential") {
    return !!(row.owner || row.invited);
  }
  return !!(row.owner || row.invited || row.member || row.authority);
};

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

  // Kill-switch (audit): STT_ENABLED==="off" → reject the upgrade 503 BEFORE any
  // auth/provider work, so `wrangler secret put STT_ENABLED off` stops Deepgram
  // spend cold with no redeploy. Unset / anything-but-"off" leaves STT ON.
  if (env.STT_ENABLED === "off") {
    return new Response("stt temporarily disabled", { status: 503 });
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

  // Real-money guard (a): membership gate BEFORE accept() — only a member of the
  // meeting may open a Deepgram stream against it. Mirrors the realtime upgrade's
  // canSeeMeeting (a leaked roomId/JWT otherwise lets any logged-in user burn the
  // Deepgram key). FAIL CLOSED (06-18 cross-review): the earlier `if (meetingId
  // && …)` form was a no-op because the client never sent meetingId, and was
  // bypassable by simply omitting the param. STT is always meeting-bound, and an
  // open Deepgram stream is metered $, so REQUIRE a meetingId the caller can see.
  if (!meetingId) {
    return new Response("meetingId required", { status: 400 });
  }
  if (
    env.DB &&
    !(await sttCanSeeMeeting(env.DB, callerEmail, auth.role, meetingId))
  ) {
    return new Response("not a member of this meeting", { status: 403 });
  }

  // Real-money guard (b): per-user open rate-limit (max STT_OPEN_LIMIT opens per
  // STT_OPEN_WINDOW_MS). PER-ISOLATE soft cap — see sttOpenRateLimited. Blunts a
  // reconnect/spam-open storm from a single tab. 429 → the client's onerror path.
  if (sttOpenRateLimited(callerEmail)) {
    return new Response("too many STT sessions, slow down", { status: 429 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  // Deliver incoming binary frames as ArrayBuffer, NOT Blob. The client streams
  // PCM as binary; without this the Workers runtime hands us a Blob, and every
  // forward path mis-handles it: Deepgram's `providerWs.send(blob)` coerces it to
  // the literal string "[object Blob]" (→ a TEXT frame Deepgram rejects with
  // {type:"Error", variant:"SchemaError"}), and the ElevenLabs/OpenAI wrappers'
  // pcmToBase64() throws on a Blob (no `.buffer`) and silently drops the frame.
  // Net effect for EVERY provider: no audio ever reaches the STT engine, so no
  // transcript ever comes back. Forcing arraybuffer fixes all providers at once
  // (root cause of "STT silent everywhere", 06-19).
  server.binaryType = "arraybuffer";

  // ?lang=vi|en|ko|multi — falls back to multi if missing/invalid.
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang") ?? "multi";
  const lang = SUPPORTED_LANGS.has(langParam) ? langParam : "multi";

  // Active provider. Default = STT_PROVIDER var ('deepgram'); a PER-SESSION
  // `?provider=elevenlabs|openai|deepgram` override lets the in-meeting A/B
  // picker test one provider WITHOUT flipping the global var. Unknown/empty id
  // degrades to the env default (see getProviderByIdOrActive). The adapter
  // snapshots its config at open-time; we don't re-read env per message below.
  const adapter = getProviderByIdOrActive(
    env,
    url.searchParams.get("provider"),
  );

  // Model override only applies to Deepgram (its var); other providers fall to
  // their own meta.defaultModel so a stray DEEPGRAM_STT_MODEL can't leak across.
  const model =
    adapter.meta.id === "deepgram"
      ? env.DEEPGRAM_STT_MODEL || adapter.meta.defaultModel
      : adapter.meta.defaultModel;

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Real-money guards (c)/(d): a hard MAX-session cap and an audio-idle cap so a
  // forgotten/muted tab can't stream Deepgram indefinitely. maxSessionTimer
  // fires once at STT_MAX_SESSION_MS; idleTimer is reset on every inbound audio
  // frame and fires if no frame arrives for STT_AUDIO_IDLE_MS.
  let maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let providerWs: WebSocket | null = null;
  let closed = false;

  const cleanup = (reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    void reason;
    // Meter the session — best-effort, never blocks teardown. STT bills per
    // second of streamed audio; we approximate it as the open→close wall time of
    // the proxied socket (the client streams continuously while STT is on). One
    // row per session, stamped with the ACTIVE adapter's id + per-minute rate
    // (NOT a hardcoded Deepgram constant) so the admin Cost tab reflects
    // whichever provider actually ran this A/B session.
    const seconds = (Date.now() - sessionStart) / 1000;
    if (env.DB && seconds >= 1) {
      // meta.cost.unit is "minute" for all 3 providers; (seconds/60)*rate.
      const costUsd = (seconds / 60) * adapter.meta.cost.usdPerUnit;
      const row = logUsageEvent(
        env.DB,
        adapter.meta.id,
        "stt",
        0,
        0,
        seconds,
        costUsd,
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
    if (maxSessionTimer) {
      clearTimeout(maxSessionTimer);
      maxSessionTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
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

  // Real-money guard (c): hard MAX-session auto-close. A forgotten tab left
  // "listening" would otherwise stream Deepgram for hours; cap it at
  // STT_MAX_SESSION_MS. cleanup() meters + tears down both sockets.
  maxSessionTimer = setTimeout(
    () => cleanup("max-session"),
    STT_MAX_SESSION_MS,
  );

  // Real-money guard (d): audio-idle auto-close. Reset on every inbound PCM
  // frame; if no audio arrives for STT_AUDIO_IDLE_MS the client is muted/gone,
  // so stop billing. Armed now and re-armed in the client→provider handler.
  const armIdleTimer = () => {
    if (closed) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => cleanup("audio-idle"), STT_AUDIO_IDLE_MS);
  };
  armIdleTimer();

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
    // Real-money guard (d): a binary frame IS audio — pet the idle watchdog so a
    // continuously-streaming session never self-closes, while a muted/gone tab
    // (no audio for STT_AUDIO_IDLE_MS) does.
    if (typeof event.data !== "string") {
      armIdleTimer();
    }
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
