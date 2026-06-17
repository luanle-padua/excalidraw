// Auth-gate tests for the AI routes (B-AI, 06-17).
//
// /translate, /translate-batch, /chatbot, /summarize are mounted at ROOT (not
// /v1) but MUST require a valid Supabase bearer token — otherwise anyone who
// knows the URL can burn the server-side GEMINI_API_KEY. We drive the Worker's
// default fetch() export (which falls through to app.fetch for these paths) and
// assert: no/garbage Authorization → 401 (Gemini never touched); a valid token
// passes the gate (reaches the route, which 503s only because GEMINI_API_KEY is
// unset here — proving the gate let it through).
//
//   npx vitest run worker/test/aiAuth.test.ts   (from repo root)

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

const worker = (await import("../src/index")).default;

// --- fakes -----------------------------------------------------------------

/** Minimal D1 fake: the JWT gate's success path calls refreshInternalDomains,
 *  which reads system_settings.internal_domains. Everything else returns null. */
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
    DB: fakeDb(),
    // GEMINI_API_KEY intentionally unset — a request that PASSES the gate then
    // 503s on the missing provider, which is how we prove the gate let it by.
    ...over,
  } as any;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

function aiRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://w/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: "hello", target: "vi" }),
  });
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe("AI route auth gate", () => {
  it("401 when no Authorization header is sent (Gemini never reached)", async () => {
    const res = await worker.fetch(aiRequest(), env(), ctx);
    expect(res.status).toBe(401);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("401 when the bearer token is invalid/expired", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("expired"));
    const res = await worker.fetch(
      aiRequest({ Authorization: "Bearer garbage" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("passes the gate with a valid token (503 only because key is unset)", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "u", email: "staff@mapgroup.co.kr", app_metadata: {} },
    });
    const res = await worker.fetch(
      aiRequest({ Authorization: "Bearer good" }),
      env(),
      ctx,
    );
    // Gate passed → route ran → 503 (provider not configured). NOT 401.
    expect(res.status).toBe(503);
    expect(jwtVerifyMock).toHaveBeenCalledOnce();
  });

  it("503 when SUPABASE_URL is unconfigured (fail closed, not open)", async () => {
    const res = await worker.fetch(
      aiRequest({ Authorization: "Bearer good" }),
      env({ SUPABASE_URL: undefined }),
      ctx,
    );
    expect(res.status).toBe(503);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});
