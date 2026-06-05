// Jotai atoms exposing the live AudioRoom state to the UI. Decoupled
// from the AudioRoom class so React components can subscribe without
// pulling the imperative API in directly.

import { atom } from "../app-jotai";

import type { PeerState } from "./AudioRoom";
import type { DailyAudio } from "./DailyAudio";
import type { MeetingRecorder, RecordingResult } from "./MeetingRecorder";

export type AudioStatus = "idle" | "connecting" | "live" | "error";

export type AudioState = {
  status: AudioStatus;
  /** the user's own mic is muted (still in call, just not transmitting) */
  muted: boolean;
  /** false when the device has no mic and the user joined as a
   *  listener-only. The UI hides the mute toggle in that case. */
  canTransmit: boolean;
  /** keyed by socket.id (excluding the local user) */
  peers: Map<string, PeerState>;
  /** human-readable error from the last failed start() attempt */
  errorMessage: string | null;
};

export const audioStateAtom = atom<AudioState>({
  status: "idle",
  muted: false,
  canTransmit: true,
  peers: new Map(),
  errorMessage: null,
});

/** the voice-call instance (DailyAudio — Daily.co SFU) — stored in an atom
 *  so commands ("toggle mute", "join audio") can be issued from anywhere
 *  without prop drilling. Set to null when no room is active. Drop-in for
 *  the old mesh AudioRoom (same method surface). */
export const audioRoomInstanceAtom = atom<DailyAudio | null>(null);

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
