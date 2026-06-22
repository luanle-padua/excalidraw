// Per-device video-quality preference + the org-wide admin cap, plus the single
// clamp() that combines them. Three layers per the PM's spec:
//   1. Daily adaptive bitrate (ABR) — always on (DailyAudio sends
//      "quality-optimized" simulcast); it scales DOWN on a weak uplink.
//   2. The USER's own ceiling — this localStorage pref (auto/low/medium/high).
//   3. The ADMIN cap — the highest level anyone may pick, read from the Worker
//      (system_settings.video_quality_cap via GET /v1/config).
// Effective level = clampQuality(userPref, adminCap); ABR then floats below it.
//
// This module is the ONE source of truth for the level→Daily-settings mapping
// and the clamp, imported by both DailyAudio (apply) and UserSettings (UI).
// Modelled 1:1 on videoBg.ts.

import { atom } from "../app-jotai";

/** The admin cap + the "high" user choice share these three ranked tiers. */
export type QualityCap = "low" | "medium" | "high";
/** The user can additionally pick "auto" = ride the admin cap and let ABR adapt. */
export type QualityLevel = "auto" | QualityCap;

const USER_KEY = "mcm:videoQuality";

/** Rank for clamping — higher = better. `auto` is resolved to the cap before
 *  ranking, so it isn't in this map. */
const RANK: Record<QualityCap, number> = { low: 0, medium: 1, high: 2 };
const BY_RANK: QualityCap[] = ["low", "medium", "high"];

/** Daily settings for each concrete tier. `sendSetting` is a Daily
 *  `updateSendSettings({video})` preset; `width/height/frameRate` feed
 *  `updateInputSettings({video:{settings}})` camera constraints. Low/Medium drop
 *  capture resolution too so they cut CPU + egress, not just encode bitrate. */
export const QUALITY_TIERS: Record<
  QualityCap,
  {
    width: number;
    height: number;
    frameRate: number;
    sendSetting: "quality-optimized" | "balanced" | "bandwidth-optimized";
  }
> = {
  high: { width: 1280, height: 720, frameRate: 30, sendSetting: "quality-optimized" },
  medium: { width: 960, height: 540, frameRate: 25, sendSetting: "balanced" },
  low: { width: 640, height: 360, frameRate: 20, sendSetting: "bandwidth-optimized" },
};

const isCap = (v: unknown): v is QualityCap =>
  v === "low" || v === "medium" || v === "high";
const isLevel = (v: unknown): v is QualityLevel => v === "auto" || isCap(v);

const loadUserPref = (): QualityLevel => {
  if (typeof window === "undefined") {
    return "auto";
  }
  try {
    const v = window.localStorage.getItem(USER_KEY);
    return isLevel(v) ? v : "auto";
  } catch {
    return "auto";
  }
};

/** The user's chosen ceiling (auto by default). */
export const videoQualityAtom = atom<QualityLevel>(loadUserPref());

/** The org-wide cap, filled from GET /v1/config at login (see session.ts).
 *  Defaults to "high" so nothing is throttled until an admin lowers it. */
export const videoQualityCapAtom = atom<QualityCap>("high");

export const getVideoQuality = (): QualityLevel => loadUserPref();

export const setVideoQualityPref = (level: QualityLevel): void => {
  try {
    window.localStorage.setItem(USER_KEY, level);
  } catch {
    // best-effort
  }
};

/** Combine the user's choice with the admin cap into the concrete tier to apply.
 *  "auto" means "ride the cap" (then ABR adapts below it); any explicit choice is
 *  clamped so it can never exceed the cap. */
export const clampQuality = (
  userPref: QualityLevel,
  cap: QualityCap,
): QualityCap => {
  if (userPref === "auto") {
    return cap;
  }
  return RANK[userPref] <= RANK[cap] ? userPref : cap;
};

/** Tiers the user is allowed to choose given the cap (for greying out the UI). */
export const allowedTiers = (cap: QualityCap): QualityCap[] =>
  BY_RANK.filter((t) => RANK[t] <= RANK[cap]);

// ---- Phase 5 — scale subscription thresholds ----------------------------
//
// Centralised here, next to QUALITY_TIERS, so an admin can tune the "big
// meeting" thresholds in ONE place (rather than hardcoding magic numbers across
// DailyAudio / the gallery). Daily's guidance: a laptop decodes ~30 simulcast
// streams comfortably, mobile ~12 (~75 kbps/stream downstream). We sit BELOW
// those ceilings so the device never thrashes before pagination kicks in.

/** Above this many REMOTE camera videos we stop auto-subscribing to every track
 *  and switch to manual subscription + pagination (subscribe only the visible
 *  tiles + active speaker). Desktop is the generous default; a mobile/tablet
 *  caps far lower because it decodes + composites far fewer streams. The mobile
 *  value is selected by maxVideoSubscribeFor(isMobile) at call time. */
export const MAX_VIDEO_SUBSCRIBE_DESKTOP = 20;
export const MAX_VIDEO_SUBSCRIBE_MOBILE = 9;

/** Pick the manual-subscription threshold for the running device. Mobile/tablet
 *  web decodes far fewer streams, so it paginates much sooner. */
export const maxVideoSubscribeFor = (isMobile: boolean): number =>
  isMobile ? MAX_VIDEO_SUBSCRIBE_MOBILE : MAX_VIDEO_SUBSCRIBE_DESKTOP;

/** At or below this many remote camera tiles the grid is "small": every
 *  non-speaker stays on the MIDDLE simulcast layer (base 1) so idle tiles look
 *  sharp. Strictly ABOVE it the grid is "large": non-speakers drop to the LOWEST
 *  layer (base 0) per Daily's large-grid guidance — the active speaker is still
 *  promoted to the top layer regardless. */
export const RECEIVE_BASE_LAYER_CUTOFF = 9;

/** Adaptive receive BASE layer for non-speaker tiles, given the remote camera
 *  tile count. Small grid (≤ cutoff) → layer 1 (legibly sharp idle tiles); large
 *  grid (> cutoff) → layer 0 (cheapest, the default Daily recommends for big
 *  grids). PURE so it can be unit tested in isolation. */
export const receiveBaseForTileCount = (tileCount: number): 0 | 1 =>
  tileCount > RECEIVE_BASE_LAYER_CUTOFF ? 0 : 1;
