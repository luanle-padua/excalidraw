// RawWsTransport — a thin socket.io-compatible shim over a native WebSocket,
// for the Cloudflare Durable Object realtime backend (DO migration, 06-17).
//
// WHY: Team A's RoomDO speaks raw WebSocket, not the socket.io protocol. The
// rest of the app (Portal.tsx, Collab.tsx) is written against the small slice
// of the socket.io `Socket` surface it actually uses:
//   .on(ev,cb) .off(ev,cb?) .once(ev,cb) .emit(ev,...args) .id .close() .connect()
//   + the implicit "connect" / "disconnect" / "connect_error" lifecycle events.
// This class mimics exactly that slice so the SAME downstream logic — encrypt,
// the 18-subtype switch, host election, presence — runs byte-identical on both
// transports. The transport carries OPAQUE bytes only; it never sees plaintext
// (encryptData/decryptData stay in Portal/Collab, keyed by the E2E roomKey that
// is NEVER sent to the server). See docs/plans/durable-objects-migration.md §5.
//
// WIRE FRAME (must match Team A's RoomDO EXACTLY):
//   CONTROL  = ws.send( JSON.stringify({ ev, args:[...] }) )   // a string
//   BINARY   = ws.send( ArrayBuffer )  laid out:
//                [ type:1B ][ iv:12B ][ ciphertext: rest ]
//                type 1 = broadcast (server-broadcast)
//                type 2 = volatile  (server-volatile-broadcast)
// On receive:
//   typeof data === "string"        → JSON.parse → dispatch .on(ev)(...args)
//   data instanceof ArrayBuffer     → parse type/iv/ciphertext
//                                      → dispatch .on("client-broadcast")(
//                                          ciphertext: ArrayBuffer,
//                                          iv: Uint8Array )
//
// The encrypted scene/cursor path emits ("server-broadcast"/"server-volatile-
// broadcast", roomId, encryptedBuffer, iv) (Portal._broadcastSocketData) — we
// pack those into the binary frame. Everything else (join-room, user-follow,
// USER_PROFILE-less control, rtc-signal, …) rides the CONTROL frame as JSON.

import { IV_LENGTH_BYTES } from "@excalidraw/excalidraw/data/encryption";

import { WS_EVENTS } from "../app_constants";

import { supabase } from "../data/supabaseClient";

type Listener = (...args: any[]) => void;

/** Binary frame header byte (1 = durable broadcast, 2 = volatile/drop-on-
 *  backpressure). Mirrors Team A's RoomDO frame layout. */
const FRAME_BROADCAST = 1;
const FRAME_VOLATILE = 2;

/** Reconnect backoff bounds (ms). Deploying the Worker restarts the DO and
 *  drops every WS, so auto-reconnect is mandatory or every client silently
 *  desyncs after each deploy (plan §5, R4). */
const BACKOFF_MIN_MS = 500;
// 30s, not 10s: a tab whose upgrade is PERMANENTLY rejected (finished meeting
// 409, revoked/not-invited 403, expired token 401 — all returned BEFORE the 101,
// so the browser only ever sees a generic close, never the status) keeps
// retrying; capping the settle interval higher bounds a stuck tab to ~2.9k
// req/day instead of ~17k (06-18 reconnect-storm fix).
const BACKOFF_MAX_MS = 30_000;

/** A socket must stay open at least this long before we TRUST it and reset the
 *  backoff counter. Without this, a socket that opens (101) then closes within
 *  a few seconds — DO rejects post-accept, deploy/hibernation churn — pins
 *  backoff at the 500ms floor and hammers the Worker ~4×/s (~345k req/day).
 *  (06-18 reconnect-storm fix.) */
const STABLE_OPEN_MS = 10_000;

/** Circuit breaker: after this many reconnects that never reached a STABLE
 *  open, give up and surface connect_error instead of retrying forever. Caps a
 *  permanently-rejected or long-dead-network tab. With the 30s backoff cap this
 *  is ~30min of attempts before stopping — long enough to ride out a deploy
 *  bounce, short enough that a dead tab can't drain the daily request quota. */
