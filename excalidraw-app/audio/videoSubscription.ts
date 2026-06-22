// Manual subscription + pagination DECISION CORE (Phase 5 of the monitoring &
// resilience plan). PURE + side-effect-free so it is unit-testable in isolation
// (visible set + all sessions + threshold → a per-session video subscription
// map). All the SDK wiring (setSubscribeToTracksAutomatically /
// updateParticipants) and the visible-tile signalling live in DailyAudio; this
// module only decides WHAT each remote camera's subscription should be.
//
// Why: `subscribeToTracksAutomatically: true` makes a client decode EVERY remote
// camera. Daily's guidance is ~30 streams on a laptop, ~12 on mobile (~75
// kbps/stream downstream), so a large meeting overwhelms the device. Above the
// per-device threshold we page: only the tiles actually on screen (plus the
// active speaker) are SUBSCRIBED; the immediate neighbours are STAGED (kept warm
// so a page-flip is instant — staged tracks are negotiated but not decoded); the
// rest are UNSUBSCRIBED (no decode, no downstream bandwidth).
//
// Identity note: this module speaks Daily SESSION ids end to end — DailyAudio
// resolves our socket.id ↔ session_id at the boundary (the visible set arrives
// as socket.ids and is translated before it reaches here), so the result keys
// drop straight into updateParticipants({ [sessionId]: … }).

import type { DailyTrackSubscriptionState } from "@daily-co/daily-js";

/** The track-state values Daily reports for a participant's camera. 'off' and
 *  'blocked' mean nothing is being published (no track to subscribe); every
 *  other value means a track exists we COULD subscribe — including 'sendable'
 *  (the peer is publishing but, with automatic subscription off, we are not yet
 *  subscribed, so it never reaches 'playable'). */
export type RemoteCameraState =
  | "blocked"
  | "off"
  | "sendable"
  | "loading"
  | "interrupted"
  | "playable";

/** A remote participant as seen on the LIVE Daily roster (call.participants()),
 *  reduced to just the fields the subscription mapping needs. `local` excludes
 *  our own self-view; `socketId` is null until userData propagates. */
export type RosterCamera = {
  sessionId: string;
  /** Our socket.id for this participant, or null if not resolved yet. */
  socketId: string | null;
  local: boolean;
  /** Daily's tracks.video.state for this participant's camera. */
  videoState: RemoteCameraState;
};

/** True when this participant's camera is actually publishing a track we could
 *  subscribe to (i.e. NOT 'off'/'blocked'). 'sendable' counts: the peer is
 *  publishing even though we have not subscribed yet. */
export const isPublishingCamera = (state: RemoteCameraState): boolean =>
  state !== "off" && state !== "blocked";

/**
 * PURE roster → RemoteVideoParticipant[] reducer. Seeds the subscription
 * decision from the FULL live roster (every remote camera, subscribed or not)
 * rather than from only the tracks that already reached `playable`, so an
 * off-page camera that joined after automatic subscription was switched off is
 * still considered and can be subscribed the moment it scrolls into view.
 *
 * Drops the local self-view, any non-publishing camera ('off'/'blocked'), and
 * any participant whose socket.id is not resolved yet (a later reconcile
 * retries). `visibleSockets` and `activeSocket` are our socket.id space; a tile
 * is `subscribed` when visible OR the active speaker. Staging is left to the
 * caller (best-effort — none for now).
 */
export const remoteCamerasFromRoster = (
  roster: RosterCamera[],
  visibleSockets: ReadonlySet<string>,
  activeSessionId: string | null,
  activeSocket: string | null,
): RemoteVideoParticipant[] => {
  const out: RemoteVideoParticipant[] = [];
  for (const cam of roster) {
    if (cam.local || !isPublishingCamera(cam.videoState) || !cam.socketId) {
      continue;
    }
    out.push({
      sessionId: cam.sessionId,
      visible: visibleSockets.has(cam.socketId),
      isActiveSpeaker:
        cam.sessionId === activeSessionId || cam.socketId === activeSocket,
      staged: false,
    });
  }
  return out;
};

/** A remote camera participant the call currently knows about. `staged` marks a
 *  participant whose tile is NOT visible but is a near-neighbour we want kept
 *  warm (best-effort — the caller decides who is "near"). */
export type RemoteVideoParticipant = {
  /** Daily session_id — the key updateParticipants() expects. */
  sessionId: string;
  /** This participant's tile is currently rendered on screen. */
  visible: boolean;
  /** This participant is the active speaker (always subscribed, even off-page). */
  isActiveSpeaker: boolean;
  /** Keep this one warm (negotiated but not decoded) though it's off-screen. */
  staged: boolean;
};

/** The three subscription tiers, as a language-neutral CODE (never a localized
 *  string). Mapped to Daily's `video` subscription value by toDailyVideoSub. */
export type SubscriptionTier = "subscribed" | "staged" | "unsubscribed";

/** Map our tier CODE to Daily's `video` subscription literal:
 *  subscribed → true (decode + render), staged → 'staged' (negotiate, don't
 *  decode), unsubscribed → false (drop entirely). */
export const toDailyVideoSub = (
  tier: SubscriptionTier,
): DailyTrackSubscriptionState =>
  tier === "subscribed" ? true : tier === "staged" ? "staged" : false;

/**
 * Decide whether manual subscription should be ACTIVE at all. We only page when
 * the count of remote camera videos strictly EXCEEDS the device threshold; at or
 * below it we keep Daily's automatic subscription (simpler, no churn). A
 * threshold ≤ 0 disables paging entirely (treated as "always automatic").
 */
export const shouldPaginate = (
  remoteVideoCount: number,
  threshold: number,
): boolean => threshold > 0 && remoteVideoCount > threshold;

/**
 * PURE subscription decision. Given every remote camera participant and the
 * per-device threshold, return a map session_id → SubscriptionTier:
 *   - when NOT paginating (count ≤ threshold) → empty map (caller leaves Daily
 *     on automatic subscription; nothing to override);
 *   - when paginating → every remote camera gets an explicit tier:
 *       visible OR active-speaker → "subscribed"
 *       staged (near-neighbour)   → "staged"
 *       everything else           → "unsubscribed".
 *
 * The active speaker is ALWAYS subscribed even when its tile is off the current
 * page, so the speaker ring + audio-follow never points at a black tile.
 */
export const computeSubscriptions = (
  participants: RemoteVideoParticipant[],
  threshold: number,
): Map<string, SubscriptionTier> => {
  const out = new Map<string, SubscriptionTier>();
  if (!shouldPaginate(participants.length, threshold)) {
    return out; // small meeting — automatic subscription, no overrides
  }
  for (const p of participants) {
    const tier: SubscriptionTier =
      p.visible || p.isActiveSpeaker
        ? "subscribed"
        : p.staged
        ? "staged"
        : "unsubscribed";
    out.set(p.sessionId, tier);
  }
  return out;
};

/** Convenience: how many of a subscription map are actually being decoded
 *  (subscribed). Used only by DailyAudio's pagination LOG line so "showing N of
 *  M" is never mistaken for "showing everyone". */
export const countSubscribed = (
  subs: Map<string, SubscriptionTier>,
): number => {
  let n = 0;
  for (const tier of subs.values()) {
    if (tier === "subscribed") {
      n++;
    }
  }
  return n;
};
