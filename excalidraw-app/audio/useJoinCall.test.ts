// Unit tests for the PURE join-intent decision (joinActionsFor) — the
// side-effect-free core of the pre-join "green room" join flow (Item 6). Given
// the user's {mic, camera} intent from the modal (or the intent-less idle Join
// button), it produces the ordered list of post-`start()` media acquisitions the
// hook walks. `start()` itself (listener-only join) is always implicit and not
// represented here, which is exactly why the decision is testable in isolation.
//
//   npx vitest run excalidraw-app/audio/useJoinCall.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import { joinActionsFor } from "./useJoinCall";

describe("joinActionsFor", () => {
  it("no intent (idle Join fallback) → listener-only, no extra actions", () => {
    expect(joinActionsFor({})).toEqual([]);
    expect(joinActionsFor({ mic: false, camera: false })).toEqual([]);
  });

  it("mic-only intent → ensureMic, no camera", () => {
    expect(joinActionsFor({ mic: true })).toEqual(["ensureMic"]);
    expect(joinActionsFor({ mic: true, camera: false })).toEqual(["ensureMic"]);
  });

  it("camera-only intent → setCameraOn, no mic (camera default-off path)", () => {
    expect(joinActionsFor({ camera: true })).toEqual(["setCameraOn"]);
    expect(joinActionsFor({ mic: false, camera: true })).toEqual([
      "setCameraOn",
    ]);
  });

  it("both intents → mic BEFORE camera (deterministic order)", () => {
    expect(joinActionsFor({ mic: true, camera: true })).toEqual([
      "ensureMic",
      "setCameraOn",
    ]);
  });
});
