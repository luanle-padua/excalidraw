// Jotai atoms exposing live CAMERA video to the UI. Video rides the SAME
// Daily call object as the audio (DailyAudio) — it is NOT a separate room — so
// these atoms are driven by AudioRoomController off the DailyAudio video events
// and consumed by ParticipantsBar, which renders a <video> into a person's
// existing tile when their socket.id has an active stream (otherwise the tile
// keeps showing the MCMAvatar).
//
// Keyed by socket.id (the same identity bridge as audio peers), so a video
// track maps to exactly the right participant tile. Includes the LOCAL
// self-view (under our own socket.id) so "me" sees their mirrored camera.

import { atom } from "../app-jotai";

/** socket.id → the participant's live camera MediaStream. Present only while a
 *  camera is actually publishing; absent ⇒ that tile falls back to the avatar. */
export const videoTilesAtom = atom<Map<string, MediaStream>>(new Map());

/** Whether the full-screen participant GALLERY view (grid of everyone's camera,
 *  like Zoom/Meet) is open. Toggled from the participant strip; the gallery
 *  reuses the same per-person tiles ParticipantsBar already builds. */
export const galleryOpenAtom = atom<boolean>(false);

export type CameraStatus = "off" | "on" | "starting" | "error";

/** WHY the camera is in an error state, as a language-neutral CODE — the UI maps
 *  it to an i18n message at render time (never bake a localized string into
 *  state: a Korean/English guest must not read a Vietnamese camera error).
 *  Mirrors AudioErrorKind in audioState.ts.
 *
 *  Derived from Daily's structured `camera-error` payload (error.type) via the
 *  PURE cameraErrorKindFor() below, OR from a raw getUserMedia DOMException name
 *  on the camera-toggle path (NotAllowedError → "permissions", etc.).
 *
 *  - `permissions`: the user/browser blocked camera (or mic) access — the UI
 *    offers an "allow camera" prompt + guidance.
 *  - `in-use`: the camera (or mic) is held by another app (Teams/Zoom/OBS…).
 *  - `not-found`: no camera device is present.
 *  - `constraints`: the requested capture constraints can't be satisfied.
 *  - `other`: any other / unknown camera error — surfaced generically so
 *    nothing is swallowed silently. */
export type CameraErrorKind =
  | "permissions"
  | "in-use"
  | "not-found"
  | "constraints"
  | "other";

export type CameraState = {
  status: CameraStatus;
  /** error code from the last failed camera start — see CameraErrorKind. Null
   *  unless status is "error". */
  errorKind: CameraErrorKind | null;
  /** raw (dev-facing) error detail for the tooltip; UI shows an i18n string. */
  errorMessage: string | null;
};

export const cameraStateAtom = atom<CameraState>({
  status: "off",
  errorKind: null,
  errorMessage: null,
});

/** PURE map: a Daily `camera-error` payload `error.type` → our CameraErrorKind.
 *  Centralised + pure so the mapping is unit-tested in isolation (payload →
 *  code) without standing up a DailyCall. Unknown / future types collapse to
 *  "other" so nothing is swallowed silently.
 *
 *  Daily's `cam-in-use` / `mic-in-use` / `cam-mic-in-use` all collapse to our
 *  single "in-use" code; `undefined-mediadevices` and `unknown` fall to "other"
 *  (no dedicated UX). */
export const cameraErrorKindFor = (
  type: string | undefined,
): CameraErrorKind => {
  switch (type) {
    case "permissions":
      return "permissions";
    case "cam-in-use":
    case "mic-in-use":
    case "cam-mic-in-use":
      return "in-use";
    case "not-found":
      return "not-found";
    case "constraints":
      return "constraints";
    default:
      // "undefined-mediadevices", "unknown", and any future type.
      return "other";
  }
};

/** The shape we read off a Daily `camera-error` payload to decide whether the
 *  failure actually implicates the local CAMERA (video) — distinct from a
 *  mic-only acquisition failure that rides the same event. We only depend on the
 *  fields Daily documents for disambiguation (the top-level videoOk flag and the
 *  per-type media arrays), kept narrow so the mapping stays pure + testable
 *  without the full daily-js union. */
export type CameraErrorVideoSignal = {
  /** error.type — 'cam-in-use' / 'mic-in-use' / 'permissions' / … */
  type: string | undefined;
  /** errorMsg.videoOk — Daily's explicit "video stream is still fine" flag. */
  videoOk?: boolean;
  /** error.blockedMedia (permissions) / missingMedia (not-found) /
   *  failedMedia (constraints): which media the failure actually concerns. */
  affectedMedia?: Array<"video" | "audio"> | undefined;
};

/** PURE predicate: does this Daily `camera-error` actually implicate the local
 *  CAMERA (video), or is it a mic-only failure that merely arrives on the same
 *  event? In this codebase mic and camera are acquired on SEPARATE paths, so a
 *  `mic-in-use` / mic-permission failure must NOT tear down a working self-view.
 *
 *  We treat the failure as NOT affecting video when Daily gives us a positive
 *  signal that video is unaffected:
 *   - `videoOk === true` (Daily says the video stream is still good), OR
 *   - the per-type media array is present AND does not list "video"
 *     (e.g. permissions blockedMedia=["audio"], not-found missingMedia=["audio"]).
 *  Otherwise we assume video IS affected (cam-in-use, cam-mic-in-use,
 *  videoOk===false, or an ambiguous/unknown payload) so we never leave a stale
 *  self-view promising a camera that Daily actually dropped. */
export const cameraErrorAffectsVideo = (
  signal: CameraErrorVideoSignal,
): boolean => {
  // A pure mic-in-use error has nothing to do with the camera.
  if (signal.type === "mic-in-use") {
    return false;
  }
  // Daily's explicit flag wins: if it says video is OK, video is unaffected.
  if (signal.videoOk === true) {
    return false;
  }
  // A typed media array (blockedMedia/missingMedia/failedMedia) that exists but
  // does not list "video" means only audio failed.
  if (
    signal.affectedMedia !== undefined &&
    !signal.affectedMedia.includes("video")
  ) {
    return false;
  }
  // Otherwise assume the camera is implicated (fail safe toward syncing state).
  return true;
};

/** PURE map: a raw getUserMedia DOMException `name` → our CameraErrorKind. The
 *  camera TOGGLE path acquires the camera itself (navigator.mediaDevices.
 *  getUserMedia) and surfaces a plain DOMException — not Daily's structured
 *  `camera-error` — so the controller maps that name with the same vocabulary.
 *  Keeps both error sources (event + exception) speaking one code set. */
export const cameraErrorKindForDomException = (
  name: string | undefined,
): CameraErrorKind => {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permissions";
    case "NotReadableError":
    case "TrackStartError":
      return "in-use";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "not-found";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "constraints";
    default:
      return "other";
  }
};
