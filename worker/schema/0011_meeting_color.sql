-- Per-meeting colour — a user-assigned accent colour synced to the calendar.
-- Nullable hex string (e.g. "#6965db"); NULL means "no colour assigned" and the
-- client falls back to its default. Settable via PATCH /v1/meetings/:roomId and
-- read back by both the project meeting list and the calendar feed.
ALTER TABLE meeting ADD COLUMN color TEXT;
