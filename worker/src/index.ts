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

type Bindings = {
  BUCKET: R2Bucket;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// TEST PHASE: allow any origin (pages.dev, localhost, tunnel). Lock this
// down to the app's real origin(s) before rollout.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "PUT", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-kind", "x-name"],
  }),
);

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
            m.updated_at, m.last_opened_at,
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

export default app;
