// Auth-handshake tests for the realtime WS gate (closes 1b/B12).
//
// We mock `jose` (offline JWKS verify) and provide a fake D1 + ROOM namespace,
// then drive handleRealtimeUpgrade() directly — no workerd / wrangler (the
// local D1 is held by `wrangler dev`). Asserts the §4 gate order:
//   bad/expired JWT → 401 · canSeeMeeting fail → 403 · knock not-admitted →
//   403 · WS-count over cap → 403 · all pass → 101 (and only then).
//
//   npx vitest run worker/test/realtimeAuth.test.ts   (from repo root)

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so we control JWT verification outcomes ---------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

// email module pulls no runtime deps we care about, but stub to be safe.
vi.mock("../src/email", () => ({
  sendEmail: vi.fn(),
  guestInviteEmail: vi.fn(),
}));

// Permissive Response: node's undici forbids status 101 (the WS upgrade
// status) which the Workers runtime allows. Stub it BEFORE importing index.ts
// so handleRealtimeUpgrade's `new Response(..., {status:101})` works in node.
class TestResponse {
  status: number;
  statusText: string;
  body: unknown;
  webSocket: unknown;
  headers: Headers;
  constructor(
    body: unknown,
    init?: {
      status?: number;
      statusText?: string;
      headers?: HeadersInit;
      webSocket?: unknown;
    },
  ) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? "";
    this.headers = new Headers(init?.headers);
    this.webSocket = init?.webSocket ?? null;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async json() {
    return JSON.parse(this.body as string);
  }
}
vi.stubGlobal("Response", TestResponse);

const { handleRealtimeUpgrade } = await import("../src/index");

// --- fakes -----------------------------------------------------------------

