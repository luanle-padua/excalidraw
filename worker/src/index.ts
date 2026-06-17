// MAP CanvasMeet — storage API (Cloudflare Worker).
//
// Routes (all under /v1):
//   Scene (canvas) blob — the heart of "save & reopen a meeting":
//     PUT  /v1/scenes/:roomId          body = encrypted scene bytes
//     GET  /v1/scenes/:roomId          -> encrypted scene bytes | 404
//   Library file bytes (images / PDF / DXF / IFC-GLB / thumbs):
//     PUT  /v1/files/:roomId/:fileId   body = encrypted file bytes
//     GET  /v1/files/:roomId/:fileId   -> encrypted bytes | 404
//   Chat history blob (encrypted, for reopen / read-only review):
//     PUT  /v1/chats/:roomId           body = encrypted chat-log bytes
//     GET  /v1/chats/:roomId           -> encrypted bytes | 404
//   Library manifest blob (encrypted DXF/IFC/PDF source + metadata):
//     PUT  /v1/library/:roomId         body = encrypted library bytes
//     GET  /v1/library/:roomId         -> encrypted bytes | 404
//   Project folders + meeting registry — powers the "folder → meetings
//   → pull content" UX:
//     POST /v1/projects                {name, hostEmail?}            -> project
//     GET  /v1/projects?host=<email>                                 -> project[]
//     GET  /v1/projects/:projectId/meetings                          -> meeting[]
//     POST /v1/meetings                {roomId, roomKey?, projectId?, title?, createdBy?}
//     GET  /v1/meetings/:roomId                                      -> meeting (incl. room_key)
//
// Bytes live in R2 (encrypted-at-rest); D1 holds the folder structure +
// pointers + (test phase) the managed room key. Auth is intentionally
// OPEN for the link-only test phase — gate every route behind Cloudflare
// Access (verify Cf-Access-Jwt-Assertion) before any real rollout.
//
// This Worker is the seed of the full Cloudflare backend: the Durable
// Object realtime relay and the AI/TURN routes get added here later.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { aiRoutes } from "./ai";
import { guestInviteEmail, sendEmail } from "./email";
import { RoomDO } from "./roomDO";
import { handleSttUpgrade } from "./stt";
import { logUsageEvent } from "./usage";

import type { MiddlewareHandler } from "hono";

// Re-exported so the AI cost helper is reachable as "the logUsageEvent in
// index.ts" (Admin Console P0) even though the implementation lives in usage.ts
// to avoid a circular import with ai.ts. Used directly below by the admin
// endpoints' siblings; also the canonical import for any future server-side
// metering added here.
export { logUsageEvent };

// Re-export the Durable Object class so the runtime can instantiate the
// `ROOM` binding declared in wrangler.jsonc.
export { RoomDO };

type Bindings = {
  BUCKET: R2Bucket;
  DB: D1Database;
  // Daily.co — screen-share media (server-side secret, never sent to client).
  // Local: worker/.dev.vars · Prod: `wrangler secret put DAILY_API_KEY`.
  DAILY_API_KEY?: string;
  DAILY_DOMAIN?: string;
  // Supabase project URL — used to build the JWT issuer + JWKS endpoint for
  // verifying user access tokens. (No secret needed: tokens are ES256-signed,
  // verified against the public JWKS.)
  SUPABASE_URL?: string;
  // Supabase secret/service key — ADMIN ONLY (proxies the Supabase Admin REST
  // API for user management). Never sent to the client; gated behind the admin
  // role. Local: worker/.dev.vars · Prod: `wrangler secret put`.
  SUPABASE_SERVICE_API_KEY?: string;
  // Resend — transactional email (guest invite link + credentials). API key is
  // a SECRET (`wrangler secret put RESEND_API_KEY`, local: worker/.dev.vars);
  // RESEND_FROM is a plain var in wrangler.jsonc ("Canvas M <addr>").
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  // CORS allowlist (B6) — comma-separated extra origins permitted to call /v1
  // (e.g. the production app origin). localhost / *.pages.dev / *.workers.dev /
  // quick-tunnel are always allowed; everything else is rejected. Plain var in
  // wrangler.jsonc, e.g. "https://app.mapgroup.co.kr".
  ALLOWED_ORIGINS?: string;
  // Durable Object binding for the realtime relay (one DO instance per room).
  // The WS upgrade at GET /rooms/:roomId/ws is auth-gated at the Worker then
  // routed to env.ROOM.idFromName(roomId).get(). See docs/plans/
  // durable-objects-migration.md and src/roomDO.ts.
  ROOM: DurableObjectNamespace;
  // Max concurrent WebSockets per room — handshake cap (§4, R14). Plain var.
  ROOM_WS_CAP?: string;
  // AI routes (I-1, plan §6) — Gemini chat translation / chatbot / summary.
  // GEMINI_API_KEY is a SECRET (`wrangler secret put GEMINI_API_KEY`, local:
  // worker/.dev.vars). GEMINI_TRANSLATION_MODEL is an optional plain var
  // (defaults to gemini-2.5-flash). Same names the Fly room server used.
  GEMINI_API_KEY?: string;
  GEMINI_TRANSLATION_MODEL?: string;
  // STT proxy (I-1, plan §2/§6) — Deepgram realtime transcription. DEEPGRAM_API_KEY
  // is a SECRET (`wrangler secret put DEEPGRAM_API_KEY`, local: worker/.dev.vars);
  // absent ⇒ STT stays default-OFF (the /stt proxy reports "not configured").
  // DEEPGRAM_STT_MODEL is an optional plain var (defaults to nova-3).
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_STT_MODEL?: string;
  // STT provider seam (Admin Console P2). STT_PROVIDER selects the active STT
  // backend (plain var, default 'deepgram'); STT_PROVIDER_CONFIG is optional
  // JSON for provider-specific knobs (plain var). The other providers' keys are
  // SECRETS — declared here but NOT set in wrangler.jsonc; the human runs
  // `wrangler secret put ELEVENLABS_API_KEY` / `OPENAI_API_KEY` when wiring one
  // up. Deepgram stays the working default; nothing changes until STT_PROVIDER
  // is flipped.
  ELEVENLABS_API_KEY?: string;
  OPENAI_API_KEY?: string;
  STT_PROVIDER?: string;
  STT_PROVIDER_CONFIG?: string;
};

// CORS origin check (B6, 06-17). The real risk is a random website riding a
// leaked bearer token; an explicit allowlist closes that. Dev origins stay open
// so the cloudflared quick-tunnel + Pages preview flow keeps working.
// Defensive secret read: strip a leading UTF-8 BOM + surrounding whitespace.
// `wrangler secret put` piped from a PowerShell/BOM source stamps a BOM onto the
// value (﻿), which then poisons any header/URL built from it — the 06-17
// outage (Supabase apikey + Daily key + SUPABASE_URL all carried a BOM → 500/502
// on every upstream call). Normalize at the read site so a bad rotate can't recur.
const cleanSecret = (s?: string): string => (s ?? "").trim();

const isAllowedOrigin = (origin: string, env: Bindings): boolean => {
  if (!origin) {
    return false;
  }
  let host: string;
  let protocol: string;
  try {
    const u = new URL(origin);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    return false;
  }
  if (protocol !== "https:" && protocol !== "http:") {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return true;
  }
  // Private LAN IPs (RFC1918) — lets a local dev server reached over the LAN
  // (e.g. http://172.16.x.x:3001 for cross-device testing) call the ONLINE
  // Worker so the local dev link operates identically to production. A public
  // attacker page can't be served from a private-IP origin.
  if (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  ) {
    return true;
  }
  if (
    host.endsWith(".pages.dev") ||
    host.endsWith(".workers.dev") ||
    host.endsWith(".trycloudflare.com")
  ) {
    return true;
  }
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
};

// Auth context attached by the JWT middleware for downstream handlers.
type Variables = {
  userId: string;
  email?: string;
  /** app_metadata.role from the verified JWT ("admin" gates /v1/admin/*). */
  role?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS (B6, 06-17): allowlist instead of wildcard. localhost / *.pages.dev /
// *.workers.dev / quick-tunnel + ALLOWED_ORIGINS env are permitted; any other
// origin gets no CORS headers (browser blocks it). Returning the request's own
// origin (not "*") is required once we send credentials/Authorization broadly.
app.use(
  "*",
  cors({
    origin: (origin, c) =>
      isAllowedOrigin(origin, c.env as Bindings) ? origin : null,
    allowMethods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "x-kind",
      "x-name",
      "x-tags",
      "x-visibility",
      "Authorization",
    ],
  }),
);

// ---- Supabase JWT auth gate (shared) -------------------------------------
// A valid Supabase user access token (`Authorization: Bearer <jwt>`) is
// required by every /v1 route (except /v1/health) AND by the four AI routes
// (/translate, /translate-batch, /chatbot, /summarize). We verify OFFLINE
// against the project's public JWKS (ES256) — no per-request call to Supabase.
// The JWKS is fetched once per worker isolate and cached by jose. On success
// the user id (sub) + email + role are attached for handlers/authz. This
// closes the previously wide-open API; per-meeting membership authz layers on
// later.
//
// CORS preflight (OPTIONS) is answered by the cors() middleware above before
// this runs, so browsers can still negotiate without a token.

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

// Shared Hono middleware: verify the bearer JWT and attach the identity. Used
// by the /v1/* gate below and applied DIRECTLY to the root AI paths (which are
// NOT under /v1) so they can't be hit anonymously and burn the Gemini key.
const jwtGate: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  // Trim + strip trailing slashes: a stray newline or trailing "/" in the
  // SUPABASE_URL secret made `new URL()` throw "Invalid URL string" → uncaught
  // 500 on EVERY authed request (the 06-17 outage). Normalize defensively.
  const supabaseUrl = c.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  if (!supabaseUrl) {
    return c.json({ error: "auth not configured" }, 503);
  }
  const authz = c.req.header("Authorization");
  if (!authz?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = authz.slice(7);
  const issuer = `${supabaseUrl}/auth/v1`;
  if (!jwks) {
    // A malformed SUPABASE_URL must surface as a clear 503 (misconfig), never
    // an uncaught new-URL throw that 500s every authed route.
    let jwksUrl: URL;
    try {
      jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
    } catch {
      return c.json({ error: "auth misconfigured" }, 503);
    }
    jwks = createRemoteJWKSet(jwksUrl);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: "authenticated",
    });
    c.set("userId", String(payload.sub ?? ""));
    c.set(
      "email",
      typeof payload.email === "string" ? payload.email : undefined,
    );
    const appMeta = payload.app_metadata as { role?: unknown } | undefined;
    c.set("role", typeof appMeta?.role === "string" ? appMeta.role : undefined);
    // Keep the internal-domain list warm — authz below depends on it.
    await refreshInternalDomains(c.env.DB);
    return next();
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }
};

// /v1/* shares the gate, but /v1/health stays open (liveness probe).
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") {
    return next();
  }
  return jwtGate(c, next);
});

// ---- AI routes (I-1, plan §6) --------------------------------------------
// Gemini chat translation / chatbot / meeting summary, ported off the Fly room
// server. Mounted at ROOT (not under /v1) so the request/response contract is
// identical to the room server — the client switch is a pure base-URL change
// (room-server URL → STORAGE_URL). They ride the CORS middleware above and are
// now ALSO behind the shared JWT gate (B-AI, 06-17): the room server had no
// auth, which left the server-side GEMINI_API_KEY open to anyone who knew the
// URL. The per-isolate IP rate-limit in ai.ts is a soft cost cap, not auth —
// it resets on isolate rotation and is trivially bypassed from distributed IPs.
// The gate runs on each AI path BEFORE app.route("/", aiRoutes) below, so the
// client must send `Authorization: Bearer <jwt>` (via fetchWithAuth) on these.
// Routes added: POST /translate, /translate-batch, /chatbot, /summarize.
app.use("/translate", jwtGate);
app.use("/translate-batch", jwtGate);
app.use("/chatbot", jwtGate);
app.use("/summarize", jwtGate);
app.route("/", aiRoutes);

