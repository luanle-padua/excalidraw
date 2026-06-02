-- MAP CanvasMeet — storage metadata (D1 / SQLite).
--
-- Minimal on purpose: just enough to power "save & reopen a meeting"
-- and the "project folder → meetings → pull content" UX. The richer
-- org / label model (departments, teams, AI-recall tags) is deferred
-- until the data-architecture decision is made — these tables grow,
-- they don't get thrown away.
--
-- R2 holds the actual bytes (encrypted-at-rest); D1 holds pointers +
-- the folder structure + (test phase) the managed room key so a host
-- can reopen any meeting in their project from any device.

-- A project = a folder of meetings, owned by a host.
CREATE TABLE IF NOT EXISTS project (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  host_email  TEXT,                 -- owner; nullable in link-only test phase, filled from Access later
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_project_host ON project(host_email, updated_at DESC);

-- A meeting = one Excalidraw room. Belongs to a project (nullable so a
-- quick ad-hoc room can exist before being filed into a folder).
CREATE TABLE IF NOT EXISTS meeting (
  id              TEXT PRIMARY KEY,     -- == roomId
  project_id      TEXT REFERENCES project(id),
  title           TEXT,
  created_by      TEXT,                 -- host name/email
  -- TEST PHASE: managed room key so the host can reopen any meeting in
  -- their folder cross-device. This is the SSE/managed-key trade-off
  -- (NOT strict E2E). To be wrapped under Access identity later.
  room_key        TEXT,
  scene_r2_key    TEXT,                 -- R2 key of the latest encrypted scene blob
  scene_updated_at INTEGER,
  thumbnail       TEXT,                 -- small data URL for the folder card (optional)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_meeting_project ON meeting(project_id, updated_at DESC);

-- Library files of a meeting (bytes in R2; row is the index).
CREATE TABLE IF NOT EXISTS file (
  id          TEXT PRIMARY KEY,     -- == fileId used on the canvas
  meeting_id  TEXT NOT NULL REFERENCES meeting(id),
  project_id  TEXT REFERENCES project(id),
  kind        TEXT,                 -- image|pdf|dxf|ifc|glb|thumb
  name        TEXT,
  size        INTEGER,
  r2_key      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_file_meeting ON file(meeting_id);
CREATE INDEX IF NOT EXISTS ix_file_project ON file(project_id, kind);
