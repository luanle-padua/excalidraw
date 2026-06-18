// Jotai state for video PERFORMANCE / active-speaker tracking. Sits alongside
// videoState.ts (which owns the raw camera streams) but is concerned only with
// *who is talking right now*, derived from Daily's SFU "active-speaker-change"
// event in DailyAudio and pushed here by AudioRoomController.
//
// This is the CONTRACT surface read by the layout lane: the speaker tile is
// ringed by reading activeSpeakerAtom. It is also used internally by the
// receive-layer optimisation in DailyAudio (promote the active speaker to a
// higher simulcast layer, demote everyone else) — but that optimisation lives
// in DailyAudio and only mirrors its result here for the UI.
//
// Keyed by OUR socket.id (the same identity bridge as videoTilesAtom), never a
// raw Daily session_id, so the layout lane can match it against the per-person
// tiles ParticipantsBar already builds.

import { atom } from "../app-jotai";

/** socket.id of the participant Daily currently reports as the active speaker,
 *  or null when nobody is speaking / the call is down. Set by
 *  AudioRoomController from DailyAudio's onActiveSpeaker event; read by the
 *  layout lane to ring that person's tile. */
export const activeSpeakerAtom = atom<string | null>(null);
