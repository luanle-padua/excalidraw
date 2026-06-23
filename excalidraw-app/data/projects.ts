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

// ---------------- Project status (canonical lifecycle) ----------------
// The project's lifecycle, stored as a CANONICAL value in the existing
// free-text `stage` column (no migration). A division admin (division HEAD)
// or the project leader picks it; the sidebar groups projects on it instead
// of the old keyword heuristic. Legacy projects whose `stage` holds free text
// simply don't match a canonical value — they fall back to the default group.
export const PROJECT_STATUSES = [
  "prepare",
  "ongoing",
  "on-hold",
  "finished",
  "cancelled",
  "archived",
] as const;

export type ProjectStatus = typeof PROJECT_STATUSES[number];

/** Narrow an arbitrary `stage` string to a canonical status, or null when it
 *  is empty / a legacy free-text value. Centralised so the sidebar grouping,
 *  the badge, and the picker all read the column the same way. */
export const projectStatusOf = (
  stage: string | null | undefined,
): ProjectStatus | null =>
  stage && (PROJECT_STATUSES as readonly string[]).includes(stage)
    ? (stage as ProjectStatus)
    : null;

/** i18n key for a status' label (translated at render time via `t()`). Kept
 *  here so every surface shows the same wording. */
export const projectStatusLabelKey = (status: ProjectStatus): string =>
  `projStatus.${status}`;

// Tunnel mode → same-origin via the Vite `/v1` proxy (base = ""); local
// dev → absolute worker URL. Mirrors storage.ts / Collab's socket handling.
export const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");
export const IS_PROJECTS_CONFIGURED =
  import.meta.env.VITE_DEV_TUNNEL === "true" || Boolean(STORAGE_URL);

export type Project = {
  id: string;
  name: string;
  host_email: string | null;
  /** The designated project LEADER (lower-cased email) — defaults to the
   *  creator; the leading-division head reassigns it. Shown as "Trưởng dự án". */
  leader_email?: string | null;
  /** Which division leads the project (its head manages it). Nullable. */
  lead_division_id?: string | null;
  /** How the caller reaches this folder: "member" = full folder;
   *  "invitee" = internal user invited to / attended some meetings only —
   *  the server already filters the meeting list down to those;
   *  "lead" = the caller leads it / heads its division but isn't a member. */
  access?: "member" | "invitee" | "lead";
  /** The viewer's OWN role on this project, stamped server-side:
   *  "admin" | "owner" (leader) | "manager" | "member" (participate-only).
   *  Invitee rows carry none. Drives the badge + management gating. */
  my_role?: "admin" | "owner" | "manager" | "member";
  /** Whether the viewer may MANAGE this project (guests, members, edit
   *  metadata, danger zone). Computed server-side = canManageProject (admin
   *  OR owner/manager OR project leader OR leading-division head). The client
   *  gates management UI on THIS, not on a client-side guess. */
  can_manage?: boolean;
  /** Whether the viewer is in the project LEADERSHIP (admin / leader / leading-
   *  division head — NOT a plain co-operator). Gates delete + delegating
   *  co-operators + changing the leading division. */
  is_leadership?: boolean;
  /** Whether the viewer may ASSIGN/REPLACE the project leader — admin or the
   *  leading-division HEAD only. Gates the "Assign leader" affordance. */
  can_assign_leader?: boolean;
  code: string | null;
  client: string | null;
  location: string | null;
  stage: string | null;
  type: string | null;
  branch: string | null;
  cover: string | null;
  description: string | null;
  /** Accent colour (hex) — cosmetic personalisation, nullable. */
  color?: string | null;
  /** Icon (emoji/id) — cosmetic personalisation, nullable. */
  icon?: string | null;
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
  /** Who scheduled it (lower-cased email) — gates the Edit affordance.
   *  Optional: some adapters (invitations) don't carry it. */
  organizer_email?: string | null;
  thumbnail: string | null;
  participant_count: number | null;
  duration_s: number | null;
  scene_updated_at: number | null;
  updated_at: number;
  last_opened_at: number | null;
  discipline?: string | null;
  priority?: string | null;
  confidentiality?: string | null;
  scheduled_at?: string | null;
  /** User-assigned accent colour (hex) — overrides the status colour on
   *  the card stripe and the calendar event. Nullable: most meetings have
   *  none and fall back to the status palette. */
  color?: string | null;
  /** User-assigned icon (emoji/id) — same cosmetic class as `color`. */
  icon?: string | null;
  /** Parent project name, when the API/adaptor carries it (the project
   *  view already knows it from context; the calendar/invite adapters
   *  populate it so the card can show it in every context). */
  project_name?: string | null;
  /** Parent project id — lets the card's project chip jump straight to
   *  that project's meeting list. Only adapters that know it (calendar)
   *  carry it; the invite shape has just the name. */
  project_id?: string | null;
  /** True when this meeting has a PUBLISHED recap package (a shared
   *  summary/file/transcript bundle). Computed server-side via an EXISTS
   *  subquery on `meeting_package` (status='published', not deleted); the
   *  card renders a "Recap" badge when set. Optional: calendar/invite
   *  adapters that don't carry it default it to false. SQLite returns it
   *  as 0/1, so the card coerces truthiness. */
  has_recap?: boolean | number;
};

