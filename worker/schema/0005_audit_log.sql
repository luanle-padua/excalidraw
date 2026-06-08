-- Admin audit log: every admin mutation (user create/role/disable/delete,
-- meeting delete) is recorded for security + compliance.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  actor_email  TEXT,           -- the admin who performed the action
  action       TEXT NOT NULL,  -- e.g. "user.create", "user.role", "meeting.delete"
  target       TEXT,           -- the affected entity (email / roomId / user id)
  meta         TEXT,           -- optional JSON detail
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts DESC);
