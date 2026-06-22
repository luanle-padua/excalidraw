// Jotai atoms exposing the live AudioRoom state to the UI. Decoupled
// from the AudioRoom class so React components can subscribe without
// pulling the imperative API in directly.

import { atom } from "../app-jotai";

import type { PeerState } from "./audioTypes";
import type { DailyAudio } from "./DailyAudio";
import type { MeetingRecorder, RecordingResult } from "./MeetingRecorder";

export type AudioStatus = "idle" | "connecting" | "live" | "error";

/** WHY the last start() failed, as a code — the UI maps it to an i18n
 *  message at render time (never bake a localized string into state:
 *  a Korean/English guest must not read a Vietnamese mic error).
 *
 *  - `mic-denied` / `mic-busy` / `mic`: local getUserMedia failures (DOMException
 *    name classified in AudioRoomController).
 *  - `call`: a generic call-level failure (token/join, unclassified fatal).
 *  - `meeting-full`: Daily rejected the join because the room hit
 *    `max_participants` — the UI tells the user the meeting is full.
 *  - `token-expired`: the room/token expired (`exp-token`/`exp-room`/`nbf-*`) —
 *    the UI asks the user to refresh / rejoin.
 *
 *  The last two are derived from Daily's structured fatal `error.type` via the
 *  PURE fatalErrorKindFor() below (Phase 2). */
export type AudioErrorKind =
  | "mic-denied"
  | "mic-busy"
  | "mic"
  | "call"
  | "meeting-full"
  | "token-expired";

/** PURE map: a Daily FATAL `error.type` → our AudioErrorKind. Centralised + pure
 *  so it can be unit-tested in isolation (payload → code). Only the two types
 *  that warrant a DISTINCT user message are classified here; everything else
 *  (ejected / not-allowed / connection-error / end-of-life / no-room / undefined)
 *  collapses to the generic "call" code so nothing is swallowed silently.
 *
 *  Daily's room/token-expiry family — `exp-token`, `exp-room`, and the
 *  not-before pair `nbf-token`/`nbf-room` — all map to "token-expired" (the user
 *  fix is identical: refresh / rejoin). */
export const fatalErrorKindFor = (type: string | undefined): AudioErrorKind => {
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

export type AudioState = {
  status: AudioStatus;
  /** the user's own mic is muted (still in call, just not transmitting) */
  muted: boolean;
  /** false when the device has no mic and the user joined as a
   *  listener-only. The UI hides the mute toggle in that case. */
  canTransmit: boolean;
  /** keyed by socket.id (excluding the local user) */
  peers: Map<string, PeerState>;
  /** error code from the last failed start() attempt — see AudioErrorKind */
  errorKind: AudioErrorKind | null;
  /** raw (dev-facing) error detail for the tooltip / console */
  errorMessage: string | null;
};

export const audioStateAtom = atom<AudioState>({
  status: "idle",
  muted: false,
  canTransmit: true,
  peers: new Map(),
  errorKind: null,
  errorMessage: null,
});

/** the voice-call instance (DailyAudio — Daily.co SFU) — stored in an atom
 *  so commands ("toggle mute", "join audio") can be issued from anywhere
 *  without prop drilling. Set to null when no room is active. Drop-in for
 *  the old mesh AudioRoom (same method surface). */
export const audioRoomInstanceAtom = atom<DailyAudio | null>(null);

// ---------------- Pre-join "green room" (Item 6) ----------------
// A "hair-check" gate shown BETWEEN entering the canvas (activeRoomLink set,
// audio still idle) and joining the call. The user previews their camera and
// picks mic/camera intent before the call starts. It gates CALL entry only —
// the WaitingForStart / WaitingRoom gates own ROOM entry (sequential, never
// simultaneous). All three atoms are reset by AudioRoomController's idle
// teardown so a fresh room re-gates cleanly.
//
// `preJoinPendingAtom` is the per-room "should the modal be showing" flag, set
// true when the controller provisions a room and cleared once the user Joins or
// Cancels (or the room tears down). It holds the roomId it was raised for so a
// reconnect to the SAME room (a transient socket blip that re-runs provisioning)
// doesn't re-gate a user who already chose — only a genuinely new room re-shows
// the modal.
export const preJoinPendingAtom = atom<string | null>(null);

/** The user's MIC intent chosen in the pre-join modal — whether to acquire +
 *  publish the mic right after the call goes live (ensureMic). Default false:
 *  joining is listener-only unless the user opts in. */
export const preJoinMicIntentAtom = atom<boolean>(false);

/** The user's CAMERA intent chosen in the pre-join modal — whether to turn the
 *  camera on right after the call goes live (setCamera(true)). Default false:
 *  camera is opt-in, mirroring the lazy architecture. */
export const preJoinCamIntentAtom = atom<boolean>(false);

export type RecordingStatus = "idle" | "recording" | "finalizing";

export type RecordingState = {
  status: RecordingStatus;
  /** number of audio sources currently feeding the mixer; useful for the
   *  UI to show "ghi 3 nguồn" while a recording is live */
  inputCount: number;
  /** most recently completed recording, kept so the UI can offer a
   *  playback + download right after stop() */
  lastResult: RecordingResult | null;
  /** error from a failed start() / stop(), surfaced to the UI */
  errorMessage: string | null;
};

export const recordingStateAtom = atom<RecordingState>({
  status: "idle",
  inputCount: 0,
  lastResult: null,
  errorMessage: null,
});

export const recorderInstanceAtom = atom<MeetingRecorder | null>(null);
