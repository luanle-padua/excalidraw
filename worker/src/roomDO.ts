// RoomDO — one Durable Object per meeting room (1 DO = 1 roomId).
//
// This is the SERVER side of the socket.io → Durable Objects realtime
// migration (docs/plans/durable-objects-migration.md). It replaces the
// Node + socket.io relay (room/src/index.ts:855-1019) with a raw-WebSocket
// relay built on the WebSocket Hibernation API (ctx.acceptWebSocket +
// webSocketMessage/Close/Error). The DO is a DUMB end-to-end relay: it never
// decrypts scene/cursor bytes (E2E via roomKey), it only routes frames and
// derives presence.
//
// Wire frame (MUST match the client RawWsTransport — Team B):
//   • CONTROL  = ws.send(JSON.stringify({ ev, args: [...] }))     (string)
//   • BINARY   = ws.send(ArrayBuffer) laid out as
//                  [type:1B (1=broadcast, 2=volatile)][iv:12B][ciphertext]
//     The encrypted client-broadcast path. The DO relays it OPAQUELY (it
//     re-frames byte-identically; it never reads iv/ciphertext as plaintext).
//   Receiver distinguishes by typeof data: string → control, ArrayBuffer →
//   binary.
//
// AUTH: the Worker (src/index.ts) verifies the Supabase JWT + canSeeMeeting +
// knock + WS-count cap BEFORE env.ROOM.get() and BEFORE returning 101. The DO
// RE-TRUSTS the identity passed in the upgrade request headers (it does NOT
// re-verify JWKS in the hot path). See §4 of the plan.

// ---------------------------------------------------------------------------
// Frame constants + helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Binary frame leading byte: a normal (reliable) scene/data broadcast. */
export const BINARY_BROADCAST = 1;
/** Binary frame leading byte: a volatile broadcast (cursor/idle, drop-on-backpressure). */
export const BINARY_VOLATILE = 2;

/** AES-GCM iv length (bytes) the client prepends — fixed at 12. */
export const IV_LENGTH = 12;

/** Minimum valid binary frame: 1 (type) + 12 (iv) + ≥1 ciphertext byte. */
const MIN_BINARY_FRAME = 1 + IV_LENGTH + 1;

/** Volatile drop threshold — skip a volatile send when the socket's send
 *  buffer is already above this. Matches socket.io's volatile backpressure
 *  drop for cursor/idle floods (plan §3 server-volatile-broadcast). */
const VOLATILE_BUFFER_THRESHOLD = 512 * 1024; // 512 KiB

/** Debounce window for collapsing the N×close burst on a deploy/restart into
 *  a single room-user-change broadcast (plan §3 disconnecting, R12). */
const ROOM_USER_CHANGE_DEBOUNCE_MS = 250;

/** Ghost reaper (06-18). A half-open TCP connection keeps the socket in
 *  readyState OPEN — counting against the WS cap, showing a phantom participant,
 *  and (worst) pinning host election on a dead client — until the OS/edge TCP
 *  keepalive finally tears it down, which can take MINUTES. The client sends a
 *  lightweight `hb` control frame every ~40s; the DO refreshes lastSeen on it
 *  and an alarm() drops any socket whose lastSeen is older than GHOST_TIMEOUT_MS
 *  (~3 missed 40s beats of slack, so a backgrounded/throttled-but-alive tab or a
 *  GC stall isn't false-reaped). The alarm stops re-arming once the room is
 *  EMPTY → that room returns to $0 idle. NOTE: a room that still has an
 *  alive-but-idle client is NOT $0 — each 40s `hb` is a real message that wakes
 *  the DO briefly; the cost is small, bounded, and self-limiting (the moment the
 *  last tab closes, the wakes stop). */
const GHOST_TIMEOUT_MS = 130_000;
const REAPER_INTERVAL_MS = 50_000;

export type ControlFrame = { ev: string; args: unknown[] };

/** `bufferedAmount` exists on the runtime WebSocket but isn't in the Workers
 *  type surface — read it through a narrow accessor (0 if unavailable). */
