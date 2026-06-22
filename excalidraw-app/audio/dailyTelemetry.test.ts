// Unit tests for the PURE Daily getNetworkStats() → sample/formatting helpers
// (dailyTelemetry.ts). These are the single boundary that narrows Daily's raw
// stats payload and renders it for the telemetry console sink + the quality-chip
// tooltip, so a regression here silently corrupts every observability line and
// the user-facing stats tooltip.
//
//   npx vitest run excalidraw-app/audio/dailyTelemetry.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import {
  extractStatsSample,
  formatStatsLine,
  formatStatsTooltip,
  type NetworkStatsSample,
} from "./dailyTelemetry";

import type { DailyNetworkStats } from "@daily-co/daily-js";

/** Build a full Daily getNetworkStats() payload with a `latest` block; only the
 *  fields the extractor reads need realistic values, the rest are filler. */
const rawWithLatest = (
  latest: Partial<DailyNetworkStats["stats"] extends infer S
    ? S extends { latest: infer L }
      ? L
      : never
    : never>,
  worst: { send?: number; recv?: number } = {},
  networkState: DailyNetworkStats["networkState"] = "good",
): DailyNetworkStats =>
  ({
    networkState,
    networkStateReasons: [],
    threshold: "good",
    quality: 100,
    stats: {
      latest: {
        timestamp: 0,
        recvBitsPerSecond: null,
        sendBitsPerSecond: null,
        availableOutgoingBitrate: null,
        networkRoundTripTime: null,
        videoRecvBitsPerSecond: null,
        videoSendBitsPerSecond: null,
        audioRecvBitsPerSecond: null,
        audioSendBitsPerSecond: null,
        videoRecvPacketLoss: null,
        videoSendPacketLoss: null,
        audioRecvPacketLoss: null,
        audioSendPacketLoss: null,
        totalSendPacketLoss: null,
        totalRecvPacketLoss: null,
        videoRecvJitter: null,
        videoSendJitter: null,
        audioRecvJitter: null,
        audioSendJitter: null,
        ...latest,
      },
      worstVideoRecvPacketLoss: worst.recv ?? 0,
      worstVideoSendPacketLoss: worst.send ?? 0,
      worstAudioRecvPacketLoss: 0,
      worstAudioSendPacketLoss: 0,
      worstVideoRecvJitter: 0,
      worstVideoSendJitter: 0,
      worstAudioRecvJitter: 0,
      worstAudioSendJitter: 0,
      averageNetworkRoundTripTime: 0,
    },
  } as DailyNetworkStats);

describe("extractStatsSample", () => {
  it("returns null before Daily has a sample (empty `stats` object, no `latest`)", () => {
    const raw = {
      networkState: "unknown",
      networkStateReasons: [],
      threshold: "good",
      quality: 0,
      stats: {},
    } as unknown as DailyNetworkStats;
    expect(extractStatsSample(raw)).toBeNull();
  });

  it("narrows + converts units: bps→kbps, seconds→ms, loss kept as a fraction", () => {
    const raw = rawWithLatest(
      {
        videoSendBitsPerSecond: 320_400, // → 320 kbps
        videoRecvBitsPerSecond: 512_000, // → 512 kbps
        totalSendPacketLoss: 0.0123, // → 0.012 (rounded to 3 dp)
        totalRecvPacketLoss: 0.05,
        networkRoundTripTime: 0.18, // 180 ms
        availableOutgoingBitrate: 1_000_000, // → 1000 kbps
      },
      { send: 0.2, recv: 0.3 },
      "warning",
    );
    expect(extractStatsSample(raw)).toEqual<NetworkStatsSample>({
      networkState: "warning",
      videoSendKbps: 320,
      videoRecvKbps: 512,
      sendPacketLoss: 0.012,
      recvPacketLoss: 0.05,
      rttMs: 180,
      availableOutgoingKbps: 1000,
      worstSendPacketLoss: 0.2,
      worstRecvPacketLoss: 0.3,
    });
  });

  it("passes nulls through for metrics Daily hasn't measured yet", () => {
    const raw = rawWithLatest({ videoSendBitsPerSecond: null });
    const sample = extractStatsSample(raw);
    expect(sample?.videoSendKbps).toBeNull();
    expect(sample?.rttMs).toBeNull();
    expect(sample?.availableOutgoingKbps).toBeNull();
  });
});

describe("formatStatsLine", () => {
  it("renders a stable key=value line with units, '—' for nulls, and loss as %", () => {
    const sample: NetworkStatsSample = {
      networkState: "good",
      videoSendKbps: 320,
      videoRecvKbps: null,
      sendPacketLoss: 0.04,
      recvPacketLoss: null,
      rttMs: 180,
      availableOutgoingKbps: 1000,
      worstSendPacketLoss: 0.1,
      worstRecvPacketLoss: 0.1,
    };
    expect(formatStatsLine(sample)).toBe(
      "state=good vSend=320kbps vRecv=— sendLoss=4% recvLoss=— rtt=180ms availOut=1000kbps",
    );
  });
});

describe("formatStatsTooltip", () => {
  it("includes only measured metrics, surfaces the WORSE of send/recv loss", () => {
    const sample: NetworkStatsSample = {
      networkState: "warning",
      videoSendKbps: 320,
      videoRecvKbps: 512,
      sendPacketLoss: 0.02,
      recvPacketLoss: 0.06, // worse → 6%
      rttMs: 180,
      availableOutgoingKbps: 1000,
      worstSendPacketLoss: 0.1,
      worstRecvPacketLoss: 0.1,
    };
    expect(formatStatsTooltip(sample)).toBe("rtt 180ms · loss 6% · 320kbps");
  });

  it("returns an empty string when nothing is measured yet (caller omits it)", () => {
    const sample: NetworkStatsSample = {
      networkState: "unknown",
      videoSendKbps: null,
      videoRecvKbps: null,
      sendPacketLoss: null,
      recvPacketLoss: null,
      rttMs: null,
      availableOutgoingKbps: null,
      worstSendPacketLoss: null,
      worstRecvPacketLoss: null,
    };
    expect(formatStatsTooltip(sample)).toBe("");
  });
});