const json = { "content-type": "application/json" };

/** Outcome of a list fetch that DISTINGUISHES "genuinely empty" from
 *  "couldn't reach the worker" — empty-states must not lie when offline.
 *  Shared by the other data modules (calendar, invite, userFiles). */
export type ListResult<T> = { ok: true; items: T[] } | { ok: false };

export const listProjectsChecked = async (
  host?: string,
): Promise<ListResult<Project>> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return { ok: true, items: [] };
  }
  const url = host
    ? `${STORAGE_URL}/v1/projects?host=${encodeURIComponent(host)}`
    : `${STORAGE_URL}/v1/projects`;
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, items: (await res.json()).projects ?? [] };
  } catch {
    // storage worker offline
    return { ok: false };
  }
};

export const listProjects = async (host?: string): Promise<Project[]> => {
  const r = await listProjectsChecked(host);
  return r.ok ? r.items : [];
};

// The owner is stamped server-side from the verified JWT (and gets their
// project_member row in the same request) — no client-supplied host email.
export const createProject = async (name: string): Promise<Project | null> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name }),
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
    /** Accent colour (hex) — cosmetic; the worker exempts a colour/icon-only
     *  patch from the owner-only guard (any member can tint the folder). */
    color?: string;
    /** Icon (emoji/id) — same cosmetic class as `color`. */
    icon?: string;
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

// Set a project's canonical lifecycle status (written to the `stage` column).
// The worker gates this to the division admin (division HEAD) / project leader
// / platform admin — NOT a plain member or a delegated co-operator. Returns the
// updated project on success so the caller can patch its list in place.
export const setProjectStatus = async (
  projectId: string,
  status: ProjectStatus,
): Promise<Project | null> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return null;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/status`,
      { method: "POST", headers: json, body: JSON.stringify({ status }) },
    );
    if (!res.ok) {
      return null;
    }
    return (await res.json()).project ?? null;
  } catch {
    return null;
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
    duration_min?: number;
    organizer_email?: string;
    host_email?: string;
    /** Accent colour (hex) or null to clear it. Synced to the calendar. */
    color?: string | null;
    /** Icon (emoji/id) — same cosmetic class as `color`. */
    icon?: string | null;
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

export const listMeetingsChecked = async (
  projectId: string,
): Promise<ListResult<MeetingSummary>> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return { ok: true, items: [] };
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/meetings`,
    );
    if (!res.ok) {
      return { ok: false };
    }
    return { ok: true, items: (await res.json()).meetings ?? [] };
  } catch {
    return { ok: false };
  }
};

export const listMeetings = async (
  projectId: string,
): Promise<MeetingSummary[]> => {
  const r = await listMeetingsChecked(projectId);
  return r.ok ? r.items : [];
};

