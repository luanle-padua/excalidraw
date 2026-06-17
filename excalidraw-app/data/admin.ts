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
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/users?perPage=200`,
    );
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

// ---- Backup + archive (download-then-delete) -----------------------------
// These fetch a JSON file from the Worker and trigger a browser download. We
// fetch the response as a Blob (responseType blob), build an object URL, and
// click a synthetic <a download>. Distinguishes "forbidden" (403, missing
// admin role) from a network error so the UI can show the right message.

export type DownloadResult =
  | { ok: true }
  | { ok: false; status: number; reason: "forbidden" | "error" };

const CONTENT_DISPOSITION_FILENAME = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i;

// Pull the suggested filename out of a Content-Disposition header, if any.
const filenameFromDisposition = (header: string | null): string | null => {
  if (!header) {
    return null;
  }
  const m = CONTENT_DISPOSITION_FILENAME.exec(header);
  if (!m?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(m[1].trim());
  } catch {
    return m[1].trim();
  }
};

// Save a Blob to disk via a synthetic <a download>. Revokes the object URL on
// the next tick (after the click has been queued by the browser).
const saveBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const isoDate = (): string => new Date().toISOString().slice(0, 10);

// Shared download flow: GET `url`, on success stream to a download with the
// server-supplied filename (Content-Disposition) or `fallbackName`.
const downloadJson = async (
  url: string,
  fallbackName: string,
): Promise<DownloadResult> => {
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: res.status === 403 ? "forbidden" : "error",
      };
    }
    const blob = await res.blob();
    const name =
      filenameFromDisposition(res.headers.get("content-disposition")) ??
      fallbackName;
    saveBlob(blob, name);
    return { ok: true };
  } catch {
    return { ok: false, status: 0, reason: "error" };
  }
};

/** Download a full DB backup as a JSON file (GET /v1/admin/backup). */
export const downloadDbBackup = (): Promise<DownloadResult> =>
  downloadJson(
    `${STORAGE_URL}/v1/admin/backup`,
    `canvasm-db-backup-${isoDate()}.json`,
  );

/** Download a single project's archive as JSON (GET
 *  /v1/admin/projects/:id/archive). Pair this with deleteAdminProject for the
 *  "archive then delete" flow — the archive file is the recovery path. */
export const downloadProjectArchive = (id: string): Promise<DownloadResult> =>
  downloadJson(
    `${STORAGE_URL}/v1/admin/projects/${encodeURIComponent(id)}/archive`,
    `canvasm-project-${id}-${isoDate()}.json`,
  );

// ---- Realtime monitoring (live rooms, DO vs socket.io rollout) -----------

export type AdminRealtimeRoom = {
  room_id: string;
  title: string | null;
  backend: "do" | "socketio";
  connected: number;
  connected_exact: boolean;
  host_present: boolean;
  state: "active" | "idle" | "full";
  since: number;
  since_label: string;
};

export type AdminRealtimeRejections = {
  denied: number;
  revoked: number;
  finished: number;
  room_full: number;
  total: number;
};

export type AdminRealtime = {
  health: "ok" | "warn" | "down";
  generated_at: number;
  summary: {
    live_meetings: number;
    people_connected: number;
    rooms_on_do: number;
    rooms_on_socketio: number;
    rooms_full: number;
    ws_cap: number;
  };
  rooms: AdminRealtimeRoom[];
  rejections_24h: AdminRealtimeRejections | null;
  observability_url: string;
};

export const getAdminRealtime = async (): Promise<AdminRealtime | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/realtime`);
    return res.ok ? await res.json() : null;
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

export type AdminAiCostBreakdown = {
  gemini: {
    total_cost_usd: number;
    translate_calls: number;
    chatbot_calls: number;
    summarize_calls: number;
    total_tokens: number;
  };
  deepgram: {
    total_cost_usd: number;
    stt_seconds: number;
  };
};

export type AdminCost = {
  meetings: number;
  projects: number;
  storage_bytes: number;
  meeting_minutes: number;
  recording_minutes: number;
  ai_calls: number;
  // Extended (06-17): AI provider cost roll-up + a usage-derived estimate.
  ai_cost_breakdown?: AdminAiCostBreakdown;
  cost_estimate_usd?: number;
};

// ---- AI cost & usage (Gemini + Deepgram metering) -----------------------

export type AdminUsageProvider = {
  name: string;
  total_cost_usd: number;
  total_tokens: number;
  total_seconds: number;
  calls: number;
};

