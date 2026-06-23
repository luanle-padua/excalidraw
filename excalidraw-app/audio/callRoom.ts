// Shared Daily room naming — the single source of truth for which Daily room
// a meeting's media (voice + camera + screen) lives in.
//
// ─────────────────────── ⚠ ROOM MERGE — REVERTED (06-23 pivot) ─────────────
// A meeting spans TWO Daily rooms (the proven, shipped split):
//   • "<roomId>-audio" — voice + camera (DailyAudio)
//   • "<roomId>"       — screen share   (DailyScreenShare)
//
// HISTORY: Phase 5 briefly MERGED both call objects onto "<roomId>-audio" so a
// single DAILY CLOUD recording could composite voice+camera+screen into one
// MP4. That merge only existed to serve Daily cloud recording.
//
// PIVOT (06-23): recording moved OFF Daily cloud recording to a CLIENT-SIDE
// MediaRecorder (audio/clientRecording.ts). The host's browser now captures the
// mixed audio + the live screen-share video TRACK directly (from the
// screen-share controller's MediaStream) and records that to WebM locally — no
// Daily-side compositing, so there is NO reason to force both call objects onto
// one room. We restore the proven 2-room A/V split by setting
// MERGE_SCREEN_INTO_CALL_ROOM = false (below), which removes the risk the merge
// posed to screen-share's lazy-join / single-share lock.
//
// The flag is retained (not deleted) as the single defensive seam: flipping it
// back to true re-merges the rooms if the dormant Daily cloud-recording backend
// is ever re-wired. Nothing else in the app depends on the merged path —
// screenShareRoomName() is the ONLY consumer (DailyScreenShare via the
// controller), and with the flag false it returns the bare meeting id exactly
// as it did before the merge.

/** Suffix appended to a meeting's roomId to form its Daily CALL room (voice +
 *  camera, and — post-merge — screen share too). */
export const CALL_ROOM_SUFFIX = "-audio";

/** The Daily room name carrying a meeting's media. Single source of truth so
 *  DailyAudio and the screen-share controller never drift apart. */
export const callRoomName = (roomId: string): string =>
  `${roomId}${CALL_ROOM_SUFFIX}`;

/**
 * Whether the screen share joins the merged CALL room (true → one recordable
 * room) or the legacy bare-id room (false → split rooms). FALSE since the 06-23
 * pivot to client-side recording: the host's browser captures the screen track
 * directly, so the screen no longer needs to live in the audio/camera room. The
 * flag is kept as a defensive seam — flip back to true ONLY if the dormant Daily
 * cloud-recording backend is re-wired and needs both call objects on one room.
 */
export const MERGE_SCREEN_INTO_CALL_ROOM = false;

/** The Daily room name the SCREEN-SHARE call object should join for a meeting.
 *  Post-merge this is the same call room as audio/camera; pre-merge (fallback)
 *  it is the bare meeting id. */
export const screenShareRoomName = (roomId: string): string =>
  MERGE_SCREEN_INTO_CALL_ROOM ? callRoomName(roomId) : roomId;
