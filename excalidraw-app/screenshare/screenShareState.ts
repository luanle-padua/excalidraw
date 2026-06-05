// Jotai atoms for the Daily.co screen-share subsystem. Mirrors audio/audioState.ts:
//   - a STATE atom the UI subscribes to (the live media: remote stream, status)
//   - an INSTANCE atom holding the imperative manager so handlers (the Present
//     button) can drive start/stop without prop-drilling.
//
// NOTE: the PRESENCE/lock signal (who is sharing, over the socket) lives in
// collab/Collab.tsx as `screenShareStateAtom`. THIS file holds the local MEDIA
// state (the actual Daily stream) — the two are intentionally separate: presence
// drives badges + the lock, media drives the viewer pane.

import { atom } from "../app-jotai";

import type { DailyScreenShare } from "./DailyScreenShare";

export type ScreenShareStatus =
  | "idle"
  | "connecting"
  | "sharing"
  | "viewing"
  | "error";

export type ScreenShareMedia = {
  /** overall manager status (drives connecting spinners / error notices) */
  status: ScreenShareStatus;
  /** the remote presenter's screen stream to render, when watching someone */
  remoteStream: MediaStream | null;
  /** display name of the remote presenter (for the viewer header) */
  remoteSharerName: string | null;
  /** true while WE are the one presenting (drives the Present button state) */
  localActive: boolean;
  errorMessage: string | null;
};

export const SCREEN_SHARE_IDLE: ScreenShareMedia = {
  status: "idle",
  remoteStream: null,
  remoteSharerName: null,
  localActive: false,
  errorMessage: null,
};

export const screenShareMediaAtom = atom<ScreenShareMedia>(SCREEN_SHARE_IDLE);

export const screenShareInstanceAtom = atom<DailyScreenShare | null>(null);
