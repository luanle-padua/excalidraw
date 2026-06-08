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
    allowHeaders: ["Content-Type", "x-kind", "x-name", "Authorization"],
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
    c.set("email", typeof payload.email === "string" ? payload.email : undefined);
    const appMeta = payload.app_metadata as { role?: unknown } | undefined;
    c.set(
      "role",
      typeof appMeta?.role === "string" ? appMeta.role : undefined,
    );
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

app.get("/v1/health", (c) => c.json({ ok: true }));

// ---- Scene (canvas) blob -------------------------------------------------

app.put("/v1/scenes/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
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
    return c.json({ error: "not found" }, 404);
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
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) {
    return c.json({ error: "empty body" }, 400);
  }
  await c.env.BUCKET.put(chatKey(roomId), body);
  return c.json({ ok: true });
});

app.get("/v1/chats/:roomId", async (c) => {
  const obj = await c.env.BUCKET.get(chatKey(c.req.param("roomId")));
  if (!obj) {
    return c.json({ error: "not found" }, 404);
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
    return c.json({ error: "not found" }, 404);
  }
  return new Response(obj.body, {
    headers: { "content-type": "application/octet-stream", etag: obj.httpEtag },
  });
});

// ---- Library file bytes --------------------------------------------------

app.put("/v1/files/:roomId/:fileId", async (c) => {
  const roomId = c.req.param("roomId");
  const fileId = c.req.param("fileId");
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

app.post("/v1/projects", async (c) => {
  const { name, hostEmail } = await c.req.json<{
    name: string;
    hostEmail?: string;
  }>();
  if (!name?.trim()) {
    return c.json({ error: "name required" }, 400);
  }
  const id = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO project (id, name, host_email, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
  )
    .bind(id, name.trim(), hostEmail ?? null, ts)
    .run();
  return c.json({ id, name: name.trim(), hostEmail: hostEmail ?? null });
});

app.get("/v1/projects", async (c) => {
  const host = c.req.query("host");
  const cols = `id, name, host_email, code, client, location, stage, type, branch, cover, description, created_at, updated_at`;
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
});

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
  }>();
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
    )
    .run();
  return c.json({ ok: true });
});

app.get("/v1/projects/:projectId/meetings", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, topic, type, status, created_by, thumbnail,
            participant_count, duration_s, scene_updated_at, updated_at,
            last_opened_at
     FROM meeting WHERE project_id = ?1 ORDER BY updated_at DESC`,
  )
    .bind(c.req.param("projectId"))
    .all();
  return c.json({ meetings: results });
});

// ---- Meetings (registry) -------------------------------------------------

app.post("/v1/meetings", async (c) => {
  const b = await c.req.json<{
    roomId: string;
    roomKey?: string;
    projectId?: string;
    title?: string;
    createdBy?: string;
    thumbnail?: string;
  }>();
  if (!b.roomId) {
    return c.json({ error: "roomId required" }, 400);
  }
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO meeting (id, project_id, title, created_by, room_key, thumbnail, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(id) DO UPDATE SET
       project_id = COALESCE(excluded.project_id, meeting.project_id),
       title      = COALESCE(excluded.title, meeting.title),
       room_key   = COALESCE(excluded.room_key, meeting.room_key),
       thumbnail  = COALESCE(excluded.thumbnail, meeting.thumbnail),
       updated_at = excluded.updated_at`,
  )
    .bind(
      b.roomId,
      b.projectId ?? null,
      b.title ?? null,
      b.createdBy ?? null,
      b.roomKey ?? null,
      b.thumbnail ?? null,
      ts,
    )
    .run();
  return c.json({ ok: true, roomId: b.roomId });
});

app.get("/v1/meetings/:roomId", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.project_id, m.title, m.topic, m.description, m.type,
            m.status, m.discipline, m.priority, m.confidentiality,
            m.scheduled_at, m.created_by, m.room_key, m.scene_r2_key,
            m.scene_updated_at, m.thumbnail, m.participant_count, m.duration_s,
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
  }>();
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
    )
    .run();
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
    return c.json({ error: "list users failed", detail: await res.text() }, 502);
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
    return c.json({ error: "create user failed", detail: await res.text() }, 502);
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
  const res = await supaAdmin(cr.url, cr.key, "PUT", `/admin/users/${id}`, patch);
  if (!res.ok) {
    return c.json({ error: "update user failed", detail: await res.text() }, 502);
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
    return c.json({ error: "delete user failed", detail: await res.text() }, 502);
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
            m.scheduled_at, m.created_by, m.participant_count, m.duration_s,
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
  return c.json({ meeting, files, participants });
});

// Delete a meeting + cascade: its R2 blobs (scene/files/chats/library) + file rows.
app.delete("/v1/admin/meetings/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const meeting = await c.env.DB.prepare(
    `SELECT id FROM meeting WHERE id = ?1`,
  )
    .bind(roomId)
    .first();
  if (!meeting) {
    return c.json({ error: "not found" }, 404);
  }
  // R2: delete everything under each per-room prefix.
  for (const prefix of [
    `scenes/${roomId}`,
    `files/${roomId}`,
    `chats/${roomId}`,
    `library/${roomId}`,
  ]) {
    let cursor: string | undefined;
    do {
      const listed = await c.env.BUCKET.list({ prefix, cursor });
      for (const obj of listed.objects) {
        await c.env.BUCKET.delete(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  await c.env.DB.prepare(`DELETE FROM file WHERE meeting_id = ?1`)
    .bind(roomId)
    .run();
  await c.env.DB.prepare(`DELETE FROM meeting WHERE id = ?1`)
    .bind(roomId)
    .run();
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
      { name: "R2 storage", configured: !!c.env.BUCKET, note: "scenes/files/chats/library" },
      { name: "D1 database", configured: !!c.env.DB, note: "registry + audit log" },
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

export default app;