const bufferedAmountOf = (ws: WebSocket): number => {
  const v = (ws as unknown as { bufferedAmount?: number }).bufferedAmount;
  return typeof v === "number" ? v : 0;
};

/** Pack a control frame to the wire string. */
export const packControl = (ev: string, args: unknown[] = []): string =>
  JSON.stringify({ ev, args });

/** Parse an incoming control string. Returns null on malformed input (never
 *  throws — a bad frame must not wedge the message handler). */
export const parseControl = (data: string): ControlFrame | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { ev?: unknown }).ev !== "string"
  ) {
    return null;
  }
  const rawArgs = (parsed as { args?: unknown }).args;
  return {
    ev: (parsed as { ev: string }).ev,
    args: Array.isArray(rawArgs) ? rawArgs : [],
  };
};

/** Read the leading type byte of a binary frame. Returns null if the buffer is
 *  too short to be a valid [type][iv][ciphertext] frame (malformed iv / no
 *  ciphertext) — the caller logs + drops rather than relaying garbage or
 *  hanging a parser. */
export const readBinaryType = (buf: ArrayBuffer): number | null => {
  if (buf.byteLength < MIN_BINARY_FRAME) {
    return null;
  }
  return new Uint8Array(buf, 0, 1)[0];
};

// ---------------------------------------------------------------------------
// Identity stored per WebSocket via serializeAttachment (survives hibernation)
// ---------------------------------------------------------------------------

export type WsAttachment = {
  /** Server-minted stable id for this connection (mirrors socket.io socket.id). */
  socketId: string;
  /** Supabase user id (JWT sub). */
  sub: string;
  /** User email (for diagnostics; identity already verified at the Worker). */
  email: string;
  /** app_metadata.role from the verified JWT. */
  role: string;
  /** When this connection was accepted (host-election dedup key, client-side). */
  joinedAt: number;
  /** Last time a client frame (incl. the `hb` heartbeat) was seen on this
   *  socket — the ghost reaper drops sockets that go quiet (06-18). Optional so
   *  attachments serialized before the reaper landed still deserialize. */
  lastSeen?: number;
  /** AUTHORITATIVE single-owner recording lock (#24). When set, THIS socket is
   *  the one active recording session's owner for the room. Stored in the
   *  attachment (not DO memory) so it SURVIVES hibernation and AUTO-RELEASES
   *  when this socket closes (webSocketClose / ghost reaper). At most one OPEN
   *  socket in the room may hold this at a time — `currentRecordingOwner()`
   *  enforces "only one" on acquire. email/name come from the socket's verified
   *  join identity (email from the JWT; name is not carried on the socket, so it
   *  is null — the client UI resolves the display name from presence). Optional
   *  so pre-lock attachments still deserialize. */
  recording?: {
    sessionId: string;
    startedAt: number;
    email: string | null;
    name: string | null;
  };
};

type Env = {
  // RoomDO needs no bindings of its own for the August relay scope — the DO
  // holds no D1/R2 (R2 stays authoritative in the Worker). Kept for future use.
  [key: string]: unknown;
};

