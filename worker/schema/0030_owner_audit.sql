-- Owner audit trail (spec docs/specs/chairman-account.md §1.4).
--
-- The `owner` role (developer super-admin, ABOVE chairman/admin) has
-- operational supremacy, INCLUDING the ability to read meeting CONTENT when
-- operating/debugging. The spec's core principle — "quyền giám sát phải tự bị
-- giám sát", applied to the Owner too — requires that even the Owner leaves a
-- trace when accessing content. This is NOT to constrain the Owner but to
-- PROTECT them (a clean-hands evidence trail for disputes, and a hard
-- requirement once Canvas M goes to external/multi-national customers).
--
-- Kept in a SEPARATE table from `audit_log` (admin actions) and the
-- forward-looking `chairman_audit` (not built yet) so the three accountability
-- trails stay distinct and independently queryable. Mirrors the `audit_log`
-- shape (0005_audit_log.sql) plus explicit ts/created_at columns like
-- usage_events (0028).
CREATE TABLE IF NOT EXISTS owner_audit (
  id           TEXT PRIMARY KEY,
  owner_email  TEXT,           -- the owner who performed the access
  action       TEXT NOT NULL,  -- e.g. "owner.open_content"
  target       TEXT,           -- the affected entity (roomId / project id / ...)
  meta         TEXT,           -- optional JSON detail
  ts           INTEGER NOT NULL,  -- event time (ms epoch)
  created_at   INTEGER NOT NULL   -- row insert time (ms epoch)
);
CREATE INDEX IF NOT EXISTS ix_owner_audit_ts    ON owner_audit(ts DESC);
CREATE INDEX IF NOT EXISTS ix_owner_audit_owner ON owner_audit(owner_email, ts DESC);
