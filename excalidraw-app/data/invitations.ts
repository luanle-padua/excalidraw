// Client API for answering my OWN meeting invitations (worker /v1/me/...).
// Mirrors data/invite.ts: fetchWithAuth (Supabase JWT) + try/catch so a flaky
// worker degrades to a quiet "no" instead of crashing the notification bell.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** RSVP to an invitation addressed to me. The worker matches the row by the
 *  verified JWT email, so only `meetingId` + the answer travel. Returns
 *  whether the worker recorded it (false on refusal OR network failure). */
export const respondInvitation = async (
  meetingId: string,
  response: "accepted" | "declined",
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/me/invitations/${encodeURIComponent(
        meetingId,
      )}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};