// ---- Admin gate ----------------------------------------------------------
// /v1/admin/* requires the "admin" role (Supabase app_metadata.role, carried in
// the verified JWT). Runs AFTER the JWT middleware above, so the role is set.
app.use("/v1/admin/*", async (c, next) => {
  if (c.get("role") !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
});

const now = () => Date.now();
// A denied guest may re-knock only after this cooldown (server-enforced so the
// re-knock button can't be hammered). See docs/plans/waiting-room.md.
const REKNOCK_COOLDOWN_MS = 30_000;
const sceneKey = (roomId: string) => `scenes/${roomId}/current`;
const fileKey = (roomId: string, fileId: string) => `files/${roomId}/${fileId}`;
const chatKey = (roomId: string) => `chats/${roomId}/current`;
const libraryKey = (roomId: string) => `library/${roomId}/current`;
const transcriptKey = (roomId: string) => `transcripts/${roomId}/current`;
const userFileKey = (email: string, fileId: string) =>
  `userfiles/${email}/${fileId}`;

// Internal domains come from system_settings.internal_domains (comma-separated,
// admin-editable — P0.2: the setting is now REAL, no more hardcode). Cached
// per-isolate for 60s so the synchronous isInternalEmail() checks sprinkled
// through authz stay cheap; the hardcoded list is only the cold-start /
// empty-table fallback. Refreshed by the JWT middleware on every request.
let internalDomains = ["mapgroup.co.kr"];
let internalDomainsAt = 0;
const refreshInternalDomains = async (db: D1Database) => {
  if (Date.now() - internalDomainsAt < 60_000) {
    return;
  }
  internalDomainsAt = Date.now();
  try {
    const row = await db
      .prepare(
        `SELECT value FROM system_settings WHERE key = 'internal_domains'`,
      )
      .first<{ value: string }>();
    const list = (row?.value ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    if (list.length) {
      internalDomains = list;
    }
  } catch {
    // settings table missing (pre-0007 DB) — keep the fallback list
  }
};
const isInternalEmail = (email?: string) =>
  !!email && internalDomains.some((d) => email.toLowerCase().endsWith(`@${d}`));

// Tombstone check (P0.5): a permanently deleted meeting must STAY deleted — a
// client still holding the room open could otherwise re-create the registry
// row / re-upload blobs through the upsert PUT routes.
const isDeletedMeeting = async (db: D1Database, roomId: string) =>
  !!(await db
    .prepare(`SELECT 1 FROM deleted_meeting WHERE id = ?1`)
    .bind(roomId)
    .first());

// Finished meetings are review-only: reject blob PUTs (scene/chat/transcript/
// library/files) once the meeting is finished AND a grace window has passed.
// The window exists because clients legitimately flush AFTER the finish PATCH:
// the leave flush, the final scene save, and the chat/transcript timers all
// land within minutes — blocking them would lose the meeting's last state.
// `updated_at` is a reliable anchor: the finish PATCH is the LAST write that
// touches it (every later status PATCH gets 409 from the terminal-state rule),
// so updated_at effectively == finished_at. Known soft spot (accepted): an
// admin PATCH that edits other fields refreshes updated_at and re-opens the
// window. NOTE: the summary POST is intentionally NOT gated — the AI summary
// arrives after finish by design.
const FINISHED_WRITE_GRACE_MS = 10 * 60 * 1000;
const isFinishedLocked = async (db: D1Database, roomId: string) => {
  const row = await db
    .prepare(`SELECT status, updated_at FROM meeting WHERE id = ?1`)
    .bind(roomId)
    .first<{ status: string | null; updated_at: number }>();
  return (
    !!row &&
    normalizeStatus(row.status) === "finished" &&
    Date.now() - row.updated_at > FINISHED_WRITE_GRACE_MS
  );
};

// ---- Meeting lifecycle (Phase 4.5 state machine) ---------------------------
// One canonical status vocabulary. Mirrors components/mcm/meetingStatus.ts:
//   scheduled ──Start──> live ──End for all──> finished   (terminal, immutable)
//       └──cancel──> cancelled ──restore──> scheduled
const MEETING_STATUSES = ["scheduled", "live", "finished", "cancelled"];

/** Tolerant read of any historical status value onto the canonical set. */
const normalizeStatus = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim().toLowerCase();
  if (!v) {
    return null;
  }
  if (v === "live" || v === "in progress" || v === "in_progress") {
    return "live";
  }
  if (v === "finished" || v === "completed" || v === "done") {
    return "finished";
  }
  if (v === "cancelled" || v === "canceled") {
    return "cancelled";
  }
  if (v === "scheduled") {
    return "scheduled";
  }
  return null;
};

// Per-meeting authz (Phase 4.5, tightened 06-10 — "chỉ những người được mời
// mới join được, kể cả nội bộ"). can-see = admin OR the meeting's
// organizer/host OR an active meeting_invitee OR a member of the meeting's
// project. There is NO blanket internal-allow anymore: an internal user who
// wasn't invited (and isn't in the project) cannot see or join the meeting.
// Unregistered ad-hoc rooms (no D1 row) stay open to any authenticated user —
// they have no invite list to enforce.
const canSeeMeeting = async (
  db: D1Database,
  email: string | undefined,
  role: string | undefined,
  roomId: string,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  if (!email) {
    return false;
  }
  const e = email.toLowerCase();
  const row = await db
    .prepare(
      `SELECT
         (SELECT 1 FROM meeting WHERE id = ?1) AS registered,
         (SELECT confidentiality FROM meeting WHERE id = ?1) AS conf,
         (SELECT 1 FROM meeting
            WHERE id = ?1
              AND (lower(organizer_email) = ?2 OR lower(host_email) = ?2))
           AS owner,
         (SELECT 1 FROM meeting_invitee
            WHERE meeting_id = ?1 AND email = ?2 AND status <> 'revoked')
           AS invited,
         (SELECT 1 FROM project_member pm
            JOIN meeting m ON m.project_id = pm.project_id
            WHERE m.id = ?1 AND pm.email = ?2
              AND pm.role IN ('owner','manager')) AS member,
         (SELECT 1 FROM meeting m
            JOIN project p ON p.id = m.project_id
            LEFT JOIN division d ON d.id = p.lead_division_id
            WHERE m.id = ?1
              AND (lower(p.leader_email) = ?2 OR lower(d.head_email) = ?2))
           AS authority`,
    )
    .bind(roomId, e)
    .first<{
      registered: number | null;
      conf: string | null;
      owner: number | null;
      invited: number | null;
      member: number | null;
      authority: number | null;
    }>();
  if (!row?.registered) {
    // Ad-hoc room without a registry row — nothing to gate against.
    return true;
  }
  // Confidential meetings are INVITEE-ONLY (quyết định 06-10 #3): project
  // membership alone is not enough — the field is enforced, not decorative.
  // NOT even the division head/leader may peek unless they created it (owner)
  // or were explicitly invited — confidential is a deliberate carve-out from
  // the head's auto-manage power (06-16).
  if ((row.conf ?? "").toLowerCase() === "confidential") {
    return !!(row.owner || row.invited);
  }
  // Per anh Luân 06-16: project membership ALONE no longer auto-joins a meeting.
  // Auto-access is the LEADERSHIP set only — division HEAD + project LEADER (the
  // `authority` arm), the organizer/host (`owner`), a co-host or any explicitly
  // invited person (`invited`), and a manager-tier member (owner/manager =
  // leader/co-operator, the now-restricted `member` arm). A PLAIN project member
  // must be invited per-meeting ("đó là bảo mật") — they no longer jump into
  // every meeting in the folder. A PROJECT GUEST is likewise an identity, not a
  // blanket grant: they reach a meeting ONLY via an explicit meeting_invitee row.
  return !!(row.owner || row.invited || row.member || row.authority);
};

// Per-project access LEVEL (case "phòng ban này mời phòng ban khác"):
//   "full"    — admin or project_member: the whole folder.
//   "partial" — INTERNAL user who isn't a member but was invited to (or
//               actually attended) ≥1 meeting of the project: the folder
//               appears in their list, filtered down to just those meetings.
//   null      — no access. Guests NEVER reach partial (folders stay
//               confidential by construction); their only surface remains
//               /v1/me/invitations.
type ProjectAccess = "full" | "partial" | null;

const projectAccess = async (
  db: D1Database,
  email: string | undefined,
  role: string | undefined,
  projectId: string,
): Promise<ProjectAccess> => {
  if (role === "admin") {
    return "full";
  }
  if (!email) {
    return null;
  }
  const e = email.toLowerCase();
  const member = await db
    .prepare(
      `SELECT 1 FROM project_member
       WHERE project_id = ?1 AND email = ?2 LIMIT 1`,
    )
    .bind(projectId, e)
    .first();
  if (member) {
    return "full";
  }
  // Phase 2: the designated leader and the leading division's HEAD see the whole
  // folder too (manage implies full visibility) — without needing a member row.
  // Division admin = HEAD only (anh Luân 06-16); the deputy/rank-2 person is no
  // longer a division authority — they see a folder only via a member row or an
  // assigned project role.
  const lead = await db
    .prepare(
      `SELECT 1 FROM project p
         LEFT JOIN division d ON d.id = p.lead_division_id
        WHERE p.id = ?1
          AND (lower(p.leader_email) = ?2 OR lower(d.head_email) = ?2)
        LIMIT 1`,
    )
    .bind(projectId, e)
    .first();
  if (lead) {
    return "full";
  }
  if (!isInternalEmail(e)) {
    return null;
  }
  // "Attended" grants visibility ONLY while the invite wasn't revoked —
  // a revoked invite is a VETO (quyết định 06-11: "add nhầm → cho ra" must
  // remove the meeting from their dashboard entirely). Their participant
  // row / contributions stay in the meeting as historical fact.
  const touched = await db
    .prepare(
      `SELECT 1 FROM meeting m
       WHERE m.project_id = ?1
         AND (EXISTS (SELECT 1 FROM meeting_invitee mi
                      WHERE mi.meeting_id = m.id AND mi.email = ?2
                        AND mi.status <> 'revoked')
              OR (EXISTS (SELECT 1 FROM meeting_participant mp
                          WHERE mp.meeting_id = m.id
                            AND lower(mp.user_email) = ?2)
                  AND NOT EXISTS (SELECT 1 FROM meeting_invitee mr
                                  WHERE mr.meeting_id = m.id AND mr.email = ?2
                                    AND mr.status = 'revoked')))
       LIMIT 1`,
    )
    .bind(projectId, e)
    .first();
  return touched ? "partial" : null;
};

// MANAGEMENT gate — distinct from projectAccess (participate). True only for an
// admin, or a project_member with a MANAGER-tier role ('owner' = project
// leader/creator, or 'manager' = delegated manager). A plain 'member' is
// PARTICIPATE-ONLY and never passes — this is the fix for the cross-division
// joiner who was added as 'member' just to attend yet inherited guest/member
// management (06-15). (Phase 1: no division-head / leader-column checks yet.)
const canManageProject = async (
  db: D1Database,
  projectId: string,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  // Manage = a manager-tier member ('owner'/'manager'), OR the designated
  // project leader (project.leader_email), OR the HEAD of the project's leading
  // division (project.lead_division_id → division.head_email). The last two are
  // Phase 2: a division head manages every project their division leads WITHOUT
  // being added as a member (anh Luân 06-15).
  const row = await db
    .prepare(
      `SELECT
         (SELECT 1 FROM project_member
            WHERE project_id = ?1 AND email = ?2
              AND role IN ('owner','manager')) AS mgr,
         (SELECT 1 FROM project
            WHERE id = ?1 AND lower(leader_email) = ?2) AS leader,
         (SELECT 1 FROM division d
            JOIN project p ON p.lead_division_id = d.id
            WHERE p.id = ?1
              AND lower(d.head_email) = ?2)
           AS head`,
    )
    .bind(projectId, me)
    .first<{
      mgr: number | null;
      leader: number | null;
      head: number | null;
    }>();
  return !!(row?.mgr || row?.leader || row?.head);
};

// Is the caller in the LEADERSHIP of this project — admin, the project leader
// (leader_email or a 'owner' member), or the HEAD of the leading division?
// Distinct from canManageProject: it EXCLUDES a delegated 'manager', because
// leadership actions (designate/replace a manager, delete the project) belong
// to the leader/head — a manager must not mint more managers.
const isProjectLeadership = async (
  db: D1Database,
  projectId: string,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  const row = await db
    .prepare(
      `SELECT
         (SELECT 1 FROM project_member
            WHERE project_id = ?1 AND email = ?2 AND role = 'owner') AS owner,
         (SELECT 1 FROM project
            WHERE id = ?1 AND lower(leader_email) = ?2) AS leader,
         (SELECT 1 FROM division d
            JOIN project p ON p.lead_division_id = d.id
            WHERE p.id = ?1
              AND lower(d.head_email) = ?2)
           AS head`,
    )
    .bind(projectId, me)
    .first<{
      owner: number | null;
      leader: number | null;
      head: number | null;
    }>();
  return !!(row?.owner || row?.leader || row?.head);
};

// Is the caller the HEAD of this project's leading division (or admin)? ONLY the
// head (or admin) assigns/replaces the project LEADER — a leader can't hand off
// their own leadership.
const isDivisionHeadOfProject = async (
  db: D1Database,
  projectId: string,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  return !!(await db
    .prepare(
      `SELECT 1 FROM division d
         JOIN project p ON p.lead_division_id = d.id
        WHERE p.id = ?1
          AND lower(d.head_email) = ?2
        LIMIT 1`,
    )
    .bind(projectId, me)
    .first());
};

// May the caller CREATE a project? Any INTERNAL user (or admin). Creating a
// project just opens a personal folder where the creator is auto-written as
// leader + 'owner' member (see POST /v1/projects) — it grants NO cross-project
// or division power, so there's no reason to gate it to division admins. The
// division HEAD still auto-manages every project their division leads; a creator
// who isn't a head simply owns their own folder until/unless a head reassigns
// the leader. (anh Luân 06-16: division admin = head-only; create open to all
// internal so a 트럼-phòng/deputy can still open projects.)
const canCreateProject = async (
  _db: D1Database,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  const me = email?.toLowerCase();
  return !!me && isInternalEmail(me);
};

// Does the caller have HOST-level authority over this MEETING by virtue of the
// project — i.e. they're the project LEADER or the leading-division HEAD? Such a
// person gets full meeting control (End, edit) even if someone else created it
// (anh Luân 06-15: "division head có toàn quyền trên cuộc họp ngang leader").
// Division admin = HEAD only (anh Luân 06-16); the deputy is no longer an
// authority — they host/End a meeting only as organizer/host/co-host/leader.
const isMeetingProjectAuthority = async (
  db: D1Database,
  roomId: string,
  email: string | undefined,
): Promise<boolean> => {
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  return !!(await db
    .prepare(
      `SELECT 1 FROM meeting m
         JOIN project p ON p.id = m.project_id
         LEFT JOIN division d ON d.id = p.lead_division_id
        WHERE m.id = ?1
          AND (lower(p.leader_email) = ?2 OR lower(d.head_email) = ?2)
        LIMIT 1`,
    )
    .bind(roomId, me)
    .first());
};

// Is the caller a member of the OWNING DEPARTMENT of this meeting's project —
// i.e. their division == the project's leading division (anh Luân 06-16: "dự án
// của phòng này làm chủ, phòng khác không nhảy vô start được")? This is the
// acting-host scope: a same-department internal may Start a scheduled meeting
// when the host is absent; a cross-department invitee may NOT. Ad-hoc meetings
// (no project / no lead division) match nobody here — the organizer/internal
// fallback in the PATCH handles those.
const isOwningDeptMember = async (
  db: D1Database,
  roomId: string,
  email: string | undefined,
): Promise<boolean> => {
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  return !!(await db
    .prepare(
      `SELECT 1 FROM meeting m
         JOIN project p ON p.id = m.project_id
         JOIN user_division ud ON ud.division_id = p.lead_division_id
        WHERE m.id = ?1 AND lower(ud.email) = ?2
        LIMIT 1`,
    )
    .bind(roomId, me)
    .first());
};

// May the caller MANAGE a meeting's people (invite, set co-host, edit)? This is
// the "meeting authority" set (anh Luân 06-15: "mời phải đúng chuẩn role"):
// admin · organizer · designated host · a co-host · or project authority
// (leader / head — deputy dropped 06-16). A plain invited participant who can
// merely SEE the meeting must NOT invite others. Legacy rows with no
// organizer_email fall back to internal-allow (so pre-organizer meetings
// aren't unmanageable).
const isMeetingManager = async (
  db: D1Database,
  roomId: string,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => {
  if (role === "admin") {
    return true;
  }
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  const row = await db
    .prepare(
      `SELECT
         (SELECT organizer_email FROM meeting WHERE id = ?1) AS organizer,
         (SELECT 1 FROM meeting
            WHERE id = ?1 AND lower(host_email) = ?2) AS host,
         (SELECT 1 FROM meeting_invitee
            WHERE meeting_id = ?1 AND email = ?2
              AND role = 'cohost' AND status <> 'revoked') AS cohost`,
    )
    .bind(roomId, me)
    .first<{
      organizer: string | null;
      host: number | null;
      cohost: number | null;
    }>();
  const isOrganizer = row?.organizer
    ? row.organizer.toLowerCase() === me
    : isInternalEmail(me); // legacy fallback (no organizer recorded)
  if (isOrganizer || row?.host || row?.cohost) {
    return true;
  }
  return isMeetingProjectAuthority(db, roomId, me);
};

// Per-meeting authz gate on every per-room blob/meeting route. Closes the hole
// where any valid JWT could read room_key + scene + chat + library + files for
// ANY meeting (Daily-token gating alone left the canvas wide open). Internal
// staff + admins pass (open dev flow); EXTERNAL guests are restricted to
// meetings they were invited to. roomId is path segment 3 for all these paths.
const roomGate: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const roomId = c.req.path.split("/")[3];
  if (
    roomId &&
    !(await canSeeMeeting(c.env.DB, c.get("email"), c.get("role"), roomId))
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  // Review of a FINISHED meeting is internal-only (quyết định 06-11): guests
  // lose access once the meeting ends — the host shares a packaged recap
  // with externals separately (later phase). Checked only for guests so the
  // common internal path pays no extra query.
  const email = c.get("email");
  if (roomId && c.get("role") !== "admin" && !isInternalEmail(email)) {
    const row = await c.env.DB.prepare(
      `SELECT status FROM meeting WHERE id = ?1`,
    )
      .bind(roomId)
      .first<{ status: string | null }>();
    if (normalizeStatus(row?.status) === "finished") {
      return c.json({ error: "finished — review is internal only" }, 403);
    }
  }
  return next();
};
app.use("/v1/scenes/*", roomGate);
app.use("/v1/chats/*", roomGate);
app.use("/v1/library/*", roomGate);
app.use("/v1/files/*", roomGate);
app.use("/v1/transcripts/*", roomGate);
app.use("/v1/meetings/:roomId", roomGate);
app.use("/v1/meetings/:roomId/*", roomGate);

app.get("/v1/health", (c) => c.json({ ok: true }));

// Runtime config for ANY authenticated user — the live internal-domain list
// (admin-editable system setting), so the client's internal/guest DISPLAY
// matches what authz actually enforces instead of a client-side hardcode.
// The JWT middleware already refreshed the per-isolate cache this request.
app.get("/v1/config", (c) => c.json({ internal_domains: internalDomains }));

// ---- Scene (canvas) blob -------------------------------------------------

app.put("/v1/scenes/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  // A deleted meeting stays deleted — without this, a client still holding
  // the room open re-creates the registry row via the upsert below (P0.5).
  if (await isDeletedMeeting(c.env.DB, roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  // Finished + past the grace window — review-only, no scene rewrites.
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  const key = sceneKey(roomId);
  await c.env.BUCKET.put(key, body);

  // Upsert the meeting row so the folder UI sees it + its freshness.
  const ts = now();
  const title = c.req.query("title") ?? null;
  // A scene autosave may carry a projectId for a FRESH room — don't let it file
  // the room into a project the caller can't reach (the meeting-create gate is
  // bypassed on this path). Strip (not 403) so the save itself still succeeds;
  // an existing row's project_id is preserved by COALESCE regardless. (Audit H2.)
  let projectId = c.req.query("projectId") ?? null;
  if (projectId) {
    const acc = await projectAccess(
      c.env.DB,
      c.get("email"),
      c.get("role"),
      projectId,
    );
    if (acc !== "full") {
      projectId = null;
    }
  }
  await c.env.DB.prepare(
    `INSERT INTO meeting (id, project_id, title, scene_r2_key, scene_updated_at, created_at, updated_at, realtime_backend)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, 'do')
     ON CONFLICT(id) DO UPDATE SET
       scene_r2_key = excluded.scene_r2_key,
       scene_updated_at = excluded.scene_updated_at,
       updated_at = excluded.updated_at,
       project_id = COALESCE(meeting.project_id, excluded.project_id),
       title = COALESCE(meeting.title, excluded.title)`,
  )
    .bind(roomId, projectId, title, key, ts)
    .run();

  return c.json({ ok: true, key, updatedAt: ts });
});

app.get("/v1/scenes/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const obj = await c.env.BUCKET.get(sceneKey(roomId));
  if (!obj) {
    // 204, not 404: a brand-new room legitimately has no blob yet, and the
    // browser logs every 4xx as console noise. Loaders treat an empty body
    // exactly like "nothing stored". (Same for chats/transcripts/library.)
    return c.body(null, 204);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

// ---- Chat history blob ---------------------------------------------------
// Per-room encrypted chat log (E2E with the room key, like the scene). Lets
// a reopened meeting — especially a finished one in read-only review — show
// its past conversation. R2 only; no D1 row needed.

app.put("/v1/chats/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  if (await isDeletedMeeting(c.env.DB, roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  await c.env.BUCKET.put(chatKey(roomId), body);
  return c.json({ ok: true });
});

// ---- Transcript blob (P0.3 — quyết định 06-10 #4) -------------------------
// The full STT transcript, E2E-encrypted with the room key exactly like the
// chat log (server relays bytes, never reads them). Previously localStorage-
// only — outside the server/admin boundary, lost on browser wipe. The
// QUERYABLE artifact is the AI summary (D1 `meeting.ai_summary`, see the
// summary route); this blob is the detail layer opened from review mode.

app.put("/v1/transcripts/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  if (await isDeletedMeeting(c.env.DB, roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  await c.env.BUCKET.put(transcriptKey(roomId), body);
  return c.json({ ok: true });
});

app.get("/v1/transcripts/:roomId", async (c) => {
  const obj = await c.env.BUCKET.get(transcriptKey(c.req.param("roomId")));
  if (!obj) {
    return c.body(null, 204);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

app.get("/v1/chats/:roomId", async (c) => {
  const obj = await c.env.BUCKET.get(chatKey(c.req.param("roomId")));
  if (!obj) {
    return c.body(null, 204);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

// ---- Library manifest blob -----------------------------------------------
// The full meeting library (DXF / IFC / PDF source bytes + metadata) as one
// encrypted blob, so a reopen restores material the scene's native file map
// doesn't carry. R2 only; no D1 row.

app.put("/v1/library/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  if (await isDeletedMeeting(c.env.DB, roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  await c.env.BUCKET.put(libraryKey(roomId), body);
  return c.json({ ok: true });
});

app.get("/v1/library/:roomId", async (c) => {
  const obj = await c.env.BUCKET.get(libraryKey(c.req.param("roomId")));
  if (!obj) {
    return c.body(null, 204);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

// ---- Library file bytes --------------------------------------------------

app.put("/v1/files/:roomId/:fileId", async (c) => {
  const roomId = c.req.param("roomId");
  const fileId = c.req.param("fileId");
  if (await isDeletedMeeting(c.env.DB, roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  const key = fileKey(roomId, fileId);
  await c.env.BUCKET.put(key, body);

  const ts = now();
  const kind = c.req.header("x-kind") ?? null;
  const name = c.req.header("x-name") ?? null;
  // Same guard as scene autosave: a file upload's projectId can't file the room
  // into a project the caller can't reach. Strip rather than 403. (Audit H2.)
  let projectId = c.req.query("projectId") ?? null;
  if (projectId) {
    const acc = await projectAccess(
      c.env.DB,
      c.get("email"),
      c.get("role"),
      projectId,
    );
    if (acc !== "full") {
      projectId = null;
    }
  }
  await c.env.DB.prepare(
    `INSERT INTO file (id, meeting_id, project_id, kind, name, size, r2_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       size = excluded.size, r2_key = excluded.r2_key`,
  )
    .bind(fileId, roomId, projectId, kind, name, body.byteLength, key, ts)
    .run();

  return c.json({ ok: true, key });
});

app.get("/v1/files/:roomId/:fileId", async (c) => {
  const obj = await c.env.BUCKET.get(
    fileKey(c.req.param("roomId"), c.req.param("fileId")),
  );
  if (!obj) {
    // 204, not 404 — mirrors the scene/chat/transcript GET routes. A missing
    // file blob is a normal race, not an error: app-generated decorations
    // (`mcm-deco-…`) are uploaded best-effort by the throttled collab file
    // queue, so a peer can legitimately request one a beat before it lands in
    // R2 (or for a scene that referenced a never-uploaded/since-trashed file).
    // 404 spammed the browser console AND marked the image permanently errored
    // (broken thumbnail). The loader treats an empty body as "nothing stored"
    // and simply skips that file. (B2, 06-17.)
    return c.body(null, 204);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

// ---- Projects (folders) --------------------------------------------------

// Create a project. INTERNAL action (guests never own folders); the owner is
// the verified JWT email — and they get a project_member row IN THE SAME
// REQUEST. Without that row the membership-scoped GET /v1/projects can't see
// the project the user just created (the "tạo project xong biến mất" bug:
// migration 0008 only backfilled owners for projects existing at the time).
app.post("/v1/projects", async (c) => {
  const email = c.get("email");
  const role = c.get("role");
  // Any INTERNAL user may open a project (anh Luân 06-16): the creator is
  // auto-written as leader + 'owner' member below, so it's a self-contained
  // personal folder that grants no cross-project power. The division HEAD still
  // auto-manages every project their division leads. Guests never own folders.
  if (!(await canCreateProject(c.env.DB, email, role))) {
    return c.json({ error: "internal users only" }, 403);
  }
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) {
    return c.json({ error: "name required" }, 400);
  }
  const owner = email?.toLowerCase() ?? null;
  const id = crypto.randomUUID();
  const ts = now();
  // The creator is the project leader; the leading division defaults to their
  // home department (user_division) so that department's HEAD inherits manage
  // (Phase 2). NULL division if the creator isn't mapped — leader/admin-managed.
  await c.env.DB.prepare(
    `INSERT INTO project
       (id, name, host_email, leader_email, lead_division_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3,
             (SELECT division_id FROM user_division WHERE email = ?3), ?4, ?4)`,
  )
    .bind(id, name.trim(), owner, ts)
    .run();
  if (owner) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO project_member
         (project_id, email, role, added_by, added_at)
       VALUES (?1, ?2, 'owner', ?2, ?3)`,
    )
      .bind(id, owner, ts)
      .run();
  }
  return c.json({ id, name: name.trim(), hostEmail: owner });
});

// Visibility: admins see ALL projects. Everyone else sees the projects they
// are a project_member of (access:"member") PLUS — internal users only — the
// projects where they were invited to / attended at least one meeting
// (access:"invitee", the "phòng ban khác mời mình 1 cuộc họp" case; the
// folder then shows ONLY those meetings, enforced by the meetings route).
// Guests never get folders; their surface stays /v1/me/invitations.
app.get("/v1/projects", async (c) => {
  const host = c.req.query("host");
  const isAdmin = c.get("role") === "admin";
  const cols = `id, name, host_email, leader_email, lead_division_id, code, client, location, stage, type, branch, cover, description, color, icon, created_at, updated_at`;
  if (isAdmin) {
    const stmt = host
      ? c.env.DB.prepare(
          `SELECT ${cols} FROM project
           WHERE host_email = ?1 ORDER BY updated_at DESC`,
        ).bind(host)
      : c.env.DB.prepare(
          `SELECT ${cols} FROM project ORDER BY updated_at DESC LIMIT 200`,
        );
    const { results } = await stmt.all();
    // Admin manages every project — the client gates its management UI on
    // can_manage (see canManageProject; admin short-circuits to true).
    return c.json({
      projects: (results as Record<string, unknown>[]).map((p) => ({
        ...p,
        my_role: "admin",
        can_manage: true,
        is_leadership: true,
        can_assign_leader: true,
      })),
    });
  }
  const email = c.get("email");
  if (!email) {
    return c.json({ projects: [] });
  }
  const e = email.toLowerCase();
  const mcols = cols
    .split(", ")
    .map((col) => `p.${col}`)
    .join(", ");
  // pm.role rides along so the client can gate management (can_manage) and
  // render the viewer's own badge without a second round-trip. is_leader/is_head
  // (Phase 2) extend manage to the project leader + leading-division head, and
  // is_head gates the "assign leader" UI.
  const leadCols = `(lower(p.leader_email) = ?1) AS is_leader,
         (lower(d.head_email) = ?1) AS is_head`;
  const memberStmt = host
    ? c.env.DB.prepare(
        `SELECT ${mcols}, pm.role AS my_role, ${leadCols} FROM project p
         JOIN project_member pm ON pm.project_id = p.id AND pm.email = ?1
         LEFT JOIN division d ON d.id = p.lead_division_id
         WHERE p.host_email = ?2 ORDER BY p.updated_at DESC`,
      ).bind(e, host)
    : c.env.DB.prepare(
        `SELECT ${mcols}, pm.role AS my_role, ${leadCols} FROM project p
         JOIN project_member pm ON pm.project_id = p.id AND pm.email = ?1
         LEFT JOIN division d ON d.id = p.lead_division_id
         ORDER BY p.updated_at DESC LIMIT 200`,
      ).bind(e);
  const { results: memberRows } = await memberStmt.all<
    Record<string, unknown>
  >();
  const projects: Record<string, unknown>[] = memberRows.map((p) => ({
    ...p,
    access: "member",
    // Manage = manager-tier role OR project leader OR leading-division head
    // (mirrors canManageProject). Leadership EXCLUDES a plain co-operator
    // ('manager') — it gates delete + delegating co-operators. Assign-leader =
    // head only (admin handled above).
    can_manage:
      p.my_role === "owner" ||
      p.my_role === "manager" ||
      !!p.is_leader ||
      !!p.is_head,
    is_leadership: p.my_role === "owner" || !!p.is_leader || !!p.is_head,
    can_assign_leader: !!p.is_head,
  }));
  if (isInternalEmail(e) && !host) {
    const memberIds = new Set(projects.map((p) => p.id as string));
    // Phase 2 LEAD arm: projects the caller leads or whose division they head,
    // but isn't a member of — surfaced so a head sees every project their
    // division leads on their own dashboard, with full manage.
    const { results: leadRows } = await c.env.DB.prepare(
      `SELECT ${mcols}, ${leadCols} FROM project p
       LEFT JOIN division d ON d.id = p.lead_division_id
       WHERE lower(p.leader_email) = ?1 OR lower(d.head_email) = ?1
       ORDER BY p.updated_at DESC LIMIT 200`,
    )
      .bind(e)
      .all<Record<string, unknown>>();
    for (const p of leadRows) {
      if (!memberIds.has(p.id as string)) {
        memberIds.add(p.id as string);
        projects.push({
          ...p,
          access: "lead",
          can_manage: true,
          is_leadership: true,
          can_assign_leader: !!p.is_head,
        });
      }
    }
    const { results: invitedRows } = await c.env.DB.prepare(
      // Participant arm carries the revoked-invite VETO (see projectAccess).
      `SELECT DISTINCT ${mcols} FROM project p
       JOIN meeting m ON m.project_id = p.id
       WHERE EXISTS (SELECT 1 FROM meeting_invitee mi
                     WHERE mi.meeting_id = m.id AND mi.email = ?1
                       AND mi.status <> 'revoked')
          OR (EXISTS (SELECT 1 FROM meeting_participant mp
                      WHERE mp.meeting_id = m.id AND lower(mp.user_email) = ?1)
              AND NOT EXISTS (SELECT 1 FROM meeting_invitee mr
                              WHERE mr.meeting_id = m.id AND mr.email = ?1
                                AND mr.status = 'revoked'))
       ORDER BY p.updated_at DESC LIMIT 200`,
    )
      .bind(e)
      .all<Record<string, unknown>>();
    for (const p of invitedRows) {
      if (!memberIds.has(p.id as string)) {
        // Invitee = participate-only on someone else's folder; never manage.
        projects.push({
          ...p,
          access: "invitee",
          can_manage: false,
          is_leadership: false,
          can_assign_leader: false,
        });
      }
    }
  }
  return c.json({ projects });
});

// Editing a project's metadata is a MANAGE privilege — admin, owner (leader),
// or a delegated manager (canManageProject). Plain members browse + create
// meetings but never reshape the folder. Closes audit finding #4 (any valid
// JWT could PATCH any project).
app.patch("/v1/projects/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{
    name?: string;
    code?: string;
    client?: string;
    location?: string;
    stage?: string;
    type?: string;
    branch?: string;
    cover?: string;
    description?: string;
    // Accent colour (hex) + icon (emoji/id) — COSMETIC personalisation, NOT
    // content. Mirrors meeting.color's exempt guard: a colour/icon-only PATCH
    // skips the owner-only check so any member can tint their folder.
    color?: string;
    icon?: string;
  }>();
  // Owner-only applies to CONTENT edits (name/code/.../description). `color`
  // and `icon` are deliberately exempt — same rationale as meeting colour
  // (cosmetic shared accent, not a folder reshape).
  const touchesContent =
    b.name !== undefined ||
    b.code !== undefined ||
    b.client !== undefined ||
    b.location !== undefined ||
    b.stage !== undefined ||
    b.type !== undefined ||
    b.branch !== undefined ||
    b.cover !== undefined ||
    b.description !== undefined;
  if (
    touchesContent &&
    !(await canManageProject(c.env.DB, id, c.get("email"), c.get("role")))
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE project SET
       name = COALESCE(?2, name),
       code = COALESCE(?3, code),
       client = COALESCE(?4, client),
       location = COALESCE(?5, location),
       stage = COALESCE(?6, stage),
       type = COALESCE(?7, type),
       branch = COALESCE(?8, branch),
       cover = COALESCE(?9, cover),
       description = COALESCE(?10, description),
       color = COALESCE(?12, color),
       icon = COALESCE(?13, icon),
       updated_at = ?11
     WHERE id = ?1`,
  )
    .bind(
      id,
      b.name ?? null,
      b.code ?? null,
      b.client ?? null,
      b.location ?? null,
      b.stage ?? null,
      b.type ?? null,
      b.branch ?? null,
      b.cover ?? null,
      b.description ?? null,
      now(),
      b.color ?? null,
      b.icon ?? null,
    )
    .run();
  return c.json({ ok: true });
});

// Delete a project (LEADERSHIP — admin, leader, or leading-division head; NOT a
// delegated manager). A non-admin can only delete an EMPTY project — its
// meetings must be disposed of first through the meeting lifecycle (cancel →
// delete), so a folder delete can never silently take finished meetings with it.
// Admins may force-cascade (ops/repair).
app.delete("/v1/projects/:id", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email");
  const isAdmin = c.get("role") === "admin";
  if (!(await isProjectLeadership(c.env.DB, id, email, c.get("role")))) {
    return c.json({ error: "leadership only" }, 403);
  }
  const exists = await c.env.DB.prepare(`SELECT 1 FROM project WHERE id = ?1`)
    .bind(id)
    .first();
  if (!exists) {
    return c.json({ error: "not found" }, 404);
  }
  const { results: meetings } = await c.env.DB.prepare(
    `SELECT id FROM meeting WHERE project_id = ?1`,
  )
    .bind(id)
    .all<{ id: string }>();
  if (meetings.length && !isAdmin) {
    return c.json(
      {
        error: "project has meetings — delete them first",
        count: meetings.length,
      },
      409,
    );
  }
  for (const m of meetings) {
    await deleteMeetingCascade(c.env, m.id, email);
  }
  await c.env.DB.prepare(`DELETE FROM project_member WHERE project_id = ?1`)
    .bind(id)
    .run();
  await c.env.DB.prepare(`DELETE FROM project WHERE id = ?1`).bind(id).run();
  await logAudit(c.env.DB, email, "project.delete", id, {
    meetings: meetings.length,
  });
  return c.json({ ok: true, deleted: id });
});

// Member roster — anyone with FULL access (members see who shares the folder).
app.get("/v1/projects/:id/members", async (c) => {
  const id = c.req.param("id");
  const access = await projectAccess(
    c.env.DB,
    c.get("email"),
    c.get("role"),
    id,
  );
  if (access !== "full") {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT email, role, added_by, added_at FROM project_member
     WHERE project_id = ?1 ORDER BY role DESC, added_at ASC`,
  )
    .bind(id)
    .all();
  return c.json({ members: results });
});

// Add members (admin/owner/manager; INTERNAL emails only — a client is never a
// project member, confidentiality by construction). A delegated manager may
// help add participants (canManageProject), not just the owner.
app.post("/v1/projects/:id/members", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email");
  if (!(await canManageProject(c.env.DB, id, email, c.get("role")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const b = await c.req.json<{ emails?: string[] }>();
  const t = now();
  let added = 0;
  for (const raw of b.emails ?? []) {
    const m = (raw || "").trim().toLowerCase();
    if (!isInternalEmail(m)) {
      continue;
    }
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO project_member
         (project_id, email, role, added_by, added_at)
       VALUES (?1, ?2, 'member', ?3, ?4)`,
    )
      .bind(id, m, email ?? null, t)
      .run();
    added++;
  }
  await logAudit(c.env.DB, email, "project.member.add", id, { added });
  return c.json({ ok: true, added });
});

// Remove a member (admin/owner/manager). The LAST owner is unremovable — a
// project must never become ownerless.
app.delete("/v1/projects/:id/members/:email", async (c) => {
  const id = c.req.param("id");
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const email = c.get("email");
  if (!(await canManageProject(c.env.DB, id, email, c.get("role")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const row = await c.env.DB.prepare(
    `SELECT role FROM project_member WHERE project_id = ?1 AND email = ?2`,
  )
    .bind(id, target)
    .first<{ role: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  if (row.role === "owner") {
    const owners = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_member
       WHERE project_id = ?1 AND role = 'owner'`,
    )
      .bind(id)
      .first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) {
      return c.json({ error: "cannot remove the last owner" }, 409);
    }
  }
  await c.env.DB.prepare(
    `DELETE FROM project_member WHERE project_id = ?1 AND email = ?2`,
  )
    .bind(id, target)
    .run();
  await logAudit(c.env.DB, email, "project.member.remove", id, {
    email: target,
  });
  return c.json({ ok: true });
});

// Promote/demote a delegated MANAGER. Gated to LEADERSHIP (admin · leader ·
// leading-division head) — a manager cannot mint other managers. Body
// {role:'manager'|'member'}; 'owner' is NOT settable here (leader hand-off is
// the separate /leader route) and an OWNER row can't be re-roled via this route.
app.patch("/v1/projects/:id/members/:email/role", async (c) => {
  const id = c.req.param("id");
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const email = c.get("email");
  if (!(await isProjectLeadership(c.env.DB, id, email, c.get("role")))) {
    return c.json({ error: "leadership only" }, 403);
  }
  const b = await c.req
    .json<{ role?: string }>()
    .catch(() => ({} as { role?: string }));
  const next = b.role;
  if (next !== "manager" && next !== "member") {
    return c.json({ error: "invalid role" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT role FROM project_member WHERE project_id = ?1 AND email = ?2`,
  )
    .bind(id, target)
    .first<{ role: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  // An owner (leader) is never demoted to manager/member through this route —
  // that would silently strip leadership. Hand-off is a separate flow.
  if (row.role === "owner") {
    return c.json({ error: "cannot change an owner's role" }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE project_member SET role = ?3
     WHERE project_id = ?1 AND email = ?2`,
  )
    .bind(id, target, next)
    .run();
  await logAudit(c.env.DB, email, "project.member.role", id, {
    email: target,
    role: next,
  });
  return c.json({ ok: true, role: next });
});

// Assign / replace the project LEADER. ONLY the leading-division HEAD (or admin)
// may do this — a leader can't hand off their own leadership (anh Luân 06-15:
// "division head sẽ assign project leader"). Body {email}: an INTERNAL staff
// email; it becomes project.leader_email (which grants full manage via
// canManageProject) and is ensured to be a project_member so they show in the
// roster. The previous leader keeps any explicit member role they already had.
app.patch("/v1/projects/:id/leader", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email");
  if (!(await isDivisionHeadOfProject(c.env.DB, id, email, c.get("role")))) {
    return c.json({ error: "division head only" }, 403);
  }
  const b = await c.req
    .json<{ email?: string }>()
    .catch(() => ({} as { email?: string }));
  const leader = (b.email ?? "").trim().toLowerCase();
  if (!leader || !isInternalEmail(leader)) {
    return c.json({ error: "internal email required" }, 400);
  }
  const exists = await c.env.DB.prepare(`SELECT 1 FROM project WHERE id = ?1`)
    .bind(id)
    .first();
  if (!exists) {
    return c.json({ error: "not found" }, 404);
  }
  const ts = now();
  // Keep project_member.role='owner' IN SYNC with leader_email, so every surface
  // (roster badge, my_role, can_manage) shows the new leader as "Trưởng dự án"
  // and the previous leader as a co-operator — not still "participant" (the bug
  // anh Luân hit). Demote the old owner(s) first, then promote the new leader.
  await c.env.DB.prepare(
    `UPDATE project_member SET role = 'manager'
      WHERE project_id = ?1 AND role = 'owner' AND email <> ?2`,
  )
    .bind(id, leader)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO project_member (project_id, email, role, added_by, added_at)
     VALUES (?1, ?2, 'owner', ?3, ?4)
     ON CONFLICT(project_id, email) DO UPDATE SET role = 'owner'`,
  )
    .bind(id, leader, email ?? null, ts)
    .run();
  await c.env.DB.prepare(
    `UPDATE project SET leader_email = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(id, leader, ts)
    .run();
  await logAudit(c.env.DB, email, "project.leader", id, { email: leader });
  return c.json({ ok: true, leader });
});

// The division catalogue — id + name + head (+ dormant deputy column). Internal
// users read it to resolve the project's leading-department NAME (read-only
// display) and to know whether THEY are the division HEAD. deputy_email is kept
// on the wire for back-compat but confers NO power since 06-16 (admin = head
// only); the client ignores it. Guests get nothing.
app.get("/v1/divisions", async (c) => {
  if (!(c.get("role") === "admin" || isInternalEmail(c.get("email")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, head_email, deputy_email FROM division
      ORDER BY name COLLATE NOCASE`,
  ).all();
  return c.json({ divisions: results });
});

// Meetings of a project, scoped by access level: "full" (member/admin) sees
// everything; "partial" (internal user invited to / attended some meetings)
// sees ONLY those meetings — the rest of the project stays invisible. The
// per-meeting roomGate still guards the actual blobs.
app.get("/v1/projects/:projectId/meetings", async (c) => {
  const projectId = c.req.param("projectId");
  const access = await projectAccess(
    c.env.DB,
    c.get("email"),
    c.get("role"),
    projectId,
  );
  if (!access) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cols = `m.id, m.title, m.topic, m.type, m.status, m.created_by,
            m.organizer_email, m.thumbnail, m.participant_count, m.duration_s,
            m.scene_updated_at, m.updated_at, m.last_opened_at, m.discipline,
            m.priority, m.confidentiality, m.scheduled_at, m.color, m.icon`;
  // Confidential meetings stay invisible to plain project members in the
  // folder list too — only organizer/host/invitee (and admins) see the card.
  // Mirrors the canSeeMeeting enforcement (quyết định 06-10 #3).
  const confFilter = `(lower(COALESCE(m.confidentiality,'')) <> 'confidential'
             OR lower(COALESCE(m.organizer_email,'')) = ?2
             OR lower(COALESCE(m.host_email,'')) = ?2
             OR EXISTS (SELECT 1 FROM meeting_invitee mi
                        WHERE mi.meeting_id = m.id AND mi.email = ?2
                          AND mi.status <> 'revoked'))`;
  const stmt =
    access === "full"
      ? c.get("role") === "admin"
        ? c.env.DB.prepare(
            `SELECT ${cols} FROM meeting m
             WHERE m.project_id = ?1 ORDER BY m.updated_at DESC`,
          ).bind(projectId)
        : c.env.DB.prepare(
            `SELECT ${cols} FROM meeting m
             WHERE m.project_id = ?1 AND ${confFilter}
             ORDER BY m.updated_at DESC`,
          ).bind(projectId, c.get("email")?.toLowerCase() ?? "")
      : c.env.DB.prepare(
          // Participant arm carries the revoked-invite VETO (projectAccess).
          `SELECT ${cols} FROM meeting m
           WHERE m.project_id = ?1
             AND (EXISTS (SELECT 1 FROM meeting_invitee mi
                          WHERE mi.meeting_id = m.id AND mi.email = ?2
                            AND mi.status <> 'revoked')
                  OR (EXISTS (SELECT 1 FROM meeting_participant mp
                              WHERE mp.meeting_id = m.id
                                AND lower(mp.user_email) = ?2)
                      AND NOT EXISTS (SELECT 1 FROM meeting_invitee mr
                                      WHERE mr.meeting_id = m.id
                                        AND mr.email = ?2
                                        AND mr.status = 'revoked')))
           ORDER BY m.updated_at DESC`,
        ).bind(projectId, c.get("email")?.toLowerCase() ?? "");
  const { results } = await stmt.all();
  return c.json({ meetings: results });
});

// ---- Meetings (registry) -------------------------------------------------

// Create/upsert a meeting in ONE atomic call — including its lifecycle fields,
// so a scheduled meeting can never exist half-registered (the old flow was
// register → separate PATCH for organizer/status; if the PATCH failed the
// meeting had no owner). The ORGANIZER is the verified JWT email, never a
// client-supplied value; host_email starts as the organizer (the design's
// default — acting-host is runtime-only and never persisted).
app.post("/v1/meetings", async (c) => {
  // Creating meetings is an INTERNAL action (mọi user nội bộ tạo được —
  // guests never create; they only join what they're invited to).
  if (!(c.get("role") === "admin" || isInternalEmail(c.get("email")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const b = await c.req.json<{
    roomId: string;
    roomKey?: string;
    projectId?: string;
    title?: string;
    createdBy?: string;
    thumbnail?: string;
    status?: string;
    scheduledAt?: string;
    durationMin?: number;
    // Full create payload (form tạo = form edit): agenda metadata, a
    // designated HOST (internal email — defaults to the organizer), and the
    // per-meeting policies.
    topic?: string;
    description?: string;
    type?: string;
    discipline?: string;
    priority?: string;
    confidentiality?: string;
    hostEmail?: string;
    waitingRoom?: boolean;
    recordingEnabled?: boolean;
  }>();
  if (!b.roomId) {
    return c.json({ error: "roomId required" }, 400);
  }
  // ORGANIZING a meeting inside a project is a MANAGEMENT act (anh Luân 06-15:
  // "co-operator chịu trách nhiệm tổ chức cuộc họp"): only the project's
  // managers — admin · head · leader · co-operator (deputy dropped 06-16) — may
  // create one.
  // A plain participate-only member joins meetings, doesn't open them. This
  // also closes audit H2 (can't inject a card into a foreign department's
  // folder — canManageProject is strictly tighter than membership).
  if (b.projectId) {
    if (
      !(await canManageProject(
        c.env.DB,
        b.projectId,
        c.get("email"),
        c.get("role"),
      ))
    ) {
      return c.json({ error: "forbidden project" }, 403);
    }
  }
  if (await isDeletedMeeting(c.env.DB, b.roomId)) {
    return c.json({ error: "meeting deleted" }, 410);
  }
  // A meeting is only ever BORN scheduled or live — terminal states are
  // reached through the PATCH state machine, never at create.
  const status = b.status === undefined ? null : normalizeStatus(b.status);
  if (b.status !== undefined && status !== "scheduled" && status !== "live") {
    return c.json({ error: "invalid status" }, 400);
  }
  const organizer = c.get("email")?.toLowerCase() ?? null;
  // Host must be INTERNAL (a guest never hosts); anything else falls back to
  // the organizer — the design default.
  const hostEmail =
    b.hostEmail && isInternalEmail(b.hostEmail)
      ? b.hostEmail.toLowerCase()
      : organizer;
  const ts = now();
  // ON CONFLICT this is a RE-REGISTER of an existing meeting: only fill gaps
  // (NULL columns), NEVER overwrite — lifecycle (status/schedule) and
  // ownership (organizer/host) on an existing row move exclusively through
  // the guarded PATCH. Without meeting-first COALESCE here, one POST at an
  // existing id could rewrite a finished meeting or steal its room_key.
  await c.env.DB.prepare(
    `INSERT INTO meeting (id, project_id, title, created_by, room_key, thumbnail,
                          organizer_email, host_email, status, scheduled_at,
                          duration_min, topic, description, type, discipline,
                          priority, confidentiality, waiting_room,
                          recording_enabled, created_at, updated_at,
                          realtime_backend)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18, ?19, ?20, ?20, 'do')
     ON CONFLICT(id) DO UPDATE SET
       project_id = COALESCE(meeting.project_id, excluded.project_id),
       title      = COALESCE(meeting.title, excluded.title),
       room_key   = COALESCE(meeting.room_key, excluded.room_key),
       thumbnail  = COALESCE(meeting.thumbnail, excluded.thumbnail),
       organizer_email = COALESCE(meeting.organizer_email, excluded.organizer_email),
       host_email      = COALESCE(meeting.host_email, excluded.host_email),
       status          = COALESCE(meeting.status, excluded.status),
       scheduled_at    = COALESCE(meeting.scheduled_at, excluded.scheduled_at),
       duration_min    = COALESCE(meeting.duration_min, excluded.duration_min),
       topic           = COALESCE(meeting.topic, excluded.topic),
       description     = COALESCE(meeting.description, excluded.description),
       type            = COALESCE(meeting.type, excluded.type),
       discipline      = COALESCE(meeting.discipline, excluded.discipline),
       priority        = COALESCE(meeting.priority, excluded.priority),
       confidentiality = COALESCE(meeting.confidentiality, excluded.confidentiality),
       waiting_room      = COALESCE(meeting.waiting_room, excluded.waiting_room),
       recording_enabled = COALESCE(meeting.recording_enabled, excluded.recording_enabled),
       updated_at = excluded.updated_at`,
  )
    .bind(
      b.roomId,
      b.projectId ?? null,
      b.title ?? null,
      b.createdBy ?? null,
      b.roomKey ?? null,
      b.thumbnail ?? null,
      organizer,
      hostEmail,
      status,
      b.scheduledAt ?? null,
      b.durationMin ?? null,
      b.topic || null,
      b.description || null,
      b.type || null,
      b.discipline || null,
      b.priority || null,
      b.confidentiality || null,
      b.waitingRoom === undefined ? null : b.waitingRoom ? 1 : 0,
      b.recordingEnabled === undefined ? null : b.recordingEnabled ? 1 : 0,
      ts,
    )
    .run();
  return c.json({ ok: true, roomId: b.roomId });
});

app.get("/v1/meetings/:roomId", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.project_id, m.title, m.topic, m.description, m.type,
            m.status, m.discipline, m.priority, m.confidentiality,
            m.scheduled_at, m.duration_min, m.organizer_email, m.host_email,
            m.created_by, m.room_key, m.scene_r2_key,
            m.scene_updated_at, m.thumbnail, m.participant_count, m.duration_s,
            m.ai_summary, m.ai_summary_at, m.color, m.icon,
            m.realtime_backend,
            m.created_at, m.updated_at, m.last_opened_at,
            p.name AS project_name, p.stage AS project_stage
     FROM meeting m LEFT JOIN project p ON p.id = m.project_id
     WHERE m.id = ?1`,
  )
    .bind(c.req.param("roomId"))
    .first<Record<string, unknown>>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  // Does the VIEWER hold host-level authority over this meeting (admin, its
  // organizer/host, or the project leader / leading-division head)? The client
  // uses this to surface host controls (End / kick / mute) to a division head
  // even when socket host-election landed on someone else. Destructive lifecycle
  // moves are independently re-checked server-side (PATCH gate).
  const me = c.get("email")?.toLowerCase();
  const org = (row.organizer_email as string | null)?.toLowerCase();
  const hostEmail = (row.host_email as string | null)?.toLowerCase();
  let viewer_is_authority =
    c.get("role") === "admin" || (!!me && (me === org || me === hostEmail));
  if (!viewer_is_authority && me) {
    viewer_is_authority = await isMeetingProjectAuthority(
      c.env.DB,
      row.id as string,
      me,
    );
  }
  // May the viewer START this (scheduled) meeting — the acting-host scope?
  // Authority/organizer/host always; otherwise a co-host or a member of the
  // OWNING DEPARTMENT (same division as the project). Mirrors the PATCH live
  // gate so the client's Start button matches what the server will allow
  // (anh Luân 06-16: only the owning department starts, not any internal).
  let viewer_can_start = viewer_is_authority;
  if (!viewer_can_start && me) {
    viewer_can_start =
      (await isOwningDeptMember(c.env.DB, row.id as string, me)) ||
      !!(await c.env.DB.prepare(
        `SELECT 1 FROM meeting_invitee WHERE meeting_id = ?1 AND email = ?2
          AND role = 'cohost' AND status <> 'revoked' LIMIT 1`,
      )
        .bind(row.id as string, me)
        .first());
  }
  return c.json({
    meeting: { ...row, viewer_is_authority, viewer_can_start },
  });
});

app.patch("/v1/meetings/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const b = await c.req.json<{
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
    // User-assigned accent colour (nullable hex, e.g. "#6965db"). COALESCE:
    // omit to keep the current colour; the calendar + cards read it back.
    color?: string;
    // User-assigned icon (emoji/id) — same cosmetic class as `color`, same
    // guard exemption below.
    icon?: string;
  }>();

  // ---- Edit + lifecycle guard ---------------------------------------------
  // WHO may edit: meeting CONTENT (title/topic/schedule/metadata/host fields)
  // belongs to the ORGANIZER — "user tạo meeting mới edit được meeting".
  // Legacy rows without an organizer fall back to internal-allow. `color` is
  // deliberately exempt (cosmetic, shared calendar tint).
  // WHAT may change by state: finished = IMMUTABLE (every field — the review
  // invariant); cancelled = frozen except restore; status transitions follow
  // the state machine: scheduled→live (Start, any internal — acting-host) ·
  // live→finished (End for all) · scheduled→cancelled / cancelled→scheduled
  // (organizer). Admins bypass for ops/repair.
  const touchesContent =
    b.title !== undefined ||
    b.topic !== undefined ||
    b.description !== undefined ||
    b.type !== undefined ||
    b.discipline !== undefined ||
    b.priority !== undefined ||
    b.confidentiality !== undefined ||
    b.scheduled_at !== undefined ||
    b.duration_min !== undefined ||
    b.organizer_email !== undefined ||
    b.host_email !== undefined;
  // NOTE: `color` and `icon` are NOT in this guard — cosmetic shared accents
  // (the calendar tint / card icon), exempt from the finished-immutable rule,
  // so a colour/icon-only PATCH falls straight through to the UPDATE below
  // (even on a finished meeting). Including them here wrongly 409'd
  // "recolour a finished card".
  if (b.status !== undefined || touchesContent) {
    let next: string | null = null;
    if (b.status !== undefined) {
      next = normalizeStatus(b.status);
      if (!next) {
        return c.json({ error: "invalid status" }, 400);
      }
      b.status = next;
    }
    const role = c.get("role");
    if (role !== "admin") {
      const row = await c.env.DB.prepare(
        `SELECT status, organizer_email, host_email FROM meeting WHERE id = ?1`,
      )
        .bind(roomId)
        .first<{
          status: string | null;
          organizer_email: string | null;
          host_email: string | null;
        }>();
      if (!row) {
        return c.json({ error: "not found" }, 404);
      }
      const cur = normalizeStatus(row.status);
      const me = c.get("email")?.toLowerCase();
      const isOrganizer = row.organizer_email
        ? row.organizer_email.toLowerCase() === me
        : isInternalEmail(me);
      // The project LEADER / leading-division HEAD has full meeting authority —
      // edit, End, cancel — even on a meeting someone else created (anh Luân
      // 06-15: division head = full quyền ngang leader).
      const projAuthority = await isMeetingProjectAuthority(
        c.env.DB,
        roomId,
        me,
      );
      if (cur === "finished") {
        return c.json({ error: "meeting is finished (immutable)" }, 409);
      }
      if (touchesContent) {
        if (cur === "cancelled") {
          return c.json({ error: "cancelled — restore it first" }, 409);
        }
        if (!isOrganizer && !projAuthority) {
          return c.json({ error: "organizer only" }, 403);
        }
      }
      if (next && cur !== next) {
        // Lifecycle moves are an INTERNAL privilege across the board (Start =
        // acting-host rule, End = host, cancel/restore = organizer) — a guest
        // invitee passes roomGate but must never drive the state machine.
        if (!isInternalEmail(me)) {
          return c.json({ error: "internal only" }, 403);
        }
        const allowed =
          cur === null ||
          (cur === "scheduled" && (next === "live" || next === "cancelled")) ||
          (cur === "live" && next === "finished") ||
          (cur === "cancelled" && next === "scheduled");
        if (!allowed) {
          return c.json({ error: `cannot go ${cur} → ${next}` }, 409);
        }
        if (next === "live") {
          // Start = acting-host, but scoped to the OWNING DEPARTMENT (anh Luân
          // 06-16: "dự án của phòng này làm chủ, phòng khác không nhảy vô start
          // được"). A same-department internal, the organizer, the designated
          // host/co-host, or the project authority (leader/head) may start it —
          // a cross-department invitee may NOT. Ad-hoc meetings (no project)
          // have no owning dept, so the organizer/internal fallback applies.
          const isHostS =
            !!row.host_email && row.host_email.toLowerCase() === me;
          const isCohostS = !!(
            me &&
            (await c.env.DB.prepare(
              `SELECT 1 FROM meeting_invitee
                WHERE meeting_id = ?1 AND email = ?2
                  AND role = 'cohost' AND status <> 'revoked' LIMIT 1`,
            )
              .bind(roomId, me)
              .first())
          );
          const deptInsider = await isOwningDeptMember(c.env.DB, roomId, me);
          if (
            !isOrganizer &&
            !projAuthority &&
            !isHostS &&
            !isCohostS &&
            !deptInsider
          ) {
            return c.json(
              { error: "only the owning department may start this meeting" },
              403,
            );
          }
        }
        if (next === "finished") {
          // End-for-all is NOT the acting-host rule (quyết định 06-11): only
          // the designated host, a co-host invitee, or the organizer may end —
          // a random internal participant must not. Legacy rows without an
          // organizer keep the internal-allow fallback via isOrganizer above.
          const isHost =
            !!row.host_email && row.host_email.toLowerCase() === me;
          const isCohost = !!(
            me &&
            (await c.env.DB.prepare(
              `SELECT 1 FROM meeting_invitee
                WHERE meeting_id = ?1 AND email = ?2
                  AND role = 'cohost' AND status <> 'revoked' LIMIT 1`,
            )
              .bind(roomId, me)
              .first())
          );
          if (!isHost && !isCohost && !isOrganizer && !projAuthority) {
            return c.json(
              { error: "host, co-host, organizer or project lead only" },
              403,
            );
          }
        }
        if (next === "cancelled" || cur === "cancelled") {
          if (!isOrganizer && !projAuthority) {
            return c.json({ error: "organizer only" }, 403);
          }
        }
        // Commit the transition CONDITIONALLY on the status we just validated
        // — two concurrent transitions (Start vs Cancel) can't both win; the
        // loser sees 0 changed rows and 409s instead of silently overwriting.
        const res = await c.env.DB.prepare(
          `UPDATE meeting SET status = ?3, updated_at = ?4
           WHERE id = ?1 AND status IS ?2`,
        )
          .bind(roomId, row.status, next, now())
          .run();
        if (!res.meta.changes) {
          return c.json({ error: "status changed concurrently — retry" }, 409);
        }
        // Already written — keep the main UPDATE below status-neutral.
        b.status = undefined;
      }
    }
  }

  await c.env.DB.prepare(
    `UPDATE meeting SET
       title = COALESCE(?2, title),
       topic = COALESCE(?3, topic),
       description = COALESCE(?4, description),
       type = COALESCE(?5, type),
       status = COALESCE(?6, status),
       discipline = COALESCE(?7, discipline),
       priority = COALESCE(?8, priority),
       confidentiality = COALESCE(?9, confidentiality),
       scheduled_at = COALESCE(?10, scheduled_at),
       duration_min = COALESCE(?12, duration_min),
       organizer_email = COALESCE(?13, organizer_email),
       host_email = COALESCE(?14, host_email),
       color = COALESCE(?15, color),
       icon = COALESCE(?16, icon),
       updated_at = ?11
     WHERE id = ?1`,
  )
    .bind(
      roomId,
      b.title ?? null,
      b.topic ?? null,
      b.description ?? null,
      b.type ?? null,
      b.status ?? null,
      b.discipline ?? null,
      b.priority ?? null,
      b.confidentiality ?? null,
      b.scheduled_at ?? null,
      now(),
      b.duration_min ?? null,
      b.organizer_email ?? null,
      b.host_email ?? null,
      b.color ?? null,
      b.icon ?? null,
    )
    .run();
  return c.json({ ok: true });
});

// AI summary (quyết định 06-10 #4 — summary-first): written once at End-for-all
// (client calls the room server's /summarize, then stores the text here), kept
// in D1 — server-readable and QUERYABLE, the foundation for cross-meeting AI
// questions. Deliberately a SEPARATE route from PATCH: the meeting is finished
// (immutable) by the time the summary lands, and the summary is derived data,
// not meeting content. Internal-only; roomGate already vetted visibility.
app.post("/v1/meetings/:roomId/summary", async (c) => {
  if (!(c.get("role") === "admin" || isInternalEmail(c.get("email")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const roomId = c.req.param("roomId");
  const { summary } = await c.req.json<{ summary?: string }>();
  if (!summary?.trim()) {
    return c.json({ error: "summary required" }, 400);
  }
  // The auto-summary at End-for-all writes ONCE (ai_summary was NULL). A
  // reviewer must not regenerate-and-overwrite the stored recap — restrict
  // the write to the still-empty case. Admin bypasses for ops/repair.
  const isAdmin = c.get("role") === "admin";
  const res = await c.env.DB.prepare(
    isAdmin
      ? `UPDATE meeting SET ai_summary = ?2, ai_summary_at = ?3 WHERE id = ?1`
      : `UPDATE meeting SET ai_summary = ?2, ai_summary_at = ?3
         WHERE id = ?1 AND (ai_summary IS NULL OR ai_summary = '')`,
  )
    .bind(roomId, summary.trim().slice(0, 20_000), now())
    .run();
  if (!res.meta.changes) {
    // No row changed: either the meeting doesn't exist or a summary already
    // exists (reviewer overwrite blocked). Both are a no-op for the caller.
    return c.json({ ok: true, skipped: true });
  }
  return c.json({ ok: true });
});

// Log that the current user joined this meeting. The email comes from the
// VERIFIED JWT (can't be spoofed); the client only supplies a display name.
// Upsert: joined_at on first join, last_seen_at refreshed each call.
app.post("/v1/meetings/:roomId/participant", async (c) => {
  const roomId = c.req.param("roomId");
  const email = c.get("email");
  if (!email) {
    return c.json({ error: "no email" }, 400);
  }
  // Reviewing a finished meeting is NOT attending it — skip the row so we
  // don't pollute "attended" (history, activity log, partial project access).
  // 200-skip, NOT 409: a client race (the viewOnly atom flips a tick after
  // mount) can still fire this once, and a finished review is legitimate —
  // it's just a no-op, so don't paint the console red. Grace window keeps
  // END-time last_seen updates from peers still in the room.
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ ok: true, skipped: true });
  }
  let name: string | undefined;
  try {
    name = (await c.req.json<{ name?: string }>()).name;
  } catch {
    // body optional
  }
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO meeting_participant
       (meeting_id, user_email, name, joined_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(meeting_id, user_email) DO UPDATE SET
       last_seen_at = ?4,
       name = COALESCE(?3, name)`,
  )
    .bind(roomId, email, name ?? null, t)
    .run();
  return c.json({ ok: true });
});

// ---- Invite / membership (Phase 4.5) -------------------------------------
// Invite people to a meeting. Internal staff + admins can invite (dev rule).
// Each invitee gets a meeting_invitee row (the per-meeting grant). `addToProject`
// (internal emails only) also grants project membership — a client is NEVER
// auto-added to the project (confidentiality). See host-and-scheduling.md.
app.post("/v1/meetings/:roomId/invitees", async (c) => {
  const roomId = c.req.param("roomId");
  const email = c.get("email");
  const role = c.get("role");
  // Inviting people (and assigning co-host) is a MEETING-MANAGEMENT act — only
  // the organizer / host / a co-host / project authority / admin (anh Luân
  // 06-15: "mời phải đúng chuẩn role"). A plain participant who can merely SEE
  // the meeting must not invite others.
  if (!(await isMeetingManager(c.env.DB, roomId, email, role))) {
    return c.json({ error: "meeting manager only" }, 403);
  }
  const b = await c.req.json<{
    invitees?: { email: string; role?: string }[];
    addToProject?: string[];
  }>();
  const list = b.invitees ?? [];
  const meeting = await c.env.DB.prepare(
    `SELECT project_id, status FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first<{ project_id: string | null; status: string | null }>();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  // No invites into a terminal meeting — finished is immutable, a cancelled
  // one must be restored first.
  const mStatus = normalizeStatus(meeting.status);
  if (mStatus === "finished" || mStatus === "cancelled") {
    return c.json({ error: `meeting is ${mStatus}` }, 409);
  }
  const t = now();
  for (const inv of list) {
    const ie = (inv.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ie)) {
      continue;
    }
    const kind = isInternalEmail(ie) ? "internal" : "guest";
    await c.env.DB.prepare(
      `INSERT INTO meeting_invitee
         (meeting_id, email, kind, role, status, invited_by, invited_at)
       VALUES (?1, ?2, ?3, ?4, 'invited', ?5, ?6)
       ON CONFLICT(meeting_id, email) DO UPDATE SET
         status = 'invited', role = ?4, revoked_at = NULL`,
    )
      .bind(roomId, ie, kind, inv.role ?? "attendee", email ?? null, t)
      .run();
    // Keep each inviter's personal client list DB-synced: a GUEST email typed
    // by hand becomes a contact card for THE INVITER (name = email local part
    // until edited), so they can re-pick it later without retyping. Deduped per
    // (email, created_by) — not globally — because the book is now scoped to
    // created_by (06-15 audit H1): a global dedup would let the first inviter's
    // card suppress everyone else's, leaving them unable to see/reuse it.
    if (kind === "guest") {
      const existing = await c.env.DB.prepare(
        `SELECT 1 FROM client
          WHERE email = ?1 AND lower(created_by) = ?2 LIMIT 1`,
      )
        .bind(ie, (email ?? "").toLowerCase())
        .first();
      if (!existing) {
        await c.env.DB.prepare(
          `INSERT INTO client (id, name, company, email, note, created_by, created_at)
           VALUES (?1, ?2, NULL, ?3, NULL, ?4, ?5)`,
        )
          .bind(
            crypto.randomUUID(),
            ie.split("@")[0] || ie,
            ie,
            email ?? null,
            t,
          )
          .run();
      }
    }
  }
  // addToProject: grant project membership — internal only, never a client.
  if (meeting?.project_id && b.addToProject?.length) {
    for (const m of b.addToProject) {
      const me = (m || "").trim().toLowerCase();
      if (!isInternalEmail(me)) {
        continue;
      }
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO project_member
           (project_id, email, role, added_by, added_at)
         VALUES (?1, ?2, 'member', ?3, ?4)`,
      )
        .bind(meeting.project_id, me, email ?? null, t)
        .run();
    }
  }
  await logAudit(c.env.DB, email, "meeting.invite", roomId, {
    count: list.length,
  });
  return c.json({ ok: true });
});

// Revoke an invite (soft — keep the row for audit, treated as no-access).
// MEETING-MANAGER only (organizer / host / co-host / project authority / admin)
// — same rule as inviting; taking access away is managing the meeting's people.
// Finished meetings are immutable.
app.delete("/v1/meetings/:roomId/invitees/:email", async (c) => {
  const roomId = c.req.param("roomId");
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const email = c.get("email");
  const role = c.get("role");
  if (!(await isMeetingManager(c.env.DB, roomId, email, role))) {
    return c.json({ error: "meeting manager only" }, 403);
  }
  const meeting = await c.env.DB.prepare(
    `SELECT status, organizer_email FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first<{ status: string | null; organizer_email: string | null }>();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  if (role !== "admin") {
    if (normalizeStatus(meeting.status) === "finished") {
      return c.json({ error: "meeting is finished (immutable)" }, 409);
    }
  }
  await c.env.DB.prepare(
    `UPDATE meeting_invitee SET status = 'revoked', revoked_at = ?3
     WHERE meeting_id = ?1 AND email = ?2`,
  )
    .bind(roomId, target, now())
    .run();
  await logAudit(c.env.DB, email, "meeting.revoke", roomId, { email: target });
  return c.json({ ok: true });
});

// Provision a GUEST login account so an EXTERNAL invitee can sign in without
// any email delivery — the host then manually shares email + temp password +
// meeting link. Auth: an authenticated INTERNAL user OR admin (the same rule
// that gates inviting); external/guest callers are rejected. The target email
// MUST be external — internal accounts are never created here (use the admin
// console). The temp password is generated server-side, returned ONCE, and
// NEVER logged. If the account already exists we can't recover its password,
// so we report `existed: true` (no password) and the UI tells the host.
app.post("/v1/guests", async (c) => {
  const email = c.get("email");
  const role = c.get("role");
  if (!(role === "admin" || isInternalEmail(email))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ ok: false, error: "admin not configured" }, 503);
  }
  const b = await c.req
    .json<{ email?: string; name?: string }>()
    .catch(() => ({} as { email?: string; name?: string }));
  const guestEmail = (b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
    return c.json({ ok: false, error: "invalid email" }, 400);
  }
  // Creating INTERNAL accounts here is forbidden — this route is guest-only.
  if (isInternalEmail(guestEmail)) {
    return c.json({ ok: false, error: "email is internal" }, 400);
  }
  // Strong random temp password — base64url of 16 random bytes (~22 chars,
  // mixed case + digits + - _). Generated server-side, shown to the host once.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const password = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const name = (b.name || "").trim();
  const md: Record<string, unknown> = {};
  if (name) {
    md.display_name = name;
    md.name = name;
  }
  const res = await supaAdmin(cr.url, cr.key, "POST", "/admin/users", {
    email: guestEmail,
    password,
    email_confirm: true,
    app_metadata: { role: "guest" },
    user_metadata: md,
  });
  if (res.ok) {
    await logAudit(c.env.DB, email, "guest.create", guestEmail);
    // NOTE: never log `password`.
    return c.json({ ok: true, existed: false, email: guestEmail, password });
  }
  // Already registered → Supabase 422 / "already been registered". We can't
  // recover the existing password; tell the host the account already exists.
  const detail = await res.text();
  if (
    res.status === 422 ||
    /already.*registered|already exists/i.test(detail)
  ) {
    return c.json({ ok: true, existed: true, email: guestEmail });
  }
  return c.json({ ok: false, error: "create guest failed" }, 502);
});

// Email a guest their meeting link (+ optional login credentials) via Resend.
// Same gate as creating a guest: internal staff or admin only. Optional —
// hosts can still copy/paste the link manually if Resend isn't configured.
app.post("/v1/guests/send-invite", async (c) => {
  const email = c.get("email");
  const role = c.get("role");
  if (!(role === "admin" || isInternalEmail(email))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  const b = await c.req
    .json<{
      to?: string;
      link?: string;
      meetingTitle?: string;
    }>()
    .catch(() => ({} as Record<string, never>));
  const to = (b.to || "").trim();
  const link = (b.link || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !link) {
    return c.json({ ok: false, error: "invalid" }, 400);
  }
  // SECURITY (B4): never email login credentials — only the meeting link.
  const { subject, html, text } = guestInviteEmail({
    meetingTitle: b.meetingTitle,
    link,
    appName: "Canvas M",
  });
  const r = await sendEmail(
    {
      RESEND_API_KEY: c.env.RESEND_API_KEY ?? "",
      RESEND_FROM: c.env.RESEND_FROM ?? "",
    },
    { to, subject, html, text },
  );
  if (!r.ok) {
    return c.json({ ok: false, error: r.error ?? "send failed" }, 502);
  }
  await logAudit(c.env.DB, email, "guest.invite_email", to);
  return c.json({ ok: true, id: r.id });
});

// ---- Project-scoped guests (new guest-access model, 06-15) ---------------
// Guest access is PROJECT-SCOPED and INDEPENDENT per department — strict
// confidentiality BETWEEN departments. A host (a member/owner of the project)
// issues a SYNTHETIC Supabase login (never the guest's real email) + temp
// password scoped to ONE project; the guest follows that project across ALL
// its meetings. canSeeMeeting + /v1/me/meetings honour an `active` row. Admin
// has FULL power everywhere (lists/issues/resets/revokes for ANY project) and
// bypasses the per-department isolation.

// Gate for every project-guest route: ADMIN, or a MANAGER of the project.
// Delegates to canManageProject — a plain participate-only member must NOT
// pass (the cross-division-joiner bug fix, 06-15). Admin always passes.
const canManageProjectGuests = async (
  db: D1Database,
  projectId: string,
  email: string | undefined,
  role: string | undefined,
): Promise<boolean> => canManageProject(db, projectId, email, role);

// Strong random temp password — base64url of 16 random bytes (~22 chars).
// Generated server-side, returned ONCE to the host, NEVER logged.
const genTempPassword = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

// List the project's ACTIVE guests (admin or a member/owner of the project).
app.get("/v1/projects/:projectId/guests", async (c) => {
  const projectId = c.req.param("projectId");
  if (
    !(await canManageProjectGuests(
      c.env.DB,
      projectId,
      c.get("email"),
      c.get("role"),
    ))
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, login, label, real_email, company, phone, address,
            country, logo_key, created_by, created_at, status
       FROM project_guest
      WHERE project_id = ?1 AND status = 'active'
      ORDER BY created_at DESC`,
  )
    .bind(projectId)
    .all();
  // Surface the logo as a portal image URL (not the raw R2 key) so the roster
  // can preview it; country comes straight through for the country dropdown.
  return c.json({
    guests: (results as Record<string, unknown>[]).map((g) => ({
      ...g,
      logo_url: g.logo_key ? `/v1/portal/guests/${g.id}/logo` : null,
    })),
  });
});

// Issue a guest ID for the project: create a Supabase user with a SYNTHETIC
// login (pg-<hex>@guest.canvasm.app) + temp password (email_confirm:true), then
// insert the project_guest row. Returns { login, password, label } ONCE; the
// password is never stored or logged. (admin or a member/owner of the project)
app.post("/v1/projects/:projectId/guests", async (c) => {
  const projectId = c.req.param("projectId");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const project = await c.env.DB.prepare(`SELECT 1 FROM project WHERE id = ?1`)
    .bind(projectId)
    .first();
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  type GuestDetailBody = {
    label?: string;
    real_email?: string;
    company?: string;
    phone?: string;
    address?: string;
    country?: string;
  };
  const b = await c.req
    .json<GuestDetailBody>()
    .catch(() => ({} as GuestDetailBody));
  const label = (b.label || "").trim();
  const realEmail = (b.real_email || "").trim().toLowerCase();
  // Optional CRM-style contact fields — free-text, capped so a runaway client
  // can't bloat the row. NULL when blank (keeps the column clean for filtering).
  const cap = (s: string | undefined, n: number) =>
    (s || "").trim().slice(0, n) || null;
  const company = cap(b.company, 200);
  const phone = cap(b.phone, 64);
  const address = cap(b.address, 400);
  // Client-branding country tag (06-17) — drives the entry-page backdrop.
  const country = normCountry(b.country);
  if (realEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(realEmail)) {
    return c.json({ error: "invalid email" }, 400);
  }
  // Synthetic login — 8 random hex chars under a fixed guest domain. NEVER the
  // guest's real email; unique by construction (collision-retry below).
  const synthLogin = () => {
    const r = new Uint8Array(4);
    crypto.getRandomValues(r);
    const hex = [...r].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `pg-${hex}@guest.canvasm.app`;
  };
  const password = genTempPassword();
  // Create the Supabase user; retry once on the (astronomically rare) login
  // collision so a duplicate hex never blocks issuance.
  let login = synthLogin();
  let supaId = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supaAdmin(cr.url, cr.key, "POST", "/admin/users", {
      email: login,
      password,
      email_confirm: true,
      app_metadata: { role: "guest", project_id: projectId },
      user_metadata: label ? { display_name: label, name: label } : {},
    });
    if (res.ok) {
      const created = (await res.json()) as { id?: string };
      supaId = created.id ?? "";
      break;
    }
    const detail = await res.text();
    if (
      attempt < 2 &&
      (res.status === 422 || /already.*registered|already exists/i.test(detail))
    ) {
      login = synthLogin();
      continue;
    }
    return c.json({ error: "create guest failed" }, 502);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO project_guest
       (id, project_id, login, label, real_email, company, phone, address,
        country, supa_id, created_by, created_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active')`,
  )
    .bind(
      id,
      projectId,
      login,
      label || null,
      realEmail || null,
      company,
      phone,
      address,
      country,
      supaId || null,
      email ?? null,
      now(),
    )
    .run();
  await logAudit(c.env.DB, email, "project_guest.create", projectId, { login });
  // NOTE: never log `password`.
  return c.json({ ok: true, id, login, password, label });
});

// Edit a guest's CONTACT details (label/email/company/phone/address). This is a
// pure D1 metadata update — it never touches the Supabase auth identity (the
// synthetic login is immutable) and so needs no admin creds. Lets the host fill
// in or correct the contact card after issuing. (admin or a member/owner.)
app.patch("/v1/projects/:projectId/guests/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  type GuestPatchBody = {
    label?: string;
    real_email?: string;
    company?: string;
    phone?: string;
    address?: string;
    country?: string;
  };
  const b = await c.req
    .json<GuestPatchBody>()
    .catch(() => ({} as GuestPatchBody));
  const realEmail = (b.real_email || "").trim().toLowerCase();
  if (realEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(realEmail)) {
    return c.json({ error: "invalid email" }, 400);
  }
  const cap = (s: string | undefined, n: number) =>
    (s || "").trim().slice(0, n) || null;
  const res = await c.env.DB.prepare(
    `UPDATE project_guest
        SET label = ?1, real_email = ?2, company = ?3, phone = ?4, address = ?5,
            country = ?6
      WHERE id = ?7 AND project_id = ?8 AND status = 'active'`,
  )
    .bind(
      cap(b.label, 200),
      realEmail || null,
      cap(b.company, 200),
      cap(b.phone, 64),
      cap(b.address, 400),
      normCountry(b.country),
      id,
      projectId,
    )
    .run();
  if (!res.meta.changes) {
    return c.json({ error: "not found" }, 404);
  }
  await logAudit(c.env.DB, email, "project_guest.update", projectId, { id });
  return c.json({ ok: true, id });
});

// Reset a guest's Supabase password — returns the new password ONCE.
// (admin or a member/owner of the project)
app.post("/v1/projects/:projectId/guests/:id/reset", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  const guest = await c.env.DB.prepare(
    `SELECT supa_id, login FROM project_guest
      WHERE id = ?1 AND project_id = ?2 AND status = 'active'`,
  )
    .bind(id, projectId)
    .first<{ supa_id: string | null; login: string }>();
  if (!guest) {
    return c.json({ error: "not found" }, 404);
  }
  const supaId = await resolveSupaId(cr, guest.supa_id, guest.login);
  if (!supaId) {
    return c.json({ error: "guest account missing" }, 404);
  }
  const password = genTempPassword();
  const res = await supaAdmin(cr.url, cr.key, "PUT", `/admin/users/${supaId}`, {
    password,
  });
  if (!res.ok) {
    return c.json({ error: "reset failed" }, 502);
  }
  await logAudit(c.env.DB, email, "project_guest.reset", projectId, {
    login: guest.login,
  });
  return c.json({ ok: true, login: guest.login, password });
});

// Revoke ONE guest — DISABLE the Supabase login + mark the row 'revoked'.
// NEVER deletes: project_guest is the only synthetic-login→person map, so a
// DELETE would orphan every meeting_invitee / meeting_participant / authored-
// content attribution and break the AI knowledge graph (docs/plans/guest-data-
// lifecycle.md). Disabled = BANNED in Supabase (supa_id stays resolvable, can be
// re-enabled later); status='revoked' drops the canSeeMeeting/me-meetings grant
// so the guest loses access. (admin or a member/owner of the project.)
app.delete("/v1/projects/:projectId/guests/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const guest = await c.env.DB.prepare(
    `SELECT supa_id, login FROM project_guest
      WHERE id = ?1 AND project_id = ?2`,
  )
    .bind(id, projectId)
    .first<{ supa_id: string | null; login: string }>();
  if (!guest) {
    return c.json({ error: "not found" }, 404);
  }
  const cr = adminCreds(c);
  if (cr) {
    const supaId = await resolveSupaId(cr, guest.supa_id, guest.login);
    if (supaId) {
      // BAN (disable), don't DELETE — keeps the account resolvable + restorable.
      await supaAdmin(cr.url, cr.key, "PUT", `/admin/users/${supaId}`, {
        ban_duration: "876000h",
      });
    }
  }
  const revokedAt = Date.now();
  // CASCADE the revocation into meeting_invitee — otherwise the guest keeps
  // data access until their already-issued JWT expires (Supabase ban only
  // blocks NEW tokens). canSeeMeeting/me-meetings/Daily gate on
  // meeting_invitee.status, NOT project_guest.status, so without this a
  // revoked guest can still PUT/GET scene+chat+files for ~1h (the token TTL).
  // This makes "revoke = kick" deny on the very next request. (06-15 audit H3.)
  await c.env.DB.prepare(
    `UPDATE meeting_invitee SET status = 'revoked', revoked_at = ?2
      WHERE email = ?1 AND status <> 'revoked'`,
  )
    .bind(guest.login, revokedAt)
    .run();
  await c.env.DB.prepare(
    `UPDATE project_guest SET status = 'revoked', revoked_at = ?2 WHERE id = ?1`,
  )
    .bind(id, revokedAt)
    .run();
  await logAudit(c.env.DB, email, "project_guest.revoke", projectId, {
    login: guest.login,
  });
  return c.json({ ok: true, revoked: id });
});

// RETIRE all guests of the project — the "done with the project" action.
// DISABLE every login + mark every active row 'revoked'. NEVER deletes — the
// records, attendance/attribution, and the AI moat are preserved (docs/plans/
// guest-data-lifecycle.md). (admin or a member/owner.)
app.post("/v1/projects/:projectId/guests/clean", async (c) => {
  const projectId = c.req.param("projectId");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, supa_id, login FROM project_guest
      WHERE project_id = ?1 AND status = 'active'`,
  )
    .bind(projectId)
    .all<{ id: string; supa_id: string | null; login: string }>();
  if (cr) {
    for (const g of results) {
      const supaId = await resolveSupaId(cr, g.supa_id, g.login);
      if (supaId) {
        // BAN (disable), don't DELETE — preserve the row + history.
        await supaAdmin(cr.url, cr.key, "PUT", `/admin/users/${supaId}`, {
          ban_duration: "876000h",
        });
      }
    }
  }
  const retiredAt = Date.now();
  // CASCADE into meeting_invitee BEFORE flipping project_guest.status (so the
  // subquery still sees the active logins) — same reason as single-revoke:
  // strip the invitee grant so canSeeMeeting denies immediately, not after the
  // guest's JWT expires. (06-15 audit H3.)
  await c.env.DB.prepare(
    `UPDATE meeting_invitee SET status = 'revoked', revoked_at = ?2
      WHERE status <> 'revoked'
        AND email IN (SELECT login FROM project_guest
                       WHERE project_id = ?1 AND status = 'active')`,
  )
    .bind(projectId, retiredAt)
    .run();
  await c.env.DB.prepare(
    `UPDATE project_guest SET status = 'revoked', revoked_at = ?2
      WHERE project_id = ?1 AND status = 'active'`,
  )
    .bind(projectId, retiredAt)
    .run();
  await logAudit(c.env.DB, email, "project_guest.retire", projectId, {
    count: results.length,
  });
  return c.json({ ok: true, removed: results.length });
});

// CENTRALIZED guest manager — every active guest the caller MAY MANAGE, in one
// place (across all their projects). SCOPED SERVER-SIDE to project membership,
// mirroring canManageProjectGuests exactly: admin sees ALL project guests (full
// power); a regular user sees ONLY guests of projects they MANAGE (a
// project_member row with role owner/manager — a plain participate-only member
// sees none). The caller's project list is derived server-side from
// project_member — never trusted from the client — so a guest of a project the
// caller can't manage is NEVER returned (between-department confidentiality).
app.get("/v1/me/project-guests", async (c) => {
  const email = c.get("email");
  const role = c.get("role");
  const me = email?.toLowerCase();
  if (role !== "admin" && !me) {
    return c.json({ error: "forbidden" }, 403);
  }
  // Admin → all active guests across every project. Else → only guests whose
  // project_id is one the caller MANAGES (the EXISTS subquery mirrors
  // canManageProject — role owner/manager — applied per row).
  const { results } =
    role === "admin"
      ? await c.env.DB.prepare(
          `SELECT pg.id, pg.project_id, p.name AS project_name, pg.login,
                  pg.label, pg.real_email, pg.company, pg.phone, pg.address,
                  pg.country, pg.logo_key, pg.status, pg.created_at
             FROM project_guest pg
             JOIN project p ON p.id = pg.project_id
            WHERE pg.status = 'active'
            ORDER BY p.name COLLATE NOCASE, pg.created_at DESC`,
        ).all()
      : await c.env.DB.prepare(
          `SELECT pg.id, pg.project_id, p.name AS project_name, pg.login,
                  pg.label, pg.real_email, pg.company, pg.phone, pg.address,
                  pg.country, pg.logo_key, pg.status, pg.created_at
             FROM project_guest pg
             JOIN project p ON p.id = pg.project_id
            WHERE pg.status = 'active'
              AND EXISTS (
                SELECT 1 FROM project_member pm
                 WHERE pm.project_id = pg.project_id AND pm.email = ?1
                   AND pm.role IN ('owner','manager')
              )
            ORDER BY p.name COLLATE NOCASE, pg.created_at DESC`,
        )
          .bind(me)
          .all();
  return c.json({
    guests: (results as Record<string, unknown>[]).map((g) => ({
      ...g,
      logo_url: g.logo_key ? `/v1/portal/guests/${g.id}/logo` : null,
    })),
  });
});

// ORGANIZER delete — only a CANCELLED meeting may be deleted (the lifecycle's
// one disposal path: cancel first, then delete; finished stays immutable
// forever, live/scheduled must be cancelled/ended first). Full cascade.
app.delete("/v1/meetings/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const email = c.get("email");
  const role = c.get("role");
  const meeting = await c.env.DB.prepare(
    `SELECT status, organizer_email FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first<{ status: string | null; organizer_email: string | null }>();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  if (role !== "admin") {
    if (normalizeStatus(meeting.status) !== "cancelled") {
      return c.json({ error: "only a cancelled meeting can be deleted" }, 409);
    }
    const isOrganizer = meeting.organizer_email
      ? meeting.organizer_email.toLowerCase() === email?.toLowerCase()
      : isInternalEmail(email);
    if (!isOrganizer) {
      return c.json({ error: "organizer only" }, 403);
    }
  }
  await deleteMeetingCascade(c.env, roomId, email);
  await logAudit(c.env.DB, email, "meeting.delete", roomId);
  return c.json({ ok: true, deleted: roomId });
});

// List a meeting's invitees (active + revoked, for the organizer's edit form —
// revoked rows render struck-through/auditable rather than vanishing).
// Internal staff + admins (same visibility rule as inviting).
app.get("/v1/meetings/:roomId/invitees", async (c) => {
  if (!(c.get("role") === "admin" || isInternalEmail(c.get("email")))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT email, kind, role, status, invited_by, invited_at
     FROM meeting_invitee WHERE meeting_id = ?1
     ORDER BY invited_at ASC`,
  )
    .bind(c.req.param("roomId"))
    .all();
  return c.json({ invitees: results });
});

// Who ACTUALLY joined this meeting (vs invitees = who was asked). Same
// per-meeting visibility as the rest of the room routes (roomGate) — an
// invited guest may see who attended the meeting they were part of.
app.get("/v1/meetings/:roomId/participants", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT user_email, name, joined_at, last_seen_at
     FROM meeting_participant WHERE meeting_id = ?1
     ORDER BY joined_at ASC`,
  )
    .bind(c.req.param("roomId"))
    .all();
  return c.json({ participants: results });
});

// ---- Waiting room (knock-to-join, Phase 4.5) -----------------------------
// External invited guests don't barge into a LIVE meeting — they "knock" and a
// host/manager admits them. Internal staff + admins auto-admit and never knock.
// The real server gate lives on the Daily token endpoint (an EXTERNAL caller
// needs a status='admitted' knock row); these routes drive the knock lifecycle.
// All are under /v1/meetings/:roomId/* → roomGate already vetted that the caller
// can SEE the meeting (an invitee). See docs/plans/waiting-room.md.

// A guest knocks (or re-knocks). EXTERNAL only — internal/admin are told not to
// knock (they auto-admit). roomGate guarantees the caller is invited.
app.post("/v1/meetings/:roomId/knock", async (c) => {
  const roomId = c.req.param("roomId");
  const email = c.get("email");
  const role = c.get("role");
  if (!email) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  // Internal staff + admins auto-admit and must never sit in the waiting room —
  // they have no knock row, so a knock here is a client-side bug.
  if (isInternalEmail(email) || role === "admin") {
    return c.json(
      { error: "internal users do not knock", status: "admitted" },
      409,
    );
  }
  const e = email.toLowerCase();
  const meeting = await c.env.DB.prepare(
    `SELECT status FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first<{ status: string | null }>();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  // Only a LIVE meeting has a waiting room — a scheduled one parks at the start
  // gate, a finished/cancelled one has no room to knock into.
  if (normalizeStatus(meeting.status) !== "live") {
    return c.json({ error: "meeting not live" }, 409);
  }
  // Read the body AT MOST ONCE — reading c.req.json() twice throws
  // "body already used". c.get('name') does NOT exist on Variables, so the
  // display name comes ONLY from the request body.
  const body = await c.req
    .json<{ name?: string }>()
    .catch(() => ({} as { name?: string }));
  const name = body.name || null;
  const t = now();
  const existing = await c.env.DB.prepare(
    `SELECT status, last_seen FROM meeting_knock WHERE room_id = ?1 AND email = ?2`,
  )
    .bind(roomId, e)
    .first<{ status: string; last_seen: number }>();
  // Already admitted → idempotent success (bump last_seen so the host sees a
  // fresh heartbeat); the client falls through to connect.
  if (existing?.status === "admitted") {
    await c.env.DB.prepare(
      `UPDATE meeting_knock SET last_seen = ?3 WHERE room_id = ?1 AND email = ?2`,
    )
      .bind(roomId, e, t)
      .run();
    return c.json({ ok: true, status: "admitted" });
  }
  // Denied within the cooldown → refuse the re-knock (server-enforced so the
  // re-knock button can't be hammered).
  if (
    existing?.status === "denied" &&
    t - existing.last_seen < REKNOCK_COOLDOWN_MS
  ) {
    return c.json(
      {
        error: "denied — try again later",
        status: "denied",
        retryAfter: Math.ceil(
          (REKNOCK_COOLDOWN_MS - (t - existing.last_seen)) / 1000,
        ),
      },
      429,
    );
  }
  // (Re)knock: upsert as 'invited' (a denied row past cooldown is reset to
  // invited so the host sees the fresh knock), bump last_seen, keep created_at.
  await c.env.DB.prepare(
    `INSERT INTO meeting_knock (room_id, email, name, status, created_at, last_seen)
       VALUES (?1, ?2, ?3, 'invited', ?4, ?4)
     ON CONFLICT(room_id, email) DO UPDATE SET
       status = 'invited',
       name = COALESCE(?3, meeting_knock.name),
       last_seen = ?4`,
  )
    .bind(roomId, e, name, t)
    .run();
  return c.json({ ok: true, status: "invited" });
});

// A guest reads THEIR OWN knock status (the waiting-room poll). Self-scoped:
// only ever the caller's own row. roomGate vetted visibility.
app.get("/v1/meetings/:roomId/knock", async (c) => {
  const roomId = c.req.param("roomId");
  const email = c.get("email");
  if (!email) {
    return c.json({ knock: null });
  }
  const row = await c.env.DB.prepare(
    `SELECT status FROM meeting_knock WHERE room_id = ?1 AND email = ?2`,
  )
    .bind(roomId, email.toLowerCase())
    .first<{ status: string }>();
  return c.json({ knock: row ?? null });
});

// A manager lists everyone still WAITING (status='invited'). Manager-gated
// (admin or internal who can see the meeting) — a guest never sees this.
app.get("/v1/meetings/:roomId/knocks", async (c) => {
  const roomId = c.req.param("roomId");
  if (
    !(await isMeetingManager(c.env.DB, roomId, c.get("email"), c.get("role")))
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT email, name, created_at FROM meeting_knock
       WHERE room_id = ?1 AND status = 'invited'
       ORDER BY created_at ASC`,
  )
    .bind(roomId)
    .all();
  return c.json({ knocks: results });
});

// A manager admits or denies a waiting guest. Manager-gated. Deny is SOFT
// (knock-only, never meeting_invitee) and re-knockable after the cooldown.
app.patch("/v1/meetings/:roomId/knock/:email", async (c) => {
  const roomId = c.req.param("roomId");
  if (
    !(await isMeetingManager(c.env.DB, roomId, c.get("email"), c.get("role")))
  ) {
    return c.json({ error: "forbidden" }, 403);
  }
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const body = await c.req
    .json<{ action?: string }>()
    .catch(() => ({} as { action?: string }));
  const action = body.action;
  if (action !== "admit" && action !== "deny") {
    return c.json({ error: "action must be admit|deny" }, 400);
  }
  if (action === "admit") {
    // No admitting someone into a meeting that's no longer live (it ended /
    // was cancelled while they waited).
    const meeting = await c.env.DB.prepare(
      `SELECT status FROM meeting WHERE id = ?1`,
    )
      .bind(roomId)
      .first<{ status: string | null }>();
    if (normalizeStatus(meeting?.status) !== "live") {
      return c.json({ error: "meeting not live" }, 409);
    }
  }
  const nextStatus = action === "admit" ? "admitted" : "denied";
  const res = await c.env.DB.prepare(
    `UPDATE meeting_knock SET status = ?3, last_seen = ?4
       WHERE room_id = ?1 AND email = ?2`,
  )
    .bind(roomId, target, nextStatus, now())
    .run();
  // No fabricated admit/deny for someone who never knocked.
  if (res.meta.changes === 0) {
    return c.json({ error: "no such knock" }, 404);
  }
  await logAudit(c.env.DB, c.get("email"), `meeting.knock.${action}`, roomId, {
    target,
  });
  return c.json({ ok: true, status: nextStatus });
});

// The current user's invited / upcoming meetings — the ONLY surface a client
// sees (project NAME only, never the folder). Powers the "Invited / Upcoming"
// list. See host-and-scheduling.md.
app.get("/v1/me/invitations", async (c) => {
  const email = c.get("email");
  if (!email) {
    return c.json({ invitations: [] });
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.title, m.topic, m.status, m.scheduled_at, m.duration_min,
            m.created_by, p.name AS project_name, mi.role AS my_role
     FROM meeting_invitee mi
     JOIN meeting m ON m.id = mi.meeting_id
     LEFT JOIN project p ON p.id = m.project_id
     WHERE mi.email = ?1 AND mi.status <> 'revoked'
     ORDER BY COALESCE(m.scheduled_at, '') ASC, m.updated_at DESC`,
  )
    .bind(email.toLowerCase())
    .all();
  return c.json({ invitations: results });
});

// RSVP — the invitee answers their OWN invitation (accept/decline). Strictly
// self-scoped: the row is matched by the verified JWT email, and a revoked
// invitation can't be resurrected by answering it. Declining never deletes
// the row (the organizer's invitee list keeps the audit trail) and the
// invitee can still change their mind until revoked.
app.post("/v1/me/invitations/:meetingId/respond", async (c) => {
  const email = c.get("email");
  if (!email) {
    return c.json({ error: "no email" }, 400);
  }
  const b = await c.req.json<{ response?: string }>();
  if (b.response !== "accepted" && b.response !== "declined") {
    return c.json({ error: "invalid response" }, 400);
  }
  const { meta } = await c.env.DB.prepare(
    `UPDATE meeting_invitee SET status = ?3
     WHERE meeting_id = ?1 AND email = ?2 AND status <> 'revoked'`,
  )
    .bind(c.req.param("meetingId"), email.toLowerCase(), b.response)
    .run();
  if (!meta.changes) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true, status: b.response });
});

// Internal staff directory for the invite picker (name/email/title/division).
// Any internal user can read it (to invite colleagues); guests get 403. Uses
// the Supabase service key server-side; only minimal fields are returned.
app.get("/v1/directory", async (c) => {
  const me = c.get("email");
  if (!(c.get("role") === "admin" || isInternalEmail(me))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ users: [] });
  }
  const people: {
    email: string;
    name: string;
    title?: string;
    division?: string;
    avatar?: string;
  }[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await supaAdmin(
      cr.url,
      cr.key,
      "GET",
      `/admin/users?page=${page}&per_page=200`,
    );
    if (!res.ok) {
      break;
    }
    const { users } = (await res.json()) as {
      users: {
        email?: string;
        user_metadata?: {
          name?: string;
          title?: string;
          division?: string;
          avatar?: string;
        };
        app_metadata?: { role?: string };
      }[];
    };
    for (const u of users) {
      // internal humans only — skip externals + the admin console account.
      if (!isInternalEmail(u.email) || u.app_metadata?.role === "admin") {
        continue;
      }
      // Avatar: only the small "lib:NN.png" gallery refs ride along (that's
      // all the client syncs to user_metadata) — never inline data URLs.
      const avatar = u.user_metadata?.avatar;
      people.push({
        email: u.email!.toLowerCase(),
        name: u.user_metadata?.name || u.email!,
        title: u.user_metadata?.title,
        division: u.user_metadata?.division,
        avatar:
          typeof avatar === "string" && avatar.startsWith("lib:")
            ? avatar
            : undefined,
      });
    }
    if (users.length < 200) {
      break;
    }
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ users: people });
});

// ---- Client list (shared CRM-lite contact book) --------------------------
// A reusable address book of EXTERNAL contacts (clients/consultants) that
// internal staff manage once and then pick from when inviting — instead of
// retyping a raw email each time. A `client` row is just a contact card, NOT a
// login: inviting one still creates a normal guest meeting_invitee by email.
// Gate: internal staff + admins (same rule as the directory/invite). Admins
// monitor + manage every row from the Admin → Clients tab.

const canManageClients = (
  email: string | undefined,
  role: string | undefined,
): boolean => role === "admin" || isInternalEmail(email);

// List clients (newest first). SCOPED: admin sees EVERY card (full oversight);
// a regular staff member sees ONLY the cards they themselves added
// (created_by = me). Before this the route returned the GLOBAL book to every
// internal user, leaking external client emails/company/notes ACROSS
// departments — incl. contacts attached only to confidential meetings the
// caller can't see. The shared, per-project external roster is now served by
// project_guest (department-confidential by construction); this legacy book is
// just each person's personal quick-contacts. (06-15 audit H1.)
app.get("/v1/clients", async (c) => {
  const me = c.get("email");
  const role = c.get("role");
  if (!canManageClients(me, role)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } =
    role === "admin"
      ? await c.env.DB.prepare(
          `SELECT id, name, company, email, note, created_by, created_at
             FROM client ORDER BY created_at DESC LIMIT 500`,
        ).all()
      : await c.env.DB.prepare(
          `SELECT id, name, company, email, note, created_by, created_at
             FROM client WHERE lower(created_by) = ?1
            ORDER BY created_at DESC LIMIT 500`,
        )
          .bind(me?.toLowerCase() ?? "")
          .all();
  return c.json({ clients: results });
});

// Create a client (contact card). name required; company/email/note optional.
// email (if given) is validated + lower-cased to match the invite/authz model.
app.post("/v1/clients", async (c) => {
  const me = c.get("email");
  if (!canManageClients(me, c.get("role"))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const b = await c.req.json<{
    name?: string;
    company?: string;
    email?: string;
    note?: string;
  }>();
  const name = (b.name ?? "").trim();
  if (!name) {
    return c.json({ error: "name required" }, 400);
  }
  const email = (b.email ?? "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "invalid email" }, 400);
  }
  const id = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO client (id, name, company, email, note, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      name,
      (b.company ?? "").trim() || null,
      email || null,
      (b.note ?? "").trim() || null,
      me ?? null,
      ts,
    )
    .run();
  await logAudit(c.env.DB, me, "client.create", id, { name, email });
  return c.json({
    client: {
      id,
      name,
      company: (b.company ?? "").trim() || null,
      email: email || null,
      note: (b.note ?? "").trim() || null,
      created_by: me ?? null,
      created_at: ts,
    },
  });
});

// Delete a client (hard delete — it's only a contact card; existing meeting
// invites are unaffected since they live in meeting_invitee, not here).
// SCOPED to ownership: admin deletes any card; a regular staff member deletes
// ONLY their own (created_by = me) — before this any internal user could delete
// another department's contact card. (06-15 audit H1.)
app.delete("/v1/clients/:id", async (c) => {
  const me = c.get("email");
  const role = c.get("role");
  if (!canManageClients(me, role)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const id = c.req.param("id");
  const res =
    role === "admin"
      ? await c.env.DB.prepare(`DELETE FROM client WHERE id = ?1`)
          .bind(id)
          .run()
      : await c.env.DB.prepare(
          `DELETE FROM client WHERE id = ?1 AND lower(created_by) = ?2`,
        )
          .bind(id, me?.toLowerCase() ?? "")
          .run();
  if (!res.meta.changes) {
    return c.json({ error: "not found" }, 404);
  }
  await logAudit(c.env.DB, me, "client.delete", id);
  return c.json({ ok: true, deleted: id });
});

// ---- Calendar: my meetings -----------------------------------------------
// Every meeting the caller can MANAGE on their calendar — the union of:
//   (a) meetings they organize/created (created_by OR organizer_email = me),
//   (b) meetings they're an active invitee of (status <> 'revoked'),
//   (c) meetings in projects they're a project_member of.
// Deduped by meeting id. Admins see ALL meetings. Distinct from
// /v1/me/invitations, which is the client-facing "invited to" list only.
app.get("/v1/me/meetings", async (c) => {
  const email = c.get("email");
  const isAdmin = c.get("role") === "admin";
  if (!email && !isAdmin) {
    return c.json({ meetings: [] });
  }
  const cols = `m.id, m.title, m.status, m.scheduled_at, m.created_at,
                m.project_id, p.name AS project_name, m.created_by,
                m.organizer_email, m.duration_min, m.color, m.icon`;
  const order = `ORDER BY COALESCE(m.scheduled_at, '') ASC, m.created_at DESC`;
  if (isAdmin) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${cols}
       FROM meeting m LEFT JOIN project p ON p.id = m.project_id
       ${order}`,
    ).all();
    return c.json({ meetings: results });
  }
  const e = (email as string).toLowerCase();
  // NOTE: identity is the verified EMAIL — created_by is only a display name
  // (never compared against emails; meetings now always carry organizer_email).
  // invited_direct/attended power the "invited to a LIVE meeting" nudge:
  // direct invitee who hasn't joined yet ⇒ worth a toast; a mere
  // project-member sighting is not an invitation.
  const { results } = await c.env.DB.prepare(
    `SELECT ${cols},
       EXISTS(SELECT 1 FROM meeting_invitee mi2
                WHERE mi2.meeting_id = m.id AND mi2.email = ?1
                  AND mi2.status <> 'revoked') AS invited_direct,
       EXISTS(SELECT 1 FROM meeting_participant mp
                WHERE mp.meeting_id = m.id AND mp.user_email = ?1) AS attended,
       -- My own RSVP state ('invited'|'accepted'|'declined'|'revoked');
       -- NULL when I'm not a direct invitee (organizer / project member).
       (SELECT status FROM meeting_invitee mi3
          WHERE mi3.meeting_id = m.id AND mi3.email = ?1) AS my_invite_status,
       -- Personal timestamps for the dashboard activity log (when was I
       -- invited / when did I first join) — cheap subselects on PK indexes.
       (SELECT invited_at FROM meeting_invitee mi4
          WHERE mi4.meeting_id = m.id AND mi4.email = ?1) AS my_invited_at,
       (SELECT joined_at FROM meeting_participant mp2
          WHERE mp2.meeting_id = m.id AND mp2.user_email = ?1) AS my_joined_at
     FROM meeting m LEFT JOIN project p ON p.id = m.project_id
     WHERE m.id IN (
       SELECT id FROM meeting
         WHERE lower(organizer_email) = ?1 OR lower(host_email) = ?1
       UNION
       SELECT meeting_id FROM meeting_invitee
         WHERE email = ?1 AND status <> 'revoked'
       UNION
       SELECT mm.id FROM meeting mm
         JOIN project_member pm ON pm.project_id = mm.project_id
         WHERE pm.email = ?1
           -- Confidential = invitee-only: plain project membership doesn't
           -- surface it (the organizer/invitee arms above still do).
           AND lower(COALESCE(mm.confidentiality, '')) <> 'confidential'
       -- A PROJECT GUEST is NOT auto-shown the project's meetings (06-15 fix):
       -- they appear here ONLY via the invitee arm above — meetings they were
       -- EXPLICITLY invited to. The project_guest row is identity, not a grant.
     )
     ${order}`,
  )
    .bind(e)
    .all();
  return c.json({ meetings: results });
});

// ---- Calendar: per-user notes --------------------------------------------
// A scratch note owned by the caller, keyed by scope+ref:
//   scope=day     · ref=YYYY-MM-DD  → note for a calendar day
//   scope=meeting · ref=roomId      → note for one meeting
// Strictly per-user: every query is bound to the caller's JWT email, so a
// note is never read from or written for anyone else.
app.get("/v1/notes", async (c) => {
  const email = c.get("email");
  if (!email) {
    return c.json({ body: "" });
  }
  const scope = c.req.query("scope");
  const ref = (c.req.query("ref") ?? "").trim();
  if ((scope !== "day" && scope !== "meeting") || !ref) {
    return c.json({ body: "" });
  }
  const row = await c.env.DB.prepare(
    `SELECT body FROM note WHERE scope = ?1 AND ref = ?2 AND email = ?3`,
  )
    .bind(scope, ref, email.toLowerCase())
    .first<{ body: string }>();
  return c.json({ body: row?.body ?? "" });
});

app.put("/v1/notes", async (c) => {
  const email = c.get("email");
  if (!email) {
    return c.json({ error: "no email" }, 400);
  }
  const b = await c.req.json<{
    scope?: string;
    ref?: string;
    body?: string;
  }>();
  if (b.scope !== "day" && b.scope !== "meeting") {
    return c.json({ error: "invalid scope" }, 400);
  }
  const ref = (b.ref ?? "").trim();
  if (!ref) {
    return c.json({ error: "ref required" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO note (scope, ref, email, body, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(scope, ref, email) DO UPDATE SET
       body = excluded.body, updated_at = excluded.updated_at`,
  )
    .bind(b.scope, ref, email.toLowerCase(), b.body ?? "", now())
    .run();
  return c.json({ ok: true });
});

// ---- My Files — "Tài liệu của tôi" (quyết định 06-10 #2) -------------------
// A personal document shelf for INTERNAL users: upload once on the dashboard,
// bake once, then COPY into any meeting (the client pulls the bytes and runs
// them through the normal ingest/encrypt pipeline — the meeting keeps its
// snapshot; deleting a shelf file never punches a hole in an old meeting).
// Bytes live SERVER-READABLE at userfiles/<email>/<fileId> (no room key exists
// outside a meeting); the index row is the user_file table (rule: every new
// prefix gets a D1 index). Strictly owner-scoped via the JWT email.

const MAX_USER_FILE_BYTES = 50 * 1024 * 1024;

app.get("/v1/me/files", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email || !(c.get("role") === "admin" || isInternalEmail(email))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, kind, size, tags, visibility, created_at FROM user_file
     WHERE owner_email = ?1 ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(email)
    .all();
  return c.json({ files: results });
});

app.put("/v1/me/files/:fileId", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email || !(c.get("role") === "admin" || isInternalEmail(email))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const fileId = c.req.param("fileId");
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  if (body.byteLength > MAX_USER_FILE_BYTES) {
    return c.json({ error: "file too large (max 50MB)" }, 413);
  }
  const key = userFileKey(email, fileId);
  // Remember the REAL mime on the object itself — the copy-into-meeting
  // client rebuilds a File from these bytes and ingest's image detection is
  // mime-based, so serving octet-stream made shelf images unupsertable.
  await c.env.BUCKET.put(key, body, {
    httpMetadata: {
      contentType: c.req.header("content-type") ?? "application/octet-stream",
    },
  });
  // Optional shelf metadata: x-tags is a free-form "a,b,c" string (empty ⇒
  // untagged), x-visibility gates the copy-into-meeting confirmation.
  const tags = c.req.header("x-tags")?.trim() || null;
  const visibility =
    c.req.header("x-visibility") === "sharable" ? "sharable" : "private";
  await c.env.DB.prepare(
    `INSERT INTO user_file (id, owner_email, name, kind, size, tags, visibility, r2_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind,
       size = excluded.size, tags = excluded.tags,
       visibility = excluded.visibility, r2_key = excluded.r2_key`,
  )
    .bind(
      fileId,
      email,
      c.req.header("x-name") ?? null,
      c.req.header("x-kind") ?? null,
      body.byteLength,
      tags,
      visibility,
      key,
      now(),
    )
    .run();
  return c.json({ ok: true, id: fileId });
});

// Edit shelf metadata in place (tags / visibility / rename) — owner-scoped
// like DELETE; the bytes and the meetings' snapshots are untouched.
app.patch("/v1/me/files/:fileId", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email) {
    return c.json({ error: "forbidden" }, 403);
  }
  const fileId = c.req.param("fileId");
  const row = await c.env.DB.prepare(
    `SELECT id FROM user_file WHERE id = ?1 AND owner_email = ?2`,
  )
    .bind(fileId, email)
    .first<{ id: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  const b = await c.req.json<{
    tags?: string | null;
    visibility?: string;
    name?: string;
  }>();
  const sets: string[] = [];
  const binds: (string | null)[] = [];
  if (b.tags !== undefined) {
    sets.push(`tags = ?${binds.length + 1}`);
    binds.push((b.tags ?? "").trim() || null);
  }
  if (b.visibility !== undefined) {
    if (b.visibility !== "private" && b.visibility !== "sharable") {
      return c.json({ error: "invalid visibility" }, 400);
    }
    sets.push(`visibility = ?${binds.length + 1}`);
    binds.push(b.visibility);
  }
  if (b.name !== undefined) {
    const name = (b.name ?? "").trim();
    if (!name) {
      return c.json({ error: "name required" }, 400);
    }
    sets.push(`name = ?${binds.length + 1}`);
    binds.push(name);
  }
  if (!sets.length) {
    return c.json({ error: "nothing to update" }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE user_file SET ${sets.join(", ")}
     WHERE id = ?${binds.length + 1} AND owner_email = ?${binds.length + 2}`,
  )
    .bind(...binds, fileId, email)
    .run();
  return c.json({ ok: true, id: fileId });
});

app.get("/v1/me/files/:fileId/content", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email) {
    return c.json({ error: "forbidden" }, 403);
  }
  // Ownership via the row (not just the key) so a forged fileId can't probe
  // someone else's prefix.
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM user_file WHERE id = ?1 AND owner_email = ?2`,
  )
    .bind(c.req.param("fileId"), email)
    .first<{ r2_key: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(obj.body, {
    headers: {
      // Stored mime when we have it (uploads after 06-11); legacy objects
      // fall back to octet-stream and the client's kind-based fallback.
      "content-type":
        obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
    },
  });
});

app.delete("/v1/me/files/:fileId", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email) {
    return c.json({ error: "forbidden" }, 403);
  }
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM user_file WHERE id = ?1 AND owner_email = ?2`,
  )
    .bind(c.req.param("fileId"), email)
    .first<{ r2_key: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  await c.env.BUCKET.delete(row.r2_key);
  await c.env.DB.prepare(`DELETE FROM user_file WHERE id = ?1`)
    .bind(c.req.param("fileId"))
    .run();
  return c.json({ ok: true });
});

// ---- Daily.co screen-share token -----------------------------------------
// Mints a short-lived meeting token for the Daily room that mirrors this
// meeting's roomId. The DAILY_API_KEY stays server-side; the client only
// ever receives { url, token } and joins via @daily-co/daily-js. The room is
// created on first use (idempotent: GET → create on 404) as a PRIVATE room,
// so a token is required to join. Screen video/audio only — webcam/mic stay
// off (audio runs on the existing WebRTC mesh, not Daily).

const DAILY_API = "https://api.daily.co/v1";

app.get("/v1/daily/token", async (c) => {
  const apiKey = cleanSecret(c.env.DAILY_API_KEY);
  if (!apiKey) {
    return c.json({ error: "daily not configured" }, 503);
  }
  const roomId = c.req.query("roomId");
  if (!roomId) {
    return c.json({ error: "roomId required" }, 400);
  }
  // Audio runs in a DERIVED Daily room named "<meetingId>-audio"
  // (DailyAudio.ts) — but the meeting registry, canSeeMeeting, finished-lock
  // and the waiting-room knock are all keyed by the MEETING id. Gate against
  // that base id, not the suffixed Daily room name; otherwise the lookups hit
  // a non-existent "…-audio" row (canSeeMeeting falls through as "ad-hoc" and
  // the admitted-knock check never matches → a legit guest gets 403). Screen-
  // share already uses the bare meeting id, so the strip is a no-op there.
  const meetingId = roomId.replace(/-audio$/, "");
  // Per-meeting gate: a guest can only get a Daily token for a meeting they
  // were invited to (internal staff + admins pass). Closes the "any JWT mints
  // any room's token" hole noted in roadmap/dev-phase-notes.
  if (
    !(await canSeeMeeting(c.env.DB, c.get("email"), c.get("role"), meetingId))
  ) {
    return c.json({ error: "not invited to this meeting" }, 403);
  }
  // No media in a finished meeting — review is look-only, so there is no
  // legitimate audio/screen-share session to token. (UI hides the buttons;
  // this is the server backstop.)
  if (await isFinishedLocked(c.env.DB, meetingId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
  }
  // WAITING ROOM media gate (decision 1a, docs/plans/waiting-room.md): an
  // EXTERNAL guest only gets a Daily token once a host has ADMITTED their
  // knock. Internal staff + admins skip (they auto-admit, never knock). This
  // is the enforceable media gate; the canvas relay stays trust-the-key.
  {
    const me = c.get("email");
    if (c.get("role") !== "admin" && !isInternalEmail(me)) {
      const knock = await c.env.DB.prepare(
        `SELECT status FROM meeting_knock WHERE room_id = ?1 AND email = ?2`,
      )
        .bind(meetingId, me?.toLowerCase())
        .first<{ status: string | null }>();
      if (knock?.status !== "admitted") {
        return c.json({ error: "not admitted to this meeting" }, 403);
      }
    }
  }
  const userName = (c.req.query("name") || "Guest").slice(0, 64);
  // Optional stable identity (we pass the socket.id) — baked into the token as
  // Daily's user_id, which propagates reliably to other participants so the
  // client can map a Daily participant back to its socket.id for the UI.
  const uid = c.req.query("uid")?.slice(0, 80);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // 1) Ensure the Daily room exists (named after roomId).
  let roomUrl: string | null = null;
  const getRoom = await fetch(
    `${DAILY_API}/rooms/${encodeURIComponent(roomId)}`,
    { headers },
  );
  if (getRoom.ok) {
    roomUrl = ((await getRoom.json()) as { url?: string }).url ?? null;
  } else if (getRoom.status === 404) {
    const createRoom = await fetch(`${DAILY_API}/rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: roomId,
        privacy: "private",
        properties: {
          enable_screenshare: true,
          start_video_off: true,
          start_audio_off: true,
        },
      }),
    });
    if (!createRoom.ok) {
      return c.json(
        { error: "room create failed", detail: await createRoom.text() },
        502,
      );
    }
    roomUrl = ((await createRoom.json()) as { url?: string }).url ?? null;
  } else {
    return c.json(
      { error: "room lookup failed", detail: await getRoom.text() },
      502,
    );
  }

  // 2) Mint a token scoped to this room — screen share only, 4h expiry.
  const tokenRes = await fetch(`${DAILY_API}/meeting-tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      properties: {
        room_name: roomId,
        user_name: userName,
        ...(uid ? { user_id: uid } : {}),
        exp: Math.floor(now() / 1000) + 4 * 60 * 60,
        // audio = voice call (room "<id>-audio"); screenVideo/screenAudio =
        // screen share (room "<id>"). One token shape serves both.
        permissions: { canSend: ["audio", "screenVideo", "screenAudio"] },
      },
    }),
  });
  if (!tokenRes.ok) {
    return c.json(
      { error: "token failed", detail: await tokenRes.text() },
      502,
    );
  }
  const token = ((await tokenRes.json()) as { token?: string }).token ?? null;
  if (!roomUrl || !token) {
    return c.json({ error: "daily response missing url/token" }, 502);
  }

  return c.json({ data: { url: roomUrl, token } });
});

// ==========================================================================
// ADMIN CONSOLE — gated by the "admin" role (see /v1/admin/* middleware above)
// ==========================================================================

// Proxy a call to the Supabase Admin REST API with the service key (never
// exposed to the client).
const supaAdmin = (
  url: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  fetch(`${url}/auth/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const adminCreds = (c: { env: Bindings }) => {
  const url = cleanSecret(c.env.SUPABASE_URL).replace(/\/+$/, "");
  const key = cleanSecret(c.env.SUPABASE_SERVICE_API_KEY);
  return url && key ? { url, key } : null;
};

// Resolve a Supabase user id for a project-guest: prefer the cached `supa_id`
// stamped at creation; fall back to a GoTrue lookup by login email (for rows
// created before caching, or if the cache is empty). Returns "" if not found.
const resolveSupaId = async (
  cr: { url: string; key: string },
  cached: string | null,
  login: string,
): Promise<string> => {
  if (cached) {
    return cached;
  }
  const res = await supaAdmin(
    cr.url,
    cr.key,
    "GET",
    `/admin/users?email=${encodeURIComponent(login)}`,
  );
  if (!res.ok) {
    return "";
  }
  const data = (await res.json()) as { users?: { id?: string }[] };
  return data.users?.[0]?.id ?? "";
};

// Record an admin mutation in the audit log (best-effort — never blocks).
const logAudit = async (
  db: D1Database,
  email: string | undefined,
  action: string,
  target?: string,
  meta?: unknown,
) => {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (id, actor_email, action, target, meta, ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        crypto.randomUUID(),
        email ?? null,
        action,
        target ?? null,
        meta !== undefined ? JSON.stringify(meta) : null,
        now(),
      )
      .run();
  } catch {
    // audit failure must not break the action
  }
};

// ---- Admin: users --------------------------------------------------------

app.get("/v1/admin/users", async (c) => {
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  const page = c.req.query("page") ?? "1";
  const perPage = c.req.query("perPage") ?? "200";
  const res = await supaAdmin(
    cr.url,
    cr.key,
    "GET",
    `/admin/users?page=${page}&per_page=${perPage}`,
  );
  if (!res.ok) {
    return c.json(
      { error: "list users failed", detail: await res.text() },
      502,
    );
  }
  return c.json(await res.json());
});

app.post("/v1/admin/users", async (c) => {
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  const b = await c.req.json<{
    email: string;
    password: string;
    role?: string;
    name?: string;
    company?: string;
  }>();
  if (!b.email || !b.password) {
    return c.json({ error: "email + password required" }, 400);
  }
  const md: Record<string, unknown> = {};
  if (b.name) {
    md.display_name = b.name;
    md.name = b.name;
  }
  if (b.company) {
    md.company = b.company;
  }
  const res = await supaAdmin(cr.url, cr.key, "POST", "/admin/users", {
    email: b.email,
    password: b.password,
    email_confirm: true,
    app_metadata: { role: b.role ?? "member" },
    user_metadata: md,
  });
  if (!res.ok) {
    return c.json(
      { error: "create user failed", detail: await res.text() },
      502,
    );
  }
  await logAudit(c.env.DB, c.get("email"), "user.create", b.email, {
    role: b.role ?? "member",
  });
  return c.json(await res.json());
});

// Update role / password / disabled (ban) for a user.
app.patch("/v1/admin/users/:id", async (c) => {
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  const id = c.req.param("id");
  const b = await c.req.json<{
    role?: string;
    password?: string;
    disabled?: boolean;
  }>();
  const patch: Record<string, unknown> = {};
  if (b.role) {
    patch.app_metadata = { role: b.role };
  }
  if (b.password) {
    patch.password = b.password;
  }
  if (typeof b.disabled === "boolean") {
    // Supabase "ban" = disable login; a long duration ≈ indefinite.
    patch.ban_duration = b.disabled ? "876000h" : "none";
  }
  const res = await supaAdmin(
    cr.url,
    cr.key,
    "PUT",
    `/admin/users/${id}`,
    patch,
  );
  if (!res.ok) {
    return c.json(
      { error: "update user failed", detail: await res.text() },
      502,
    );
  }
  await logAudit(c.env.DB, c.get("email"), "user.update", id, {
    role: b.role,
    disabled: b.disabled,
    passwordChanged: !!b.password,
  });
  return c.json(await res.json());
});

app.delete("/v1/admin/users/:id", async (c) => {
  const cr = adminCreds(c);
  if (!cr) {
    return c.json({ error: "admin not configured" }, 503);
  }
  const res = await supaAdmin(
    cr.url,
    cr.key,
    "DELETE",
    `/admin/users/${c.req.param("id")}`,
  );
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    return c.json(
      { error: "delete user failed", detail: await res.text() },
      502,
    );
  }
  await logAudit(c.env.DB, c.get("email"), "user.delete", c.req.param("id"));
  return c.json({ ok: true });
});

// ---- Admin: meetings (across ALL hosts/projects) -------------------------

app.get("/v1/admin/meetings", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, parseInt(c.req.query("limit") ?? "200", 10)),
  );
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.project_id, m.title, m.topic, m.type, m.status,
            m.created_by, m.participant_count, m.duration_s,
            m.created_at, m.updated_at, m.last_opened_at,
            p.name AS project_name
     FROM meeting m LEFT JOIN project p ON p.id = m.project_id
     ORDER BY m.updated_at DESC LIMIT ?1`,
  )
    .bind(limit)
    .all();
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM meeting`,
  ).first<{ total: number }>();
  return c.json({ meetings: results, total: countRow?.total ?? 0 });
});

// Full detail of one meeting: metadata + project + files + WHO joined.
// (room_key / scene_r2_key are deliberately NOT returned.)
app.get("/v1/admin/meetings/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const meeting = await c.env.DB.prepare(
    `SELECT m.id, m.project_id, m.title, m.topic, m.description, m.type,
            m.status, m.discipline, m.priority, m.confidentiality,
            m.scheduled_at, m.created_by, m.organizer_email, m.host_email,
            m.participant_count, m.duration_s, m.ai_summary, m.ai_summary_at,
            m.thumbnail, m.created_at, m.updated_at, m.last_opened_at,
            p.name AS project_name, p.code AS project_code, p.stage AS project_stage
     FROM meeting m LEFT JOIN project p ON p.id = m.project_id
     WHERE m.id = ?1`,
  )
    .bind(roomId)
    .first();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  const { results: files } = await c.env.DB.prepare(
    `SELECT id, kind, name, size, created_at FROM file
     WHERE meeting_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(roomId)
    .all();
  const { results: participants } = await c.env.DB.prepare(
    `SELECT user_email, name, joined_at, last_seen_at FROM meeting_participant
     WHERE meeting_id = ?1 ORDER BY joined_at ASC`,
  )
    .bind(roomId)
    .all();
  const { results: invitees } = await c.env.DB.prepare(
    `SELECT email, kind, role, status, invited_by, invited_at
     FROM meeting_invitee WHERE meeting_id = ?1 ORDER BY invited_at ASC`,
  )
    .bind(roomId)
    .all();
  return c.json({ meeting, files, participants, invitees });
});

// COMPLIANCE ACCESS (quyết định 06-10 #1): the admin may open ANY meeting's
// CONTENT in read-only review — risk management is part of the admin mandate.
// This is the ONLY route that hands the admin a room_key, and it NEVER
// returns one without an audit_log row landing first: unlike logAudit
// (best-effort), a failed audit insert here aborts the request. Users are not
// notified; the immutable trail is what keeps this power accountable.
app.post("/v1/admin/meetings/:roomId/open", async (c) => {
  const roomId = c.req.param("roomId");
  const meeting = await c.env.DB.prepare(
    `SELECT id, title, status, room_key FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first<{
      id: string;
      title: string | null;
      status: string | null;
      room_key: string | null;
    }>();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  if (!meeting.room_key) {
    return c.json({ error: "meeting has no stored key" }, 409);
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_log (id, actor_email, action, target, meta, ts)
       VALUES (?1, ?2, 'admin.open_content', ?3, ?4, ?5)`,
    )
      .bind(
        crypto.randomUUID(),
        c.get("email") ?? null,
        roomId,
        JSON.stringify({ title: meeting.title, status: meeting.status }),
        now(),
      )
      .run();
  } catch {
    return c.json({ error: "audit log unavailable — access denied" }, 500);
  }
  return c.json({
    roomId,
    roomKey: meeting.room_key,
    title: meeting.title,
    status: normalizeStatus(meeting.status),
  });
});

// ---- Admin: projects (full back-office view) ------------------------------

app.get("/v1/admin/projects", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.host_email, p.code, p.client, p.stage,
            p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM meeting m WHERE m.project_id = p.id)
              AS meeting_count,
            (SELECT COUNT(*) FROM project_member pm WHERE pm.project_id = p.id)
              AS member_count
     FROM project p ORDER BY p.updated_at DESC LIMIT 500`,
  ).all();
  return c.json({ projects: results });
});

// Admin force-delete: cascades every meeting (tombstoned), members, the row.
app.delete("/v1/admin/projects/:id", async (c) => {
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare(`SELECT 1 FROM project WHERE id = ?1`)
    .bind(id)
    .first();
  if (!exists) {
    return c.json({ error: "not found" }, 404);
  }
  const { results: meetings } = await c.env.DB.prepare(
    `SELECT id FROM meeting WHERE project_id = ?1`,
  )
    .bind(id)
    .all<{ id: string }>();
  for (const m of meetings) {
    await deleteMeetingCascade(c.env, m.id, c.get("email"));
  }
  await c.env.DB.prepare(`DELETE FROM project_member WHERE project_id = ?1`)
    .bind(id)
    .run();
  await c.env.DB.prepare(`DELETE FROM project WHERE id = ?1`).bind(id).run();
  await logAudit(c.env.DB, c.get("email"), "project.delete", id, {
    meetings: meetings.length,
    forced: true,
  });
  return c.json({ ok: true, deleted: id });
});

// ---- Admin: BACKUP + ARCHIVE (docs/runbooks/backup.md) -------------------
// Two on-demand admin downloads that complement the scheduled CI job + R2
// soft-delete (trash/) + D1 Time Travel. See the runbook for the full plan.

// Base64-encode an ArrayBuffer without blowing the call stack on large blobs:
// String.fromCharCode(...bytes) spreads every byte as an argument and throws
// "Maximum call stack size exceeded" past ~100KB, so chunk through btoa.
const bufToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32KB per btoa call — safe under the arg-spread limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

// Per-blob size cap for the project archive. Blobs over this are NOT base64'd
// into the JSON (a single big DXF/IFC/GLB would bloat the archive + risk an
// OOM on the worker isolate). They're flagged with { skipped: true, size } and
// the key, so the admin knows to pull them separately (the soft-deleted copy
// lives under trash/<ts>/<key> after the DELETE, or via the file stream route).
const ARCHIVE_BLOB_CAP_BYTES = 8 * 1024 * 1024; // 8MB

// GET /v1/admin/backup — full D1 metadata dump (JSON, downloadable).
// Enumerates every real data table from sqlite_master, SELECT * each, and
// assembles { generated_at, tables: { <table>: rows[] } }. METADATA ONLY —
// R2 blob bytes are NOT here (small by design; blobs go through the archive
// route or the scheduled CI .sql export). For an internal DB this is a few MB
// at most, so we build it in memory; revisit if the row count ever explodes.
app.get("/v1/admin/backup", async (c) => {
  const { results: tableRows } = await c.env.DB.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        AND name <> 'schema_version'
      ORDER BY name`,
  ).all<{ name: string }>();

  const tables: Record<string, unknown[]> = {};
  for (const { name } of tableRows ?? []) {
    // Table names come from sqlite_master (not user input), so the identifier
    // interpolation is safe; D1 has no bind slot for identifiers anyway.
    const { results } = await c.env.DB.prepare(`SELECT * FROM "${name}"`).all();
    tables[name] = results ?? [];
  }

  const date = new Date().toISOString().slice(0, 10);
  await logAudit(c.env.DB, c.get("email"), "admin.backup", undefined, {
    tables: Object.keys(tables).length,
  });
  return new Response(
    JSON.stringify({ generated_at: now(), tables }, null, 2),
    {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="canvasm-db-backup-${date}.json"`,
      },
    },
  );
});

// GET /v1/admin/projects/:id/archive — complete, RESTORABLE archive of ONE
// project (JSON, downloadable). The intended flow is: admin downloads this,
// THEN calls DELETE /v1/admin/projects/:id (which soft-deletes blobs to trash/
// and tombstones the meetings). The archive is the off-platform copy that lets
// you re-create the project later.
//
// Contents: { generated_at, blob_cap_bytes, project, meetings[] } where each
// meeting carries its D1 rows (invitees / participants / knocks / notes) AND
// its R2 blob CONTENTS (scenes / files / chats / library / transcripts),
// base64-encoded with key + contentType. Recordings are EXCLUDED on purpose.
app.get("/v1/admin/projects/:id/archive", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare(`SELECT * FROM project WHERE id = ?1`)
    .bind(id)
    .first();
  if (!project) {
    return c.json({ error: "not found" }, 404);
  }

  const { results: meetingRows } = await c.env.DB.prepare(
    `SELECT * FROM meeting WHERE project_id = ?1`,
  )
    .bind(id)
    .all<{ id: string }>();

  type ArchivedBlob = {
    key: string;
    contentType: string;
    size: number;
    data?: string; // base64; omitted when skipped
    skipped?: true; // true when over ARCHIVE_BLOB_CAP_BYTES
  };

  const meetings = [];
  for (const m of meetingRows ?? []) {
    const roomId = m.id;
    const [invitees, participants, knocks, notes] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM meeting_invitee WHERE meeting_id = ?1`)
        .bind(roomId)
        .all()
        .then((r) => r.results ?? []),
      c.env.DB.prepare(
        `SELECT * FROM meeting_participant WHERE meeting_id = ?1`,
      )
        .bind(roomId)
        .all()
        .then((r) => r.results ?? []),
      c.env.DB.prepare(`SELECT * FROM meeting_knock WHERE room_id = ?1`)
        .bind(roomId)
        .all()
        .then((r) => r.results ?? []),
      c.env.DB.prepare(
        `SELECT * FROM note WHERE scope = 'meeting' AND ref = ?1`,
      )
        .bind(roomId)
        .all()
        .then((r) => r.results ?? []),
    ]);

    // R2 blob contents for this meeting. We walk the SAME per-room prefixes the
    // delete cascade does (scenes/files/chats/library/transcripts) — and NOTE:
    // we deliberately do NOT walk `recordings/<roomId>` (Phase 5). Recordings
    // are large media; base64-ing them into a JSON would bloat the archive and
    // risk an OOM. They rely on R2 durability + soft-delete + lifecycle instead.
    // TODO(recordings): give recordings a separate per-file download/retention
    //   path (signed URL per file or `wrangler r2 object get`), NEVER bulk
    //   base64 into this archive. See docs/runbooks/backup.md.
    const blobs: ArchivedBlob[] = [];
    for (const prefix of [
      `scenes/${roomId}`,
      `files/${roomId}`,
      `chats/${roomId}`,
      `library/${roomId}`,
      `transcripts/${roomId}`,
    ]) {
      let cursor: string | undefined;
      do {
        const listed = await c.env.BUCKET.list({ prefix, cursor });
        for (const obj of listed.objects) {
          const contentType =
            obj.httpMetadata?.contentType ?? "application/octet-stream";
          if (obj.size > ARCHIVE_BLOB_CAP_BYTES) {
            blobs.push({
              key: obj.key,
              contentType,
              size: obj.size,
              skipped: true,
            });
            continue;
          }
          const blob = await c.env.BUCKET.get(obj.key);
          if (!blob) {
            continue;
          }
          blobs.push({
            key: obj.key,
            contentType,
            size: obj.size,
            data: bufToBase64(await blob.arrayBuffer()),
          });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }

    meetings.push({
      meeting: m,
      invitees,
      participants,
      knocks,
      notes,
      blobs,
    });
  }

  const date = new Date().toISOString().slice(0, 10);
  await logAudit(c.env.DB, c.get("email"), "admin.project.archive", id, {
    meetings: meetings.length,
  });
  return new Response(
    JSON.stringify(
      {
        generated_at: now(),
        blob_cap_bytes: ARCHIVE_BLOB_CAP_BYTES,
        project,
        meetings,
      },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="canvasm-project-${id}-${date}.json"`,
      },
    },
  );
});

// Full cascade delete of one meeting: every R2 blob under its per-room
// prefixes + every D1 row that references it (file index, invitees,
// participants, per-meeting notes), then the meeting row itself. Shared by
// the admin route and the organizer's delete-cancelled route so neither
// leaves orphans behind.
// Best-effort delete of a Daily room (cost cleanup — an orphaned room keeps
// billing/occupying the Daily account). 404 = already gone, treat as success;
// other failures are swallowed so they never block the D1/R2 cascade.
const deleteDailyRoom = async (env: Bindings, name: string): Promise<void> => {
  const apiKey = env.DAILY_API_KEY;
  if (!apiKey) {
    return;
  }
  try {
    await fetch(`${DAILY_API}/rooms/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    /* best-effort */
  }
};

const deleteMeetingCascade = async (
  env: Bindings,
  roomId: string,
  actor?: string,
): Promise<void> => {
  // Soft-delete blobs (B9): R2 has NO S3-style versioning, so a hard delete is
  // PERMANENT. Move each blob to a `trash/<deletedAt>/...` prefix instead —
  // recoverable, and aligned with the project rule "revoke ≠ delete, don't
  // hard-delete, keep history/moat" (memory mcm-guest-data-lifecycle). Set a
  // dashboard lifecycle rule on the `trash/` prefix to expire it after N days
  // (cost control). Bucket Locks (retention) guard against bucket-level deletes.
  const trashAt = now();
  for (const prefix of [
    `scenes/${roomId}`,
    `files/${roomId}`,
    `chats/${roomId}`,
    `library/${roomId}`,
    `transcripts/${roomId}`,
  ]) {
    let cursor: string | undefined;
    do {
      const listed = await env.BUCKET.list({ prefix, cursor });
      for (const obj of listed.objects) {
        const blob = await env.BUCKET.get(obj.key);
        if (blob) {
          await env.BUCKET.put(`trash/${trashAt}/${obj.key}`, blob.body, {
            httpMetadata: blob.httpMetadata,
            customMetadata: {
              ...(obj.customMetadata ?? {}),
              trashedFrom: obj.key,
              trashedAt: String(trashAt),
            },
          });
        }
        await env.BUCKET.delete(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  await env.DB.prepare(`DELETE FROM file WHERE meeting_id = ?1`)
    .bind(roomId)
    .run();
  await env.DB.prepare(`DELETE FROM meeting_invitee WHERE meeting_id = ?1`)
    .bind(roomId)
    .run();
  await env.DB.prepare(`DELETE FROM meeting_participant WHERE meeting_id = ?1`)
    .bind(roomId)
    .run();
  // Waiting-room knock rows (migration 0025) — keyed by the base meeting id.
  await env.DB.prepare(`DELETE FROM meeting_knock WHERE room_id = ?1`)
    .bind(roomId)
    .run();
  await env.DB.prepare(`DELETE FROM note WHERE scope = 'meeting' AND ref = ?1`)
    .bind(roomId)
    .run();
  await env.DB.prepare(`DELETE FROM meeting WHERE id = ?1`).bind(roomId).run();
  // Cost cleanup: drop both Daily rooms (screen-share <id> + audio <id>-audio).
  await deleteDailyRoom(env, roomId);
  await deleteDailyRoom(env, `${roomId}-audio`);
  // Tombstone: deleted stays deleted — the upsert PUT/POST routes check this
  // so a client still holding the room open can't resurrect the meeting.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO deleted_meeting (id, deleted_by, deleted_at)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(roomId, actor ?? null, now())
    .run();
};

// Delete a meeting + cascade (admin — any meeting, any state).
app.delete("/v1/admin/meetings/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const meeting = await c.env.DB.prepare(`SELECT id FROM meeting WHERE id = ?1`)
    .bind(roomId)
    .first();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  await deleteMeetingCascade(c.env, roomId, c.get("email"));
  await logAudit(c.env.DB, c.get("email"), "meeting.delete", roomId);
  return c.json({ ok: true, deleted: roomId });
});

// ---- Admin: dashboard stats ---------------------------------------------

app.get("/v1/admin/stats", async (c) => {
  const dayAgo = now() - 24 * 60 * 60 * 1000;
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM meeting) AS total_meetings,
       (SELECT COUNT(*) FROM project) AS total_projects,
       (SELECT COUNT(*) FROM meeting WHERE created_at > ?1) AS meetings_today,
       (SELECT COUNT(*) FROM file) AS total_files`,
  )
    .bind(dayAgo)
    .first();
  return c.json({ stats: row });
});

// ---- Admin: realtime monitoring ------------------------------------------
// Read-only live view of every meeting whose realtime collab is active. For DO
// rooms we fan out the same `__count` RPC the auth gate uses (in parallel, with
// a short timeout — a slow/missing DO degrades to "idle", it NEVER fails the
// page or wakes the DO). socket.io rooms have no DO to poll, so we approximate
// the connected count from recent meeting_participant rows. Auto-admin-gated by
// app.use("/v1/admin/*").
app.get("/v1/admin/realtime", async (c) => {
  const ROOM_WS_CAP = Number(c.env.ROOM_WS_CAP ?? "500") || 500;
  // ~90s recency window for "present" in a socket.io room and for host_present.
  const RECENT_MS = 90 * 1000;
  const recentCutoff = now() - RECENT_MS;

  type LiveMeeting = {
    id: string;
    title: string | null;
    realtime_backend: string | null;
    host_email: string | null;
    last_opened_at: number | null;
    created_at: number;
  };
  const { results: liveRows } = await c.env.DB.prepare(
    `SELECT id, title, realtime_backend, host_email, last_opened_at, created_at
       FROM meeting
      WHERE status = 'live'
      ORDER BY last_opened_at DESC
      LIMIT 50`,
  ).all<LiveMeeting>();
  const live = liveRows ?? [];

  // host_present + socket.io connected count both lean on the recent
  // participant set. One query per live meeting is cheap at LIMIT 50; run them
  // in parallel.
  const recentSets = await Promise.all(
    live.map(async (m) => {
      const { results } = await c.env.DB.prepare(
        `SELECT lower(user_email) AS email
           FROM meeting_participant
          WHERE meeting_id = ?1 AND last_seen_at > ?2`,
      )
        .bind(m.id, recentCutoff)
        .all<{ email: string }>();
      return { id: m.id, emails: (results ?? []).map((r) => r.email) };
    }),
  );
  const recentByMeeting = new Map(recentSets.map((r) => [r.id, r.emails]));

  // Fan out __count to every DO room in PARALLEL. Timeout/error → idle, count 0
  // (and counted toward the error tally for the health signal). MIRRORS the
  // exact call in handleRealtimeUpgrade (https://room.internal/__count).
  let doErrors = 0;
  let doRooms = 0;
  let socketioRooms = 0;
  const counts = await Promise.allSettled(
    live.map(async (m) => {
      if (m.realtime_backend === "do") {
        const stub = c.env.ROOM.get(c.env.ROOM.idFromName(m.id));
        const res = await stub.fetch("https://room.internal/__count", {
          method: "GET",
          signal: AbortSignal.timeout(800),
        });
        if (!res.ok) {
          throw new Error(`__count ${res.status}`);
        }
        const { count } = (await res.json()) as { count: number };
        return { id: m.id, connected: typeof count === "number" ? count : 0 };
      }
      // socket.io / null: approximate from the recent participant set.
      return {
        id: m.id,
        connected: (recentByMeeting.get(m.id) ?? []).length,
      };
    }),
  );
  const connectedByMeeting = new Map<string, number>();
  live.forEach((m, i) => {
    const settled = counts[i];
    const isDo = m.realtime_backend === "do";
    if (isDo) {
      doRooms += 1;
    } else {
      socketioRooms += 1;
    }
    if (settled.status === "fulfilled") {
      connectedByMeeting.set(m.id, settled.value.connected);
    } else {
      // DO __count failed → idle, 0 connected. Do NOT fail the page.
      connectedByMeeting.set(m.id, 0);
      if (isDo) {
        doErrors += 1;
      }
    }
  });

  const fmtSince = (ms: number | null): string => {
    if (!ms) {
      return "—";
    }
    const mins = Math.max(0, Math.round((now() - ms) / 60000));
    if (mins < 1) {
      return "vừa xong";
    }
    if (mins < 60) {
      return `${mins} phút`;
    }
    const h = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${h} giờ ${rem} phút` : `${h} giờ`;
  };

  let roomsFull = 0;
  let peopleConnected = 0;
  const rooms = live.map((m, i) => {
    const connected = connectedByMeeting.get(m.id) ?? 0;
    const isDo = m.realtime_backend === "do";
    const settled = counts[i];
    const doFailed = isDo && settled?.status === "rejected";
    const full = connected >= ROOM_WS_CAP;
    if (full) {
      roomsFull += 1;
    }
    peopleConnected += connected;
    const state: "active" | "idle" | "full" = full
      ? "full"
      : doFailed || connected === 0
      ? "idle"
      : "active";
    const since = m.last_opened_at ?? m.created_at;
    const hostEmail = m.host_email?.toLowerCase() ?? null;
    const recent = recentByMeeting.get(m.id) ?? [];
    return {
      room_id: m.id,
      title: m.title,
      backend: isDo ? "do" : "socketio",
      connected,
      // DO count is exact; socket.io is an approximation from last_seen_at.
      connected_exact: isDo && !doFailed,
      host_present: hostEmail ? recent.includes(hostEmail) : false,
      state,
      since,
      since_label: fmtSince(since),
    };
  });

  // rejections_24h — grouped by reason out of the audit_log meta JSON (there is
  // no `reason` column; logAudit stores { reason } inside meta). Returns null if
  // the table or rows aren't there yet (best-effort; never fails the page).
  let rejections: {
    denied: number;
    revoked: number;
    finished: number;
    room_full: number;
    total: number;
  } | null = null;
  try {
    const dayAgo = now() - 86_400_000;
    const { results: rejRows } = await c.env.DB.prepare(
      `SELECT json_extract(meta, '$.reason') AS reason, COUNT(*) AS n
         FROM audit_log
        WHERE action = 'realtime.reject' AND ts > ?1
        GROUP BY reason`,
    )
      .bind(dayAgo)
      .all<{ reason: string | null; n: number }>();
    if (rejRows) {
      const agg = {
        denied: 0,
        revoked: 0,
        finished: 0,
        room_full: 0,
        total: 0,
      };
      for (const r of rejRows) {
        const n = Number(r.n) || 0;
        agg.total += n;
        if (r.reason === "denied") {
          agg.denied += n;
        } else if (r.reason === "revoked") {
          agg.revoked += n;
        } else if (r.reason === "finished") {
          agg.finished += n;
        } else if (r.reason === "room_full") {
          agg.room_full += n;
        }
      }
      rejections = agg;
    }
  } catch {
    rejections = null;
  }

  // Health: down if >50% of DO rooms errored on __count; warn on any idle/full
  // or a rejection spike; else ok.
  const idleCount = rooms.filter((r) => r.state === "idle").length;
  const rejectionSpike = (rejections?.total ?? 0) > 20;
  let health: "ok" | "warn" | "down" = "ok";
  if (doRooms > 0 && doErrors / doRooms > 0.5) {
    health = "down";
  } else if (idleCount > 0 || roomsFull > 0 || rejectionSpike) {
    health = "warn";
  }

  // Cloudflare observability deep-link for the mcm-storage Worker.
  const observabilityUrl =
    "https://dash.cloudflare.com/?to=/:account/workers/services/view/mcm-storage/production/observability";

  return c.json({
    health,
    generated_at: now(),
    summary: {
      live_meetings: live.length,
      people_connected: peopleConnected,
      rooms_on_do: doRooms,
      rooms_on_socketio: socketioRooms,
      rooms_full: roomsFull,
      ws_cap: ROOM_WS_CAP,
    },
    rooms,
    rejections_24h: rejections,
    observability_url: observabilityUrl,
  });
});

// ---- Admin: audit log ----------------------------------------------------
app.get("/v1/admin/audit", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, actor_email, action, target, meta, ts
     FROM audit_log ORDER BY ts DESC LIMIT 200`,
  ).all();
  return c.json({ entries: results });
});

// ---- Admin: storage (R2 usage from the D1 file index) --------------------
app.get("/v1/admin/storage", async (c) => {
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM file`,
  ).first();
  const { results: byKind } = await c.env.DB.prepare(
    `SELECT kind, COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes
     FROM file GROUP BY kind ORDER BY bytes DESC`,
  ).all();
  const { results: topMeetings } = await c.env.DB.prepare(
    `SELECT f.meeting_id, m.title, COUNT(*) AS files,
            COALESCE(SUM(f.size),0) AS bytes
     FROM file f LEFT JOIN meeting m ON m.id = f.meeting_id
     GROUP BY f.meeting_id ORDER BY bytes DESC LIMIT 10`,
  ).all();
  return c.json({ total, byKind, topMeetings });
});

// ---- Admin: cost/usage aggregates ----------------------------------------
// Raw usage we can measure from our own data; the client multiplies by the
// published provider rates to show an ESTIMATE (real $ lives in each provider's
// billing dashboard, linked client-side).
app.get("/v1/admin/cost", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM meeting) AS meetings,
       (SELECT COUNT(*) FROM project) AS projects,
       (SELECT COALESCE(SUM(size),0) FROM file) AS storage_bytes,
       (SELECT COALESCE(SUM(duration_s),0) FROM meeting) AS total_seconds`,
  ).first<{
    meetings: number;
    projects: number;
    storage_bytes: number;
    total_seconds: number;
  }>();

  // AI cost breakdown (Admin Console P0) — joined from usage_events. Best-effort:
  // an un-migrated DB (no usage_events table) yields all-zeros, never a 500.
  let ai = {
    gemini: {
      total_cost_usd: 0,
      translate_calls: 0,
      chatbot_calls: 0,
      summarize_calls: 0,
      total_tokens: 0,
    },
    deepgram: { total_cost_usd: 0, stt_seconds: 0 },
    ai_calls: 0,
    cost_estimate_usd: 0,
  };
  try {
    const u = await c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN provider='gemini' THEN est_cost_usd END),0) AS gemini_cost,
         COALESCE(SUM(CASE WHEN provider='gemini' THEN tokens_in+tokens_out END),0) AS gemini_tokens,
         COALESCE(SUM(CASE WHEN provider='gemini' AND kind='translate' THEN 1 END),0) AS translate_calls,
         COALESCE(SUM(CASE WHEN provider='gemini' AND kind='chatbot'   THEN 1 END),0) AS chatbot_calls,
         COALESCE(SUM(CASE WHEN provider='gemini' AND kind='summarize' THEN 1 END),0) AS summarize_calls,
         COALESCE(SUM(CASE WHEN provider='deepgram' THEN est_cost_usd END),0) AS deepgram_cost,
         COALESCE(SUM(CASE WHEN provider='deepgram' THEN seconds END),0) AS stt_seconds,
         COUNT(*) AS ai_calls,
         COALESCE(SUM(est_cost_usd),0) AS total_cost
       FROM usage_events`,
    ).first<{
      gemini_cost: number;
      gemini_tokens: number;
      translate_calls: number;
      chatbot_calls: number;
      summarize_calls: number;
      deepgram_cost: number;
      stt_seconds: number;
      ai_calls: number;
      total_cost: number;
    }>();
    if (u) {
      ai = {
        gemini: {
          total_cost_usd: u.gemini_cost,
          translate_calls: u.translate_calls,
          chatbot_calls: u.chatbot_calls,
          summarize_calls: u.summarize_calls,
          total_tokens: u.gemini_tokens,
        },
        deepgram: {
          total_cost_usd: u.deepgram_cost,
          stt_seconds: u.stt_seconds,
        },
        ai_calls: u.ai_calls,
        cost_estimate_usd: u.total_cost,
      };
    }
  } catch {
    // usage_events table missing (pre-0028 DB) — keep the all-zero default
  }

  return c.json({
    usage: {
      meetings: row?.meetings ?? 0,
      projects: row?.projects ?? 0,
      storage_bytes: row?.storage_bytes ?? 0,
      meeting_minutes: Math.round((row?.total_seconds ?? 0) / 60),
      recording_minutes: 0, // tracked once Phase 5 recording lands
      ai_calls: ai.ai_calls,
    },
    ai_cost_breakdown: { gemini: ai.gemini, deepgram: ai.deepgram },
    ai_calls: ai.ai_calls,
    cost_estimate_usd: ai.cost_estimate_usd,
  });
});

// ---- Admin: AI cost & usage (Admin Console P0) ---------------------------
// Full AI spend dashboard: a roll-up summary (by provider + by kind), a daily
// spend trend, and a paginated recent-events feed. Sourced from usage_events
// (best-effort metered by ai.ts / the STT proxy). An un-migrated DB yields the
// empty shape, never a 500.
app.get("/v1/admin/usage", async (c) => {
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1),
    500,
  );
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

  const empty = {
    summary: {
      total_cost_usd: 0,
      total_ai_calls: 0,
      by_provider: [] as Array<{
        name: string;
        total_cost_usd: number;
        total_tokens: number;
        total_seconds: number;
        calls: number;
      }>,
      by_kind: [] as Array<{ kind: string; cost_usd: number; count: number }>,
    },
    daily_trend: [] as Array<{
      date: string;
      cost_usd: number;
      call_count: number;
    }>,
    recent: [] as Array<Record<string, unknown>>,
  };

  try {
    const totals = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(est_cost_usd),0) AS total_cost_usd,
              COUNT(*) AS total_ai_calls
         FROM usage_events`,
    ).first<{ total_cost_usd: number; total_ai_calls: number }>();

    const { results: byProvider } = await c.env.DB.prepare(
      `SELECT COALESCE(provider,'unknown') AS name,
              COALESCE(SUM(est_cost_usd),0) AS total_cost_usd,
              COALESCE(SUM(tokens_in+tokens_out),0) AS total_tokens,
              COALESCE(SUM(seconds),0) AS total_seconds,
              COUNT(*) AS calls
         FROM usage_events
        GROUP BY provider
        ORDER BY total_cost_usd DESC`,
    ).all<{
      name: string;
      total_cost_usd: number;
      total_tokens: number;
      total_seconds: number;
      calls: number;
    }>();

    const { results: byKind } = await c.env.DB.prepare(
      `SELECT COALESCE(kind,'unknown') AS kind,
              COALESCE(SUM(est_cost_usd),0) AS cost_usd,
              COUNT(*) AS count
         FROM usage_events
        GROUP BY kind
        ORDER BY cost_usd DESC`,
    ).all<{ kind: string; cost_usd: number; count: number }>();

    // Daily spend — group by UTC calendar day (ts is ms epoch). 30-day window.
    const { results: daily } = await c.env.DB.prepare(
      `SELECT date(ts/1000,'unixepoch') AS date,
              COALESCE(SUM(est_cost_usd),0) AS cost_usd,
              COUNT(*) AS call_count
         FROM usage_events
        WHERE ts > ?1
        GROUP BY date
        ORDER BY date ASC`,
    )
      .bind(now() - 30 * 86400000)
      .all<{ date: string; cost_usd: number; call_count: number }>();

    const { results: recent } = await c.env.DB.prepare(
      `SELECT id, ts, provider, kind, tokens_in, tokens_out, seconds,
              est_cost_usd, email, meeting_id
         FROM usage_events
        ORDER BY ts DESC
        LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit, offset)
      .all<Record<string, unknown>>();

    return c.json({
      summary: {
        total_cost_usd: totals?.total_cost_usd ?? 0,
        total_ai_calls: totals?.total_ai_calls ?? 0,
        by_provider: byProvider,
        by_kind: byKind,
      },
      daily_trend: daily,
      recent,
    });
  } catch {
    // usage_events table missing (pre-0028 DB) — return the empty shape
    return c.json(empty);
  }
});