const MAX_RECONNECT_ATTEMPTS = 60;

/** App-level liveness heartbeat (06-18 ghost reaper). The server (RoomDO) drops
 *  a socket that stops sending `hb` for GHOST_TIMEOUT_MS (130s), so a half-open
 *  tab no longer lingers in the WS cap / presence / host election. This is a
 *  DISTINCT control frame from the runtime ping/pong auto-response (which does
 *  NOT wake the DO and so can't refresh server-side lastSeen).
 *
 *  06-26 HOST-BACKGROUND-DROP FIX: lowered 40s → 25s. The reaper is 130s, so
 *  even at 40s we nominally had ~3 beats of slack — but `setInterval` in a
 *  BACKGROUND tab is throttled to ~once/minute and FROZEN entirely after a few
 *  minutes (Chrome Page Freeze / memory pressure). When the host backgrounded
 *  their tab, `hb` stopped, the DO reaped the socket, and (worst) the recording
 *  lock it owned was released → recording STOPPED. The real fix is the Web Worker
 *  ticker below (not throttled in background tabs) + the server-side recording
 *  grace/reclaim window; 25s just adds a fourth beat of margin so a single
 *  hiccupped tick never strands a live host near the 130s edge. */
const HEARTBEAT_MS = 25_000;

/** Drop a volatile (cursor/idle) frame when the socket's outbound buffer is
 *  already this deep — matches socket.io `volatile` backpressure-drop so a
 *  60fps cursor flood can't grow the buffer unboundedly (plan §3, R16). */
const VOLATILE_BUFFER_LIMIT_BYTES = 256 * 1024;

/** Body of the dedicated heartbeat Web Worker (06-26 host-background-drop fix).
 *  A `setInterval` running on the MAIN thread is throttled to ~once/minute in a
 *  background tab and FROZEN after a few minutes (Chrome Page Freeze) — which
 *  silently stops our `hb` frames and gets the host reaped. A Web Worker timer
 *  is NOT subject to that background throttling, so it keeps ticking while the
 *  tab is hidden. The worker is intentionally trivial: tick on an interval and
 *  postMessage back to the main thread, which sends the actual `hb` (the worker
 *  has no WebSocket / DOM access). The interval is passed in via the first
 *  message so the constant lives in ONE place. */
const HEARTBEAT_WORKER_SOURCE = `
  let timer = null;
  self.onmessage = (e) => {
    const interval = e && e.data;
    if (typeof interval === "number" && interval > 0) {
      if (timer !== null) {
        clearInterval(timer);
      }
      timer = setInterval(() => self.postMessage(0), interval);
    }
  };
`;

export interface RawWsTransportOptions {
  /** Base URL of the Worker hosting the RoomDO, e.g.
   *  "https://mcm-storage.rnd-ai.workers.dev" or "" for same-origin (tunnel). */
  wsBase: string;
  roomId: string;
}

/**
 * Native-WebSocket transport that presents the socket.io `Socket` surface the
 * MAP CanvasMeet client relies on. Cast to `Socket` at the call site in
 * Collab.tsx — it is a structural stand-in, not a real socket.io socket.
 */
export class RawWsTransport {
  /** socket.io parity: server-assigned connection id. The DO mints a UUID and
   *  sends it in the `init-room` control frame; we mirror it here so the app's
   *  `socket.id` reads (host election, cursor identity) keep working. Undefined
   *  until the first `init-room` after each (re)connect, like socket.io's
   *  `.id` is undefined before "connect". */
  id: string | undefined = undefined;

  /** socket.io parity flag. */
  connected = false;
  disconnected = true;

  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly roomId: string;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onceListeners = new Map<string, Set<Listener>>();

