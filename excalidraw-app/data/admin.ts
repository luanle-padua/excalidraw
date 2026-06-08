// Client API for the admin console (worker /v1/admin/*). Every call goes
// through fetchWithAuth (attaches the Supabase JWT); the Worker re-verifies the
// "admin" role server-side, so these are safe to expose in the client bundle —
// a non-admin gets 403.

import { fetchWithAuth } from "./fetchWithAuth";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

export type AdminUser = {
  id: string;
  email: string;
  app_metadata?: { role?: string };
  user_metadata?: {
    display_name?: string;
    name?: string;
    company?: string;
    title?: string;
    division?: string;
    department?: string;
    emp_no?: string;
  };
  created_at?: string;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  banned_until?: string | null;
};

export type AdminMeeting = {
  id: string;
  project_id: string | null;
  title: string | null;
  topic: string | null;
  type: string | null;
  status: string | null;
  created_by: string | null;
  participant_count: number | null;
  duration_s: number | null;
  created_at: number | null;
  updated_at: number | null;
  last_opened_at: number | null;
  project_name: string | null;
};

export type AdminStats = {
  total_meetings: number;
  total_projects: number;
  meetings_today: number;
  total_files: number;
};

export const listAdminUsers = async (): Promise<AdminUser[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/users?perPage=200`);
    if (!res.ok) {
      return [];
    }
    return (await res.json()).users ?? [];
  } catch {
    return [];
  }
};

export const createAdminUser = async (u: {
  email: string;
  password: string;
  role?: string;
  name?: string;
  company?: string;
}): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(u),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export const updateAdminUser = async (
  id: string,
  patch: { role?: string; password?: string; disabled?: boolean },
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/users/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const deleteAdminUser = async (id: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/users/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const listAdminMeetings = async (): Promise<{
  meetings: AdminMeeting[];
  total: number;
}> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/meetings`);
    if (!res.ok) {
      return { meetings: [], total: 0 };
    }
    const j = await res.json();
    return { meetings: j.meetings ?? [], total: j.total ?? 0 };
  } catch {
    return { meetings: [], total: 0 };
  }
};

export const deleteAdminMeeting = async (roomId: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/meetings/${encodeURIComponent(roomId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const getAdminStats = async (): Promise<AdminStats | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/stats`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()).stats ?? null;
  } catch {
    return null;
  }
};

// ---- A2: audit / storage / cost / integrations --------------------------

export type AdminAuditEntry = {
  id: string;
  actor_email: string | null;
  action: string;
  target: string | null;
  meta: string | null;
  ts: number;
};

export type AdminStorage = {
  total: { files: number; bytes: number };
  byKind: { kind: string | null; files: number; bytes: number }[];
  topMeetings: {
    meeting_id: string;
    title: string | null;
    files: number;
    bytes: number;
  }[];
};

export type AdminCost = {
  meetings: number;
  projects: number;
  storage_bytes: number;
  meeting_minutes: number;
  recording_minutes: number;
  ai_calls: number;
};

export type AdminIntegration = {
  name: string;
  configured: boolean | null;
  note: string;
};

export const getAdminAudit = async (): Promise<AdminAuditEntry[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/audit`);
    return res.ok ? (await res.json()).entries ?? [] : [];
  } catch {
    return [];
  }
};

export const getAdminStorage = async (): Promise<AdminStorage | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/storage`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

export const getAdminCost = async (): Promise<AdminCost | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/cost`);
    return res.ok ? (await res.json()).usage ?? null : null;
  } catch {
    return null;
  }
};

export const getAdminIntegrations = async (): Promise<AdminIntegration[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/integrations`);
    return res.ok ? (await res.json()).integrations ?? [] : [];
  } catch {
    return [];
  }
};

// ---- Meeting detail (metadata + project + files + who joined) ------------

export type AdminMeetingFile = {
  id: string;
  kind: string | null;
  name: string | null;
  size: number | null;
  created_at: number | null;
};

export type AdminParticipant = {
  user_email: string;
  name: string | null;
  joined_at: number;
  last_seen_at: number;
};

export type AdminMeetingDetail = {
  meeting: AdminMeeting & {
    description: string | null;
    discipline: string | null;
    priority: string | null;
    confidentiality: string | null;
    scheduled_at: string | null;
    thumbnail: string | null;
    updated_at: number | null;
    project_code: string | null;
    project_stage: string | null;
  };
  files: AdminMeetingFile[];
  participants: AdminParticipant[];
};

export const getAdminMeetingDetail = async (
  roomId: string,
): Promise<AdminMeetingDetail | null> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/meetings/${encodeURIComponent(roomId)}`,
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