// ---- Admin: system status (Admin Console P0) -----------------------------
// Lightweight service-health board for the console. D1 gets a cheap real ping
// (it's the dependency most worth knowing about); the rest report static 'on'
// when their binding/secret is present. Stub-grade by design — deep upstream
// health checks (Gemini/Deepgram round-trips) would burn metered quota.
app.get("/v1/admin/system-status", async (c) => {
  const lastCheck = now();
  let d1: "on" | "warn" | "off" = "on";
  let d1Detail: string | undefined;
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (err) {
    d1 = "off";
    d1Detail = (err as Error)?.message?.slice(0, 120) ?? "ping failed";
  }

  const svc = (
    id: string,
    name: string,
    ok: boolean,
    detail?: string,
  ): {
    id: string;
    name: string;
    status: "on" | "warn" | "off";
    last_check: number;
    detail?: string;
  } => ({
    id,
    name,
    status: ok ? "on" : "warn",
    last_check: lastCheck,
    ...(detail ? { detail } : {}),
  });

  const sttProvider = (c.env.STT_PROVIDER ?? "deepgram").trim() || "deepgram";

  return c.json({
    services: [
      {
        id: "d1",
        name: "D1 database",
        status: d1,
        last_check: lastCheck,
        ...(d1Detail ? { detail: d1Detail } : {}),
      },
      svc("r2", "R2 storage", !!c.env.BUCKET),
      svc("auth", "Supabase Auth", !!c.env.SUPABASE_URL, "JWT verify (JWKS)"),
      svc("realtime", "Realtime relay (DO)", !!c.env.ROOM),
      svc(
        "gemini",
        "Gemini (AI)",
        !!c.env.GEMINI_API_KEY,
        "translate/chatbot/summarize",
      ),
      svc(
        "stt",
        "Speech-to-text",
        !!c.env.DEEPGRAM_API_KEY,
        `provider: ${sttProvider}`,
      ),
      svc("daily", "Daily.co (media)", !!c.env.DAILY_API_KEY),
      svc("email", "Resend (email)", !!c.env.RESEND_API_KEY),
    ],
  });
});

