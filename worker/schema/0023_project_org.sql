-- Project org columns (Phase 2). `lead_division_id` = which division leads the
-- project — its HEAD gets default manage power (see canManageProject).
-- `leader_email` = the designated project leader (the head/admin assigns; the
-- leader full-manages + delegates managers). Both nullable: a NULL
-- lead_division_id means NO division gating — only owner/leader/admin manage,
-- exactly the pre-Phase-2 behaviour, so nothing silently loses access.
ALTER TABLE project ADD COLUMN lead_division_id TEXT REFERENCES division(id);
ALTER TABLE project ADD COLUMN leader_email TEXT;

-- Backfill: the project leader defaults to its host (creator); the leading
-- division defaults to the host's home department (user_division). Existing
-- projects whose host has no mapped division stay NULL (leader/admin-managed).
UPDATE project SET leader_email = host_email
  WHERE leader_email IS NULL AND host_email IS NOT NULL;
UPDATE project SET lead_division_id = (
    SELECT ud.division_id FROM user_division ud
     WHERE ud.email = lower(project.host_email)
  )
  WHERE lead_division_id IS NULL AND host_email IS NOT NULL;