// Create/upsert a meeting in ONE call — lifecycle fields included, so a
// scheduled meeting can never exist half-registered. The organizer/host
// emails are stamped SERVER-side from the verified JWT (not passed here).
export const registerMeeting = async (m: {
  roomId: string;
  roomKey?: string;
  projectId?: string;
  title?: string;
  createdBy?: string;
  thumbnail?: string;
  /** Lifecycle at birth: "live" (instant/ad-hoc) | "scheduled". */
  status?: "live" | "scheduled";
  scheduledAt?: string;
  durationMin?: number;
  // Full create payload — form tạo = form edit (agenda metadata), plus a
  // designated host (internal email, defaults to organizer) and policies.
  topic?: string;
  description?: string;
  type?: string;
  discipline?: string;
  priority?: string;
  confidentiality?: string;
  hostEmail?: string;
  waitingRoom?: boolean;
  recordingEnabled?: boolean;
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

export type Meeting = {
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
  /** Planned length (minutes) — Phase 4.5 scheduling. */
  duration_min: number | null;
  /** Who scheduled it (lower-cased email). Gates reschedule/cancel. */
  organizer_email: string | null;
  /** Current host (defaults to the organizer). */
  host_email: string | null;
  created_by: string | null;
  /** ms-since-epoch the meeting row was created = when the host started it;
   *  the shared, objective anchor for the meeting timer. */
  created_at: number | null;
  project_id: string | null;
  project_name: string | null;
  project_stage: string | null;
  /** AI recap written once at End-for-all (quyết định 06-10 #4 —
   *  summary-first). Plaintext in D1 — queryable, unlike the E2E
   *  transcript blob it is derived from. */
  ai_summary: string | null;
  ai_summary_at: number | null;
  /** Cosmetic accents (hex colour + emoji/icon id), nullable. */
  color?: string | null;
  icon?: string | null;
  /** Server-computed: the viewer holds host authority over this meeting (admin,
   *  organizer/host, or the project leader / leading-division head). Surfaces
   *  the host controls (End / kick / mute) to a division head. */
  viewer_is_authority?: boolean;
  /** Server-computed: the viewer may START this scheduled meeting — the
   *  acting-host scope, now limited to the OWNING DEPARTMENT (organizer / host /
   *  co-host / project authority / same-division member), NOT any internal user
   *  (anh Luân 06-16: a meeting belongs to its department; another department
   *  can't start it). */
  viewer_can_start?: boolean;
  /** Server-computed: the consent-notice VERSION this viewer has already
   *  accepted for the meeting (recording / AI-as-project-data disclosure), or
   *  null if they never have. The join-time consent gate shows itself when this
   *  doesn't match the current CONSENT_VERSION — so a wording bump re-prompts,
   *  but an unchanged version never nags. See data/meetingConsent.ts. */
  viewer_consent_version?: string | null;
  /** RUNTIME per-meeting realtime backend selector (DO migration, 06-17).
   *  Team A stamps this on the meeting row in D1: "do" routes the realtime
   *  collab through the Cloudflare Durable Object (raw WebSocket transport);
   *  anything else (incl. absent/null) is now IGNORED for routing — the
   *  socket.io room server is RETIRED (06-17), so every meeting resolves to
   *  "do" (see resolveRealtimeBackend). The flag is kept only for the admin
   *  rollout view. Read at `initializeRoom` so every client in ONE meeting
   *  picks the SAME backend (no build-time `import.meta.env` split-brain —
   *  see docs/plans/durable-objects-migration.md §7.1). */
  realtime_backend?: "do" | "socketio" | null;
};

/** The two realtime transports the client can drive. Resolved per-meeting at
 *  connect time from the server-supplied `realtime_backend` flag. */
export type RealtimeBackend = "do" | "socketio";

/** Normalize a meeting's `realtime_backend` flag into a definite backend.
 *
 *  FORCED "do" (06-17): realtime is now 100% Durable Objects. The legacy
 *  socket.io room server is RETIRED — it no longer exists, so a socket.io
 *  connection can NEVER succeed (the WS opens then closes immediately). Every
 *  meeting therefore resolves to the DO transport regardless of the stored
 *  flag: new meetings carry "do", but OLD/finished/ad-hoc meetings created
 *  before the DO default carry "socketio"/absent/null — they must still use
 *  DO, not the dead relay. The `realtime_backend` field is kept for the admin
 *  console rollout view; it no longer routes the client transport. */
export const resolveRealtimeBackend = (
  _meeting: Pick<Meeting, "realtime_backend"> | null | undefined,
): RealtimeBackend => "do";

/** Discriminated meeting lookup — callers that gate behaviour on the
 *  registry (the collab start-gate) must tell "this room is genuinely
 *  unregistered" (404 → ad-hoc, pass through) apart from "the worker is
 *  unreachable / errored" (fail CLOSED, don't grant an editable canvas). */
export type MeetingFetch =
  | { kind: "found"; meeting: Meeting }
  | { kind: "not-found" }
  // roomGate said no — this user is not (or no longer) allowed to see the
  // meeting. Distinct from "error": it's an ANSWER, not an outage. The
  // in-room access re-check kicks on it; the start gate blocks on it.
  | { kind: "forbidden" }
  | { kind: "error" };

export const getMeetingChecked = async (
  roomId: string,
): Promise<MeetingFetch> => {
  if (!IS_PROJECTS_CONFIGURED) {
    // No worker in this dev setup — every room is ad-hoc by definition.
    return { kind: "not-found" };
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}`,
    );
    if (res.status === 404) {
      return { kind: "not-found" };
    }
    if (res.status === 403) {
      return { kind: "forbidden" };
    }
    if (!res.ok) {
      return { kind: "error" };
    }
    const meeting = (await res.json()).meeting ?? null;
    return meeting ? { kind: "found", meeting } : { kind: "not-found" };
  } catch {
    return { kind: "error" };
  }
};

export const getMeeting = async (roomId: string): Promise<Meeting | null> => {
  const fetched = await getMeetingChecked(roomId);
  return fetched.kind === "found" ? fetched.meeting : null;
};

/** Store the AI-generated recap for a meeting (D1 `meeting.ai_summary`).
 *  Written once, fire-and-forget, from the host's End-for-all flow. */
export const saveMeetingAiSummary = async (
  roomId: string,
  summary: string,
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED || !summary.trim()) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}/summary`,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({ summary }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
};

/** Permanently delete a CANCELLED meeting (organizer/admin; worker enforces
 *  the cancelled-only rule and cascades R2 blobs + every related D1 row). */
export const deleteMeeting = async (roomId: string): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/meetings/${encodeURIComponent(roomId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
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

// ---------------- Project members + project deletion ----------------
// Roster management for the project-overview view. The worker already
// owns the routes (GET/POST/DELETE /v1/projects/:id/members,
// DELETE /v1/projects/:id); these are the missing clients.

export type ProjectMember = {
  email: string;
  role: string;
  added_by: string | null;
  added_at: number;
};

export const listProjectMembers = async (
  projectId: string,
): Promise<ProjectMember[]> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/members`,
    );
    if (!res.ok) {
      return [];
    }
    return (await res.json()).members ?? [];
  } catch {
    return [];
  }
};

export const addProjectMembers = async (
  projectId: string,
  emails: string[],
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/members`,
      { method: "POST", headers: json, body: JSON.stringify({ emails }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export const removeProjectMember = async (
  projectId: string,
  email: string,
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/members/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
};

// Promote/demote a delegated manager (owner/admin only — the worker gates it).
// `role` is 'manager' (delegate management) or 'member' (back to participate-
// only). The worker refuses to re-role an owner.
export const setMemberRole = async (
  projectId: string,
  email: string,
  role: "manager" | "member",
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(
        projectId,
      )}/members/${encodeURIComponent(email)}/role`,
      { method: "PATCH", headers: json, body: JSON.stringify({ role }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

// Assign / replace the project LEADER (the leading-division HEAD or admin only —
// the worker gates it). `email` becomes project.leader_email and is ensured to
// be on the roster. A leader can't reassign their own leadership.
export const setProjectLeader = async (
  projectId: string,
  email: string,
): Promise<boolean> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return false;
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}/leader`,
      { method: "PATCH", headers: json, body: JSON.stringify({ email }) },
    );
    return res.ok;
  } catch {
    return false;
  }
};

export type Division = {
  id: string;
  name: string;
  head_email: string | null;
  /** The head's immediate deputy (rank 2) — also allowed to create projects. */
  deputy_email?: string | null;
};

// The division catalogue (department names + head/deputy). Internal-only; used
// to resolve a project's leading-department NAME for read-only display and to
// know whether the viewer is a head/deputy (→ may create projects).
export const listDivisions = async (): Promise<Division[]> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return [];
  }
  try {
    const res = await fetchWithAuth(`${STORAGE_URL}/v1/divisions`);
    return res.ok ? (await res.json()).divisions ?? [] : [];
  } catch {
    return [];
  }
};

// Delete an empty project. The worker returns 409 when the project still
// has meetings — surface the status so the caller can prompt "delete the
// meetings first" instead of a generic failure.
export const deleteProject = async (
  projectId: string,
): Promise<{ ok: boolean; status: number }> => {
  if (!IS_PROJECTS_CONFIGURED) {
    return { ok: false, status: 0 };
  }
  try {
    const res = await fetchWithAuth(
      `${STORAGE_URL}/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
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