export class RoomDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;

  /** Lazy in-memory follow map: followedSocketId → Set<followerSocketId>.
   *  Rebuilt on demand from live attachments; lost on eviction (followers
   *  re-FOLLOW — non-critical, plan §3 user-follow). */
  private followMap: Map<string, Set<string>> = new Map();

  /** Debounce handle for the room-user-change burst collapse. */
  private roomChangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // -------------------------------------------------------------------------
  // RPC: the Worker's auth gate asks for the current connection count to
  // enforce the WS-count cap BEFORE accepting a new socket (plan §4). This is
  // a method-style RPC over fetch (the DO has no JS-RPC class here to keep the
  // wire surface small + testable without the rpc runtime).
  // -------------------------------------------------------------------------
  private wsCount(): number {
    // getWebSockets() returns only the hibernatable sockets this DO is
    // tracking; CLOSING/CLOSED are pruned by the runtime.
    return this.ctx.getWebSockets().length;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal RPC path used by the Worker auth gate (not the client upgrade).
    if (url.pathname.endsWith("/__count")) {
      return new Response(JSON.stringify({ count: this.wsCount() }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Internal RPC: hard-wipe this room's persistent storage on a meeting
    // hard-delete cascade (audit leak fix). The Worker calls this AFTER it has
    // removed the registry row, so canSeeMeeting already denies new joins; here
    // we just drop the DO's own key/value (roomEverInitialized + the reaper
    // alarm) so a deleted meeting leaves nothing behind. Best-effort: any live
    // sockets are closed before the storage clears, and deleteAll() also
    // cancels the pending alarm.
    if (url.pathname.endsWith("/__destroy")) {
      try {
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1001, "meeting deleted");
          } catch {
            /* ignore individual socket close failures */
          }
        }
        await this.ctx.storage.deleteAll();
      } catch {
        /* best-effort wipe */
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // The client WebSocket upgrade. The Worker has ALREADY verified auth; the
    // accepted identity rides in headers we re-trust here.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const sub = request.headers.get("x-mcm-sub") ?? "";
    const email = request.headers.get("x-mcm-email") ?? "";
    const role = request.headers.get("x-mcm-role") ?? "";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const socketId = crypto.randomUUID();
    const attachment: WsAttachment = {
      socketId,
      sub,
      email,
      role,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    // Hibernatable accept. Tagging by socketId lets us target a single peer for
    // rtc-signal without scanning every socket's attachment.
    this.ctx.acceptWebSocket(server, [socketId]);
    // serializeAttachment makes the identity survive hibernation/eviction —
    // the runtime stores it and re-hydrates it on wake (plan §3 socket.id row).
    server.serializeAttachment(attachment);

    // Ping/pong handled by the runtime WITHOUT waking the DO (preserves
    // hibernation / $0 idle). No app-level heartbeat (plan §3 heartbeat row).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    // init-room IMMEDIATELY after accept, in the same turn, BEFORE returning
    // 101 — the client only emits join-room after it sees init-room
    // (Portal.tsx:46-51). We include the minted socketId so the client can set
    // its `.id` (replaces socket.io's server-assigned socket.id).
    server.send(packControl("init-room", [{ socketId }]));

    // Arm the ghost reaper if it isn't already running (idempotent — one alarm
    // per DO). It re-arms itself while sockets remain and stops when the room
    // empties, so an idle room still hibernates.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REAPER_INTERVAL_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Hibernation message handler. Distinguishes control (string) vs binary
  // (ArrayBuffer) purely by typeof — no length-prefix parser (plan §5, R10).
  // -------------------------------------------------------------------------
  async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    if (typeof message === "string") {
      const frame = parseControl(message);
      if (!frame) {
        // Malformed control frame — log + drop, never wedge the handler.
        console.warn("RoomDO: dropped malformed control frame");
        return;
      }
      await this.handleControl(ws, frame);
      return;
    }
    // Binary = encrypted broadcast. Relay opaquely.
    this.handleBinary(ws, message);
  }

  private getAttachment(ws: WebSocket): WsAttachment | null {
    const a = ws.deserializeAttachment() as WsAttachment | null;
    return a && typeof a.socketId === "string" ? a : null;
  }

  /** All sockets currently OPEN (presence + relay targets). */
  private openSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  /** Presence list: socketIds of all OPEN sockets (plan §3 room-user-change). */
  private roomUserList(): string[] {
    const ids: string[] = [];
    for (const ws of this.openSockets()) {
      const a = this.getAttachment(ws);
      if (a) {
        ids.push(a.socketId);
      }
    }
    return ids;
  }

  private sendControl(ws: WebSocket, ev: string, args: unknown[] = []): void {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) {
      return;
    }
    try {
      ws.send(packControl(ev, args));
    } catch {
      // socket racing closed — ignore.
    }
  }

  /** Broadcast a control frame to every OPEN socket except `except`. */
  private broadcastControl(
    ev: string,
    args: unknown[],
    except?: WebSocket,
  ): void {
    for (const ws of this.openSockets()) {
      if (ws === except) {
        continue;
      }
      this.sendControl(ws, ev, args);
    }
  }

  /** Find the OPEN socket whose attachment.socketId === id (rtc/follow target). */
  private findBySocketId(id: string): WebSocket | null {
    // Tagged accept lets the runtime index by tag.
    const tagged = this.ctx.getWebSockets(id);
    for (const ws of tagged) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        return ws;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Control-frame dispatch — mirrors every socket.on(...) in the old server.
  // -------------------------------------------------------------------------
  private async handleControl(
    ws: WebSocket,
    frame: ControlFrame,
  ): Promise<void> {
    const self = this.getAttachment(ws);
    if (!self) {
      return;
    }
    switch (frame.ev) {
      case "join-room":
        await this.onJoinRoom(ws, self);
        break;
      case "server-broadcast":
        // Control-shaped broadcast fallback (rarely used; binary is the hot
        // path). args = [roomId, encryptedData, iv]. Relay opaquely.
        this.broadcastControl("client-broadcast", frame.args.slice(1), ws);
        break;
      case "server-volatile-broadcast":
        this.relayVolatileControl(ws, frame.args.slice(1));
        break;
      case "request-room-clients":
        // D1: currently UNUSED — no client emits request-room-clients (the
        // WebRTC audio mesh was replaced by Daily.co). Kept (harmless, generic)
        // for cheap forward-compat: re-send the current peer list to the asker.
        this.sendControl(ws, "room-user-change", [this.roomUserList()]);
        break;
      case "rtc-signal":
        // D1: currently UNUSED — no client emits rtc-signal (WebRTC mesh →
        // Daily.co). Kept (harmless, generic) for cheap forward-compat.
        this.onRtcSignal(self, frame.args[0]);
        break;
      case "user-follow":
        this.onUserFollow(self, frame.args[0]);
        break;
      case "hb":
        // Liveness heartbeat (06-18 ghost reaper): refresh lastSeen so the
        // alarm doesn't reap an alive-but-idle socket. A dead/half-open ghost
        // stops sending these and gets dropped on the next reaper tick.
        this.touchLastSeen(ws, self);
        break;
      case "recording-acquire":
        // #24 single-owner recording lock — DO is AUTHORITATIVE (handled here,
        // NOT relayed). Replaces the client-side soft check that raced on
        // late-synced RECORDING_STATE.
        this.onRecordingAcquire(ws, self, frame.args[0]);
        break;
      case "recording-release":
        this.onRecordingRelease(ws, self);
        break;
      default:
        // Unknown control event — ignore (forward-compat; old server ignored
        // unregistered events too).
        break;
    }
  }

  /** join-room: first-in-room (once per room lifetime) else new-user; then
   *  broadcast full room-user-change (plan §3 join-room + §3.1 invariant 1). */
  private async onJoinRoom(ws: WebSocket, self: WsAttachment): Promise<void> {
    // first-in-room is driven by a PERSISTED flag, NEVER getWebSockets().length
    // — on a wake-from-hibernation the first reconnecting socket must NOT be
    // told it is "first" (that would clear the scene). Plan §3.1 invariant 1 / R5.
    const everInitialized = await this.ctx.storage.get<boolean>(
      "roomEverInitialized",
    );
    if (!everInitialized) {
      await this.ctx.storage.put("roomEverInitialized", true);
      this.sendControl(ws, "first-in-room", []);
    } else {
      // Tell existing peers a new user arrived (so they push USER_PROFILE/INIT).
      this.broadcastControl("new-user", [self.socketId], ws);
    }
    // Full presence list to everyone (matches io.in(room).emit on join).
    this.broadcastControl("room-user-change", [this.roomUserList()]);
    // UNICAST the current recording state to the just-joined socket so a LATE
    // joiner learns an already-active session (replaces the client's old 5s
    // RECORDING_STATE re-broadcast hack — contract §8). Only emitted when a
    // session is live; a fresh joiner with no active session needs nothing.
    const owner = this.currentRecordingOwner();
    if (owner) {
      this.sendControl(ws, "recording-state", [
        {
          recording: true,
          owner: { email: owner.email, name: owner.name },
          startedAt: owner.startedAt,
          sessionId: owner.sessionId,
        },
      ]);
    }
  }

  /** Volatile broadcast via the control fallback path (binary is the usual
   *  carrier). Skips sockets whose send buffer is already full. */
  private relayVolatileControl(sender: WebSocket, args: unknown[]): void {
    for (const ws of this.openSockets()) {
      if (ws === sender) {
        continue;
      }
      if (bufferedAmountOf(ws) > VOLATILE_BUFFER_THRESHOLD) {
        continue; // backpressure — drop (volatile semantics).
      }
      this.sendControl(ws, "client-broadcast", args);
    }
  }

  /** rtc-signal: targeted forward to payload.to; rtc-error peer-offline if the
   *  target isn't connected (avoids a hung WebRTC negotiation). Plan §3. */
  private onRtcSignal(self: WsAttachment, payload: unknown): void {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { to?: unknown }).to !== "string"
    ) {
      return;
    }
    const p = payload as { to: string; type?: unknown; data?: unknown };
    const target = this.findBySocketId(p.to);
    if (!target) {
      // Tell the sender the peer is gone so it can tear down its half-open
      // RTCPeerConnection instead of waiting forever.
      const senderWs = this.findBySocketId(self.socketId);
      if (senderWs) {
        this.sendControl(senderWs, "rtc-error", [
          { reason: "peer-offline", to: p.to },
        ]);
      }
      return;
    }
    this.sendControl(target, "rtc-signal", [
      { from: self.socketId, type: p.type, data: p.data },
    ]);
  }

  /** user-follow FOLLOW/UNFOLLOW: maintain the in-memory follow map and notify
   *  the followed user of its follower set (user-follow-room-change). Plan §3. */
  private onUserFollow(self: WsAttachment, payload: unknown): void {
    if (
      !payload ||
      typeof payload !== "object" ||
      !(payload as { userToFollow?: unknown }).userToFollow
    ) {
      return;
    }
    const p = payload as {
      userToFollow: { socketId?: unknown };
      action?: unknown;
    };
    const followed =
      typeof p.userToFollow.socketId === "string"
        ? p.userToFollow.socketId
        : null;
    if (!followed) {
      return;
    }
    let followers = this.followMap.get(followed);
    if (!followers) {
      followers = new Set();
      this.followMap.set(followed, followers);
    }
    if (p.action === "FOLLOW") {
      followers.add(self.socketId);
    } else if (p.action === "UNFOLLOW") {
      followers.delete(self.socketId);
    } else {
      return;
    }
    this.emitFollowRoomChange(followed);
  }

  /** Tell the followed user who currently follows them. */
  private emitFollowRoomChange(followedSocketId: string): void {
    const followers = this.followMap.get(followedSocketId);
    const list = followers ? Array.from(followers) : [];
    const target = this.findBySocketId(followedSocketId);
    if (target) {
      this.sendControl(target, "user-follow-room-change", [list]);
    }
  }

  // -------------------------------------------------------------------------
  // Recording lock (#24) — AUTHORITATIVE single owner per room, stored in the
  // OWNER socket's attachment so it survives hibernation and auto-releases when
  // that socket closes. The DO is the source of truth: a client cannot enforce a
  // distributed lock (the bug being fixed was two soft-hosts racing on a
  // late-synced RECORDING_STATE and both recording). Plan §7.
  // -------------------------------------------------------------------------

  /** Scan OPEN sockets for the one currently holding the recording lock and
   *  return its attachment.recording (with owner identity), or null if no
   *  session is active. "Only one" is an invariant enforced on acquire — this
   *  returns the FIRST holder found. */
  private currentRecordingOwner(): {
    sessionId: string;
    startedAt: number;
    email: string | null;
    name: string | null;
  } | null {
    for (const ws of this.openSockets()) {
      const a = this.getAttachment(ws);
      if (a?.recording) {
        return a.recording;
      }
    }
    return null;
  }

  /** recording-acquire `[{sessionId, startedAt}]`: grant the lock ONLY if no
   *  other OPEN socket holds it. Reply `recording-lock` `[{ok, owner}]` to the
   *  asker; on grant, broadcast `recording-state` to the room. Identity
   *  (email/name) is read from THIS socket's verified join attachment, never
   *  trusted from the payload. */
  private onRecordingAcquire(
    ws: WebSocket,
    self: WsAttachment,
    payload: unknown,
  ): void {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { sessionId?: unknown }).sessionId !== "string"
    ) {
      return;
    }
    const p = payload as { sessionId: string; startedAt?: unknown };
    const startedAt =
      typeof p.startedAt === "number" ? p.startedAt : Date.now();

    const existing = this.currentRecordingOwner();
    if (existing) {
      // Already owned (possibly by THIS socket on a retry — still report the
      // current owner; the client treats ok:false as "in use"). Reply only to
      // the asker; no state change, no broadcast.
      this.sendControl(ws, "recording-lock", [
        {
          ok: false,
          owner: {
            email: existing.email,
            name: existing.name,
            startedAt: existing.startedAt,
            sessionId: existing.sessionId,
          },
        },
      ]);
      return;
    }

    // Grant: stamp the lock onto THIS socket's attachment (survives hibernation,
    // auto-releases on close). email comes from the verified join identity; the
    // socket carries no display name, so name is null (the client resolves it
    // from presence). Mirror touchLastSeen's spread-and-reserialize so we don't
    // clobber lastSeen.
    const owner = {
      sessionId: p.sessionId,
      startedAt,
      email: self.email || null,
      name: null,
    };
    try {
      ws.serializeAttachment({ ...self, recording: owner });
    } catch {
      // socket racing closed — abort the grant (nothing was broadcast yet).
      return;
    }
    this.sendControl(ws, "recording-lock", [
      {
        ok: true,
        owner: {
          email: owner.email,
          name: owner.name,
          startedAt: owner.startedAt,
          sessionId: owner.sessionId,
        },
      },
    ]);
    this.broadcastControl("recording-state", [
      {
        recording: true,
        owner: { email: owner.email, name: owner.name },
        startedAt: owner.startedAt,
        sessionId: owner.sessionId,
      },
    ]);
  }

  /** recording-release `[]`: if the SENDER holds the lock, clear it and
   *  broadcast `recording-state` false. A non-owner release is a no-op (you
   *  cannot stop someone else's session). */
  private onRecordingRelease(ws: WebSocket, self: WsAttachment): void {
    if (!self.recording) {
      return;
    }
    const { recording: _drop, ...rest } = self;
    try {
      ws.serializeAttachment(rest);
    } catch {
      // socket racing closed — its lock dies with it (close path broadcasts).
      return;
    }
    this.broadcastControl("recording-state", [{ recording: false }]);
  }

  // -------------------------------------------------------------------------
  // Binary relay (encrypted client-broadcast). Opaque: the DO never decrypts.
  // -------------------------------------------------------------------------
  private handleBinary(sender: WebSocket, frame: ArrayBuffer): void {
    const type = readBinaryType(frame);
    if (type === null) {
      // Malformed (iv truncated / no ciphertext) — log + drop, don't relay.
      console.warn("RoomDO: dropped malformed binary frame");
      return;
    }
    const volatile = type === BINARY_VOLATILE;
    for (const ws of this.openSockets()) {
      if (ws === sender) {
        continue;
      }
      if (volatile && bufferedAmountOf(ws) > VOLATILE_BUFFER_THRESHOLD) {
        continue; // backpressure drop for cursor/idle floods.
      }
      try {
        ws.send(frame); // byte-identical relay.
      } catch {
        // socket racing closed — ignore.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Close / error — follow cleanup, broadcast-unfollow, debounced presence.
  // -------------------------------------------------------------------------
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.onSocketGone(ws);
  }

  private onSocketGone(ws: WebSocket): void {
    const self = this.getAttachment(ws);
    if (self) {
      // 0) AUTO-RELEASE the recording lock (#24). If this departing socket owned
      //    the active session, the lock leaves with it — tell the room the
      //    recording stopped. The attachment is discarded with the socket, so
      //    there's nothing to clear; just broadcast the false state. (No
      //    "is this socket open?" guard: by the close path it's already gone, so
      //    currentRecordingOwner() would no longer see it.)
      if (self.recording) {
        this.broadcastControl("recording-state", [{ recording: false }]);
      }
      // 1) This socket was FOLLOWING others — drop it from every follower set;
      //    if a followed user loses their last follower → broadcast-unfollow.
      for (const [followed, followers] of this.followMap) {
        if (followers.delete(self.socketId)) {
          if (followers.size === 0) {
            this.followMap.delete(followed);
            const target = this.findBySocketId(followed);
            if (target) {
              this.sendControl(target, "broadcast-unfollow", []);
            }
          } else {
            this.emitFollowRoomChange(followed);
          }
        }
      }
      // 2) This socket was BEING followed — its follower set is now moot.
      this.followMap.delete(self.socketId);
    }
    // 3) Debounced room-user-change: a deploy closes N sockets at once; collapse
    //    the burst into one broadcast ~250ms later (plan §3 disconnecting / R12).
    this.scheduleRoomUserChange();
  }

  private scheduleRoomUserChange(): void {
    if (this.roomChangeTimer) {
      return;
    }
    this.roomChangeTimer = setTimeout(() => {
      this.roomChangeTimer = null;
      this.broadcastControl("room-user-change", [this.roomUserList()]);
    }, ROOM_USER_CHANGE_DEBOUNCE_MS);
  }

  /** Refresh a socket's lastSeen in its hibernation attachment. Cheap (no D1 /
   *  storage.put) — serializeAttachment rides with the socket. Only called on
   *  the ~40s `hb` frame, not per cursor/scene frame, so it stays inexpensive. */
  private touchLastSeen(ws: WebSocket, self: WsAttachment): void {
    try {
      ws.serializeAttachment({ ...self, lastSeen: Date.now() });
    } catch {
      // socket racing closed — ignore.
    }
  }

  // -------------------------------------------------------------------------
  // Ghost reaper (06-18). webSocketClose only fires on real TCP teardown, which
  // a half-open connection delays for minutes — leaving a ghost in the cap /
  // presence / host election. This alarm drops sockets that stopped sending the
  // ~40s `hb` heartbeat, then re-arms ONLY while sockets remain (an empty room
  // lets the DO hibernate, preserving $0 idle).
  // -------------------------------------------------------------------------
  async alarm(): Promise<void> {
    const now = Date.now();
    let reaped = 0;
    let reapedRecordingOwner = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.getAttachment(ws);
      if (!a) {
        continue;
      }
      if (typeof a.lastSeen !== "number") {
        // Pre-reaper attachment — seed it so it isn't reaped on a stale read.
        this.touchLastSeen(ws, a);
        continue;
      }
      if (now - a.lastSeen > GHOST_TIMEOUT_MS) {
        // AUTO-RELEASE (#24): a reaped ghost that owned the recording lock takes
        // the lock with it. webSocketClose also fires the auto-release, but a
        // forced server close can lag — note it here so the room is told the
        // session ended now, not minutes later when the TCP teardown lands.
        if (a.recording) {
          reapedRecordingOwner = true;
        }
        try {
          ws.close(1001, "ghost-timeout");
        } catch {
          // already closing — ignore.
        }
        reaped += 1;
      }
    }
    if (reaped > 0) {
      // Reflect the drop immediately (webSocketClose also fires, but a forced
      // server close can lag — broadcast a fresh presence list now so host
      // election re-runs off the live set without the ghost).
      this.broadcastControl("room-user-change", [this.roomUserList()]);
    }
    if (reapedRecordingOwner) {
      this.broadcastControl("recording-state", [{ recording: false }]);
    }
    // Re-arm only while live sockets remain → empty room stops waking the DO.
    if (this.openSockets().length > 0) {
      await this.ctx.storage.setAlarm(now + REAPER_INTERVAL_MS);
    }
  }
}
