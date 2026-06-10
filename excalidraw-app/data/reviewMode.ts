// Tracks whether the meeting open in THIS tab was entered for REVIEW
// (read-only, because it's a finished/immutable meeting). Persisted in
// sessionStorage so a page reload — which auto-rejoins from the #room URL
// without the viewOnly flag — re-applies read-only instead of silently
// dropping the user into an editable canvas. Scoped per-tab (sessionStorage)
// so it never leaks into a different meeting in another tab.

const KEY = "mcm:reviewRoom:v1";

export const markReviewRoom = (roomId: string): void => {
  try {
    sessionStorage.setItem(KEY, roomId);
  } catch {
    // sessionStorage unavailable (private mode / quota) — non-fatal.
  }
};

export const clearReviewRoom = (): void => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
};

export const isReviewRoom = (roomId: string | null | undefined): boolean => {
  if (!roomId) {
    return false;
  }
  try {
    return sessionStorage.getItem(KEY) === roomId;
  } catch {
    return false;
  }
};

// STEALTH review (admin compliance open — quyết định 06-10: "ẩn hoàn toàn").
// On top of read-only it means: do NOT join the socket room at all. The admin
// reads the R2 snapshot only, so no presence, no cursor, no participant row —
// nothing observable to the people in the meeting. Same per-tab persistence
// trick as the review mark so a reload re-enters stealth instead of silently
// joining the room as a visible peer.

const STEALTH_KEY = "mcm:stealthRoom:v1";

export const markStealthRoom = (roomId: string): void => {
  try {
    sessionStorage.setItem(STEALTH_KEY, roomId);
  } catch {
    // non-fatal
  }
};

export const clearStealthRoom = (): void => {
  try {
    sessionStorage.removeItem(STEALTH_KEY);
  } catch {
    // non-fatal
  }
};

export const isStealthRoom = (roomId: string | null | undefined): boolean => {
  if (!roomId) {
    return false;
  }
  try {
    return sessionStorage.getItem(STEALTH_KEY) === roomId;
  } catch {
    return false;
  }
};
