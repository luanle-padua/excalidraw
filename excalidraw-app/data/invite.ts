// Client API for Phase 4.5 invite + scheduling (worker /v1/...). All calls go
// through fetchWithAuth (Supabase JWT); the worker enforces who can invite +
// who can see what.

import { fetchWithAuth } from "./fetchWithAuth";

import type { ListResult } from "./projects";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type DirectoryUser = {
  email: string;
  name: string;
  title?: string;
  division?: string;
  /** "lib:NN.png" gallery ref from the account (user_metadata.avatar). */
  avatar?: string;
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
 *  whole-folder project membership; a client is never auto-added to the project.
 *  Returns the HTTP status too so callers can tell apart worker refusals
 *  (403 not allowed, 409 meeting finished) from network failure (null). */
export const inviteToMeeting = async (
  roomId: string,
  invitees: { email: string; role?: string }[],
  addToProject?: string[],
): Promise<{ ok: boolean; status: number | null }> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/invitees`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitees, addToProject }),
      },
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
};

export type MeetingInvitee = {
  email: string;
  kind: "internal" | "guest";
  role: string;
  status: "invited" | "accepted" | "declined" | "revoked";
  invited_by: string | null;
  invited_at: number;
};

/** A meeting's invitee list (active + revoked) — powers the organizer's
 *  edit form. Internal staff + admins only (worker-enforced). */
export const listInvitees = async (
  roomId: string,
): Promise<MeetingInvitee[]> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/invitees`,
    );
    return res.ok ? (await res.json()).invitees ?? [] : [];
  } catch {
    return [];
  }
};

export type MeetingParticipant = {
  user_email: string;
  name: string | null;
  joined_at: number;
  last_seen_at: number;
};

/** Who ACTUALLY joined the meeting (vs invitees = who was asked). Visible to
 *  anyone who can see the meeting (worker roomGate). */
export const listParticipants = async (
  roomId: string,
): Promise<MeetingParticipant[]> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/participants`,
    );
    return res.ok ? (await res.json()).participants ?? [] : [];
  } catch {
    return [];
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
 *  sees (project name only, never the folder). Checked variant so the
 *  "Invited" list can tell offline from genuinely empty. */
export const getMyInvitationsChecked = async (): Promise<
  ListResult<MyInvitation>
> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/me/invitations`);
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, items: (await res.json()).invitations ?? [] };
  } catch {
    return { ok: false };
  }
};

export const getMyInvitations = async (): Promise<MyInvitation[]> => {
  const r = await getMyInvitationsChecked();
  return r.ok ? r.items : [];
};

// ---- Waiting room (knock-to-join) ----------------------------------------
// External guests knock to enter a LIVE meeting and poll their own status until
// a host admits them. Internal staff auto-admit (the worker short-circuits them
// — these helpers are only ever called for external callers).

export type MyKnock = {
  status: "invited" | "admitted" | "denied";
} | null;

/** The caller's OWN knock status for a meeting (self-scoped). Returns null when
 *  there's no knock row yet (or on error — the waiting-room poll treats null as
 *  "not admitted" and keeps waiting). */
export const getMyKnock = async (roomId: string): Promise<MyKnock> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/knock`,
    );
    if (!res.ok) {
      return null;
    }
    const j = (await res.json()) as { knock?: MyKnock };
    return j.knock ?? null;
  } catch {
    return null;
  }
};

/** Knock to enter a live meeting. The display name is sent in the body (the
 *  worker has no `name` on its auth context). Returns the resulting status +
 *  HTTP status so the caller can tell apart admitted / invited / denied
 *  (429 cooldown) / refusal. */
export const knockToMeeting = async (
  roomId: string,
  name?: string | null,
): Promise<{ ok: boolean; status: number | null; knockStatus?: string }> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/knock`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name ?? null }),
      },
    );
    let knockStatus: string | undefined;
    try {
      knockStatus = ((await res.json()) as { status?: string }).status;
    } catch {
      knockStatus = undefined;
    }
    return { ok: res.ok, status: res.status, knockStatus };
  } catch {
    return { ok: false, status: null };
  }
};
