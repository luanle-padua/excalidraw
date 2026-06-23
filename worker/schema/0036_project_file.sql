-- 0036 — "Project Files" (Tài liệu dự án): a PER-PROJECT SHARED document shelf.
-- Mirrors user_file (My Files) but keyed by project_id + uploaded_by instead of
-- a single owner: ANY member of the project may upload a file here, and EVERY
-- member of the project sees it (distinct from the private per-user My Files).
-- Bytes live SERVER-READABLE at R2 `project-files/<projectId>/<fileId>` (no room
-- key exists outside a meeting — same model as user_file); the small downscaled
-- WebP thumb sits at `project-files/<projectId>/<fileId>/thumb`. The index row is
-- this table (rule: every new R2 prefix gets a D1 index).
--
-- Access is gated to project members (projectAccess "full") in the Worker:
--   - list / view / upload — any member (projectAccess === "full")
--   - delete               — the uploader, OR a project manager (canManageProject)
-- thumb_r2_key NULL = no thumb yet (non-image kinds, or not yet backfilled); the
-- GET …/thumb route 404s and the client falls back to backfill/icon.

CREATE TABLE IF NOT EXISTS project_file (
  id           TEXT PRIMARY KEY,        -- uuid
  project_id   TEXT NOT NULL,           -- owning project
  name         TEXT,
  kind         TEXT,                    -- pdf | dxf | ifc | image | other
  size         INTEGER,
  r2_key       TEXT NOT NULL,
  thumb_r2_key TEXT,                    -- downscaled WebP thumb; NULL = none yet
  uploaded_by  TEXT NOT NULL,           -- JWT email (lower-case) of the uploader
  created_at   INTEGER NOT NULL
);

-- List a project's shelf newest-first (the only list query shape).
CREATE INDEX IF NOT EXISTS idx_project_file_project
  ON project_file (project_id, created_at DESC);

-- "My uploads in this project" / uploader-scoped delete checks.
CREATE INDEX IF NOT EXISTS idx_project_file_uploader
  ON project_file (uploaded_by);
