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
