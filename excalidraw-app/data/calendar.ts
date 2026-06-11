// Client API for the MCM Calendar (worker /v1/...). Mirrors data/invite.ts:
// every call goes through fetchWithAuth (Supabase JWT) and is wrapped in
// try/catch so a flaky worker never crashes the calendar — it just renders
// empty / no-op instead.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

/** A meeting as the calendar needs it — flattened across project + schedule. */
export type CalMeeting = {
  id: string;
  title: string | null;
  status: string | null;
  scheduled_at: string | null;
  created_at: number;
  project_id: string;
  project_name: string | null;
  created_by: string | null;
  /** Who scheduled it (lower-cased email) — gates the Edit affordance. */
  organizer_email: string | null;
  duration_min: number | null;
  /** User-assigned accent colour (hex). When set, the calendar event uses
   *  it instead of the status palette so card + calendar colours match. */
  color?: string | null;
  /** 1 when I'm a direct (non-revoked) invitee — drives the live-invite
   *  nudge; project-member visibility alone doesn't count as an invite. */
  invited_direct?: number;
  /** 1 when I already joined this meeting at least once (participant row). */
  attended?: number;
  /** My RSVP state ('invited'|'accepted'|'declined') — NULL when I'm not a
   *  direct invitee. */
  my_invite_status?: string | null;
  /** When I was invited / when I first joined (ms) — personal timestamps
   *  for the dashboard activity log. */
  my_invited_at?: number | null;
  my_joined_at?: number | null;
};

/** Every meeting the current user can see, for placement on the calendar. */
export const getMyMeetings = async (): Promise<CalMeeting[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/meetings`);
    return res.ok ? (await res.json()).meetings ?? [] : [];
  } catch {
    return [];
  }
};

/** Free-text note scoped to a day (YYYY-MM-DD) or a meeting (roomId). Returns
 *  the note body, or "" on a miss / error (loud-quiet: never throws). */
export const getNote = async (
  scope: "day" | "meeting",
  ref: string,
): Promise<string> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/notes?scope=${encodeURIComponent(
        scope,
      )}&ref=${encodeURIComponent(ref)}`,
    );
    return res.ok ? (await res.json()).body ?? "" : "";
  } catch {
    return "";
  }
};

/** Upsert a day/meeting note. Returns whether the save succeeded. */
export const saveNote = async (
  scope: "day" | "meeting",
  ref: string,
  body: string,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ref, body }),
    });
    return res.ok;
  } catch {
    return false;
  }
};
