-- Phase 4.5 scheduling fields on meeting. organizer_email = who scheduled it
-- (defaults to created_by); host_email = current host (defaults to organizer);
-- duration_min = planned length for the Upcoming card; waiting_room /
-- recording_enabled = per-meeting policy (defaults seeded from system_settings
-- at create time).
ALTER TABLE meeting ADD COLUMN organizer_email   TEXT;
ALTER TABLE meeting ADD COLUMN host_email        TEXT;
ALTER TABLE meeting ADD COLUMN duration_min      INTEGER;
ALTER TABLE meeting ADD COLUMN waiting_room      INTEGER DEFAULT 1;
ALTER TABLE meeting ADD COLUMN recording_enabled INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_meeting_scheduled ON meeting(status, scheduled_at);
