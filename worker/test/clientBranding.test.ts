// Client-branding helpers (06-17): country normalization + the per-country
// backdrop resolve used by /v1/portal/backdrops?country=XX and the client entry
// page. Pure functions, so we import them directly — same jose/Response stubs as
// realtimeAuth.test.ts so importing src/index has no live deps.
//
//   npx vitest run worker/test/clientBranding.test.ts   (from repo root)

import { describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: vi.fn(),
}));
vi.mock("../src/email", () => ({
  sendEmail: vi.fn(),
  guestInviteEmail: vi.fn(),
}));

const { normCountry, resolveBackdropsForCountry } = await import(
  "../src/index"
);

describe("normCountry", () => {
  it("upper-cases and trims a valid ISO alpha-2", () => {
    expect(normCountry(" vn ")).toBe("VN");
    expect(normCountry("kr")).toBe("KR");
  });
  it("rejects anything not exactly two letters → null (global)", () => {
    expect(normCountry("")).toBeNull();
    expect(normCountry("VNM")).toBeNull();
    expect(normCountry("1")).toBeNull();
    expect(normCountry("v1")).toBeNull();
    expect(normCountry(undefined)).toBeNull();
    expect(normCountry(null)).toBeNull();
    expect(normCountry(42)).toBeNull();
  });
});

describe("resolveBackdropsForCountry", () => {
  const all = [
    { id: "a", country: null },
    { id: "b", country: "VN" },
    { id: "c", country: "KR" },
    { id: "d", country: "VN" },
  ];

  it("no country → the full (ordered) list", () => {
    expect(resolveBackdropsForCountry(all, null).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("matching country → only that country's backdrops", () => {
    expect(resolveBackdropsForCountry(all, "VN").map((r) => r.id)).toEqual([
      "b",
      "d",
    ]);
  });

  it("no match → falls back to GLOBAL (untagged) backdrops only", () => {
    expect(resolveBackdropsForCountry(all, "JP").map((r) => r.id)).toEqual([
      "a",
    ]);
  });

  it("no match AND no global → empty (page keeps bundled defaults)", () => {
    const tagged = [
      { id: "x", country: "VN" },
      { id: "y", country: "KR" },
    ];
    expect(resolveBackdropsForCountry(tagged, "JP")).toEqual([]);
  });
});
