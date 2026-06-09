-- Client list (CRM-lite). A shared, DB-synced address book of EXTERNAL
-- contacts (clients/consultants) that internal staff manage once and then
-- pull from when inviting — instead of retyping a raw email every time.
--
-- This is NOT a login/identity (that's Supabase Auth + meeting_invitee). A
-- `client` row is just a reusable contact card; inviting one still creates a
-- normal guest meeting_invitee keyed by the email. created_by = the verified
-- JWT email of the internal staff member who added it (audit / "who owns it").
-- Emails stored lower-cased to match the rest of the authz model.

CREATE TABLE IF NOT EXISTS client (
  id         TEXT PRIMARY KEY,            -- crypto.randomUUID()
  name       TEXT NOT NULL,               -- contact display name
  company    TEXT,                        -- their firm (optional)
  email      TEXT,                        -- contact email (lower-cased, optional)
  note       TEXT,                        -- free-form note (optional)
  created_by TEXT,                        -- internal staff email (from JWT)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_client_email ON client(email);
CREATE INDEX IF NOT EXISTS ix_client_created_at ON client(created_at);
