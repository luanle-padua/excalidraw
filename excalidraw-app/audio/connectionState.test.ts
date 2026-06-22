// Unit tests for the PURE Daily-payload → connection-state mapping
// (connectionState.ts). These two functions are the single boundary that
// translates Daily's "network-connection" / "network-quality-change" payloads
// into our language-neutral codes (lifecycle / quality), so a regression here
// silently breaks the reconnecting banner / quality chip for everyone.
//
//   npx vitest run excalidraw-app/audio/connectionState.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  lifecycleFromConnectionEvent,
  qualityFromNetworkEvent,
} from "./connectionState";

describe("lifecycleFromConnectionEvent", () => {
  it("maps an sfu (media) interruption to 'reconnecting' (media pauses + auto-reconnects)", () => {
    expect(
      lifecycleFromConnectionEvent({ type: "sfu", event: "interrupted" }),
    ).toEqual({ lifecycle: "reconnecting", reasons: ["sfu"] });
  });

  it("maps a peer-to-peer interruption to 'reconnecting' too", () => {
    expect(
      lifecycleFromConnectionEvent({
        type: "peer-to-peer",
        event: "interrupted",
      }),
    ).toEqual({ lifecycle: "reconnecting", reasons: ["peer-to-peer"] });
  });

  it("maps a SIGNALING interruption to the hard 'unstable' warning (Daily ejects after ~20s)", () => {
    expect(
      lifecycleFromConnectionEvent({ type: "signaling", event: "interrupted" }),
    ).toEqual({ lifecycle: "unstable", reasons: ["signaling"] });
  });

  it("maps any 'connected' event back to 'connected' with no reasons", () => {
    for (const type of ["signaling", "sfu", "peer-to-peer"] as const) {
      expect(
        lifecycleFromConnectionEvent({ type, event: "connected" }),
      ).toEqual({ lifecycle: "connected", reasons: [] });
    }
  });

  it("returns null for intermediate / unknown events (no banner churn)", () => {
    expect(
      lifecycleFromConnectionEvent({ type: "sfu", event: "connecting" }),
    ).toBeNull();
    expect(
      lifecycleFromConnectionEvent({ type: "signaling", event: "" }),
    ).toBeNull();
  });
});

describe("qualityFromNetworkEvent", () => {
  it("passes 'good' through as 'good'", () => {
    expect(
      qualityFromNetworkEvent({ networkState: "good", networkStateReasons: [] }),
    ).toEqual({ quality: "good", reasons: [] });
  });

  it("maps Daily's 'warning' to our 'low' and carries the raw reasons", () => {
    expect(
      qualityFromNetworkEvent({
        networkState: "warning",
        networkStateReasons: ["sendPacketLoss", "roundTripTime"],
      }),
    ).toEqual({ quality: "low", reasons: ["sendPacketLoss", "roundTripTime"] });
  });

  it("maps 'bad' to 'bad'", () => {
    expect(
      qualityFromNetworkEvent({
        networkState: "bad",
        networkStateReasons: ["recvPacketLoss"],
      }),
    ).toEqual({ quality: "bad", reasons: ["recvPacketLoss"] });
  });

  it("treats 'unknown' as 'good' (no signal yet ⇒ no false alarm)", () => {
    expect(
      qualityFromNetworkEvent({
        networkState: "unknown",
        networkStateReasons: [],
      }),
    ).toEqual({ quality: "good", reasons: [] });
  });

  it("tolerates a missing networkStateReasons (defaults to [])", () => {
    expect(
      qualityFromNetworkEvent({
        networkState: "bad",
        networkStateReasons: undefined as never,
      }),
    ).toEqual({ quality: "bad", reasons: [] });
  });
});
