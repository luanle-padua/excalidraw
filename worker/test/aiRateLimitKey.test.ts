// Unit tests for the AI rate-limit KEY selection (plan §5 — AI hardening).
//
// The limiter must scope per-AUTHENTICATED-USER, not per-IP: the office shares
// one NAT egress IP, so an IP-keyed bucket throttled whole rooms during live
// meetings. `rateLimitKey` is the pure selector that decides the subject; this
// pins its preference order (email → userId → ip) and the scope flag the route
// uses to decide whether to also apply the coarse per-IP ceiling.
//
//   npx vitest run worker/test/aiRateLimitKey.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import { rateLimitKey } from "../src/ai";

describe("rateLimitKey", () => {
  it("keys on email (lower-cased) when present — the stable per-user key", () => {
    expect(
      rateLimitKey({
        email: "Staff@MapGroup.co.kr",
        userId: "uid-1",
        ip: "203.0.113.1",
      }),
    ).toEqual({ key: "u:staff@mapgroup.co.kr", scope: "user" });
  });

  it("falls back to userId when the token carries no email", () => {
    expect(
      rateLimitKey({ email: undefined, userId: "uid-9", ip: "203.0.113.1" }),
    ).toEqual({ key: "u:uid-9", scope: "user" });
  });

  it("treats a blank/whitespace email as absent and falls through to userId", () => {
    expect(
      rateLimitKey({ email: "   ", userId: "uid-2", ip: "203.0.113.1" }),
    ).toEqual({ key: "u:uid-2", scope: "user" });
  });

  it("falls back to IP only when there is no identity at all", () => {
    expect(
      rateLimitKey({ email: undefined, userId: undefined, ip: "203.0.113.7" }),
    ).toEqual({ key: "ip:203.0.113.7", scope: "ip" });
  });

  it("uses a sentinel when even the IP is missing (never an empty key)", () => {
    expect(rateLimitKey({ ip: "" })).toEqual({
      key: "ip:unknown",
      scope: "ip",
    });
  });

  it("gives two NATed users on the same IP DISTINCT keys (the bug being fixed)", () => {
    const a = rateLimitKey({ email: "a@x.co", ip: "10.0.0.1" });
    const b = rateLimitKey({ email: "b@x.co", ip: "10.0.0.1" });
    expect(a.key).not.toBe(b.key);
  });
});
