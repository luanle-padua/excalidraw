// Jotai state for Daily NETWORK RESILIENCE (Phase 1 of the monitoring &
// resilience plan). Sits alongside videoState.ts / videoPerf.ts but is
// concerned only with *the health of the call's network path* — driven by
// Daily's "network-connection" and "network-quality-change" events in
// DailyAudio and pushed here by AudioRoomController.
//
// Two orthogonal signals live in one atom:
//   - `lifecycle`: a CONNECTIVITY state machine (connected / reconnecting /
//     unstable) derived from `network-connection`. It is what drives the
//     reconnecting/unstable BANNER.
//   - `quality`: a continuous link-quality grade (good / low / bad) derived
//     from `network-quality-change`. It drives the small quality CHIP.
//
// Language-neutral by construction: every field is a CODE (enum), never a
// localized string — ConnectionBanner maps the code to an i18n string at render
// time, exactly like AudioErrorKind / NonfatalKind. `reasons` carries Daily's
// raw machine reason codes (e.g. "sendPacketLoss"); the UI maps each to an i18n
// label for the chip tooltip, falling back to the raw code if it's unknown.

import { atom } from "../app-jotai";

import type {
  DailyEventObjectNetworkConnectionEvent,
  DailyEventObjectNetworkQualityEvent,
} from "@daily-co/daily-js";

/** Connectivity state machine, derived from Daily's `network-connection`:
 *  - `connected`: healthy — no banner.
 *  - `reconnecting`: the SFU media path was interrupted; media pauses and Daily
 *    auto-reconnects (amber banner, "reconnecting…").
 *  - `unstable`: the SIGNALING path was interrupted — Daily ejects after ~20s if
 *    it doesn't recover, so this is a hard warning (red banner). */
export type ConnectionLifecycle = "connected" | "reconnecting" | "unstable";

/** Link-quality grade for the header chip, derived from Daily's
 *  `network-quality-change`. Our 3-level vocabulary; Daily's 0.90 SDK reports a
 *  4th `warning` (mapped → `low`) and `unknown` (mapped → `good`, neutral). */
export type ConnectionQuality = "good" | "low" | "bad";

export type ConnectionState = {
  lifecycle: ConnectionLifecycle;
  quality: ConnectionQuality;
  /** Daily's raw reason CODES for the current quality (e.g. "sendPacketLoss",
   *  "recvPacketLoss", "roundTripTime", "availableOutgoingBitrate"). The chip
   *  tooltip maps each to an i18n label; unknown codes fall back to raw. */
  reasons: string[];
  /** Phase 4 — a short, ALREADY-FORMATTED real-numbers suffix for the chip
   *  tooltip (e.g. "rtt 180ms · loss 4% · 320kbps"), built from the latest
   *  getNetworkStats() sample by dailyTelemetry.formatStatsTooltip. This is the
   *  one field that is NOT a code: it's pure numerics + units (language-neutral
   *  by nature), so it is safe to render verbatim. Empty until the first sample
   *  lands; reset on teardown. */
  statsTooltip: string;
};

/** The healthy resting state. AudioRoomController resets the atom to exactly
 *  this in its idle teardown block (call torn down ⇒ no banner, green chip). */
export const CONNECTION_STATE_DEFAULT: ConnectionState = {
  lifecycle: "connected",
  quality: "good",
  reasons: [],
  statsTooltip: "",
};

export const connectionStateAtom = atom<ConnectionState>(
  CONNECTION_STATE_DEFAULT,
);

/**
 * PURE map: a Daily `network-connection` payload → our ConnectionLifecycle (and
 * the relevant raw reasons). Extracted + pure so the mapping is unit-tested in
 * isolation (payload → state) without standing up a DailyCall.
 *
 * Rules (per the Daily 0.90 contract, verified against docs):
 *   - `connected` (any path) ⇒ `connected` — the path recovered, clear warnings.
 *   - `interrupted` on `signaling` ⇒ `unstable` — Daily ejects after ~20s if it
 *     doesn't recover, so this is the HARD warning.
 *   - `interrupted` on `sfu` (or `peer-to-peer`) ⇒ `reconnecting` — media pauses
 *     and auto-reconnects; softer "reconnecting…" state.
 *   - any other `event` value ⇒ null (no state change — caller keeps current).
 *
 * `reasons` echoes the connection `type` so the banner tooltip can hint WHICH
 * path is degraded (signaling vs media); it is never a localized string.
 */
export const lifecycleFromConnectionEvent = (
  e: Pick<DailyEventObjectNetworkConnectionEvent, "type" | "event">,
): { lifecycle: ConnectionLifecycle; reasons: string[] } | null => {
  if (e.event === "connected") {
    return { lifecycle: "connected", reasons: [] };
  }
  if (e.event === "interrupted") {
    if (e.type === "signaling") {
      return { lifecycle: "unstable", reasons: [e.type] };
    }
    // "sfu" (media) and "peer-to-peer" both pause + auto-reconnect.
    return { lifecycle: "reconnecting", reasons: [e.type] };
  }
  // Unknown / intermediate events ('connecting', 'failed' future values…):
  // don't churn the banner — let the caller keep the current lifecycle.
  return null;
};

/**
 * PURE map: a Daily `network-quality-change` payload → our ConnectionQuality.
 *
 * IMPORTANT: in daily-js 0.90 `networkState` is one of
 * `'good' | 'warning' | 'bad' | 'unknown'` (NOT the `'good'|'low'|'bad'` the
 * plan text assumed). We collapse it onto our 3-level chip vocabulary:
 *   - `good`    ⇒ `good`
 *   - `warning` ⇒ `low`   (degraded but usable)
 *   - `bad`     ⇒ `bad`
 *   - `unknown` ⇒ `good`  (no signal yet ⇒ don't raise a false alarm)
 *
 * We deliberately read `networkState` / `networkStateReasons` and NOT the
 * deprecated `threshold` / `quality` fields (removed from our UI in v0.77).
 */
export const qualityFromNetworkEvent = (
  e: Pick<
    DailyEventObjectNetworkQualityEvent,
    "networkState" | "networkStateReasons"
  >,
): { quality: ConnectionQuality; reasons: string[] } => {
  const quality: ConnectionQuality =
    e.networkState === "bad"
      ? "bad"
      : e.networkState === "warning"
      ? "low"
      : "good"; // "good" and "unknown" both ⇒ good (neutral)
  return { quality, reasons: [...(e.networkStateReasons ?? [])] };
};
