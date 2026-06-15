-- Project-scoped GUEST identities (new guest-access model, 06-15). A guest is
-- NOT a global shared client identity: confidentiality BETWEEN departments means
-- each project issues its OWN guest IDs, independent of every other project.
--
-- A host (a member/owner of the project) — or an admin — issues a SYNTHETIC
-- Supabase login (`pg-<hex>@guest.canvasm.app`, NEVER the guest's real email)
-- scoped to ONE project. The guest signs in with that login and follows the
-- project across ALL its meetings (canSeeMeeting + /v1/me/meetings honour the
-- active row). The same real person invited by two departments gets two
-- independent rows in two projects; neither department sees the other's.
--
-- When the project finishes, "clean" deletes the Supabase users + these rows.
-- `supa_id` caches the Supabase user id stamped at creation so reset/revoke
-- never has to look the user up by email. Logins are lower-cased + unique.

CREATE TABLE IF NOT EXISTS project_guest (
  id         TEXT PRIMARY KEY,            -- crypto.randomUUID()
  project_id TEXT NOT NULL,               -- the one project this guest is scoped to
  login      TEXT NOT NULL UNIQUE,        -- synthetic Supabase login (lower-cased)
  label      TEXT,                        -- display name shown to the host
  real_email TEXT,                        -- the guest's real email (reference only)
  supa_id    TEXT,                        -- cached Supabase user id (for reset/delete)
  created_by TEXT,                        -- issuing staff email (from JWT)
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'revoked'
);
CREATE INDEX IF NOT EXISTS ix_project_guest_project ON project_guest(project_id);
CREATE INDEX IF NOT EXISTS ix_project_guest_login ON project_guest(login);
