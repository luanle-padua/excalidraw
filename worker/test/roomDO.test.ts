// Unit tests for the RoomDO realtime relay (Durable Objects migration).
//
// Run WITHOUT the workerd runtime / wrangler (the local D1 is held by
// `wrangler dev`). We import the DO class + pure frame helpers directly and
// drive them through a MINIMAL in-memory harness that mocks the bits of the
// Durable Object / WebSocket Hibernation surface the DO actually touches:
//   ctx.acceptWebSocket / getWebSockets / storage  · ws.serializeAttachment /
//   deserializeAttachment / send / readyState · WebSocketPair ·
//   WebSocketRequestResponsePair · crypto.randomUUID.
//
//   npx vitest run worker/test/roomDO.test.ts   (from repo root)

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BINARY_BROADCAST,
  BINARY_VOLATILE,
  IV_LENGTH,
  packControl,
  parseControl,
  readBinaryType,
  RoomDO,
  type WsAttachment,
} from "../src/roomDO";

// ---------------------------------------------------------------------------
// Minimal hibernation harness
// ---------------------------------------------------------------------------

const READY_OPEN = 1;
const READY_CLOSED = 3;

type SentFrame = string | ArrayBuffer;

class FakeWebSocket {
  static READY_STATE_OPEN = READY_OPEN;
  readyState = READY_OPEN;
  bufferedAmount = 0;
  sent: SentFrame[] = [];
  private attachment: unknown = null;
  // tags assigned at acceptWebSocket time (used by getWebSockets(tag)).
  tags: string[] = [];

  send(data: SentFrame) {
    if (this.readyState !== READY_OPEN) {
      throw new Error("send on closed socket");
    }
    this.sent.push(data);
  }

  serializeAttachment(value: unknown) {
    // structuredClone mimics the runtime's serialize-across-hibernation.
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return this.attachment ? structuredClone(this.attachment) : null;
  }

  /** Control frames decoded back to {ev,args} for easy assertions. */
  controls(): { ev: string; args: unknown[] }[] {
    return this.sent
      .filter((f): f is string => typeof f === "string")
      .map((f) => parseControl(f)!)
      .filter(Boolean);
  }

  binaries(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => f instanceof ArrayBuffer);
  }

  close() {
    this.readyState = READY_CLOSED;
  }
}

class FakeStorage {
  private map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

class FakeCtx {
  storage = new FakeStorage();
  private sockets: FakeWebSocket[] = [];
  autoResponse: unknown = null;

  acceptWebSocket(ws: FakeWebSocket, tags?: string[]) {
    ws.tags = tags ?? [];
    this.sockets.push(ws);
  }

  getWebSockets(tag?: string): FakeWebSocket[] {
    if (tag === undefined) {
      return this.sockets.slice();
    }
    return this.sockets.filter((ws) => ws.tags.includes(tag));
  }

  setWebSocketAutoResponse(pair: unknown) {
    this.autoResponse = pair;
  }

  /** Test helper: simulate the runtime pruning a closed socket. */
  prune(ws: FakeWebSocket) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }
}

