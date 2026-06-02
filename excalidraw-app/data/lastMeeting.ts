// Remembers the meeting the user is currently in (roomId + roomKey) so the
// project home can offer a "Resume" banner after they close + reopen the
// app on a clean URL. Saved on entering a meeting, cleared on Leave.

const KEY = "mcm:lastMeeting:v1";

export type LastMeeting = { roomId: string; roomKey: string };

export const setLastMeeting = (m: LastMeeting): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {}
};

export const getLastMeeting = (): LastMeeting | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const p = JSON.parse(raw);
    return p?.roomId && p?.roomKey
      ? { roomId: p.roomId, roomKey: p.roomKey }
      : null;
  } catch {
    return null;
  }
};

export const clearLastMeeting = (): void => {
  try {
    localStorage.removeItem(KEY);
  } catch {}
};