export type AdminUsageKind = {
  kind: string;
  cost_usd: number;
  count: number;
};

export type AdminUsageTrendDay = {
  date: string;
  cost_usd: number;
  call_count: number;
};

export type AdminUsageCall = {
  id: string;
  ts: number;
  provider: string;
  kind: string;
  tokens_in: number;
  tokens_out: number;
  seconds: number;
  est_cost_usd: number;
  email: string | null;
  meeting_id: string | null;
};

export type AdminUsage = {
  summary: {
    total_cost_usd: number;
    total_ai_calls: number;
    by_provider: AdminUsageProvider[];
    by_kind: AdminUsageKind[];
  };
  daily_trend: AdminUsageTrendDay[];
  recent: AdminUsageCall[];
};

// ---- System status (per-service health probes) --------------------------

export type AdminSystemService = {
  id: string;
  name: string;
  status: "on" | "warn" | "off";
  last_check: number;
  detail?: string;
};

export type AdminSystemStatus = {
  services: AdminSystemService[];
};

// Discriminates "couldn't load (likely 403 / network)" from "loaded, empty"
// so the two new tabs can show an admin-permission banner instead of a blank.
export type AdminResult<T> = { ok: true; data: T } | { ok: false };

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

// AI cost & usage. Returns an AdminResult so the tab can tell "load failed
// (likely missing admin role → 403, swallowed by fetchWithAuth)" apart from a
// genuinely empty dataset and render the right fallback.
export const getAdminUsage = async (): Promise<AdminResult<AdminUsage>> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/usage`);
    if (!res.ok) {
      return import.meta.env.DEV
        ? { ok: true, data: MOCK_USAGE }
        : { ok: false };
    }
    return { ok: true, data: (await res.json()) as AdminUsage };
  } catch {
    return import.meta.env.DEV ? { ok: true, data: MOCK_USAGE } : { ok: false };
  }
};

export const getSystemStatus = async (): Promise<
  AdminResult<AdminSystemStatus>
> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/system-status`);
    if (!res.ok) {
      return import.meta.env.DEV
        ? { ok: true, data: MOCK_SYSTEM_STATUS }
        : { ok: false };
    }
    return { ok: true, data: (await res.json()) as AdminSystemStatus };
  } catch {
    return import.meta.env.DEV
      ? { ok: true, data: MOCK_SYSTEM_STATUS }
      : { ok: false };
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

export type AdminInvitee = {
  email: string;
  kind: string | null;
  role: string | null;
  status: string | null;
  invited_by: string | null;
  invited_at: number | null;
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
    organizer_email: string | null;
    host_email: string | null;
    ai_summary: string | null;
    ai_summary_at: number | null;
  };
  files: AdminMeetingFile[];
  participants: AdminParticipant[];
  invitees: AdminInvitee[];
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

// ---- Projects back-office + compliance content access (06-10 #1) ---------

export type AdminProject = {
  id: string;
  name: string | null;
  host_email: string | null;
  code: string | null;
  client: string | null;
  stage: string | null;
  created_at: number | null;
  updated_at: number | null;
  meeting_count: number;
  member_count: number;
};

export type AdminProjectMember = {
  email: string;
  role: string | null;
  added_by: string | null;
  added_at: number | null;
};

export const listAdminProjects = async (): Promise<AdminProject[]> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/projects`);
    return res.ok ? (await res.json()).projects ?? [] : [];
  } catch {
    return [];
  }
};

/** Force-delete: cascades EVERY meeting (canvas/files/chat blobs) + members. */
export const deleteAdminProject = async (id: string): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/projects/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

// Member roster reuses the regular /v1/projects routes — the Worker lets the
// admin role through its owner gate.
export const getAdminProjectMembers = async (
  projectId: string,
): Promise<AdminProjectMember[]> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/members`,
    );
    return res.ok ? (await res.json()).members ?? [] : [];
  } catch {
    return [];
  }
};

export const addAdminProjectMembers = async (
  projectId: string,
  emails: string[],
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Remove a member. 409 = removing the last owner (surfaced to the UI). */
export const removeAdminProjectMember = async (
  projectId: string,
  email: string,
): Promise<{ ok: boolean; status: number }> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/members/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
};

/** COMPLIANCE: ask the Worker for the room key to open a meeting's content
 *  read-only. The Worker writes a MANDATORY `admin.open_content` audit row
 *  before returning the key (409 = no stored key). */
export const openAdminMeetingContent = async (
  roomId: string,
): Promise<
  | { ok: true; roomId: string; roomKey: string; title: string | null }
  | { ok: false; status: number }
