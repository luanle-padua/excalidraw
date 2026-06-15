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

import { guestInviteEmail, sendEmail } from "./email";

import type { MiddlewareHandler } from "hono";

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
};

// Auth context attached by the JWT middleware for downstream handlers.
type Variables = {
  userId: string;
  email?: string;
  /** app_metadata.role from the verified JWT ("admin" gates /v1/admin/*). */
  role?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// TEST PHASE: allow any origin (pages.dev, localhost, tunnel). Lock this
// down to the app's real origin(s) before rollout.
app.use(
  "*",
  cors({
    origin: "*",
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

// ---- Supabase JWT auth gate ----------------------------------------------
// Every /v1 route (except /v1/health) now requires a valid Supabase user
// access token: `Authorization: Bearer <jwt>`. We verify OFFLINE against the
// project's public JWKS (ES256) — no per-request call to Supabase. The JWKS is
// fetched once per worker isolate and cached by jose. On success the user id
// (sub) + email are attached for handlers/authz. This closes the previously
// wide-open API; per-meeting membership authz layers on later.
//
// CORS preflight (OPTIONS) is answered by the cors() middleware above before
// this runs, so browsers can still negotiate without a token.

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") {
    return next();
  }
  const supabaseUrl = c.env.SUPABASE_URL;
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
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
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
});

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
            WHERE m.id = ?1 AND pm.email = ?2) AS member,
         (SELECT 1 FROM project_guest pg
            JOIN meeting m ON m.project_id = pg.project_id
            WHERE m.id = ?1 AND pg.login = ?2 AND pg.status = 'active')
           AS proj_guest`,
    )
    .bind(roomId, e)
    .first<{
      registered: number | null;
      conf: string | null;
      owner: number | null;
      invited: number | null;
      member: number | null;
      proj_guest: number | null;
    }>();
  if (!row?.registered) {
    // Ad-hoc room without a registry row — nothing to gate against.
    return true;
  }
  // Confidential meetings are INVITEE-ONLY (quyết định 06-10 #3): project
  // membership alone is not enough — the field is enforced, not decorative.
  // A PROJECT GUEST (new model, 06-15) is treated EXACTLY like a project member
  // for visibility: they follow the project into its normal meetings, but a
  // confidential meeting stays invitee-only — a guest must never see more than
  // an internal member would (to be in a confidential meeting, invite them).
  if ((row.conf ?? "").toLowerCase() === "confidential") {
    return !!(row.owner || row.invited);
  }
  return !!(row.owner || row.invited || row.member || row.proj_guest);
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
  const projectId = c.req.query("projectId") ?? null;
  await c.env.DB.prepare(
    `INSERT INTO meeting (id, project_id, title, scene_r2_key, scene_updated_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
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
  const projectId = c.req.query("projectId") ?? null;
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
    return c.json({ error: "not found" }, 404);
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
  if (!(role === "admin" || isInternalEmail(email))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) {
    return c.json({ error: "name required" }, 400);
  }
  const owner = email?.toLowerCase() ?? null;
  const id = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO project (id, name, host_email, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
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
  const cols = `id, name, host_email, code, client, location, stage, type, branch, cover, description, color, icon, created_at, updated_at`;
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
    return c.json({ projects: results });
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
  const memberStmt = host
    ? c.env.DB.prepare(
        `SELECT ${mcols} FROM project p
         JOIN project_member pm ON pm.project_id = p.id AND pm.email = ?1
         WHERE p.host_email = ?2 ORDER BY p.updated_at DESC`,
      ).bind(e, host)
    : c.env.DB.prepare(
        `SELECT ${mcols} FROM project p
         JOIN project_member pm ON pm.project_id = p.id AND pm.email = ?1
         ORDER BY p.updated_at DESC LIMIT 200`,
      ).bind(e);
  const { results: memberRows } = await memberStmt.all<
    Record<string, unknown>
  >();
  const projects: Record<string, unknown>[] = memberRows.map((p) => ({
    ...p,
    access: "member",
  }));
  if (isInternalEmail(e) && !host) {
    const memberIds = new Set(projects.map((p) => p.id as string));
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
        projects.push({ ...p, access: "invitee" });
      }
    }
  }
  return c.json({ projects });
});