/** Fake D1: a tiny query router keyed by SQL substring. */
function fakeDb(opts: {
  canSee?: boolean;
  knockStatus?: string | null;
  internalDomains?: string;
  finished?: boolean;
}) {
  const internalDomainsRow = {
    value: opts.internalDomains ?? "mapgroup.co.kr",
  };
  return {
    prepare(sql: string) {
      const api = {
        bind(..._args: unknown[]) {
          return api;
        },
        async first<T>(): Promise<T> {
          if (sql.includes("internal_domains")) {
            return internalDomainsRow as T;
          }
          // isFinishedLocked: SELECT status, updated_at FROM meeting WHERE id.
          // Return a finished row (old updated_at, past the write grace) when
          // opts.finished; otherwise null so the room is treated as live.
          if (sql.includes("updated_at FROM meeting")) {
            return (
              opts.finished ? { status: "finished", updated_at: 0 } : null
            ) as T;
          }
          if (sql.includes("meeting_knock")) {
            return (
              opts.knockStatus === undefined
                ? null
                : { status: opts.knockStatus }
            ) as T;
          }
          // canSeeMeeting's big SELECT — return a registered row whose arms
          // grant or deny based on opts.canSee.
          if (sql.includes("registered")) {
            const grant = opts.canSee ? 1 : null;
            return {
              registered: 1,
              conf: null,
              owner: grant,
              invited: grant,
              member: grant,
              authority: grant,
            } as T;
          }
          return null as T;
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

/** Fake ROOM namespace. The stub answers __count and the upgrade forward. */
function fakeRoom(opts: { count?: number; upgradeStatus?: number }) {
  const stub = {
    async fetch(req: Request | string): Promise<Response> {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("__count")) {
        return new Response(JSON.stringify({ count: opts.count ?? 0 }), {
          headers: { "content-type": "application/json" },
        });
      }
      // Upgrade forward — emulate the DO returning 101 (or a custom status).
      const status = opts.upgradeStatus ?? 101;
      return new Response(null, { status });
    },
  };
  return {
    idFromName: () => ({}),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SUPABASE_URL: "https://proj.supabase.co",
    DB: fakeDb({ canSee: true, knockStatus: "admitted" }),
    ROOM: fakeRoom({ count: 0 }),
    ROOM_WS_CAP: "500",
    ...over,
  } as any;
}

function wsRequest(token = "tok"): Request {
  return new Request("https://w/rooms/r1/ws", {
    headers: {
      Upgrade: "websocket",
      // Mirror the client (RawWsTransport): the marker FIRST, then the JWT.
      // The server must take the token as the non-"mcm.v1" segment (M1).
      "Sec-WebSocket-Protocol": `mcm.v1, ${token}`,
    },
  });
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe("realtime auth handshake", () => {
  it("rejects a non-upgrade request with 426", async () => {
    const res = await handleRealtimeUpgrade(
      new Request("https://w/rooms/r1/ws"),
      env(),
      "r1",
    );
    expect(res.status).toBe(426);
  });

  it("401 when the JWT is invalid/expired (NEVER 101)", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("expired"));
    const res = await handleRealtimeUpgrade(wsRequest(), env(), "r1");
    expect(res.status).toBe(401);
  });

  it("403 when canSeeMeeting denies (valid JWT)", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "u", email: "guest@other.com", app_metadata: {} },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ DB: fakeDb({ canSee: false }) }),
      "r1",
    );
    expect(res.status).toBe(403);
  });

  it("403 for an external user whose knock is NOT admitted", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "u", email: "guest@other.com", app_metadata: {} },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ DB: fakeDb({ canSee: true, knockStatus: "invited" }) }),
      "r1",
    );
    expect(res.status).toBe(403);
  });

  it("101 for an external user once admitted (knock passes)", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "u", email: "guest@other.com", app_metadata: {} },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ DB: fakeDb({ canSee: true, knockStatus: "admitted" }) }),
      "r1",
    );
    expect(res.status).toBe(101);
    // Accepted subprotocol echoed back (browser handshake requirement) — it is
    // the PROTOCOL MARKER, never the JWT (M1).
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("mcm.v1");
  });

  it("internal user skips the knock gate and gets 101", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "u",
        email: "staff@mapgroup.co.kr",
        app_metadata: {},
      },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      // knock row absent — internal must NOT be blocked by it.
      env({ DB: fakeDb({ canSee: true, knockStatus: undefined }) }),
      "r1",
    );
    expect(res.status).toBe(101);
  });

  it("admin skips knock + canSee arms and gets 101", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "a",
        email: "admin@anywhere.com",
        app_metadata: { role: "admin" },
      },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ DB: fakeDb({ canSee: false, knockStatus: undefined }) }),
      "r1",
    );
    expect(res.status).toBe(101);
  });

  it("403 when the room is at the WS-count cap", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "u",
        email: "staff@mapgroup.co.kr",
        app_metadata: {},
      },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ ROOM: fakeRoom({ count: 500 }), ROOM_WS_CAP: "500" }),
      "r1",
    );
    expect(res.status).toBe(403);
  });

  it("409 when the meeting is finished (read-only — no relay) (D3)", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "u",
        email: "staff@mapgroup.co.kr",
        app_metadata: {},
      },
    });
    const res = await handleRealtimeUpgrade(
      wsRequest(),
      env({ DB: fakeDb({ canSee: true, finished: true }) }),
      "r1",
    );
    expect(res.status).toBe(409);
  });

  it("extracts the token as the non-marker subprotocol segment (M1)", async () => {
    // Regression: the server must NOT take the first comma-segment ("mcm.v1")
    // as the token. Drive a request whose marker comes first; a valid JWT verify
    // here proves the token (segment 2) reached jwtVerify.
    const seen: unknown[] = [];
    jwtVerifyMock.mockImplementation((token: unknown) => {
      seen.push(token);
      return Promise.resolve({
        payload: {
          sub: "u",
          email: "staff@mapgroup.co.kr",
          app_metadata: {},
        },
      });
    });
    const req = new Request("https://w/rooms/r1/ws", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "mcm.v1, the-real-jwt",
      },
    });
    const res = await handleRealtimeUpgrade(req, env(), "r1");
    expect(res.status).toBe(101);
    // The JWT (not the marker) is what we verified.
    expect(seen[0]).toBe("the-real-jwt");
    // And we echo the MARKER back, never the token.
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("mcm.v1");
  });
});