// ---- Admin: integration/health status ------------------------------------
app.get("/v1/admin/integrations", (c) => {
  return c.json({
    integrations: [
      {
        name: "Supabase Auth",
        configured: !!c.env.SUPABASE_URL,
        note: "user login + JWT verify (JWKS)",
      },
      {
        name: "Supabase Admin",
        configured: !!c.env.SUPABASE_SERVICE_API_KEY,
        note: "user management (this console)",
      },
      {
        name: "Daily.co",
        configured: !!c.env.DAILY_API_KEY,
        note: "audio + screen-share media",
      },
      {
        name: "R2 storage",
        configured: !!c.env.BUCKET,
        note: "scenes/files/chats/library",
      },
      {
        name: "D1 database",
        configured: !!c.env.DB,
        note: "registry + audit log",
      },
      {
        name: "Gemini (AI)",
        configured: null,
        note: "room server — translate / summarize / chatbot",
      },
      {
        name: "Deepgram (STT)",
        configured: null,
        note: "room server — speech-to-text",
      },
      {
        name: "Cloudflare TURN",
        configured: null,
        note: "room server — WebRTC relay",
      },
    ],
  });
});

// ---- Admin: system settings ---------------------------------------------
app.get("/v1/admin/settings", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT key, value FROM system_settings`,
  ).all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const r of results) {
    settings[r.key] = r.value;
  }
  return c.json({ settings });
});

app.put("/v1/admin/settings", async (c) => {
  const body = await c.req.json<{ settings?: Record<string, string> }>();
  const entries = Object.entries(body.settings ?? {});
  for (const [k, v] of entries) {
    await c.env.DB.prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
    )
      .bind(k, v, now())
      .run();
  }
  await logAudit(c.env.DB, c.get("email"), "settings.update", undefined, {
    keys: entries.map((e) => e[0]),
  });
  return c.json({ ok: true });
});

// ---- Admin: analytics ----------------------------------------------------
app.get("/v1/admin/analytics", async (c) => {
  const d7 = now() - 7 * 86400000;
  const d30 = now() - 30 * 86400000;
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM meeting WHERE created_at > ?1) AS meetings_7d,
       (SELECT COUNT(*) FROM meeting WHERE created_at > ?2) AS meetings_30d,
       (SELECT COUNT(*) FROM meeting_participant) AS participations,
       (SELECT COUNT(DISTINCT user_email) FROM meeting_participant)
         AS unique_participants`,
  )
    .bind(d7, d30)
    .first();
  const { results: topProjects } = await c.env.DB.prepare(
    `SELECT p.name AS name, COUNT(m.id) AS meetings
     FROM meeting m JOIN project p ON p.id = m.project_id
     GROUP BY m.project_id ORDER BY meetings DESC LIMIT 5`,
  ).all();
  const { results: topParticipants } = await c.env.DB.prepare(
    `SELECT COALESCE(name, user_email) AS name, user_email, COUNT(*) AS meetings
     FROM meeting_participant GROUP BY user_email
     ORDER BY meetings DESC LIMIT 5`,
  ).all();
  return c.json({ counts, topProjects, topParticipants });
});

