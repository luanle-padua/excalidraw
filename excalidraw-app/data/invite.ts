// Client API for Phase 4.5 invite + scheduling (worker /v1/...). All calls go
// through fetchWithAuth (Supabase JWT); the worker enforces who can invite +
// who can see what.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type DirectoryUser = {
  email: string;
  name: string;
  title?: string;
  division?: string;
};

export type MyInvitation = {
  id: string;
  title: string | null;
  topic: string | null;
  status: string | null;
  scheduled_at: string | null;
  duration_min: number | null;
  created_by: string | null;
  project_name: string | null;
  my_role: string | null;
};

/** Internal staff directory for the invite picker. */
export const getDirectory = async (): Promise<DirectoryUser[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/directory`);
    return res.ok ? (await res.json()).users ?? [] : [];
  } catch {
    return [];
  }
};

/** Invite people to a meeting. `addToProject` (internal emails only) also grants
 *  whole-folder project membership; a client is never auto-added to the project. */
export const inviteToMeeting = async (
  roomId: string,
  invitees: { email: string; role?: string }[],
  addToProject?: string[],
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/invitees`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitees, addToProject }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const revokeInvitee = async (
  roomId: string,
  email: string,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(
        roomId,
      )}/invitees/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** The current user's invited / upcoming meetings — the only surface a client
 *  sees (project name only, never the folder). */
export const getMyInvitations = async (): Promise<MyInvitation[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/invitations`);
    return res.ok ? (await res.json()).invitations ?? [] : [];
  } catch {
    return [];
  }
};