> => {
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/admin/meetings/${encodeURIComponent(roomId)}/open`,
      { method: "POST" },
    );
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const j = await res.json();
    return { ok: true, roomId: j.roomId, roomKey: j.roomKey, title: j.title };
  } catch {
    return { ok: false, status: 0 };
  }
};

// ---- A3: settings + analytics -------------------------------------------

export type AdminAnalytics = {
  counts: {
    meetings_7d: number;
    meetings_30d: number;
    participations: number;
    unique_participants: number;
  };
  topProjects: { name: string | null; meetings: number }[];
  topParticipants: {
    name: string | null;
    user_email: string;
    meetings: number;
  }[];
};

export const getAdminSettings = async (): Promise<Record<string, string>> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/settings`);
    return res.ok ? (await res.json()).settings ?? {} : {};
  } catch {
    return {};
  }
};

export const putAdminSettings = async (
  settings: Record<string, string>,
): Promise<boolean> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export const getAdminAnalytics = async (): Promise<AdminAnalytics | null> => {
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/admin/analytics`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// ---- DEV-only mocks ------------------------------------------------------
// The /v1/admin/usage + /v1/admin/system-status routes are built in parallel
// by the backend team; until they merge, these let the new tabs render locally.
// They are returned ONLY when import.meta.env.DEV is true AND the live call
// failed — in production a failure surfaces the permission banner instead.

const MOCK_USAGE: AdminUsage = {
  summary: {
    total_cost_usd: 42.871,
    total_ai_calls: 1843,
    by_provider: [
      {
        name: "gemini",
        total_cost_usd: 31.42,
        total_tokens: 4_812_900,
        total_seconds: 0,
        calls: 1521,
      },
      {
        name: "deepgram",
        total_cost_usd: 11.451,
        total_tokens: 0,
        total_seconds: 18_320,
        calls: 322,
      },
    ],
    by_kind: [
      { kind: "translate", cost_usd: 14.2, count: 980 },
      { kind: "chatbot", cost_usd: 9.61, count: 401 },
      { kind: "summarize", cost_usd: 7.61, count: 140 },
      { kind: "stt", cost_usd: 11.451, count: 322 },
    ],
  },
  daily_trend: Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return {
      date: d.toISOString().slice(0, 10),
      cost_usd: Number((1.5 + Math.sin(i) * 1.1 + i * 0.12).toFixed(2)),
      call_count: 80 + Math.round(Math.cos(i) * 30 + i * 6),
    };
  }),
  recent: Array.from({ length: 12 }, (_, i) => {
    const providers = ["gemini", "deepgram"] as const;
    const kinds = ["translate", "chatbot", "summarize", "stt"] as const;
    const provider = providers[i % 2];
    const kind = provider === "deepgram" ? "stt" : kinds[i % 3];
    return {
      id: `mock-${i}`,
      ts: Date.now() - i * 1000 * 60 * 7,
      provider,
      kind,
      tokens_in: provider === "gemini" ? 900 + i * 40 : 0,
      tokens_out: provider === "gemini" ? 300 + i * 12 : 0,
      seconds: provider === "deepgram" ? 45 + i * 3 : 0,
      est_cost_usd: Number((0.004 + i * 0.0011).toFixed(4)),
      email: i % 3 === 0 ? "luan@mapgroup.co.kr" : "guest@acme.com",
      meeting_id: `room-${100 + i}`,
    };
  }),
};

const MOCK_SYSTEM_STATUS: AdminSystemStatus = {
  services: [
    {
      id: "worker",
      name: "Storage Worker",
      status: "on",
      last_check: Date.now(),
    },
    { id: "d1", name: "D1 database", status: "on", last_check: Date.now() },
    { id: "r2", name: "R2 blob storage", status: "on", last_check: Date.now() },
    {
      id: "supabase",
      name: "Supabase Auth",
      status: "on",
      last_check: Date.now(),
    },
    {
      id: "daily",
      name: "Daily.co (video)",
      status: "warn",
      last_check: Date.now() - 1000 * 60 * 4,
      detail: "Elevated join latency",
    },
    {
      id: "gemini",
      name: "Gemini API",
      status: "on",
      last_check: Date.now() - 1000 * 30,
    },
    {
      id: "deepgram",
      name: "Deepgram STT",
      status: "off",
      last_check: Date.now() - 1000 * 60 * 12,
      detail: "No successful probe in 12m",
    },
  ],
};