// ---- Portal backdrops (admin-managed client-page backgrounds) ------------
// The client portal + guest waiting room crossfade these images. Admin uploads
// /renames/reorders/deletes them here; the client reads /v1/portal/backdrops
// (any authenticated user) and falls back to bundled defaults if empty/failing.
const MAX_BACKDROP_BYTES = 5 * 1024 * 1024;
const backdropKey = (id: string) => `backdrops/${id}`;

// Client-branding helpers (06-17): a backdrop / guest may be tagged with an
// ISO-3166 alpha-2 COUNTRY ("VN", "KR", …). Normalize to upper-case 2-letter or
// null (blank / malformed → global). Defensive: never trusts client casing or
// length, so the tag column stays clean for the per-country resolve lookup.
export const normCountry = (v: unknown): string | null => {
  if (typeof v !== "string") {
    return null;
  }
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
};

// Resolve a client's backdrop rotation from the full sort-ordered list: the
// backdrops tagged with their COUNTRY, else the GLOBAL (untagged) ones as the
// fallback. No country → the whole list (admin preview / legacy). Pure so the
// /v1/portal/backdrops route and its test share one source of truth.
export const resolveBackdropsForCountry = <
  T extends { country: string | null },
>(
  all: T[],
  country: string | null,
): T[] => {
  if (!country) {
    return all;
  }
  const tagged = all.filter((r) => r.country === country);
  return tagged.length ? tagged : all.filter((r) => r.country === null);
};

