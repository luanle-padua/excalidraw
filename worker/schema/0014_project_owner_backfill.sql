-- Re-run the 0008 owner backfill. POST /v1/projects didn't insert the
-- creator's project_member row until 2026-06-10, so every project created
-- between migration 0008 (06-09) and the fix is an "orphan": its owner can't
-- see it in the membership-scoped GET /v1/projects ("tạo project xong biến
-- mất"). Idempotent — INSERT OR IGNORE keyed on (project_id, email).
INSERT OR IGNORE INTO project_member (project_id, email, role, added_by, added_at)
SELECT id, lower(host_email), 'owner', lower(host_email), created_at
FROM project WHERE host_email IS NOT NULL AND host_email <> '';
