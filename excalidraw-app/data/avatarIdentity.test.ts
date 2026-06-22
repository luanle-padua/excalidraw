// Unit tests for the PURE avatar/colour identity-key + resolver selection
// (plan §2 — "Avatar sync: ONE source of truth, keyed on EMAIL everywhere").
//
// The bug these pin: the on-canvas cursor used resolveAvatarUrlWithDefault(...,
// socketId), which rendered a RANDOM library face that changed on every
// reconnect and disagreed with the email-keyed initials shown on every other
// surface. The fix funnels every surface through `avatarIdentityKey` so the
// same person → the same default face / initials hue / name tint, stable across
// reconnects, and only anonymous (email-less) link-joins fall back to socketId.
//
//   npx vitest run excalidraw-app/data/avatarIdentity.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  AVATAR_LIBRARY,
  avatarIdentityKey,
  resolveAvatarUrl,
  resolveAvatarUrlWithDefault,
} from "./userProfile";

describe("avatarIdentityKey", () => {
  it("prefers the email (the stable login identity) over socketId", () => {
    expect(avatarIdentityKey("a@mapgroup.net", "sock-123")).toBe(
      "a@mapgroup.net",
    );
  });

  it("lower-cases + trims the email so casing/whitespace can't fork the key", () => {
    expect(avatarIdentityKey("  A@MapGroup.net ", "sock-123")).toBe(
      "a@mapgroup.net",
    );
  });

  it("is STABLE across reconnects — same email, different socketId → same key", () => {
    expect(avatarIdentityKey("a@mapgroup.net", "sock-1")).toBe(
      avatarIdentityKey("a@mapgroup.net", "sock-2"),
    );
  });

  it("falls back to socketId only for anonymous link-joins (no email)", () => {
    expect(avatarIdentityKey(null, "sock-9")).toBe("sock-9");
    expect(avatarIdentityKey(undefined, "sock-9")).toBe("sock-9");
    expect(avatarIdentityKey("   ", "sock-9")).toBe("sock-9");
  });
});

describe("resolveAvatarUrl (the chosen-image branch)", () => {
  it("returns null when no avatar is picked (caller falls back to initials)", () => {
    expect(resolveAvatarUrl(null)).toBeNull();
    expect(resolveAvatarUrl(undefined)).toBeNull();
    expect(resolveAvatarUrl("")).toBeNull();
  });

  it("maps a library pick to its public path", () => {
    expect(resolveAvatarUrl("lib:42.png")).toBe("/decorations/avatars/42.png");
  });

  it("passes a data URL through untouched (transient local preview)", () => {
    const url = "data:image/png;base64,AAAA";
    expect(resolveAvatarUrl(url)).toBe(url);
  });

  it("uses an absolute https URL as-is", () => {
    expect(resolveAvatarUrl("https://cdn.example/a.png")).toBe(
      "https://cdn.example/a.png",
    );
  });

  it("treats any other value as an R2 reference served by the worker", () => {
    // dev-tunnel mode → empty STORAGE_URL, so the served URL is same-origin.
    expect(resolveAvatarUrl("/v1/me/avatar/abc.png")).toBe(
      "/v1/me/avatar/abc.png",
    );
    expect(resolveAvatarUrl("abc.png")).toBe("/v1/me/avatar/abc.png");
  });
});

describe("resolveAvatarUrlWithDefault (the cursor default face)", () => {
  it("returns the chosen image when one is set — key is ignored", () => {
    expect(resolveAvatarUrlWithDefault("lib:42.png", "anything")).toBe(
      "/decorations/avatars/42.png",
    );
  });

  it("derives a DETERMINISTIC default face from the key when no avatar", () => {
    const a = resolveAvatarUrlWithDefault(null, "a@mapgroup.net");
    const b = resolveAvatarUrlWithDefault(null, "a@mapgroup.net");
    expect(a).toBe(b);
    expect(a).toMatch(/^\/decorations\/avatars\/\d{2}\.png$/);
    // The default always lands in the curated library set.
    const file = a.split("/").pop()!;
    expect(AVATAR_LIBRARY).toContain(file);
  });

  it("email-keyed default is STABLE across reconnects (the core bug fix)", () => {
    // Same person, two socket sessions: keying the default on the email keeps
    // the same face, where keying on socketId used to flip it every reconnect.
    const k = avatarIdentityKey("a@mapgroup.net", "sock-1");
    const k2 = avatarIdentityKey("a@mapgroup.net", "sock-2");
    expect(resolveAvatarUrlWithDefault(null, k)).toBe(
      resolveAvatarUrlWithDefault(null, k2),
    );
  });

  it("different people generally get different default faces", () => {
    // Not a hard guarantee (hash collisions exist) but these two differ, which
    // documents the intent: the face encodes identity, not session.
    const a = resolveAvatarUrlWithDefault(null, "alice@mapgroup.net");
    const b = resolveAvatarUrlWithDefault(null, "bob@mapgroup.net");
    expect(a).not.toBe(b);
  });
});