type BackdropRow = {
  id: string;
  title: string | null;
  r2_key: string;
  sort_order: number;
  created_at: number;
  country: string | null;
};

// Admin: upload a new backdrop. FIRST multipart route — Hono on Workers exposes
// the standard Fetch API via c.req.formData(); a File field carries the bytes.
app.post("/v1/admin/backdrops", async (c) => {
  const form = await c.req.formData();
  // form.get returns FormDataEntryValue | null; the multipart File arrives as a
  // Blob-like with arrayBuffer()/type. Read it as unknown and duck-type it (the
  // Workers tsconfig doesn't expose a `File` value for instanceof).
  const entry: unknown = form.get("file");
  const file = entry as {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    type?: string;
  } | null;
  if (
    !file ||
    typeof file === "string" ||
    typeof file.arrayBuffer !== "function"
  ) {
    return c.json({ error: "file required" }, 400);
  }
  const contentType = file.type || "application/octet-stream";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "image content-type required" }, 400);
  }
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) {
    return c.json({ error: "empty file" }, 400);
  }
  if (bytes.byteLength > MAX_BACKDROP_BYTES) {
    return c.json({ error: "file too large (max 5MB)" }, 413);
  }
  const rawTitle = form.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : null;
  // Optional COUNTRY tag (06-17): the client entry page resolves the backdrop by
  // the client's country; NULL = a global/default backdrop. Admin sends one
  // `country` per upload (the multi-select uploads share the same tag).
  const country = normCountry(form.get("country"));
  const id = crypto.randomUUID();
  const key = backdropKey(id);
  await c.env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });
  const max = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS mx FROM portal_backdrop`,
  ).first<{ mx: number }>();
  const sortOrder = (max?.mx ?? -1) + 1;
  const createdAt = now();
  await c.env.DB.prepare(
    `INSERT INTO portal_backdrop (id, title, r2_key, sort_order, created_at, country)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, title, key, sortOrder, createdAt, country)
    .run();
  await logAudit(c.env.DB, c.get("email"), "backdrop.create", id, {
    title,
    country,
  });
  const row: BackdropRow = {
    id,
    title,
    r2_key: key,
    sort_order: sortOrder,
    created_at: createdAt,
    country,
  };
  return c.json(row);
});

