// Jotai atoms for the Daily.co screen-share subsystem. Mirrors audio/audioState.ts:
//   - a STATE atom the UI subscribes to (the live media: remote stream, status)
//   - an INSTANCE atom holding the imperative manager so handlers (the Present
//     button) can drive start/stop without prop-drilling.
//
// NOTE: the PRESENCE/lock signal (who is sharing, over the socket) lives in
// collab/Collab.tsx as `screenShareStateAtom`. THIS file holds the local MEDIA
// state (the actual Daily stream) — the two are intentionally separate: presence
// drives badges + the lock, media drives the viewer pane.
//
// LANGUAGE-NEUTRAL by construction (Phase 6 parity with the audio stack): the
// state carries CODES (enums), never localized strings — MeetingShell maps the
// code to an i18n string at render time. The legacy `errorMessage` is kept as
// DEV-FACING raw detail only (console / tooltip), never shown localized.

import { atom } from "../app-jotai";

import type { DailyScreenShare } from "./DailyScreenShare";
import type {
  DailyEventObjectFatalError,
  DailyEventObjectNetworkConnectionEvent,
} from "@daily-co/daily-js";

export type ScreenShareStatus =
  | "idle"
  | "connecting"
  | "sharing"
  | "viewing"
  | "error";

/** WHY the screen-share call last failed, as a language-neutral CODE — the UI
 *  maps it to an i18n message at render time (never bake a localized string into
 *  state; mirrors AudioErrorKind / fatalErrorKindFor in audio/audioState.ts).
 *
 *  - `token`: the Worker returned no Daily token (room/auth problem).
 *  - `meeting-full`: Daily rejected the join — the room hit `max_participants`.
 *  - `token-expired`: the room/token expired (`exp-*` / `nbf-*`) — refresh.
 *  - `share`: the local screen-share itself failed (getDisplayMedia / a Daily
 *    `screen-share-error` nonfatal — e.g. the picker errored or the source
 *    stopped). The call stays up; only the share dropped.
 *  - `call`: any other call-level / unclassified fatal failure. */
export type ScreenShareErrorKind =
  | "token"
  | "meeting-full"
  | "token-expired"
  | "share"
  | "call";

/** Connectivity lifecycle of the screen-share call object, derived from Daily's
 *  `network-connection`. Mirrors ConnectionLifecycle in audio/connectionState.ts
 *  but lives here so the two call objects stay decoupled:
 *   - `connected`: healthy — no notice.
 *   - `reconnecting`: the SFU media path was interrupted; the shared screen
 *     pauses and Daily auto-reconnects (soft notice to the presenter).
 *   - `unstable`: the SIGNALING path was interrupted — Daily ejects after ~20s
 *     if it doesn't recover, so the share may drop (hard notice). */
export type ScreenShareLink = "connected" | "reconnecting" | "unstable";

export type ScreenShareMedia = {
  /** overall manager status (drives connecting spinners / error notices) */
  status: ScreenShareStatus;
  /** the remote presenter's screen stream to render, when watching someone */
  remoteStream: MediaStream | null;
  /** display name of the remote presenter (for the viewer header) */
  remoteSharerName: string | null;
  /** true while WE are the one presenting (drives the Present button state) */
  localActive: boolean;
  /** language-neutral error code from the last failure — see ScreenShareErrorKind.
   *  Null when there's no error. The UI maps this to an i18n message. */
  errorKind: ScreenShareErrorKind | null;
  /** raw (dev-facing) error detail for the tooltip / console — never shown
   *  localized to the user. */
  errorMessage: string | null;
  /** connectivity lifecycle of the screen-share call (Daily network-connection).
   *  Surfaced to the presenter so a dropped/recovering screen-share call is
   *  visible rather than silently freezing. */
  link: ScreenShareLink;
};

export const SCREEN_SHARE_IDLE: ScreenShareMedia = {
  status: "idle",
  remoteStream: null,
  remoteSharerName: null,
  localActive: false,
  errorKind: null,
  errorMessage: null,
  link: "connected",
};

export const screenShareMediaAtom = atom<ScreenShareMedia>(SCREEN_SHARE_IDLE);

export const screenShareInstanceAtom = atom<DailyScreenShare | null>(null);

/**
 * PURE map: a Daily FATAL `error.type` → our ScreenShareErrorKind. Centralised +
 * pure so it can be unit-tested in isolation (payload → code). Mirrors
 * fatalErrorKindFor in audio/audioState.ts: only the types that warrant a
 * DISTINCT user message are classified; everything else (ejected / not-allowed /
 * connection-error / end-of-life / no-room / undefined) collapses to the generic
 * "call" code so nothing is swallowed silently.
 *
 * The room/token-expiry family — `exp-token`, `exp-room`, and the not-before
 * pair `nbf-token` / `nbf-room` — all map to "token-expired" (identical fix:
 * refresh / rejoin).
 */
export const screenShareFatalKindFor = (
  type: string | undefined,
): ScreenShareErrorKind => {
  switch (type) {
    case "meeting-full":
      return "meeting-full";
    case "exp-token":
    case "exp-room":
    case "nbf-token":
    case "nbf-room":
      return "token-expired";
    default:
      return "call";
  }
};

/**
 * PURE map: a Daily `network-connection` payload → our ScreenShareLink (and the
 * raw reason, the degraded path). Extracted + pure so the mapping is unit-tested
 * without standing up a DailyCall. Mirrors lifecycleFromConnectionEvent in
 * audio/connectionState.ts (kept local to keep the two call objects decoupled).
 *
 *   - `connected` (any path)             ⇒ `connected` (path recovered).
 *   - `interrupted` on `signaling`       ⇒ `unstable` (hard — Daily ejects ~20s).
 *   - `interrupted` on `sfu`/`peer-to-peer` ⇒ `reconnecting` (media pauses, auto-
 *     reconnects).
 *   - any other event value              ⇒ null (no change — keep current).
 */
export const screenShareLinkFor = (
  e: Pick<DailyEventObjectNetworkConnectionEvent, "type" | "event">,
): ScreenShareLink | null => {
  if (e.event === "connected") {
    return "connected";
  }
  if (e.event === "interrupted") {
    return e.type === "signaling" ? "unstable" : "reconnecting";
  }
  return null;
};

/** Narrow alias so the manager's fatal handler can read `error.type` defensively
 *  (daily-js collapses non-connection fatal error types to `any`). */
export type ScreenShareFatalErrorObject = Pick<
  DailyEventObjectFatalError,
  "errorMsg"
> & { error?: { type?: string } };
