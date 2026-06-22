// Unit tests for the PURE Daily-payload → screen-share-state mappings
// (screenShareState.ts). These two functions are the single boundary that
// classifies Daily's fatal `error.type` and `network-connection` payloads into
// our language-neutral codes, so a regression here silently breaks the
// presenter's screen-share error / reconnect notices.
//
//   npx vitest run excalidraw-app/screenshare/screenShareState.test.ts
//
// Style mirrors audio/connectionState.test.ts and worker/test/dailyAdmin.test.ts.

import { describe, expect, it } from "vitest";

import {
  screenShareFatalKindFor,
  screenShareLinkFor,
} from "./screenShareState";

describe("screenShareFatalKindFor (Daily fatal error.type → ScreenShareErrorKind)", () => {
  it("maps meeting-full to its own code", () => {
    expect(screenShareFatalKindFor("meeting-full")).toBe("meeting-full");
  });

  it("collapses the whole room/token-expiry family to 'token-expired'", () => {
    expect(screenShareFatalKindFor("exp-token")).toBe("token-expired");
    expect(screenShareFatalKindFor("exp-room")).toBe("token-expired");
    expect(screenShareFatalKindFor("nbf-token")).toBe("token-expired");
    expect(screenShareFatalKindFor("nbf-room")).toBe("token-expired");
  });

  it("collapses every other / unknown fatal type to the generic 'call'", () => {
    expect(screenShareFatalKindFor("ejected")).toBe("call");
    expect(screenShareFatalKindFor("not-allowed")).toBe("call");
    expect(screenShareFatalKindFor("connection-error")).toBe("call");
    expect(screenShareFatalKindFor("end-of-life")).toBe("call");
    expect(screenShareFatalKindFor("no-room")).toBe("call");
    expect(screenShareFatalKindFor(undefined)).toBe("call");
  });
});

describe("screenShareLinkFor (Daily network-connection → ScreenShareLink)", () => {
  it("maps an sfu (media) interruption to 'reconnecting' (media pauses + auto-reconnects)", () => {
    expect(screenShareLinkFor({ type: "sfu", event: "interrupted" })).toBe(
      "reconnecting",
    );
  });

  it("maps a peer-to-peer interruption to 'reconnecting' too", () => {
    expect(
      screenShareLinkFor({ type: "peer-to-peer", event: "interrupted" }),
    ).toBe("reconnecting");
  });

  it("maps a SIGNALING interruption to the hard 'unstable' warning (Daily ejects after ~20s)", () => {
    expect(
      screenShareLinkFor({ type: "signaling", event: "interrupted" }),
    ).toBe("unstable");
  });

  it("maps any 'connected' event back to 'connected'", () => {
    for (const type of ["signaling", "sfu", "peer-to-peer"] as const) {
      expect(screenShareLinkFor({ type, event: "connected" })).toBe(
        "connected",
      );
    }
  });

  it("returns null for unknown / intermediate events (no state churn)", () => {
    expect(
      // a future/intermediate event value the caller should ignore
      screenShareLinkFor({ type: "sfu", event: "connecting" }),
    ).toBeNull();
  });
});
