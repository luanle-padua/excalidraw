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

export type CameraState = {
  status: CameraStatus;
  /** raw (dev-facing) error detail for the tooltip; UI shows an i18n string. */
  errorMessage: string | null;
};

export const cameraStateAtom = atom<CameraState>({
  status: "off",
  errorMessage: null,
});
