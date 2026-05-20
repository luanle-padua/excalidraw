// Room-level recording broadcast state — the "is anyone in the meeting
// currently recording?" signal, mirrored from incoming RECORDING_STATE
// socket messages.
//
// Distinct from `recordingStateAtom` (in audio/audioState.ts), which
// tracks the HOST's local MeetingRecorder lifecycle. The two are kept
// in sync on the host's machine (start recording → both atoms update;
// stop → both clear); on every other peer only this one fires, so the
// "Đang ghi âm" banner can render without the peer owning a recorder
// instance.

import { atom, appJotaiStore } from "../app-jotai";

export type RoomRecordingState = {
  /** True from the host's broadcast `recording: true` until they
   *  broadcast `recording: false`. */
  recording: boolean;
  /** Socket id of the host that started the recording. Peers compare
   *  against `hostSocketIdAtom` before trusting the message; the
   *  stored value also drives the "X is recording" attribution in the
   *  banner. */
  hostSocketId: string | null;
  /** Display name carried alongside the broadcast for the banner text.
   *  Optional — receivers fall back to the host's profile entry if
   *  this is null (covers older clients without the field). */
  hostName: string | null;
  /** When the recording began, ms since epoch. Lets every peer paint
   *  an elapsed timer that converges from the same baseline. Null
   *  while the room is not recording. */
  startedAt: number | null;
};

const IDLE_STATE: RoomRecordingState = {
  recording: false,
  hostSocketId: null,
  hostName: null,
  startedAt: null,
};

export const roomRecordingAtom = atom<RoomRecordingState>(IDLE_STATE);

export const setRoomRecording = (next: RoomRecordingState): void => {
  appJotaiStore.set(roomRecordingAtom, next);
};

export const resetRoomRecording = (): void => {
  appJotaiStore.set(roomRecordingAtom, IDLE_STATE);
};
