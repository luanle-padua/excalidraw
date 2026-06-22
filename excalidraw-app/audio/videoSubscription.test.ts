// Unit tests for the PURE Phase 5 scale-subscription decision core:
//   - receiveBaseForTileCount (videoQuality.ts) — adaptive receive base layer.
//   - shouldPaginate / computeSubscriptions / toDailyVideoSub
//     (videoSubscription.ts) — the visible-set + threshold → subscription map.
// These are the single boundary that decides which remote cameras a big meeting
// actually decodes, so a regression here silently breaks pagination (showing too
// many tiles → device thrash, or too few → black tiles).
//
//   npx vitest run excalidraw-app/audio/videoSubscription.test.ts   (repo root)

import { describe, expect, it } from "vitest";

import {
  RECEIVE_BASE_LAYER_CUTOFF,
  receiveBaseForTileCount,
} from "./videoQuality";
import {
  computeSubscriptions,
  countSubscribed,
  isPublishingCamera,
  remoteCamerasFromRoster,
  shouldPaginate,
  toDailyVideoSub,
  type RemoteVideoParticipant,
  type RosterCamera,
} from "./videoSubscription";

describe("receiveBaseForTileCount", () => {
  it("keeps layer 1 (sharp) for a small grid (≤ cutoff)", () => {
    expect(receiveBaseForTileCount(0)).toBe(1);
    expect(receiveBaseForTileCount(1)).toBe(1);
    expect(receiveBaseForTileCount(RECEIVE_BASE_LAYER_CUTOFF)).toBe(1);
  });

  it("drops to layer 0 (cheapest) for a large grid (> cutoff)", () => {
    expect(receiveBaseForTileCount(RECEIVE_BASE_LAYER_CUTOFF + 1)).toBe(0);
    expect(receiveBaseForTileCount(50)).toBe(0);
  });
});

describe("shouldPaginate", () => {
  it("paginates only when the count strictly exceeds the threshold", () => {
    expect(shouldPaginate(20, 20)).toBe(false); // at threshold → automatic
    expect(shouldPaginate(21, 20)).toBe(true); // over → paginate
    expect(shouldPaginate(5, 20)).toBe(false);
  });

  it("treats a non-positive threshold as 'never paginate'", () => {
    expect(shouldPaginate(100, 0)).toBe(false);
    expect(shouldPaginate(100, -1)).toBe(false);
  });
});

describe("toDailyVideoSub", () => {
  it("maps tier codes to Daily's video subscription literals", () => {
    expect(toDailyVideoSub("subscribed")).toBe(true);
    expect(toDailyVideoSub("staged")).toBe("staged");
    expect(toDailyVideoSub("unsubscribed")).toBe(false);
  });
});

/** Build a participant list of `n` remote cameras with session ids s0..s(n-1),
 *  applying the overrides for specific indices. */
