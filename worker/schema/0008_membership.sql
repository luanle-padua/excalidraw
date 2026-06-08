-- Phase 4.5 membership. TWO separate grants (see docs/host-and-scheduling.md):
--   project_member  = browse the WHOLE project folder (all meetings + files)
--   meeting_invitee = see/join exactly ONE meeting (the only thing a client gets)
-- A meeting_invitee row grants NOTHING at project level — that's what keeps a
-- client scoped to one meeting. Emails are stored lower-cased to match the
-- verified-JWT email used by the authz checks.

CREATE TABLE IF NOT EXISTS project_member (
  project_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  added_by    TEXT,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX IF NOT EXISTS ix_member_email ON project_member(email);

CREATE TABLE IF NOT EXISTS meeting_invitee (
  meeting_id  TEXT NOT NULL,
  email       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'guest',    -- 'internal' | 'guest'
  role        TEXT NOT NULL DEFAULT 'attendee', -- 'cohost' | 'attendee'
  status      TEXT NOT NULL DEFAULT 'invited',  -- 'invited'|'accepted'|'declined'|'revoked'
  invited_by  TEXT,
  invited_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  PRIMARY KEY (meeting_id, email)
);
CREATE INDEX IF NOT EXISTS ix_invitee_email ON meeting_invitee(email, status);
CREATE INDEX IF NOT EXISTS ix_invitee_meeting ON meeting_invitee(meeting_id);

-- Backfill: every existing project's host becomes its owner-member, so the
-- membership-scoped project list doesn't suddenly hide everyone's folders.
INSERT OR IGNORE INTO project_member (project_id, email, role, added_by, added_at)
SELECT id, lower(host_email), 'owner', lower(host_email), created_at
FROM project WHERE host_email IS NOT NULL AND host_email <> '';
