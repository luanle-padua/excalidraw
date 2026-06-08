// Client API for the project-folder feature (worker /v1/projects +
// /v1/meetings). A "project" is a folder of meetings owned by a host;
// the host opens it to reopen past meetings or start a new one inside it.
//
// TEST PHASE: no auth, so `listProjects()` returns ALL projects. When
// Cloudflare Access lands, filter by the authenticated host email.
// The reopen flow relies on the server-stored managed room key
// (`meeting.room_key`) — the SSE/managed-key trade-off documented in the
// storage layer.

import { fetchWithAuth } from "./fetchWithAuth";

// Tunnel mode → same-origin via the Vite `/v1` proxy (base = ""); local
// dev → absolute worker URL. Mirrors storage.ts / Collab's socket handling.
const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");
export const IS_PROJECTS_CONFIGURED =
  import.meta.env.VITE_DEV_TUNNEL === "true" || Boolean(STORAGE_URL);

export type Project = {
  id: string;
  name: string;
  host_email: string | null;
  code: string | null;
  client: string | null;
  location: string | null;
  stage: string | null;
  type: string | null;
  branch: string | null;
  cover: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
};

export type MeetingSummary = {
  id: string;
  title: string | null;
  topic: string | null;
  type: string | null;
  status: string | null;
  created_by: string | null;
  thumbnail: string | null;
  participant_count: number | null;
  duration_s: number | null;
  scene_updated_at: number | null;
  updated_at: number;
  last_opened_at: number | null;
};

const json = { "content-type": "application/json" };

export const listProjects = async (host?: string): Promise<Project[]> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return [];
  }
  const url = host
    ? `${STORAGE_URL}/v1/projects?host=${encodeURIComponent(host)}`
    : `${STORAGE_URL}/v1/projects`;
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      return [];
    }
    return (await res.json()).projects ?? [];
  } catch {
    // storage worker offline — degrade gracefully (no projects)
    return [];
  }
};

export const createProject = async (
  name: string,
  hostEmail?: string,
): Promise<Project | null> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name, hostEmail }),
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
};

export const updateProject = async (
  id: string,
  patch: {
    name?: string;
    code?: string;
    client?: string;
    location?: string;
    stage?: string;
    type?: string;
    branch?: string;
    cover?: string;
    description?: string;
  },
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(id)}`,
      { method: "PATCH", headers: json, body: JSON.stringify(patch) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const updateMeeting = async (
  roomId: string,
  patch: {
    title?: string;
    topic?: string;
    description?: string;
    type?: string;
    status?: string;
    discipline?: string;
    priority?: string;
    confidentiality?: string;
    scheduled_at?: string;
  },
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}`,
      { method: "PATCH", headers: json, body: JSON.stringify(patch) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const listMeetings = async (
  projectId: string,
): Promise<MeetingSummary[]> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/meetings`,
    );
    if (!res.ok) {
      return [];
    }
    return (await res.json()).meetings ?? [];
  } catch {
    return [];
  }
};

export const registerMeeting = async (m: {
  roomId: string;
  roomKey?: string;
  projectId?: string;
  title?: string;
  createdBy?: string;
  thumbnail?: string;
}): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/meetings`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(m),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export const getMeeting = async (
  roomId: string,
): Promise<{
  id: string;
  room_key: string | null;
  title: string | null;
  topic: string | null;
  description: string | null;
  type: string | null;
  status: string | null;
  discipline: string | null;
  priority: string | null;
  confidentiality: string | null;
  scheduled_at: string | null;
  created_by: string | null;
  /** ms-since-epoch the meeting row was created = when the host started it;
   *  the shared, objective anchor for the meeting timer. */
  created_at: number | null;
  project_id: string | null;
  project_name: string | null;
  project_stage: string | null;
} | null> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}`,
    );
    if (!res.ok) {
      return null;
    }
    return (await res.json()).meeting ?? null;
  } catch {
    return null;
  }
};

// Record that the current (logged-in) user joined this meeting. Best-effort —
// the authoritative email is taken from the JWT server-side; `name` is only the
// display label. Used by the admin meeting-detail view ("who participated").
export const logParticipation = async (
  roomId: string,
  name?: string,
): Promise<void> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return;
  }
  try {
    await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/participant`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
  } catch {
    // non-critical
  }
};

// Daily.co screen-share token for a meeting. The worker mints a short-lived
// token for the Daily room named after `roomId` (creating it on first use)
// and returns the join URL + token. The API key lives only on the worker.
export const getDailyToken = async (
  roomId: string,
  userName?: string,
  userId?: string,
): Promise<{ url: string; token: string } | null> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return null;
  }
  try {
    const params = new URLSearchParams({ roomId });
    if (userName) {
      params.set("name", userName);
    }
    if (userId) {
      params.set("uid", userId);
    }
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/daily/token?${params}`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()).data ?? null;
  } catch {
    return null;
  }
};