  /** Backoff state for the reconnect loop. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires STABLE_OPEN_MS after a successful open; only THEN do we trust the
   *  connection and reset the backoff counter. Guards against an open→close
   *  flap pinning backoff at the floor (06-18 reconnect-storm fix). */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** Periodic `hb` heartbeat so the server can reap this socket if it dies
   *  half-open (06-18 ghost reaper). Runs only while the socket is open.
   *  FALLBACK ticker — used only when a Web Worker can't be created (SSR / very
   *  old browser); the primary ticker is the background-immune Web Worker below. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Dedicated Web Worker that drives the heartbeat with a timer that is NOT
   *  throttled/frozen in a background tab (06-26 host-background-drop fix). Null
   *  when unavailable → we fall back to `heartbeatTimer`. */
  private heartbeatWorker: Worker | null = null;
  /** Object URL backing `heartbeatWorker`; revoked on teardown so we don't leak
   *  blob URLs across reconnects. */
  private heartbeatWorkerUrl: string | null = null;
  /** Bound `visibilitychange` handler that re-touches the server with an extra
   *  immediate `hb` on EVERY hide/show transition — belt-and-braces around the
   *  moment a tab is backgrounded (or restored) (06-26). Null while not open. */
  private visibilityHandler: (() => void) | null = null;
  /** Set by close() so an in-flight reconnect doesn't resurrect a torn-down
   *  transport. */
  private closedByUser = false;
  /** True once we've successfully opened at least once — distinguishes the
   *  first connect (fire "connect") from a reconnect (fire "connect" again,
   *  app re-sends join-room). */
  private hasEverConnected = false;

  constructor(opts: RawWsTransportOptions) {
    this.roomId = opts.roomId;
    const base = (opts.wsBase || "").replace(/\/$/, "");
    // Same-origin (tunnel) when base is empty: derive ws(s):// from location.
    if (base) {
      this.url = `${base.replace(/^http/, "ws")}/rooms/${encodeURIComponent(
        opts.roomId,
      )}/ws`;
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${window.location.host}/rooms/${encodeURIComponent(
        opts.roomId,
      )}/ws`;
    }
  }

  // ---- socket.io-compatible event API ------------------------------------

  on(ev: string, cb: Listener): this {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb);
    return this;
  }

  once(ev: string, cb: Listener): this {
    let set = this.onceListeners.get(ev);
    if (!set) {
      set = new Set();
      this.onceListeners.set(ev, set);
    }
    set.add(cb);
    return this;
  }

  off(ev: string, cb?: Listener): this {
    if (!cb) {
      this.listeners.delete(ev);
      this.onceListeners.delete(ev);
      return this;
    }
    this.listeners.get(ev)?.delete(cb);
    this.onceListeners.get(ev)?.delete(cb);
    return this;
  }

  /**
   * Emit from the app toward the server. Two shapes, matching how the app
   * uses socket.io:
   *  - server(-volatile)-broadcast → BINARY frame (encrypted scene/cursor).
   *      args = [roomId, encryptedBuffer: ArrayBuffer, iv: Uint8Array]
   *  - everything else (join-room, user-follow, …) → CONTROL JSON frame.
   */
  emit(ev: string, ...args: any[]): this {
    if (ev === WS_EVENTS.SERVER || ev === WS_EVENTS.SERVER_VOLATILE) {
      this.sendBinary(ev === WS_EVENTS.SERVER_VOLATILE, args);
    } else {
      this.sendControl(ev, args);
    }
    return this;
  }

  /** socket.io parity: idempotent (re)connect. */
  connect(): this {
    this.closedByUser = false;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return this;
    }
    void this.openSocket();
    return this;
  }

  /** Tear down for good. Mirrors socket.io `.close()` — no reconnect after. */
  close(): this {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      // Strip our handlers so the close doesn't kick off a reconnect.
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        // already closing/closed — ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.disconnected = true;
    this.id = undefined;
    return this;
  }

  // ---- internals ----------------------------------------------------------

  private async openSocket(): Promise<void> {
    // Supabase access-token JWT goes in the WebSocket SUBPROTOCOL, not a query
    // param (query params leak into logs/referrer — plan §4, R7). The browser
    // WebSocket API has no header knob; the subprotocol list is the only
    // app-controlled handshake field. Team A's AUTH GATE reads it from
    // `Sec-WebSocket-Protocol` and echoes the chosen subprotocol back.
    let token: string | undefined;
    try {
      const { data } = (await supabase?.auth.getSession()) ?? { data: null };
      token = data?.session?.access_token;
    } catch {
      // no session → open without a token; the Worker AUTH GATE 401s and we
      // back off + retry (a fresh token may land on the next attempt).
    }

    if (this.closedByUser) {
      return;
    }

    let ws: WebSocket;
    try {
      // The token rides as a subprotocol. We send a generic marker protocol
      // first so the server can always pick a valid, echo-able subprotocol
      // even when there's no token (anonymous attempt → 401 from the gate).
      const protocols = token ? ["mcm.v1", token] : ["mcm.v1"];
      ws = new WebSocket(this.url, protocols);
    } catch (err) {
      // Construction itself can throw (malformed url etc.) — treat as a failed
      // attempt and back off.
      console.error("RawWsTransport: WebSocket construction failed", err);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.disconnected = false;
      this.hasEverConnected = true;
      // Do NOT reset the backoff counter here. A socket that opens (101) then
      // closes within a few seconds — DO rejects post-accept, deploy/hibernation
      // churn — would otherwise collapse backoff to the 500ms floor and hammer
      // the Worker ~4×/s (~345k req/day). Only reset once the connection has
      // held open for STABLE_OPEN_MS (06-18 reconnect-storm fix).
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
      }
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.reconnectAttempts = 0;
      }, STABLE_OPEN_MS);
      // Start the server-liveness heartbeat (ghost reaper). Cleared on close.
      this.startHeartbeat();
      // socket.io fires "connect" on every (re)connect. Collab re-reads
      // socket.id and, via Portal's "init-room" handler, re-sends join-room —
      // so a reconnect resyncs WITHOUT Portal.close(): broadcastedElementVersions
      // is preserved, so there's no full-scene re-broadcast (§3.1 invariant 2).
      // The DO then re-sends init-room (→ join-room → new-user/first-in-room →
      // USER_PROFILE + INIT re-broadcast through the existing handlers).
      this.dispatch("connect", []);
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      // Surface as socket.io's "connect_error" only while we've never had a
      // good connection (that's the one the app's fallback listens for via
      // `.once("connect_error", …)`). Steady-state errors just precede a close.
      if (!this.hasEverConnected) {
        this.dispatch("connect_error", [new Error("websocket error")]);
      }
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.disconnected = true;
      this.id = undefined;
      this.stopHeartbeat();
      // A close before the stable threshold means this open didn't "count" —
      // leave reconnectAttempts climbing so backoff keeps growing.
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (this.ws === ws) {
        this.ws = null;
      }
      if (wasConnected) {
        // socket.io parity: tell the app it dropped. (Collab doesn't subscribe
        // to "disconnect" today, but keeping it makes the shim complete.)
        this.dispatch("disconnect", ["transport close"]);
      }
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };
  }

  /** Send one `hb` now. sendControl is a no-op unless the socket is OPEN, so a
   *  heartbeat can't resurrect a dead socket; the close handler stops the ticker
   *  anyway. */
  private sendHeartbeat(): void {
    this.sendControl("hb", []);
  }

  /** Begin the periodic `hb` heartbeat (ghost reaper). Idempotent.
   *
   *  Primary path: a dedicated Web Worker timer (HEARTBEAT_WORKER_SOURCE) that
   *  keeps ticking even when this tab is backgrounded — the main-thread
   *  `setInterval` it replaces gets throttled to ~1/min and then FROZEN by
   *  Chrome Page Freeze, which used to stop the host's `hb`, get it reaped, and
   *  stop the recording (06-26 fix). We also attach a `visibilitychange`
   *  listener for an extra immediate re-touch on hide/show. */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    // Try the background-immune Web Worker ticker first.
    let workerStarted = false;
    if (
      typeof Worker !== "undefined" &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      try {
        const url = URL.createObjectURL(
          new Blob([HEARTBEAT_WORKER_SOURCE], { type: "text/javascript" }),
        );
        const worker = new Worker(url);
        worker.onmessage = () => this.sendHeartbeat();
        // If the worker errors out, fall back to the main-thread interval so we
        // never silently lose the heartbeat entirely.
        worker.onerror = () => {
          if (this.heartbeatWorker === worker) {
            this.teardownHeartbeatWorker();
            this.startFallbackHeartbeat();
          }
        };
        worker.postMessage(HEARTBEAT_MS); // start ticking
        this.heartbeatWorker = worker;
        this.heartbeatWorkerUrl = url;
        workerStarted = true;
      } catch {
        // Worker/Blob construction blocked (e.g. CSP) — fall back below.
        this.teardownHeartbeatWorker();
      }
    }

    if (!workerStarted) {
      this.startFallbackHeartbeat();
    }

    // Belt-and-braces: re-touch the server the instant the tab is hidden AND the
    // instant it returns — covers the brief window before the worker's first
    // post-background tick and gives the reaper a fresh lastSeen on return.
    if (
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function"
    ) {
      const handler = () => this.sendHeartbeat();
      this.visibilityHandler = handler;
      document.addEventListener("visibilitychange", handler);
    }
  }

  /** Main-thread interval fallback (SSR / no Worker / worker error). Throttled
   *  in background tabs — but better than no heartbeat at all. */
  private startFallbackHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
  }

  private teardownHeartbeatWorker(): void {
    if (this.heartbeatWorker) {
      this.heartbeatWorker.onmessage = null;
      this.heartbeatWorker.onerror = null;
      try {
        this.heartbeatWorker.terminate();
      } catch {
        // already gone — ignore
      }
      this.heartbeatWorker = null;
    }
    if (this.heartbeatWorkerUrl) {
      try {
        URL.revokeObjectURL(this.heartbeatWorkerUrl);
      } catch {
        // ignore
      }
      this.heartbeatWorkerUrl = null;
    }
  }

  private stopHeartbeat(): void {
    this.teardownHeartbeatWorker();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.visibilityHandler) {
      if (
        typeof document !== "undefined" &&
        typeof document.removeEventListener === "function"
      ) {
        document.removeEventListener("visibilitychange", this.visibilityHandler);
      }
      this.visibilityHandler = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) {
      return;
    }
    // Circuit breaker (06-18 reconnect-storm fix): a permanently-rejected
    // upgrade (finished 409, revoked/not-invited 403, expired token 401 — all
    // returned BEFORE the 101, so the browser only sees a generic close, never
    // the status) or a long-dead network would otherwise retry forever. After
    // MAX_RECONNECT_ATTEMPTS without ever reaching a STABLE open, give up and
    // surface connect_error instead of draining the Worker's request quota. The
    // counter is reset on every stable open, so a healthy connection (incl. a
    // deploy bounce that re-opens cleanly) never trips this.
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.dispatch("connect_error", [
        new Error("websocket gave up after repeated reconnect failures"),
      ]);
      return;
    }
    // Exponential backoff 0.5s → 30s, with full jitter (plan §5).
    const base = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * 2 ** this.reconnectAttempts,
    );
    const delay = Math.random() * base;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) {
        void this.openSocket();
      }
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      // CONTROL frame.
      let parsed: { ev?: string; args?: unknown[] };
      try {
        parsed = JSON.parse(data);
      } catch {
        console.error("RawWsTransport: malformed control frame", data);
        return;
      }
      if (!parsed || typeof parsed.ev !== "string") {
        return;
      }
      const args = Array.isArray(parsed.args) ? parsed.args : [];
      // The DO sends our connection id with init-room as `args:[{ socketId }]`.
      // Mirror it into .id so the app's socket.id reads resolve (host election,
      // cursor identity). (M2 — the server sends an OBJECT, not a bare string.)
      if (parsed.ev === "init-room") {
        const first = args[0] as { socketId?: unknown } | undefined;
        if (first && typeof first.socketId === "string") {
          this.id = first.socketId;
        }
      }
      this.dispatch(parsed.ev, args);
      return;
    }

    if (data instanceof ArrayBuffer) {
      // BINARY frame → the encrypted broadcast path. Unpack to the same
      // ("client-broadcast", encryptedData, iv) shape the app already handles.
      if (data.byteLength < 1 + IV_LENGTH_BYTES) {
        // Too small to hold header + iv → corrupt; log and drop, don't throw
        // (plan §9.1: malformed input must not hang the parser).
        console.error(
          "RawWsTransport: undersized binary frame",
          data.byteLength,
        );
        return;
      }
      const bytes = new Uint8Array(data);
      // bytes[0] = frame type (1 broadcast / 2 volatile) — informational on
      // the receive side; both deliver the same client-broadcast.
      const iv = bytes.slice(1, 1 + IV_LENGTH_BYTES);
      // ciphertext as its own ArrayBuffer (the app types encryptedData as
      // ArrayBuffer and passes it straight to decryptData).
      const ciphertext = data.slice(1 + IV_LENGTH_BYTES);
      this.dispatch("client-broadcast", [ciphertext, iv]);
      return;
    }

    // Unknown payload type (Blob etc.) — binaryType is "arraybuffer" so this
    // shouldn't happen; log for safety.
    console.error("RawWsTransport: unexpected message type", typeof data);
  }

  private sendControl(ev: string, args: unknown[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify({ ev, args }));
    } catch (err) {
      console.error("RawWsTransport: control send failed", err);
    }
  }

  private sendBinary(volatile: boolean, args: unknown[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // args = [roomId, encryptedBuffer: ArrayBuffer, iv: Uint8Array]. roomId is
    // implicit in the DO (1 DO = 1 room) so we drop it from the wire.
    const encrypted = args[1] as ArrayBuffer | undefined;
    const iv = args[2] as Uint8Array | undefined;
    if (!(encrypted instanceof ArrayBuffer) || !iv) {
      console.error("RawWsTransport: bad binary emit args", args);
      return;
    }
    // Volatile (cursor/idle) backpressure drop: skip when the outbound buffer
    // is already deep, matching socket.io `volatile` semantics (plan §3, R16).
    if (volatile && this.ws.bufferedAmount > VOLATILE_BUFFER_LIMIT_BYTES) {
      return;
    }
    const frame = new Uint8Array(1 + IV_LENGTH_BYTES + encrypted.byteLength);
    frame[0] = volatile ? FRAME_VOLATILE : FRAME_BROADCAST;
    frame.set(iv.subarray(0, IV_LENGTH_BYTES), 1);
    frame.set(new Uint8Array(encrypted), 1 + IV_LENGTH_BYTES);
    try {
      this.ws.send(frame.buffer);
    } catch (err) {
      console.error("RawWsTransport: binary send failed", err);
    }
  }

  /** Fan a received event out to registered .on + .once listeners. */
  private dispatch(ev: string, args: unknown[]): void {
    const once = this.onceListeners.get(ev);
    if (once && once.size) {
      this.onceListeners.delete(ev);
      for (const cb of once) {
        this.safeCall(cb, args);
      }
    }
    const set = this.listeners.get(ev);
    if (set) {
      // Copy so a handler that calls .off() mid-dispatch doesn't mutate the
      // set we're iterating.
      for (const cb of [...set]) {
        this.safeCall(cb, args);
      }
    }
  }

  private safeCall(cb: Listener, args: unknown[]): void {
    try {
      cb(...args);
    } catch (err) {
      console.error("RawWsTransport: listener threw", err);
    }
  }
}
