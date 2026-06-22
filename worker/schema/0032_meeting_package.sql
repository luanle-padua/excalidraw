-- Meeting Package — curated, server-readable post-meeting deliverable.
--
-- After a meeting is FINISHED, the host / a project authority sits down and
-- curates what to share: an (editable) summary + a hand-picked subset of the
-- meeting's files, scoped to an audience (the meeting's people, the whole
-- project, or a named email list). The raw meeting (E2E, room-key) is left
-- untouched — a Package is a SEPARATE, server-readable copy: the chosen files
-- are decrypted client-side and re-uploaded as plaintext under packages/<id>/…
--
-- See docs/plans/meeting-package.md. R2 layout (NOT room-key encrypted):
--   packages/<pkgId>/files/<fileId>   — the decrypted, chosen file bytes
--   packages/<pkgId>/recap.html       — rendered recap (summary + file list)
--   packages/<pkgId>/bundle.zip       — offline export (P2)

-- One package = one curate pass of one (finished) meeting.
CREATE TABLE IF NOT EXISTS meeting_package (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meeting(id),
  project_id    TEXT,                       -- denormalised from the meeting at create
  title         TEXT,
  summary_text  TEXT,                       -- hand-edited recap (seeded from meeting.ai_summary)
  audience_kind TEXT,                       -- 'meeting' | 'project' | 'list'
  status        TEXT,                       -- 'draft' | 'published'
  bundle_r2_key TEXT,                       -- packages/<id>/bundle.zip (NULL until first export)
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  published_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_pkg_meeting ON meeting_package(meeting_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_pkg_project ON meeting_package(project_id);

-- Which meeting files were chosen into the package (the curated subset).
CREATE TABLE IF NOT EXISTS meeting_package_file (
  package_id  TEXT NOT NULL REFERENCES meeting_package(id),
  file_id     TEXT NOT NULL,
  PRIMARY KEY (package_id, file_id)
);

-- Named recipients (only when audience_kind = 'list'). revoke != delete: a
-- recipient is REVOKED by flipping status, never hard-deleted, so the
-- provenance survives for the AI knowledge graph (anh Luân: keep full history).
CREATE TABLE IF NOT EXISTS meeting_package_recipient (
  package_id  TEXT NOT NULL REFERENCES meeting_package(id),
  email       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (package_id, email)
);
CREATE INDEX IF NOT EXISTS ix_pkg_recipient_email ON meeting_package_recipient(email);