// Admin: list backdrops in rotation order.
app.get("/v1/admin/backdrops", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, r2_key, sort_order, created_at, country
     FROM portal_backdrop ORDER BY sort_order ASC, created_at ASC`,
  ).all<BackdropRow>();
  return c.json({ backdrops: results });
});

// Admin: rename and/or reorder.
app.patch("/v1/admin/backdrops/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{
    title?: string;
    sort_order?: number;
    country?: string | null;
  }>();
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (b.title !== undefined) {
    const title = (b.title ?? "").trim();
    sets.push(`title = ?${binds.length + 1}`);
    binds.push(title || null);
  }
  if (b.sort_order !== undefined) {
    if (!Number.isFinite(b.sort_order)) {
      return c.json({ error: "invalid sort_order" }, 400);
    }
    sets.push(`sort_order = ?${binds.length + 1}`);
    binds.push(Math.trunc(b.sort_order));
  }
  // Re-tag the country (06-17). Explicit null/"" clears it back to global.
  if (b.country !== undefined) {
    sets.push(`country = ?${binds.length + 1}`);
    binds.push(normCountry(b.country));
  }
  if (!sets.length) {
    return c.json({ error: "nothing to update" }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE portal_backdrop SET ${sets.join(", ")} WHERE id = ?${
      binds.length + 1
    }`,
  )
    .bind(...binds, id)
    .run();
  await logAudit(c.env.DB, c.get("email"), "backdrop.update", id, b);
  return c.json({ ok: true, id });
});

