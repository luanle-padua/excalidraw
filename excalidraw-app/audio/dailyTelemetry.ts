// PURE observability helpers for Phase 4 of the monitoring & resilience plan.
//
// Daily has NO live-quality webhook (only room/recording REST events), so the
// only way to observe a call's health in real time is to PULL getNetworkStats()
// on an interval. This module is the side-effect-free core that:
//   1. NARROWS Daily's getNetworkStats() payload down to the handful of fields
//      we actually care about (extractStatsSample), tolerating the empty-`stats`
//      shape Daily returns before the first sample exists.
//   2. FORMATS a sample into a one-line telemetry string (formatStatsLine) and a
//      short human tooltip suffix (formatStatsTooltip) for the quality chip.
//
// Keeping all extraction/formatting here (not in DailyAudio) means the mapping
// is unit-tested in isolation — exactly like connectionState.ts maps the
// network-connection / network-quality payloads. The actual interval timer,
// console emission and teardown live in DailyAudio.ts.

import type { DailyNetworkStats } from "@daily-co/daily-js";

/** The narrowed network-stats fields we keep from one getNetworkStats() pull.
 *  Every numeric field is nullable because Daily reports `null` for a metric it
 *  hasn't measured yet (e.g. send bitrate while the camera is off). */
export type NetworkStatsSample = {
  /** Daily's own coarse grade for this sample (mirrors network-quality-change).*/
  networkState: DailyNetworkStats["networkState"];
  /** kbps up/down for video, rounded — what the user perceives as "my video". */
  videoSendKbps: number | null;
  videoRecvKbps: number | null;
  /** packet loss as a FRACTION 0..1 (Daily's native unit), total across media. */
  sendPacketLoss: number | null;
  recvPacketLoss: number | null;
  /** round-trip time in milliseconds (Daily reports seconds; we convert). */
  rttMs: number | null;
  /** available outgoing bitrate in kbps — the headroom Daily sees on the uplink.*/
  availableOutgoingKbps: number | null;
  /** worst-case video loss fractions across the sampling window (0..1). */
  worstSendPacketLoss: number | null;
  worstRecvPacketLoss: number | null;
};

/** bits/second → kbps, rounded; null passes through (metric not measured yet). */
const toKbps = (bps: number | null | undefined): number | null =>
  bps == null ? null : Math.round(bps / 1000);

/** seconds → milliseconds, rounded; null passes through. */
const toMs = (s: number | null | undefined): number | null =>
  s == null ? null : Math.round(s * 1000);

/** A loss fraction 0..1 rounded to 3 decimals; null passes through. Daily
 *  already reports loss as a fraction, so we do NOT multiply by 100 here — the
 *  formatters render the percentage. */
const round3 = (n: number | null | undefined): number | null =>
  n == null ? null : Math.round(n * 1000) / 1000;

/**
 * PURE: narrow Daily's getNetworkStats() result to a NetworkStatsSample. Returns
 * null when Daily has no sample yet — its `stats` is typed
 * `Record<string, never> | DailyNetworkStatsData`, i.e. an EMPTY object before
 * the first measurement — so callers skip emitting a meaningless all-null line.
 */
export const extractStatsSample = (
  raw: DailyNetworkStats,
): NetworkStatsSample | null => {
  const stats = raw.stats;
  // The pre-first-sample shape is an empty object: no `latest` key. Detect it
  // structurally (not via the union tag, which TS can't narrow at runtime).
  if (!stats || !("latest" in stats) || !stats.latest) {
    return null;
  }
  const l = stats.latest;
  return {
    networkState: raw.networkState,
    videoSendKbps: toKbps(l.videoSendBitsPerSecond),
    videoRecvKbps: toKbps(l.videoRecvBitsPerSecond),
    sendPacketLoss: round3(l.totalSendPacketLoss),
    recvPacketLoss: round3(l.totalRecvPacketLoss),
    rttMs: toMs(l.networkRoundTripTime),
    availableOutgoingKbps: toKbps(l.availableOutgoingBitrate),
    worstSendPacketLoss: round3(stats.worstVideoSendPacketLoss),
    worstRecvPacketLoss: round3(stats.worstVideoRecvPacketLoss),
  };
};

/** Render a nullable number with a unit, or "—" when not measured. */
const num = (n: number | null, unit: string): string =>
  n == null ? "—" : `${n}${unit}`;

/** A loss FRACTION (0..1) → integer percent string, or "—". */
const pct = (n: number | null): string =>
  n == null ? "—" : `${Math.round(n * 100)}%`;

/**
 * PURE: one compact, structured line for the telemetry console sink. Stable
 * key=value ordering so the batched console.info lines grep cleanly later.
 */
export const formatStatsLine = (s: NetworkStatsSample): string =>
  [
    `state=${s.networkState}`,
    `vSend=${num(s.videoSendKbps, "kbps")}`,
    `vRecv=${num(s.videoRecvKbps, "kbps")}`,
    `sendLoss=${pct(s.sendPacketLoss)}`,
    `recvLoss=${pct(s.recvPacketLoss)}`,
    `rtt=${num(s.rttMs, "ms")}`,
    `availOut=${num(s.availableOutgoingKbps, "kbps")}`,
  ].join(" ");

/**
 * PURE: a short human-readable suffix for the quality-chip tooltip, e.g.
 * "rtt 180ms · loss 4% · 320kbps". Only includes metrics that were actually
 * measured (skips nulls) so a partial sample never shows "—" noise to the user.
 * Returns an empty string when nothing is measured yet (caller omits it).
 */
export const formatStatsTooltip = (s: NetworkStatsSample): string => {
  const parts: string[] = [];
  if (s.rttMs != null) {
    parts.push(`rtt ${s.rttMs}ms`);
  }
  // Surface the worse of send/recv loss — that's the one the user feels.
  const loss =
    s.sendPacketLoss != null || s.recvPacketLoss != null
      ? Math.max(s.sendPacketLoss ?? 0, s.recvPacketLoss ?? 0)
      : null;
  if (loss != null) {
    parts.push(`loss ${Math.round(loss * 100)}%`);
  }
  if (s.videoSendKbps != null) {
    parts.push(`${s.videoSendKbps}kbps`);
  }
  return parts.join(" · ");
};
