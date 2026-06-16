-- Fresh-test wipe (anh Luân 06-16): delete ONLY project + meeting data so the
-- dashboard starts empty, while keeping users + the org seed as source of truth.
--
-- KEEPS: division, user_division (org seed) · user_file (personal library) ·
--        client (CRM contacts) · audit_log · system_settings · day-scoped notes.
-- Children deleted before parents so it holds even with FK enforcement ON.

DELETE FROM file;                         -- per-meeting canvas files (R2 refs)
DELETE FROM meeting_participant;          -- who attended
DELETE FROM meeting_invitee;              -- invite list
DELETE FROM meeting;                      -- the meetings
DELETE FROM deleted_meeting;              -- tombstones (fresh slate)
DELETE FROM project_guest;                -- project-scoped guests
DELETE FROM project_member;               -- memberships
DELETE FROM project;                      -- the projects
DELETE FROM note WHERE scope = 'meeting'; -- meeting notes (keep day/calendar notes)