// Admin: delete the row + its R2 object.
app.delete("/v1/admin/backdrops/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM portal_backdrop WHERE id = ?1`,
  )
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  await c.env.BUCKET.delete(row.r2_key);
  await c.env.DB.prepare(`DELETE FROM portal_backdrop WHERE id = ?1`)
    .bind(id)
    .run();
  await logAudit(c.env.DB, c.get("email"), "backdrop.delete", id);
  return c.json({ ok: true, id });
});

// Portal: ANY authenticated user (the guest portal must read this — NOT
// admin-gated). Returns the rotation list with an image URL per item.
app.get("/v1/portal/backdrops", async (c) => {
  // Optional ?country=XX → resolve the rotation for ONE client's country
  // (06-17): country-tagged backdrops first, falling back to the GLOBAL
  // (untagged) rotation when that country has none. No param → every backdrop
  // (the staff/admin preview + legacy callers). `country` is returned so the
  // client can tell a country-specific hit from the global fallback.
  const want = normCountry(c.req.query("country"));
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, country FROM portal_backdrop
     ORDER BY sort_order ASC, created_at ASC`,
  ).all<{ id: string; title: string | null; country: string | null }>();
  const rows = resolveBackdropsForCountry(results, want);
  return c.json({
    backdrops: rows.map((r) => ({
      id: r.id,
      title: r.title,
      country: r.country,
      url: `/v1/portal/backdrops/${r.id}/image`,
    })),
  });
});

// Portal: stream a backdrop image (any authenticated user). Mirrors the blob
// stream routes; long Cache-Control since the bytes are immutable per id.
app.get("/v1/portal/backdrops/:id/image", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT r2_key FROM portal_backdrop WHERE id = ?1`,
  )
    .bind(c.req.param("id"))
    .first<{ r2_key: string }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(obj.body, {
    headers: {
      "content-type":
        obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
      "cache-control": "public, max-age=86400",
    },
  });
});

// ---- Client branding: guest country / company / logo (06-17) -------------
// A project guest IS the external client; the host brands their entry page with
// a COUNTRY (picks the backdrop) + COMPANY + LOGO. country/company live on the
// project_guest row (edited via the guest add/update routes above); the LOGO is
// an image uploaded to R2 at `guest-logos/<guestId>` (logo_key on the row).
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const guestLogoKey = (guestId: string) => `guest-logos/${guestId}`;

// Host: upload (replace) a guest's logo. Multipart (file). Same gate as managing
// the project's guests. Stores the bytes in R2, stamps logo_key, returns the
// portal image URL the client page will fetch.
app.post("/v1/projects/:projectId/guests/:id/logo", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const guest = await c.env.DB.prepare(
    `SELECT id FROM project_guest WHERE id = ?1 AND project_id = ?2`,
  )
    .bind(id, projectId)
    .first<{ id: string }>();
  if (!guest) {
    return c.json({ error: "not found" }, 404);
  }
  const form = await c.req.formData();
  const entry: unknown = form.get("file");
  const file = entry as {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    type?: string;
  } | null;
  if (
    !file ||
    typeof file === "string" ||
    typeof file.arrayBuffer !== "function"
  ) {
    return c.json({ error: "file required" }, 400);
  }
  const contentType = file.type || "application/octet-stream";
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "image content-type required" }, 400);
  }
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) {
    return c.json({ error: "empty file" }, 400);
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return c.json({ error: "file too large (max 2MB)" }, 413);
  }
  const key = guestLogoKey(id);
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  await c.env.DB.prepare(
    `UPDATE project_guest SET logo_key = ?1 WHERE id = ?2 AND project_id = ?3`,
  )
    .bind(key, id, projectId)
    .run();
  await logAudit(c.env.DB, email, "project_guest.logo", projectId, { id });
  return c.json({ ok: true, id, url: `/v1/portal/guests/${id}/logo` });
});

// Host: remove a guest's logo (drop the R2 object + clear logo_key).
app.delete("/v1/projects/:projectId/guests/:id/logo", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const row = await c.env.DB.prepare(
    `SELECT logo_key FROM project_guest WHERE id = ?1 AND project_id = ?2`,
  )
    .bind(id, projectId)
    .first<{ logo_key: string | null }>();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  if (row.logo_key) {
    await c.env.BUCKET.delete(row.logo_key);
  }
  await c.env.DB.prepare(
    `UPDATE project_guest SET logo_key = NULL WHERE id = ?1 AND project_id = ?2`,
  )
    .bind(id, projectId)
    .run();
  await logAudit(c.env.DB, email, "project_guest.logo.remove", projectId, {
    id,
  });
  return c.json({ ok: true, id });
});

// Portal: stream a guest's logo by guest id (any authenticated user — the
// client portal fetches its OWN logo through fetchWithAuth, same trick as the
// backdrop image). The bytes aren't confidential beyond the login; the id is a
// UUID. 404 when the guest has no logo.
app.get("/v1/portal/guests/:id/logo", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT logo_key FROM project_guest WHERE id = ?1`,
  )
    .bind(c.req.param("id"))
    .first<{ logo_key: string | null }>();
  if (!row?.logo_key) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.BUCKET.get(row.logo_key);
  if (!obj) {
    return c.json({ error: "not found" }, 404);
  }
  return new Response(obj.body, {
    headers: {
      "content-type":
        obj.httpMetadata?.contentType ?? "application/octet-stream",
      etag: obj.httpEtag,
      "cache-control": "private, max-age=3600",
    },
  });
});

// Portal: a GUEST resolves their OWN branding. The JWT email IS the synthetic
// login, so we look the guest up by `login = email` (their active row), and
// return their country + company + the logo image URL. The client page uses
// `country` to pick the backdrop (GET /v1/portal/backdrops?country=XX) and
// overlays `logo_url`. Staff/admin (no guest row) get an empty payload → the
// page falls back to the default rotation, no logo.
app.get("/v1/portal/me", async (c) => {
  const email = c.get("email")?.toLowerCase();
  if (!email) {
    return c.json({ guest: null });
  }
  const row = await c.env.DB.prepare(
    `SELECT id, label, company, country, logo_key
       FROM project_guest
      WHERE login = ?1 AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{
      id: string;
      label: string | null;
      company: string | null;
      country: string | null;
      logo_key: string | null;
    }>();
  if (!row) {
    return c.json({ guest: null });
  }
  return c.json({
    guest: {
      id: row.id,
      label: row.label,
      company: row.company,
      country: row.country,
      logo_url: row.logo_key ? `/v1/portal/guests/${row.id}/logo` : null,
    },
  });
});

// ===========================================================================
// Realtime WebSocket gate — GET /rooms/:roomId/ws  (Durable Objects migration)
// ===========================================================================
//
// This is the AUTH HANDSHAKE that closes 1b/B12: socket.io relayed scene bytes
// to ANYONE who knew the roomId (room/src/index.ts:863-920, cors origin:'*',
// no verify). The DO transport instead verifies, AT THE WORKER, BEFORE
// env.ROOM.get() and BEFORE returning 101:
//   1. Supabase JWT (token from Sec-WebSocket-Protocol; ?token= fallback)
//   2. canSeeMeeting(DB, email, role, roomId)
//   3. knock 'admitted' for external (role≠admin && !isInternalEmail)
//   4. WS-count cap (RPC to the DO) < N
// FAIL → 401/403 (NEVER 101). The DO re-trusts the identity we pass in headers
// (no JWKS in the DO hot path). See plan §4.
//
// Run BEFORE Hono /v1 handling via a pathname route-split in the default
// fetch() export below. /stt is reserved for a separate split (STT proxy, not
// migrated here) so a /stt upgrade never reaches RoomDO (plan §6).

/** The protocol marker the client always sends first so the server has a
 *  valid, echo-able subprotocol even on an anonymous (token-less) attempt.
 *  Mirrors RawWsTransport's `["mcm.v1", token]`. It is NEVER the JWT. */
const REALTIME_PROTOCOL_MARKER = "mcm.v1";

/** Pull the bearer token for the WS handshake. Sec-WebSocket-Protocol is
 *  preferred (query params leak into logs/referrers, R7). The client sends
 *  `Sec-WebSocket-Protocol: mcm.v1, <jwt>` — so the TOKEN is the segment that
 *  is NOT the "mcm.v1" marker, and we MUST echo the MARKER (never the token)
 *  back on the 101 or the browser fails the handshake. (M1) */
const realtimeToken = (
  req: Request,
): { token: string; subprotocol: string | null } => {
  const proto = req.headers.get("Sec-WebSocket-Protocol");
  if (proto) {
    const segments = proto
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // The token is the first segment that isn't the protocol marker.
    const token = segments.find((s) => s !== REALTIME_PROTOCOL_MARKER) ?? "";
    if (token) {
      // Echo the marker (if the client offered it) so we never leak the JWT
      // back in the 101 response header. Fall back to the marker regardless —
      // it's the protocol both sides agreed on.
      const subprotocol = segments.includes(REALTIME_PROTOCOL_MARKER)
        ? REALTIME_PROTOCOL_MARKER
        : null;
      return { token, subprotocol };
    }
  }
  const url = new URL(req.url);
  const qp = url.searchParams.get("token");
  return { token: qp ?? "", subprotocol: null };
};

type RealtimeIdentity = { sub: string; email: string; role: string };

/** Verify the Supabase JWT for the WS handshake. Mirrors the /v1 middleware
 *  (src/index.ts:146-183) — same offline ES256 JWKS verify, issuer + audience.
 *  Returns the identity or null on any failure (caller maps to 401). */
export const verifyRealtimeJwt = async (
  token: string,
  env: Bindings,
): Promise<RealtimeIdentity | null> => {
  if (!env.SUPABASE_URL || !token) {
    return null;
  }
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: "authenticated",
    });
    const appMeta = payload.app_metadata as { role?: unknown } | undefined;
    return {
      sub: String(payload.sub ?? ""),
      email: typeof payload.email === "string" ? payload.email : "",
      role: typeof appMeta?.role === "string" ? appMeta.role : "",
    };
  } catch {
    return null;
  }
};

/**
 * Handle the realtime WS upgrade. Returns a Response (101 on success, 401/403
 * on auth failure, 4xx on bad request). NEVER returns 101 unless every gate
 * passes (plan §4).
 */
export const handleRealtimeUpgrade = async (
  request: Request,
  env: Bindings,
  roomId: string,
): Promise<Response> => {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  if (!roomId) {
    return new Response("missing roomId", { status: 400 });
  }
  if (!env.SUPABASE_URL) {
    return new Response("auth not configured", { status: 503 });
  }

  // 1) JWT.
  const { token, subprotocol } = realtimeToken(request);
  const identity = await verifyRealtimeJwt(token, env);
  if (!identity) {
    // Best-effort reject audit (powers the admin Realtime "rejections_24h"
    // metric). No verified email here, so attribute to null. NEVER block the
    // 401 on the audit write.
    void logAudit(env.DB, undefined, "realtime.reject", roomId, {
      reason: "denied",
    });
    return new Response("unauthorized", { status: 401 });
  }

  // Keep the internal-domain list warm — the knock check below depends on it.
  await refreshInternalDomains(env.DB);

  // 2) canSeeMeeting — same membership authz as the REST routes (:306-372).
  const canSee = await canSeeMeeting(
    env.DB,
    identity.email,
    identity.role,
    roomId,
  );
  if (!canSee) {
    void logAudit(env.DB, identity.email, "realtime.reject", roomId, {
      reason: "denied",
    });
    return new Response("forbidden", { status: 403 });
  }

  // 2b) Finished = immutable review (D3). A finished meeting is read-only; a
  //     reviewer must NOT be able to relay scene/cursor bytes into a frozen
  //     room. Mirror the Daily-token endpoint's isFinishedLocked gate (:3508)
  //     and reject the upgrade with 409 (NEVER 101) — same status the REST
  //     write routes return on a locked room.
  if (await isFinishedLocked(env.DB, roomId)) {
    void logAudit(env.DB, identity.email, "realtime.reject", roomId, {
      reason: "finished",
    });
    return new Response("meeting is finished (read-only)", { status: 409 });
  }

  // 3) Knock gate for EXTERNAL users (mirrors the Daily-token gate :3502-3514):
  //    a guest with the roomKey but a non-admitted knock must NOT relay scene
  //    bytes. Internal staff + admins skip (they auto-admit, never knock).
  if (identity.role !== "admin" && !isInternalEmail(identity.email)) {
    const knock = await env.DB.prepare(
      `SELECT status FROM meeting_knock WHERE room_id = ?1 AND email = ?2`,
    )
      .bind(roomId, identity.email.toLowerCase())
      .first<{ status: string | null }>();
    if (knock?.status !== "admitted") {
      // A previously-admitted guest whose knock was flipped to 'revoked' =
      // a kick; anything else (never knocked / still pending) = denied. The
      // admin Realtime page splits these two in its 24h rejection breakdown.
      void logAudit(env.DB, identity.email, "realtime.reject", roomId, {
        reason: knock?.status === "revoked" ? "revoked" : "denied",
      });
      return new Response("not admitted to this meeting", { status: 403 });
    }
  }

  // 4) WS-count cap — RPC to the DO for the live connection count. Over cap →
  //    403 (anti-DDoS, spam-open WS, R14). Done BEFORE accepting the socket.
  const id = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(id);
  const cap = Number(env.ROOM_WS_CAP ?? "500") || 500;
  try {
    const countRes = await stub.fetch("https://room.internal/__count", {
      method: "GET",
    });
    if (countRes.ok) {
      const { count } = (await countRes.json()) as { count: number };
      if (typeof count === "number" && count >= cap) {
        void logAudit(env.DB, identity.email, "realtime.reject", roomId, {
          reason: "room_full",
        });
        return new Response("room is full", { status: 403 });
      }
    }
  } catch {
    // Count RPC failed — fail open on the cap only (auth already passed); the
    // DO is the source of truth and will still accept. Do NOT 101-bypass auth.
  }

  // OK → forward the upgrade to the DO, carrying the RE-TRUSTED identity in
  // headers (the DO does NOT re-verify JWKS in its hot path, plan §4).
  const fwd = new Request(request);
  fwd.headers.set("x-mcm-sub", identity.sub);
  fwd.headers.set("x-mcm-email", identity.email);
  fwd.headers.set("x-mcm-role", identity.role);
  const res = await stub.fetch(fwd);

  // Echo the accepted subprotocol so the browser handshake succeeds (the token
  // rode as the subprotocol; without echoing it back the WS open() rejects).
  if (res.status === 101 && subprotocol) {
    const headers = new Headers(res.headers);
    headers.set("Sec-WebSocket-Protocol", subprotocol);
    return new Response(res.body, {
      status: 101,
      statusText: res.statusText,
      headers,
      webSocket: (res as unknown as { webSocket?: WebSocket }).webSocket,
    });
  }
  return res;
};

// Default Worker entrypoint. Route-split by pathname BEFORE Hono so the WS
// upgrades never enter the Hono /v1 pipeline (plan §2/§6):
//   /rooms/:roomId/ws → [AUTH GATE] → RoomDO
//   /stt              → STT WS proxy (PCM↔Deepgram; split here so it can NEVER
//                        hit RoomDO)
//   everything else   → Hono app (REST /v1 + AI routes /translate|/chatbot|...)
export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Liveness probe (D2). The Fly room server exposed a bare GET /health;
    // uptime monitors point at it. Answer the SAME path here in the route-split
    // (before Hono, which only serves /v1/health) so the cutover off Fly
    // doesn't trip the monitors. Cheap, unauthenticated, no DB touch.
    if (path === "/health" && request.method === "GET") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    // Realtime: /rooms/:roomId/ws
    const roomMatch = /^\/rooms\/([^/]+)\/ws\/?$/.exec(path);
    if (roomMatch) {
      return handleRealtimeUpgrade(
        request,
        env,
        decodeURIComponent(roomMatch[1]),
      );
    }

    // STT WS proxy (I-1, plan §2/§6). Split BEFORE the RoomDO route so a /stt
    // upgrade NEVER reaches RoomDO — it's a standalone PCM↔Deepgram pipe, not a
    // collab relay. Accepts the client socket, opens an outbound WS to Deepgram
    // with the server-side key, pipes both ways. Default-OFF when DEEPGRAM_API_KEY
    // is unset (reports "not configured" on the socket, then closes).
    if (path === "/stt" || path.startsWith("/stt/")) {
      return handleSttUpgrade(request, env);
    }

    return app.fetch(request, env, ctx);
  },

  // Cloudflare Cron Trigger (B9 automated backup) — runs on the schedule in
  // wrangler.jsonc ("0 3 * * SUN" = Sunday 03:00 UTC). Dumps every D1 data table
  // to R2 backups/db-<date>.json. All-Cloudflare, no GitHub Action / external
  // runner. Restore = read the object + re-insert (see docs/runbooks/backup.md).
  // Metadata only (small); R2 blob bytes stay in the bucket (durable) — see the
  // archive route for per-project blob export.
  async scheduled(
    _event: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const { results: tableRows } = await env.DB.prepare(
            `SELECT name FROM sqlite_master
               WHERE type = 'table'
                 AND name NOT LIKE 'sqlite_%'
                 AND name NOT LIKE '_cf_%'
                 AND name <> 'schema_version'
               ORDER BY name`,
          ).all<{ name: string }>();

          const tables: Record<string, unknown[]> = {};
          for (const { name } of tableRows ?? []) {
            // Names come from sqlite_master, not user input — safe to interpolate.
            const { results } = await env.DB.prepare(
              `SELECT * FROM "${name}"`,
            ).all();
            tables[name] = results ?? [];
          }

          const date = new Date().toISOString().slice(0, 10);
          const key = `backups/db-${date}.json`;
          await env.BUCKET.put(
            key,
            JSON.stringify({ generated_at: now(), tables }),
            { httpMetadata: { contentType: "application/json" } },
          );
          console.log(
            `[cron backup] wrote ${key} (${Object.keys(tables).length} tables)`,
          );
        } catch (err) {
          console.error("[cron backup] failed:", err);
        }
      })(),
    );
  },
};
