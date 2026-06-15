-- Revoke ≠ delete (06-15 plan, docs/plans/guest-data-lifecycle.md): a guest is
-- ARCHIVED (status='revoked') + their Supabase login DISABLED, never hard-
-- deleted — project_guest is the ONLY synthetic-login→person map, so deleting
-- a row orphans every meeting_invitee / meeting_participant / authored-content
-- attribution and breaks the AI knowledge graph. revoked_at records when access
-- was retired. (status already exists from 0019: 'active' | 'revoked'.)
ALTER TABLE project_guest ADD COLUMN revoked_at INTEGER;
