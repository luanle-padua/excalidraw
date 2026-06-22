// Daily usage-admin + B5 cost-limit tests (docs/specs/daily-usage-admin.md).
//
// Two guarantees:
//  1. GET /v1/admin/daily is BEST-EFFORT: with no DAILY_API_KEY it returns the
//     all-zero snapshot (configured:false) and NEVER touches Daily / 500s —
//     mirroring the AI cost endpoint's missing-provider fallback.
//  2. The Daily room auto-created inside GET /v1/daily/token carries the two
//     VERIFIED B5 cost-limit props: `exp` (room auto-expiry) and
//     `max_participants` (peak cap), in addition to the existing screenshare /
//     start-off props.
//
//   npx vitest run worker/test/dailyAdmin.test.ts   (from repo root)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so we control the verified JWT (role lives in app_metadata) ---
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

vi.mock("../src/email", () => ({
  sendEmail: vi.fn(),
  guestInviteEmail: vi.fn(),
}));

const worker = (await import("../src/index")).default;

// --- fakes -----------------------------------------------------------------

/** Minimal D1 fake. refreshInternalDomains reads system_settings; the daily
 *  route does NO D1 work; the token route reads meeting status (isFinishedLocked
 *  → we return a non-finished value). Everything resolves to harmless empties.
 *
 *  `settingsRows` lets a test seed system_settings rows for the readDailyCaps
 *  SELECT (the only `.all()` that matters for the token route's room create). */
function fakeDb(settingsRows: { key: string; value: string }[] = []) {
  return {
    prepare(sql: string) {
      const isCapsSelect = sql.includes("daily_room_max_participants");
      const api = {
        bind() {
          return api;
        },
        async first() {
          // value: internal_domains; status: not finished → token route proceeds
          return { value: "mapgroup.co.kr", status: "live" };
        },
        async all() {
          return { results: isCapsSelect ? settingsRows : [] };
        },
        async run() {
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function env(
  over: Record<string, unknown> = {},
  settingsRows: { key: string; value: string }[] = [],
) {
  return {
    SUPABASE_URL: "https://proj.supabase.co",
    DB: fakeDb(settingsRows),
    ...over,
  } as any;
}

// Drive GET /v1/daily/token through to the room-create POST and return the
// captured create body. Shared by the B5 + Phase 7 room-property tests.
async function captureRoomCreate(
  settingsRows: { key: string; value: string }[] = [],
) {
  adminToken();
  let createBody: any = null;
  const fetchSpy = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/rooms/") && (!init || init.method !== "POST")) {
      return new Response("not found", { status: 404 });
    }
    if (u.endsWith("/rooms") && init?.method === "POST") {
      createBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ url: "https://x.daily.co/room1" }), {
        status: 200,
      });
    }
    if (u.endsWith("/meeting-tokens")) {
      return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const res = await worker.fetch(
    new Request("https://w/v1/daily/token?roomId=room1&name=Boss", {
      headers: { Authorization: "Bearer good" },
    }),
    env({ DAILY_API_KEY: "dk_test" }, settingsRows),
    ctx,
  );
  return { res, createBody };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

// An admin JWT passes isAdminish → canSeeMeeting + the /v1/admin/* gate.
function adminToken() {
  jwtVerifyMock.mockResolvedValue({
    payload: {
      sub: "u",
      email: "boss@mapgroup.co.kr",
      app_metadata: { role: "admin" },
    },
  });
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/admin/daily — best-effort zero when no key", () => {
  it("returns the all-zero snapshot (configured:false), never calls Daily", async () => {
    adminToken();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(
      new Request("https://w/v1/admin/daily", {
        headers: { Authorization: "Bearer good" },
      }),
      // DAILY_API_KEY intentionally unset
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.configured).toBe(false);
    expect(body.live.active_rooms).toBe(0);
    expect(body.live.live_participants).toBe(0);
    expect(body.rooms.total).toBe(0);
    expect(body.month.participant_minutes).toBe(0);
    expect(body.cost_estimate_usd).toEqual({ low: 0, high: 0 });
    // No Daily REST call should have been made.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /v1/daily/token — B5 room cost-limit props", () => {
  it("auto-created room carries exp + max_participants", async () => {
    adminToken();

    let createBody: any = null;
    const fetchSpy = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      // GET the room → 404 so the route creates it.
      if (u.includes("/rooms/") && (!init || init.method !== "POST")) {
        return new Response("not found", { status: 404 });
      }
      // POST /rooms → capture the create body, return a room url.
      if (u.endsWith("/rooms") && init?.method === "POST") {
        createBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({ url: "https://x.daily.co/room1" }),
          { status: 200 },
        );
      }
      // POST /meeting-tokens → return a token.
      if (u.endsWith("/meeting-tokens")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(
      new Request("https://w/v1/daily/token?roomId=room1&name=Boss", {
        headers: { Authorization: "Bearer good" },
      }),
      env({ DAILY_API_KEY: "dk_test" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(createBody).toBeTruthy();
    const props = createBody.properties;
    // Existing props preserved.
    expect(props.enable_screenshare).toBe(true);
    expect(props.start_video_off).toBe(true);
    expect(props.start_audio_off).toBe(true);
    // B5 cost-limit props added.
    expect(typeof props.exp).toBe("number");
    expect(props.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(props.max_participants).toBe(50);
  });
});

describe("GET /v1/daily/token — Phase 7 adaptive-simulcast flag (default OFF)", () => {
  it("OMITS enable_multiparty_adaptive_simulcast when the flag is unset", async () => {
    const { res, createBody } = await captureRoomCreate(/* no settings */);
    expect(res.status).toBe(200);
    expect(createBody).toBeTruthy();
    expect(
      "enable_multiparty_adaptive_simulcast" in createBody.properties,
    ).toBe(false);
  });

  it("OMITS the flag for blank / garbage / 'off' values", async () => {
    for (const value of ["", "  ", "off", "true", "1", "yes"]) {
      const { res, createBody } = await captureRoomCreate([
        { key: "daily_adaptive_simulcast", value },
      ]);
      expect(res.status).toBe(200);
      expect(
        "enable_multiparty_adaptive_simulcast" in createBody.properties,
      ).toBe(false);
    }
  });

  it("ENABLES the flag only for the exact opt-in 'on' (case-insensitive)", async () => {
    for (const value of ["on", "ON", "On"]) {
      const { res, createBody } = await captureRoomCreate([
        { key: "daily_adaptive_simulcast", value },
      ]);
      expect(res.status).toBe(200);
      expect(createBody.properties.enable_multiparty_adaptive_simulcast).toBe(
        true,
      );
    }
  });
});