// Editing a project's metadata is an OWNER privilege (admin bypasses).
// Members browse + create meetings; only the owner reshapes the folder.
// Closes audit finding #4 (any valid JWT could PATCH any project).
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
  if (touchesContent && c.get("role") !== "admin") {
    const me = c.get("email")?.toLowerCase();
    const owner =
      me &&
      (await c.env.DB.prepare(
        `SELECT 1 FROM project_member
         WHERE project_id = ?1 AND email = ?2 AND role = 'owner' LIMIT 1`,
      )
        .bind(id, me)
        .first());
    if (!owner) {
      return c.json({ error: "owner only" }, 403);
    }
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

// Shared owner check for the project-mutation routes below (admin bypasses).
const isProjectOwner = async (
  db: D1Database,
  projectId: string,
  email: string | undefined,
): Promise<boolean> => {
  const me = email?.toLowerCase();
  if (!me) {
    return false;
  }
  return !!(await db
    .prepare(
      `SELECT 1 FROM project_member
       WHERE project_id = ?1 AND email = ?2 AND role = 'owner' LIMIT 1`,
    )
    .bind(projectId, me)
    .first());
};

// Delete a project (owner or admin). An owner can only delete an EMPTY
// project — its meetings must be disposed of first through the meeting
// lifecycle (cancel → delete), so a folder delete can never silently take
// finished meetings with it. Admins may force-cascade (ops/repair).
app.delete("/v1/projects/:id", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email");
  const isAdmin = c.get("role") === "admin";
  if (!isAdmin && !(await isProjectOwner(c.env.DB, id, email))) {
    return c.json({ error: "owner only" }, 403);
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

// Add members (owner/admin; INTERNAL emails only — a client is never a
// project member, confidentiality by construction).
app.post("/v1/projects/:id/members", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email");
  if (
    c.get("role") !== "admin" &&
    !(await isProjectOwner(c.env.DB, id, email))
  ) {
    return c.json({ error: "owner only" }, 403);
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

// Remove a member (owner/admin). The LAST owner is unremovable — a project
// must never become ownerless.
app.delete("/v1/projects/:id/members/:email", async (c) => {
  const id = c.req.param("id");
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const email = c.get("email");
  if (
    c.get("role") !== "admin" &&
    !(await isProjectOwner(c.env.DB, id, email))
  ) {
    return c.json({ error: "owner only" }, 403);
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
                          recording_enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18, ?19, ?20, ?20)
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
            m.created_at, m.updated_at, m.last_opened_at,
            p.name AS project_name, p.stage AS project_stage
     FROM meeting m LEFT JOIN project p ON p.id = m.project_id
     WHERE m.id = ?1`,
  )
    .bind(c.req.param("roomId"))
    .first();
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ meeting: row });
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
      if (cur === "finished") {
        return c.json({ error: "meeting is finished (immutable)" }, 409);
      }
      if (touchesContent) {
        if (cur === "cancelled") {
          return c.json({ error: "cancelled — restore it first" }, 409);
        }
        if (!isOrganizer) {
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
          if (!isHost && !isCohost && !isOrganizer) {
            return c.json({ error: "host, co-host or organizer only" }, 403);
          }
        }
        if (next === "cancelled" || cur === "cancelled") {
          if (!isOrganizer) {
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
  if (!(role === "admin" || isInternalEmail(email))) {
    return c.json({ error: "forbidden" }, 403);
  }
  // The inviter must be able to SEE the meeting themselves — without this,
  // any internal user could invite themselves into any meeting and the
  // invited-only rule above would be decorative.
  if (!(await canSeeMeeting(c.env.DB, email, role, roomId))) {
    return c.json({ error: "forbidden" }, 403);
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
    // Keep the shared client list DB-synced: a GUEST email typed by hand in
    // an invite becomes a contact card automatically (name = email local
    // part until someone edits it), so every internal user + the admin see
    // the same available clients instead of each person retyping addresses.
    if (kind === "guest") {
      const existing = await c.env.DB.prepare(
        `SELECT 1 FROM client WHERE email = ?1 LIMIT 1`,
      )
        .bind(ie)
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
// ORGANIZER-only (taking someone's access away is an edit of the meeting,
// same rule as content edits); legacy rows without an organizer fall back to
// internal-allow. Finished meetings are immutable.
app.delete("/v1/meetings/:roomId/invitees/:email", async (c) => {
  const roomId = c.req.param("roomId");
  const target = decodeURIComponent(c.req.param("email")).toLowerCase();
  const email = c.get("email");
  const role = c.get("role");
  if (!(role === "admin" || isInternalEmail(email))) {
    return c.json({ error: "forbidden" }, 403);
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
    const isOrganizer = meeting.organizer_email
      ? meeting.organizer_email.toLowerCase() === email?.toLowerCase()
      : isInternalEmail(email);
    if (!isOrganizer) {
      return c.json({ error: "organizer only" }, 403);
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
      password?: string;
    }>()
    .catch(() => ({} as Record<string, never>));
  const to = (b.to || "").trim();
  const link = (b.link || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !link) {
    return c.json({ ok: false, error: "invalid" }, 400);
  }
  const { subject, html, text } = guestInviteEmail({
    meetingTitle: b.meetingTitle,
    link,
    email: to,
    password: b.password,
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

// Gate for every project-guest route: ADMIN, or a member/owner of the project.
// Admin always passes regardless of membership (full power).
const canManageProjectGuests = async (
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
      `SELECT 1 FROM project_member
       WHERE project_id = ?1 AND email = ?2 LIMIT 1`,
    )
    .bind(projectId, me)
    .first());
};

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
            created_by, created_at, status
       FROM project_guest
      WHERE project_id = ?1 AND status = 'active'
      ORDER BY created_at DESC`,
  )
    .bind(projectId)
    .all();
  return c.json({ guests: results });
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
        supa_id, created_by, created_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active')`,
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
        SET label = ?1, real_email = ?2, company = ?3, phone = ?4, address = ?5
      WHERE id = ?6 AND project_id = ?7 AND status = 'active'`,
  )
    .bind(
      cap(b.label, 200),
      realEmail || null,
      cap(b.company, 200),
      cap(b.phone, 64),
      cap(b.address, 400),
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

// Revoke ONE guest — delete the Supabase user + the row.
// (admin or a member/owner of the project)
app.delete("/v1/projects/:projectId/guests/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  const guest = await c.env.DB.prepare(
    `SELECT supa_id, login FROM project_guest
      WHERE id = ?1 AND project_id = ?2`,
  )
    .bind(id, projectId)
    .first<{ supa_id: string | null; login: string }>();
  if (!guest) {
    return c.json({ error: "not found" }, 404);
  }
  if (cr) {
    const supaId = await resolveSupaId(cr, guest.supa_id, guest.login);
    if (supaId) {
      await supaAdmin(cr.url, cr.key, "DELETE", `/admin/users/${supaId}`);
    }
  }
  await c.env.DB.prepare(`DELETE FROM project_guest WHERE id = ?1`)
    .bind(id)
    .run();
  await logAudit(c.env.DB, email, "project_guest.revoke", projectId, {
    login: guest.login,
  });
  return c.json({ ok: true, deleted: id });
});

// Clean ALL guests of the project — the "done with the project" action.
// Deletes every Supabase user + every row. (admin or a member/owner.)
app.post("/v1/projects/:projectId/guests/clean", async (c) => {
  const projectId = c.req.param("projectId");
  const email = c.get("email");
  const role = c.get("role");
  if (!(await canManageProjectGuests(c.env.DB, projectId, email, role))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cr = adminCreds(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, supa_id, login FROM project_guest WHERE project_id = ?1`,
  )
    .bind(projectId)
    .all<{ id: string; supa_id: string | null; login: string }>();
  if (cr) {
    for (const g of results) {
      const supaId = await resolveSupaId(cr, g.supa_id, g.login);
      if (supaId) {
        await supaAdmin(cr.url, cr.key, "DELETE", `/admin/users/${supaId}`);
      }
    }
  }
  await c.env.DB.prepare(`DELETE FROM project_guest WHERE project_id = ?1`)
    .bind(projectId)
    .run();
  await logAudit(c.env.DB, email, "project_guest.clean", projectId, {
    count: results.length,
  });
  return c.json({ ok: true, removed: results.length });
});

// CENTRALIZED guest manager — every active guest the caller MAY MANAGE, in one
// place (across all their projects). SCOPED SERVER-SIDE to project membership,
// mirroring canManageProjectGuests exactly: admin sees ALL project guests (full
// power); a regular user sees ONLY guests of projects they are a project_member
// of (owner/member). The caller's project list is derived server-side from
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
  // project_id is one the caller is a project_member of (the EXISTS subquery is
  // the exact membership check from canManageProjectGuests, applied per row).
  const { results } =
    role === "admin"
      ? await c.env.DB.prepare(
          `SELECT pg.id, pg.project_id, p.name AS project_name, pg.login,
                  pg.label, pg.real_email, pg.company, pg.phone, pg.address,
                  pg.status, pg.created_at
             FROM project_guest pg
             JOIN project p ON p.id = pg.project_id
            WHERE pg.status = 'active'
            ORDER BY p.name COLLATE NOCASE, pg.created_at DESC`,
        ).all()
      : await c.env.DB.prepare(
          `SELECT pg.id, pg.project_id, p.name AS project_name, pg.login,
                  pg.label, pg.real_email, pg.company, pg.phone, pg.address,
                  pg.status, pg.created_at
             FROM project_guest pg
             JOIN project p ON p.id = pg.project_id
            WHERE pg.status = 'active'
              AND EXISTS (
                SELECT 1 FROM project_member pm
                 WHERE pm.project_id = pg.project_id AND pm.email = ?1
              )
            ORDER BY p.name COLLATE NOCASE, pg.created_at DESC`,
        )
          .bind(me)
          .all();
  return c.json({ guests: results });
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

// List all clients (newest first). Internal staff + admins only.
app.get("/v1/clients", async (c) => {
  if (!canManageClients(c.get("email"), c.get("role"))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, company, email, note, created_by, created_at
     FROM client ORDER BY created_at DESC LIMIT 500`,
  ).all();
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
app.delete("/v1/clients/:id", async (c) => {
  const me = c.get("email");
  if (!canManageClients(me, c.get("role"))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const id = c.req.param("id");
  await c.env.DB.prepare(`DELETE FROM client WHERE id = ?1`).bind(id).run();
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
       UNION
       -- A PROJECT GUEST (new model, 06-15) follows their project's meetings
       -- in their lobby — treated EXACTLY like a project member: confidential
       -- meetings stay invitee-only (the invitee arm above surfaces one if the
       -- guest was explicitly invited). A guest never sees more than a member.
       SELECT mg.id FROM meeting mg
         JOIN project_guest pg ON pg.project_id = mg.project_id
         WHERE pg.login = ?1 AND pg.status = 'active'
           AND lower(COALESCE(mg.confidentiality, '')) <> 'confidential'
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
  const apiKey = c.env.DAILY_API_KEY;
  if (!apiKey) {
    return c.json({ error: "daily not configured" }, 503);
  }
  const roomId = c.req.query("roomId");
  if (!roomId) {
    return c.json({ error: "roomId required" }, 400);
  }
  // Per-meeting gate: a guest can only get a Daily token for a meeting they
  // were invited to (internal staff + admins pass). Closes the "any JWT mints
  // any room's token" hole noted in roadmap/dev-phase-notes.
  if (!(await canSeeMeeting(c.env.DB, c.get("email"), c.get("role"), roomId))) {
    return c.json({ error: "not invited to this meeting" }, 403);
  }
  // No media in a finished meeting — review is look-only, so there is no
  // legitimate audio/screen-share session to token. (UI hides the buttons;
  // this is the server backstop.)
  if (await isFinishedLocked(c.env.DB, roomId)) {
    return c.json({ error: "meeting finished (review only)" }, 409);
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
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_SERVICE_API_KEY;
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

// Full cascade delete of one meeting: every R2 blob under its per-room
// prefixes + every D1 row that references it (file index, invitees,
// participants, per-meeting notes), then the meeting row itself. Shared by
// the admin route and the organizer's delete-cancelled route so neither
// leaves orphans behind.
const deleteMeetingCascade = async (
  env: Bindings,
  roomId: string,
  actor?: string,
): Promise<void> => {
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
  await env.DB.prepare(`DELETE FROM note WHERE scope = 'meeting' AND ref = ?1`)
    .bind(roomId)
    .run();
  await env.DB.prepare(`DELETE FROM meeting WHERE id = ?1`).bind(roomId).run();
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
  return c.json({
    usage: {
      meetings: row?.meetings ?? 0,
      projects: row?.projects ?? 0,
      storage_bytes: row?.storage_bytes ?? 0,
      meeting_minutes: Math.round((row?.total_seconds ?? 0) / 60),
      recording_minutes: 0, // tracked once Phase 5 recording lands
      ai_calls: 0, // tracked once AI usage metering lands
    },
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

export default app;
