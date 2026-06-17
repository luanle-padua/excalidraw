// Owner-tier authorization tests (spec docs/specs/chairman-account.md §1.4).
//
// Two guarantees:
//  1. owner ⊇ admin — an `owner` JWT passes EVERY admin gate (`isAdminish`), so
//     it reaches /v1/admin/* exactly like admin does. We also confirm the gate
//     still rejects a non-privileged role (no weakening).
//  2. Minting the privileged roles (owner/chairman) via POST/PATCH
//     /v1/admin/users is OWNER-ONLY: an admin caller is rejected 403 BEFORE any
//     Supabase write; an admin may still create ordinary members; an owner may
//     grant the privileged role.
//
//   npx vitest run worker/test/ownerRole.test.ts   (from repo root)

import { beforeEach, describe, expect, it, vi } from "vitest";

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

/** Minimal D1 fake: refreshInternalDomains reads system_settings; the admin
 *  routes we hit either need nothing more (gate) or run harmless reads/writes
 *  (audit). Everything resolves to empty/ok. */
function fakeDb() {
  return {
    prepare(_sql: string) {
      const api = {
        bind() {
          return api;
        },
        async first() {
          return { value: "mapgroup.co.kr" };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function env(over: Record<string, unknown> = {}) {
  return {
    SUPABASE_URL: "https://proj.supabase.co",
    // present so adminCreds() is non-null and the role-grant guard (which runs
    // BEFORE the Supabase call) is the thing under test, not a 503.
    SUPABASE_SERVICE_API_KEY: "service-key",
    DB: fakeDb(),
    ...over,
  } as any;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

/** Make jwtVerify resolve to a token carrying the given role. */
function withRole(role: string | undefined) {
  jwtVerifyMock.mockResolvedValue({
    payload: {
      sub: "u",
      email: `caller@mapgroup.co.kr`,
      app_metadata: role ? { role } : {},
    },
  });
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
  vi.restoreAllMocks();
});

describe("owner ⊇ admin (isAdminish gate)", () => {
  it("owner passes the /v1/admin/* gate (reaches the route, not 403)", async () => {
    withRole("owner");
    const res = await worker.fetch(
      new Request("https://w/v1/admin/projects", {
        headers: { Authorization: "Bearer good" },
      }),
      env(),
      ctx,
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it("admin still passes the /v1/admin/* gate (unchanged)", async () => {
    withRole("admin");
    const res = await worker.fetch(
      new Request("https://w/v1/admin/projects", {
        headers: { Authorization: "Bearer good" },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("a non-privileged role is still rejected 403 (no weakening)", async () => {
    withRole(undefined); // ordinary internal staff
    const res = await worker.fetch(
      new Request("https://w/v1/admin/projects", {
        headers: { Authorization: "Bearer good" },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("/v1/owner/* is strictly owner-only — admin is rejected 403", async () => {
    withRole("admin");
    const res = await worker.fetch(
      new Request("https://w/v1/owner/anything", {
        headers: { Authorization: "Bearer good" },
      }),
      env(),
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe("privileged role granting is owner-only", () => {
  function createUser(role: string) {
    return new Request("https://w/v1/admin/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer good",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "new@mapgroup.co.kr",
        password: "pw123456",
        role,
      }),
    });
  }

  it("admin CANNOT mint an owner (403, no Supabase call)", async () => {
    withRole("admin");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(createUser("owner"), env(), ctx);
    expect(res.status).toBe(403);
    // guard runs before the Supabase admin call
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("admin CANNOT mint a chairman (403)", async () => {
    withRole("admin");
    const res = await worker.fetch(createUser("chairman"), env(), ctx);
    expect(res.status).toBe(403);
  });

  it("admin CAN still create an ordinary member (guard not triggered)", async () => {
    withRole("admin");
    // Stub the Supabase admin call so we don't hit the network; a 200 here means
    // the guard let it through to the create path.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    const res = await worker.fetch(createUser("member"), env(), ctx);
    expect(res.status).toBe(200);
  });

  it("owner CAN mint a chairman (guard passes for owner)", async () => {
    withRole("owner");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    );
    const res = await worker.fetch(createUser("chairman"), env(), ctx);
    expect(res.status).toBe(200);
  });
});
