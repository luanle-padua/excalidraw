// Adaptive quality GOVERNOR (Phase 3 of the monitoring & resilience plan).
//
// A tiny state machine that unifies two Daily signals — `cpu-load-change` and
// `network-quality-change` — into a single decision: should we step the video
// SEND ceiling DOWN (machine/uplink under pressure) or back UP (sustained
// calm)? It never fights Daily's own adaptive bitrate: like applyVideoQuality
// it only moves the CEILING, ABR keeps floating below it. The user's quality
// PREF is never touched; the governor only narrows the TEMPORARY effective
// ceiling and releases it when conditions recover.
//
// This module is the PURE, side-effect-free decision core so it can be unit
// tested in isolation (signals → next tier). All timing, hysteresis, cooldown
// and the actual `updateSendSettings`/`updateReceiveSettings` calls live in
// DailyAudio.governQuality(), which feeds these helpers.

import type { QualityCap } from "./videoQuality";

/** The ranked send tiers, lowest → highest. Shares the QualityCap vocabulary so
 *  the governor ceiling and clampQuality(userPref, adminCap) speak the same
 *  language — the governor can never resolve a tier outside this ladder. */
const TIER_LADDER: QualityCap[] = ["low", "medium", "high"];

/** Daily `cpu-load-change` payload, narrowed to the two fields we act on. */
export type CpuState = "low" | "high";
export type CpuReason = "encode" | "decode" | "scheduleDuration" | "none";

/** Our 3-level link quality (already collapsed from Daily's networkState in
 *  connectionState.qualityFromNetworkEvent). */
export type GovernorQuality = "good" | "low" | "bad";

/** The pressure a single governor evaluation observes. */
export type GovernorSignals = {
  cpuState: CpuState;
  cpuReason: CpuReason;
  networkState: GovernorQuality;
};

/** What the governor wants to do to the SEND ceiling on one evaluation. */
export type GovernorDirection = "down" | "up" | "hold";

/** Step a tier DOWN one notch (high→medium→low), clamped at `low`. */
export const stepTierDown = (tier: QualityCap): QualityCap => {
  const i = TIER_LADDER.indexOf(tier);
  return i > 0 ? TIER_LADDER[i - 1] : tier;
};

/** Step a tier UP one notch (low→medium→high), clamped at `high`. */
export const stepTierUp = (tier: QualityCap): QualityCap => {
  const i = TIER_LADDER.indexOf(tier);
  return i >= 0 && i < TIER_LADDER.length - 1 ? TIER_LADDER[i + 1] : tier;
};

/** The LOWER (worse) of two tiers on the ladder. The governor's temporary
 *  ceiling is only ever a FURTHER restriction on top of the hard
 *  clampQuality(userPref, adminCap) cap, so the effective tier applied to Daily
 *  is minTier(governorCeiling, cap) — the governor can lower, never raise above
 *  the admin/user cap. */
export const minTier = (a: QualityCap, b: QualityCap): QualityCap =>
  TIER_LADDER.indexOf(a) <= TIER_LADDER.indexOf(b) ? a : b;

/**
 * Is the SEND path under pressure right now? True when either:
 *  - CPU is high AND the bottleneck is the ENCODER (`encode`) — our own machine
 *    can't keep up publishing video, so a lower send tier (smaller capture +
 *    cheaper encode preset) relieves it; OR
 *  - the link quality is `bad` — the uplink is saturated, so a lower ceiling
 *    cuts the bitrate we ask Daily to push.
 *
 * `scheduleDuration` / `decode` CPU pressure does NOT count here — `decode` is a
 * RECEIVE-side cost (handled by lowering the receive base layer, not the send
 * tier), and `scheduleDuration` is main-thread contention the send tier can't fix.
 */
export const isSendUnderPressure = (s: GovernorSignals): boolean =>
  (s.cpuState === "high" && s.cpuReason === "encode") ||
  s.networkState === "bad";

/** Is the DECODE (receive) path under pressure? CPU high with the `decode`
 *  reason means we're spending too much decoding remote tiles → lower the
 *  receive base layer for non-speakers rather than touching our send tier. */
export const isDecodeUnderPressure = (s: GovernorSignals): boolean =>
  s.cpuState === "high" && s.cpuReason === "decode";

/** Conditions calm enough to consider stepping the ceiling back UP: CPU low AND
 *  the link is not `bad` (a `low`/`good` link is fine to recover on; ABR still
 *  floats below the raised ceiling). Recovery is gated on TIME in the caller —
 *  this only states the instantaneous "calm" predicate. */
export const isCalm = (s: GovernorSignals): boolean =>
  s.cpuState === "low" && s.networkState !== "bad";

/**
 * PURE governor decision for the SEND tier. Given the current signals and the
 * tier the governor currently holds, return the NEXT tier — moving AT MOST one
 * notch per evaluation:
 *   - under send pressure  → one notch DOWN (clamped at `low`);
 *   - calm                 → one notch UP   (clamped at `high`);
 *   - neither (e.g. low CPU but a `bad` link, or high CPU on a non-encode
 *     reason with a fine link) → HOLD.
 *
 * The result is intentionally a *desired* tier only; the caller enforces the
 * hard ceiling `clampQuality(userPref, adminCap)` (the governor may never EXCEED
 * the admin/user cap) and the timing hysteresis (no oscillation). Splitting the
 * "what" (here) from the "when" (caller) keeps this fully unit-testable.
 */
export const nextSendTier = (
  signals: GovernorSignals,
  currentTier: QualityCap,
): QualityCap => {
  if (isSendUnderPressure(signals)) {
    return stepTierDown(currentTier);
  }
  if (isCalm(signals)) {
    return stepTierUp(currentTier);
  }
  return currentTier;
};

/** The same decision expressed as a DIRECTION, for callers/tests that care
 *  about intent rather than the resolved tier (e.g. to drive the cooldown). */
export const governorDirection = (
  signals: GovernorSignals,
  currentTier: QualityCap,
): GovernorDirection => {
  const next = nextSendTier(signals, currentTier);
  if (next === currentTier) {
    return "hold";
  }
  return TIER_LADDER.indexOf(next) < TIER_LADDER.indexOf(currentTier)
    ? "down"
    : "up";
};