// Globals the DO references.
beforeEach(() => {
  vi.useFakeTimers();
  let uuidN = 0;
  // crypto is a getter-only global in node — stub just randomUUID on it.
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () =>
      `uuid-${++uuidN}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  (globalThis as any).WebSocket = { READY_STATE_OPEN: READY_OPEN };
  (globalThis as any).WebSocketPair = function () {
    const a = new FakeWebSocket();
    const b = new FakeWebSocket();
    return { 0: a, 1: b };
  };
  (globalThis as any).WebSocketRequestResponsePair = function (
    req: string,
    res: string,
  ) {
    return { request: req, response: res };
  };
  // Permissive Response: node's undici forbids status 101 (the WS upgrade
  // status), which the Workers runtime allows — model it for the harness.
  (globalThis as any).Response = class {
    status: number;
    webSocket: unknown;
    body: unknown;
    constructor(
      body: unknown,
      init?: { status?: number; webSocket?: unknown },
    ) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.webSocket = init?.webSocket ?? null;
    }
    async json() {
      return JSON.parse(this.body as string);
    }
  };
});

// Drive an upgrade and return the accepted (server) socket + the DO + ctx.
async function connect(
  room: RoomDO,
  ctx: FakeCtx,
  identity: Partial<WsAttachment> = {},
): Promise<FakeWebSocket> {
  const req = new Request("https://room.internal/rooms/r1/ws", {
    headers: {
      Upgrade: "websocket",
      "x-mcm-sub": identity.sub ?? "sub-x",
      "x-mcm-email": identity.email ?? "u@mapgroup.co.kr",
      "x-mcm-role": identity.role ?? "user",
    },
  });
  const res = await room.fetch(req);
  expect(res.status).toBe(101);
  // The server socket is the most recently accepted one.
  const all = ctx.getWebSockets();
  return all[all.length - 1];
}

function makeRoom() {
  const ctx = new FakeCtx();
  const room = new RoomDO(ctx as unknown as DurableObjectState, {} as any);
  return { ctx, room };
}

// ---------------------------------------------------------------------------
// Frame pack / unpack
// ---------------------------------------------------------------------------

describe("frame pack/unpack", () => {
  it("packs and parses a control frame round-trip", () => {
    const s = packControl("room-user-change", [["a", "b"]]);
    expect(typeof s).toBe("string");
    const f = parseControl(s);
    expect(f).toEqual({ ev: "room-user-change", args: [["a", "b"]] });
  });

  it("parseControl returns null on malformed JSON (does not throw/hang)", () => {
    expect(parseControl("{not json")).toBeNull();
    expect(parseControl("null")).toBeNull();
    expect(parseControl('{"args":[]}')).toBeNull(); // missing ev
    expect(parseControl('"a string"')).toBeNull();
  });

  it("readBinaryType reads the leading type byte for a valid frame", () => {
    const buf = new Uint8Array(1 + IV_LENGTH + 4);
    buf[0] = BINARY_BROADCAST;
    expect(readBinaryType(buf.buffer)).toBe(BINARY_BROADCAST);
    buf[0] = BINARY_VOLATILE;
    expect(readBinaryType(buf.buffer)).toBe(BINARY_VOLATILE);
  });

  it("readBinaryType returns null on a truncated/malformed iv frame", () => {
    // 1 type byte + short iv + no ciphertext → invalid, must not hang/relay.
    expect(readBinaryType(new Uint8Array(5).buffer)).toBeNull();
    expect(readBinaryType(new Uint8Array(1 + IV_LENGTH).buffer)).toBeNull(); // no ciphertext
    expect(readBinaryType(new ArrayBuffer(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// init-room + identity + hibernation persistence
// ---------------------------------------------------------------------------

describe("accept + init-room + serializeAttachment", () => {
  it("sends init-room immediately after accept with the minted socketId", async () => {
    const { ctx, room } = makeRoom();
    const ws = await connect(room, ctx);
    const ctrls = ws.controls();
    expect(ctrls[0].ev).toBe("init-room");
    const arg = ctrls[0].args[0] as { socketId: string };
    expect(typeof arg.socketId).toBe("string");
  });

  it("registers a ping/pong auto-response that does not wake the DO", async () => {
    const { ctx, room } = makeRoom();
    await connect(room, ctx);
    expect(ctx.autoResponse).toEqual({ request: "ping", response: "pong" });
  });

  it("socketId + identity survive serializeAttachment (simulated hibernation)", async () => {
    const { ctx, room } = makeRoom();
    const ws = await connect(room, ctx, { email: "host@mapgroup.co.kr" });
    // Re-read the attachment as the runtime would after a hibernation wake.
    const a = ws.deserializeAttachment() as WsAttachment;
    expect(a.socketId).toMatch(/^uuid-/);
    expect(a.email).toBe("host@mapgroup.co.kr");
    expect(typeof a.joinedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// join-room — first-in-room vs new-user, roomEverInitialized flag
// ---------------------------------------------------------------------------

describe("join-room presence", () => {
  it("first joiner gets first-in-room; second gets new-user broadcast", async () => {
    const { ctx, room } = makeRoom();
    const ws1 = await connect(room, ctx);
    await room.webSocketMessage(ws1 as any, packControl("join-room", ["r1"]));
    expect(ws1.controls().some((c) => c.ev === "first-in-room")).toBe(true);

    const ws2 = await connect(room, ctx);
    await room.webSocketMessage(ws2 as any, packControl("join-room", ["r1"]));
    // ws2 must NOT get first-in-room; ws1 must hear new-user.
    expect(ws2.controls().some((c) => c.ev === "first-in-room")).toBe(false);
    expect(ws1.controls().some((c) => c.ev === "new-user")).toBe(true);
    // Both get a room-user-change with 2 ids.
    const last = ws1
      .controls()
      .filter((c) => c.ev === "room-user-change")
      .pop();
    expect((last!.args[0] as string[]).length).toBe(2);
  });

  it("roomEverInitialized prevents first-in-room re-fire on wake-from-hibernation", async () => {
    const { ctx, room } = makeRoom();
    const ws1 = await connect(room, ctx);
    await room.webSocketMessage(ws1 as any, packControl("join-room", ["r1"]));
    // Simulate hibernation: all sockets evicted, flag persists in storage.
    ctx.prune(ws1);
    expect(await ctx.storage.get("roomEverInitialized")).toBe(true);
    // A NEW first socket reconnects after wake — must be new-user, NOT first.
    const wsReconnect = await connect(room, ctx);
    await room.webSocketMessage(
      wsReconnect as any,
      packControl("join-room", ["r1"]),
    );
    expect(wsReconnect.controls().some((c) => c.ev === "first-in-room")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Binary broadcast relay (opaque)
// ---------------------------------------------------------------------------

describe("binary broadcast relay", () => {
  function frame(type: number, ctSize = 4): ArrayBuffer {
    const buf = new Uint8Array(1 + IV_LENGTH + ctSize);
    buf[0] = type;
    buf[1] = 0xaa; // marker in the iv to assert byte-identical relay
    return buf.buffer;
  }

  it("relays a broadcast to every OPEN peer except the sender, byte-identical", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    const b = await connect(room, ctx);
    const c = await connect(room, ctx);
    const f = frame(BINARY_BROADCAST);
    await room.webSocketMessage(a as any, f);
    expect(a.binaries().length).toBe(0); // sender skipped
    expect(b.binaries()[0]).toBe(f);
    expect(c.binaries()[0]).toBe(f);
  });

  it("drops a malformed binary frame instead of relaying", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    const b = await connect(room, ctx);
    await room.webSocketMessage(a as any, new ArrayBuffer(3)); // too short
    expect(b.binaries().length).toBe(0);
  });

  it("volatile frame is dropped to a backpressured peer but sent to a clear one", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    const slow = await connect(room, ctx);
    const fast = await connect(room, ctx);
    slow.bufferedAmount = 2 * 1024 * 1024; // above threshold
    await room.webSocketMessage(a as any, frame(BINARY_VOLATILE));
    expect(slow.binaries().length).toBe(0);
    expect(fast.binaries().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rtc-signal targeted routing
// ---------------------------------------------------------------------------

describe("rtc-signal routing", () => {
  it("routes a signal to the addressed peer with from set", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    const b = await connect(room, ctx);
    const aId = (a.deserializeAttachment() as WsAttachment).socketId;
    const bId = (b.deserializeAttachment() as WsAttachment).socketId;
    await room.webSocketMessage(
      a as any,
      packControl("rtc-signal", [{ to: bId, type: "offer", data: { sdp: 1 } }]),
    );
    const sig = b.controls().find((c) => c.ev === "rtc-signal");
    expect(sig).toBeTruthy();
    expect((sig!.args[0] as any).from).toBe(aId);
    expect((sig!.args[0] as any).type).toBe("offer");
  });

  it("emits rtc-error peer-offline to the sender when target is missing", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    await room.webSocketMessage(
      a as any,
      packControl("rtc-signal", [{ to: "nope", type: "offer", data: {} }]),
    );
    const err = a.controls().find((c) => c.ev === "rtc-error");
    expect(err).toBeTruthy();
    expect((err!.args[0] as any).reason).toBe("peer-offline");
  });
});

// ---------------------------------------------------------------------------
// user-follow + close (broadcast-unfollow + debounced room-user-change)
// ---------------------------------------------------------------------------

describe("follow + close", () => {
  it("FOLLOW notifies the followed user with the follower set", async () => {
    const { ctx, room } = makeRoom();
    const follower = await connect(room, ctx);
    const followed = await connect(room, ctx);
    const followedId = (followed.deserializeAttachment() as WsAttachment)
      .socketId;
    await room.webSocketMessage(
      follower as any,
      packControl("user-follow", [
        { userToFollow: { socketId: followedId }, action: "FOLLOW" },
      ]),
    );
    const ch = followed
      .controls()
      .find((c) => c.ev === "user-follow-room-change");
    expect(ch).toBeTruthy();
    expect((ch!.args[0] as string[]).length).toBe(1);
  });

  it("broadcast-unfollow fires when a followed user loses its last follower on close", async () => {
    const { ctx, room } = makeRoom();
    const follower = await connect(room, ctx);
    const followed = await connect(room, ctx);
    const followedId = (followed.deserializeAttachment() as WsAttachment)
      .socketId;
    await room.webSocketMessage(
      follower as any,
      packControl("user-follow", [
        { userToFollow: { socketId: followedId }, action: "FOLLOW" },
      ]),
    );
    follower.close();
    await room.webSocketClose(follower as any, 1000, "", true);
    expect(followed.controls().some((c) => c.ev === "broadcast-unfollow")).toBe(
      true,
    );
  });

  it("room-user-change on close is debounced (single broadcast for an N-close burst)", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    const b = await connect(room, ctx);
    const c = await connect(room, ctx);
    // Close two at once (deploy burst).
    b.close();
    c.close();
    ctx.prune(b);
    ctx.prune(c);
    await room.webSocketClose(b as any, 1000, "", true);
    await room.webSocketClose(c as any, 1000, "", true);
    const before = a
      .controls()
      .filter((x) => x.ev === "room-user-change").length;
    vi.advanceTimersByTime(300);
    const after = a
      .controls()
      .filter((x) => x.ev === "room-user-change").length;
    // Exactly ONE debounced room-user-change despite two closes.
    expect(after - before).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// request-room-clients (audio-mesh catch-up)
// ---------------------------------------------------------------------------

describe("request-room-clients", () => {
  it("re-sends the current peer list to the asker only", async () => {
    const { ctx, room } = makeRoom();
    const a = await connect(room, ctx);
    await connect(room, ctx);
    a.sent.length = 0;
    await room.webSocketMessage(
      a as any,
      packControl("request-room-clients", []),
    );
    const ch = a.controls().find((c) => c.ev === "room-user-change");
    expect(ch).toBeTruthy();
    expect((ch!.args[0] as string[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// __count RPC (WS-count cap support)
// ---------------------------------------------------------------------------

describe("__count RPC", () => {
  it("returns the live socket count for the cap check", async () => {
    const { ctx, room } = makeRoom();
    await connect(room, ctx);
    await connect(room, ctx);
    const res = await room.fetch(new Request("https://room.internal/__count"));
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(2);
  });
});
