// Shared Daily room naming — the single source of truth for which Daily room
// a meeting's media (voice + camera + screen) lives in.
//
// ─────────────────────────── ⚠ ROOM MERGE (Phase 5) ───────────────────────
// HISTORY: a meeting used to span TWO Daily rooms:
//   • "<roomId>-audio" — voice + camera (DailyAudio)
//   • "<roomId>"       — screen share   (DailyScreenShare)
// Two rooms = two separate Daily cloud-recording files (one voice/cam, one
// screen), which defeats "one composited file" (anh Luân 06-23 §7.1: MERGE
// mic+camera+screen into ONE room, THEN record).
//
// THE MERGE: both call objects now join the SAME Daily room — the call room
// `<roomId>-audio` — so a single Daily cloud recording composites voice +
// camera + screen into one MP4. Daily's `allowMultipleCallInstances` already
// lets the two call objects (audio call + screen-share call) coexist on one
// page pointing at the same room; the Worker token already grants canSend
// ["audio","video","screenVideo","screenAudio"] for any room, so no token
// change is needed.
//
// WHY a derived suffix and not the bare id: the screen-share Daily room used
// to BE the bare meeting id; the worker token mint + canSeeMeeting gate already
// strip a trailing "-audio" to recover the meeting id (index.ts ~5996), so
// routing screen onto "<id>-audio" reuses that exact gate with zero worker
// change. The bare-id room "<roomId>" is now simply unused.
//
// DEFENSIVE SEAM: the merge is expressed ONLY here. If a live test shows the
// merge breaks screen-share's lazy-join / single-share lock, set
// MERGE_SCREEN_INTO_CALL_ROOM = false to fall back to the legacy split rooms
// WITHOUT touching any other file (recording would then capture voice+camera
// only — the screen content is still persisted as canvas/files separately).
//
// MUST BE LIVE-TESTED (2 devices) — see the report. This file cannot be
// runtime-verified by the build.

/** Suffix appended to a meeting's roomId to form its Daily CALL room (voice +
 *  camera, and — post-merge — screen share too). */
export const CALL_ROOM_SUFFIX = "-audio";

/** The Daily room name carrying a meeting's media. Single source of truth so
 *  DailyAudio and the screen-share controller never drift apart. */
export const callRoomName = (roomId: string): string =>
  `${roomId}${CALL_ROOM_SUFFIX}`;

/**
 * Whether the screen share joins the merged CALL room (true → one recordable
 * room) or the legacy bare-id room (false → split rooms, screen NOT in the
 * recording). Default TRUE per owner decision (06-23 §7.1). Flip to false as a
 * defensive fallback if a live test shows the merge regresses screen share.
 */
export const MERGE_SCREEN_INTO_CALL_ROOM = true;

/** The Daily room name the SCREEN-SHARE call object should join for a meeting.
 *  Post-merge this is the same call room as audio/camera; pre-merge (fallback)
 *  it is the bare meeting id. */
export const screenShareRoomName = (roomId: string): string =>
  MERGE_SCREEN_INTO_CALL_ROOM ? callRoomName(roomId) : roomId;
