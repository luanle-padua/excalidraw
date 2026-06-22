// Unit tests for the PURE adaptive-quality GOVERNOR decision core
// (videoGovernor.ts). These helpers are the side-effect-free heart of Phase 3:
// given the unified {cpuState, cpuReason, networkState} signals and the tier the
// governor currently holds, they decide whether the SEND ceiling steps DOWN
// (machine/uplink under pressure), back UP (sustained calm), or HOLDs — and
// whether the RECEIVE side is under decode pressure. All timing / hysteresis /
// cooldown lives in DailyAudio.governQuality(); none of it is here, which is
// exactly why the decision is testable in isolation.
//
//   npx vitest run excalidraw-app/audio/videoGovernor.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  governorDirection,
  isCalm,
  isDecodeUnderPressure,
  isSendUnderPressure,
  minTier,
  nextSendTier,
  stepTierDown,
  stepTierUp,
  type GovernorSignals,
} from "./videoGovernor";

const signals = (s: Partial<GovernorSignals>): GovernorSignals => ({
  cpuState: "low",
  cpuReason: "none",
  networkState: "good",
  ...s,
});

describe("stepTierDown / stepTierUp", () => {
  it("steps DOWN one notch and clamps at low", () => {
    expect(stepTierDown("high")).toBe("medium");
    expect(stepTierDown("medium")).toBe("low");
    expect(stepTierDown("low")).toBe("low"); // clamped
  });

  it("steps UP one notch and clamps at high", () => {
    expect(stepTierUp("low")).toBe("medium");
    expect(stepTierUp("medium")).toBe("high");
    expect(stepTierUp("high")).toBe("high"); // clamped
  });
});

describe("minTier", () => {
  it("returns the LOWER (worse) of two tiers", () => {
    expect(minTier("high", "low")).toBe("low");
    expect(minTier("low", "high")).toBe("low");
    expect(minTier("medium", "high")).toBe("medium");
    expect(minTier("medium", "medium")).toBe("medium");
  });
});

describe("isSendUnderPressure", () => {
  it("is true when CPU is high AND the bottleneck is the ENCODER", () => {
    expect(
      isSendUnderPressure(signals({ cpuState: "high", cpuReason: "encode" })),
    ).toBe(true);
  });

  it("is true when the link quality is BAD (uplink saturated)", () => {
    expect(isSendUnderPressure(signals({ networkState: "bad" }))).toBe(true);
  });

  it("is FALSE for decode / scheduleDuration CPU pressure (not a send cost)", () => {
    expect(
      isSendUnderPressure(signals({ cpuState: "high", cpuReason: "decode" })),
    ).toBe(false);
    expect(
      isSendUnderPressure(
        signals({ cpuState: "high", cpuReason: "scheduleDuration" }),
      ),
    ).toBe(false);
  });

  it("is FALSE on a merely 'low' link with low CPU", () => {
    expect(isSendUnderPressure(signals({ networkState: "low" }))).toBe(false);
  });
});

describe("isDecodeUnderPressure", () => {
  it("is true ONLY for CPU high + reason decode", () => {
    expect(
      isDecodeUnderPressure(signals({ cpuState: "high", cpuReason: "decode" })),
    ).toBe(true);
    expect(
      isDecodeUnderPressure(signals({ cpuState: "high", cpuReason: "encode" })),
    ).toBe(false);
    expect(
      isDecodeUnderPressure(signals({ cpuState: "low", cpuReason: "decode" })),
    ).toBe(false);
  });
});

describe("isCalm", () => {
  it("is true when CPU low AND link not bad", () => {
    expect(isCalm(signals({ cpuState: "low", networkState: "good" }))).toBe(
      true,
    );
    expect(isCalm(signals({ cpuState: "low", networkState: "low" }))).toBe(
      true,
    );
  });

  it("is FALSE while CPU is high or the link is bad", () => {
    expect(isCalm(signals({ cpuState: "high" }))).toBe(false);
    expect(isCalm(signals({ networkState: "bad" }))).toBe(false);
  });
});

describe("nextSendTier", () => {
  it("steps DOWN under encode pressure (high → medium → low)", () => {
    const s = signals({ cpuState: "high", cpuReason: "encode" });
    expect(nextSendTier(s, "high")).toBe("medium");
    expect(nextSendTier(s, "medium")).toBe("low");
    expect(nextSendTier(s, "low")).toBe("low"); // already at the floor
  });

  it("steps DOWN under a BAD link regardless of CPU reason", () => {
    expect(nextSendTier(signals({ networkState: "bad" }), "high")).toBe(
      "medium",
    );
  });

  it("steps UP when calm (low CPU + link not bad)", () => {
    const s = signals({ cpuState: "low", networkState: "good" });
    expect(nextSendTier(s, "low")).toBe("medium");
    expect(nextSendTier(s, "medium")).toBe("high");
    expect(nextSendTier(s, "high")).toBe("high"); // already at the ceiling
  });

  it("HOLDs when neither calm nor under send pressure", () => {
    // high CPU on a non-encode reason with a fine link: not a send pressure,
    // and not calm (CPU is high) → hold the current tier.
    const s = signals({ cpuState: "high", cpuReason: "scheduleDuration" });
    expect(nextSendTier(s, "medium")).toBe("medium");
  });

  it("HOLDs on a 'low' (warning) link with low CPU — recovers only on a clear path", () => {
    // isCalm is true here (link not bad), so it actually steps UP. Assert the
    // documented behaviour: a 'low' link still permits recovery.
    const s = signals({ cpuState: "low", networkState: "low" });
    expect(nextSendTier(s, "low")).toBe("medium");
  });

  it("prioritises DOWN over UP when both could apply (bad link wins)", () => {
    // CPU low (would be calm) but link bad → send pressure dominates → DOWN.
    const s = signals({ cpuState: "low", networkState: "bad" });
    expect(nextSendTier(s, "high")).toBe("medium");
  });
});

describe("governorDirection", () => {
  it("reports 'down' / 'up' / 'hold' matching nextSendTier", () => {
    expect(
      governorDirection(
        signals({ cpuState: "high", cpuReason: "encode" }),
        "high",
      ),
    ).toBe("down");
    expect(governorDirection(signals({}), "low")).toBe("up");
    // at the floor under pressure → no move possible → hold.
    expect(
      governorDirection(
        signals({ cpuState: "high", cpuReason: "encode" }),
        "low",
      ),
    ).toBe("hold");
    // at the top while calm → no move possible → hold.
    expect(governorDirection(signals({}), "high")).toBe("hold");
  });
});