const makeParticipants = (
  n: number,
  overrides: Partial<
    Record<number, Partial<Omit<RemoteVideoParticipant, "sessionId">>>
  > = {},
): RemoteVideoParticipant[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`,
    visible: false,
    isActiveSpeaker: false,
    staged: false,
    ...(overrides[i] ?? {}),
  }));

describe("computeSubscriptions", () => {
  it("returns an EMPTY map below the threshold (caller keeps Daily automatic)", () => {
    const participants = makeParticipants(5, { 0: { visible: true } });
    expect(computeSubscriptions(participants, 20).size).toBe(0);
  });

  it("over threshold: subscribes visible tiles, drops the rest", () => {
    // 22 cameras, threshold 20 → paginate. Tiles 0 and 1 visible.
    const participants = makeParticipants(22, {
      0: { visible: true },
      1: { visible: true },
    });
    const subs = computeSubscriptions(participants, 20);
    expect(subs.size).toBe(22); // every camera gets an explicit tier
    expect(subs.get("s0")).toBe("subscribed");
    expect(subs.get("s1")).toBe("subscribed");
    expect(subs.get("s2")).toBe("unsubscribed");
    expect(subs.get("s21")).toBe("unsubscribed");
    expect(countSubscribed(subs)).toBe(2);
  });

  it("ALWAYS subscribes the active speaker even when its tile is off-page", () => {
    // Speaker is tile 21 (off the visible page); only tiles 0-1 are visible.
    const participants = makeParticipants(22, {
      0: { visible: true },
      1: { visible: true },
      21: { isActiveSpeaker: true },
    });
    const subs = computeSubscriptions(participants, 20);
    expect(subs.get("s21")).toBe("subscribed");
    expect(countSubscribed(subs)).toBe(3);
  });

  it("stages near-neighbours (off-screen, kept warm) distinct from dropped tiles", () => {
    const participants = makeParticipants(22, {
      0: { visible: true },
      5: { staged: true },
    });
    const subs = computeSubscriptions(participants, 20);
    expect(subs.get("s0")).toBe("subscribed");
    expect(subs.get("s5")).toBe("staged");
    expect(subs.get("s6")).toBe("unsubscribed");
  });

  it("visible/active wins over staged for the same tile", () => {
    const participants = makeParticipants(22, {
      3: { visible: true, staged: true },
    });
    const subs = computeSubscriptions(participants, 20);
    expect(subs.get("s3")).toBe("subscribed");
  });
});

describe("isPublishingCamera", () => {
  it("is false only for 'off' and 'blocked' (no track to subscribe)", () => {
    expect(isPublishingCamera("off")).toBe(false);
    expect(isPublishingCamera("blocked")).toBe(false);
  });

  it("is true for any state with a track — including 'sendable' (not yet subscribed)", () => {
    expect(isPublishingCamera("sendable")).toBe(true);
    expect(isPublishingCamera("loading")).toBe(true);
    expect(isPublishingCamera("interrupted")).toBe(true);
    expect(isPublishingCamera("playable")).toBe(true);
  });
});

/** Build a roster camera with sensible publishing defaults. */
const cam = (over: Partial<RosterCamera> & { sessionId: string }): RosterCamera => ({
  socketId: `sock-${over.sessionId}`,
  local: false,
  videoState: "sendable",
  ...over,
});

describe("remoteCamerasFromRoster", () => {
  it("drops the local self-view", () => {
    const roster = [
      cam({ sessionId: "s0", local: true }),
      cam({ sessionId: "s1" }),
    ];
    const out = remoteCamerasFromRoster(roster, new Set(), null, null);
    expect(out.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  it("drops non-publishing cameras ('off'/'blocked') but keeps 'sendable'", () => {
    // 'sendable' is the key case: an off-page camera that joined AFTER automatic
    // subscription was switched off — never reaches 'playable', but must still be
    // considered so it can be subscribed when it scrolls into view.
    const roster = [
      cam({ sessionId: "off1", videoState: "off" }),
      cam({ sessionId: "blk1", videoState: "blocked" }),
      cam({ sessionId: "snd1", videoState: "sendable" }),
      cam({ sessionId: "play1", videoState: "playable" }),
    ];
    const out = remoteCamerasFromRoster(roster, new Set(), null, null);
    expect(out.map((p) => p.sessionId).sort()).toEqual(["play1", "snd1"]);
  });

  it("drops participants whose socket.id is not resolved yet", () => {
    const roster = [
      cam({ sessionId: "s0", socketId: null }),
      cam({ sessionId: "s1", socketId: "sock-1" }),
    ];
    const out = remoteCamerasFromRoster(roster, new Set(), null, null);
    expect(out.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  it("marks a camera visible when its socket.id is in the visible set", () => {
    const roster = [
      cam({ sessionId: "s0", socketId: "sock-0" }),
      cam({ sessionId: "s1", socketId: "sock-1" }),
    ];
    const out = remoteCamerasFromRoster(
      roster,
      new Set(["sock-1"]),
      null,
      null,
    );
    expect(out.find((p) => p.sessionId === "s0")?.visible).toBe(false);
    expect(out.find((p) => p.sessionId === "s1")?.visible).toBe(true);
  });

  it("marks the active speaker by session_id OR socket.id, even off-page", () => {
    const roster = [
      cam({ sessionId: "spk", socketId: "sock-spk" }),
      cam({ sessionId: "other", socketId: "sock-other" }),
    ];
    // Resolve by session_id:
    const bySession = remoteCamerasFromRoster(roster, new Set(), "spk", null);
    expect(bySession.find((p) => p.sessionId === "spk")?.isActiveSpeaker).toBe(
      true,
    );
    // Resolve by socket.id fallback (session unknown):
    const bySocket = remoteCamerasFromRoster(
      roster,
      new Set(),
      null,
      "sock-spk",
    );
    expect(bySocket.find((p) => p.sessionId === "spk")?.isActiveSpeaker).toBe(
      true,
    );
  });

  it("an off-page 'sendable' camera that scrolls into view becomes subscribed end to end", () => {
    // 22 cameras over a threshold of 20 → paginate. Camera 'late' joined after
    // pagination flipped (state 'sendable', never playable) and is now visible.
    const roster: RosterCamera[] = Array.from({ length: 21 }, (_, i) =>
      cam({ sessionId: `s${i}`, socketId: `sock-${i}` }),
    );
    roster.push(
      cam({ sessionId: "late", socketId: "sock-late", videoState: "sendable" }),
    );
    const participants = remoteCamerasFromRoster(
      roster,
      new Set(["sock-late"]),
      null,
      null,
    );
    expect(participants).toHaveLength(22);
    const subs = computeSubscriptions(participants, 20);
    expect(subs.get("late")).toBe("subscribed");
  });
});
