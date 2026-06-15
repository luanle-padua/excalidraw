// Carries an invite room (#room=ID,KEY) across a login that DROPS the URL hash.
// The chief offender is the magic-link redirect used by external guests:
// Supabase's `detectSessionInUrl` puts its own token in the fragment and
// clobbers the `#room=` we left there, so after login the guest would land on
// the dashboard instead of the meeting. We stash the room here BEFORE login and
// MeetingLobby consumes it once the session is ready, then auto-joins. The
// in-place password login (internal staff) keeps the hash, but reads from the
// same place too — see MeetingLobby's auto-join effect.

const KEY = "mcm:pendingRoom";

export type PendingRoom = { roomId: string; roomKey: string };

// Same shape MeetingLobby/LoginScreen parse: a full collab URL, a bare
// `#room=ID,KEY` fragment, or just `ID,KEY`.
const ROOM_RE = /(?:#room=)?([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]{20,})/;

export const parseRoom = (raw: string): PendingRoom | null => {
  const m = raw.trim().match(ROOM_RE);
  return m ? { roomId: m[1], roomKey: m[2] } : null;
};

export const stashPendingRoom = (room: PendingRoom): void => {
  try {
    sessionStorage.setItem(KEY, `${room.roomId},${room.roomKey}`);
  } catch {
    // sessionStorage unavailable (private mode / quota) — auto-join just won't
    // survive a hash-dropping login; the user can re-open the link.
  }
};

/** Stash whatever `#room` is currently in the URL hash, if any. Called right
 *  before kicking off a login that may drop the fragment. */
export const stashRoomFromUrl = (): void => {
  const room = parseRoom(window.location.hash);
  if (room) {
    stashPendingRoom(room);
  }
};

export const peekPendingRoom = (): PendingRoom | null => {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? parseRoom(raw) : null;
  } catch {
    return null;
  }
};

export const clearPendingRoom = (): void => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
};
