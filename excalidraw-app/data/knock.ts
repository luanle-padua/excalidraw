// Host-side waiting-room API (knock-to-join). A meeting manager (host / internal
// staff) lists who's knocking and admits / denies them. The worker enforces the
// manager gate; internal guests never appear (they auto-admit, the worker
// returns invited-only rows). See docs/plans/waiting-room.md.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type WaitingKnock = {
  email: string;
  name: string | null;
  created_at: number;
};

/** Everyone still WAITING (status='invited') for this meeting. Manager-gated by
 *  the worker — a non-manager gets a 403 and we return []. */
export const listKnocks = async (roomId: string): Promise<WaitingKnock[]> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/knocks`,
    );
    return res.ok ? (await res.json()).knocks ?? [] : [];
  } catch {
    return [];
  }
};

/** Admit or deny a waiting guest. Deny is SOFT (knock-only, re-knockable). */
export const patchKnock = async (
  roomId: string,
  email: string,
  action: "admit" | "deny",
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(
        roomId,
      )}/knock/${encodeURIComponent(email)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};
