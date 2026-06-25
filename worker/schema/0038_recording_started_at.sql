-- 0038_recording_started_at.sql
-- Absolute capture-start instant per recording track (unified replay P0, #28).
--
-- For the unified meeting replay we place every audio/screen track on the SAME
-- absolute timeline as the canvas + transcript (all already epoch ms). A track
-- only knows when ITS bytes actually began — the moment the participant's
-- MediaRecorder.start() truly fired (a late unmute starts a later track). We
-- stamp that wall-clock instant (Date.now(), epoch ms) client-side and thread it
-- through the upload route into this column.
--
-- ADDITIVE + nullable + legacy-safe: existing rows stay NULL; the replay falls
-- back to the session start for them. Nothing about live capture / lock / upload
-- behaviour changes — this is purely a timing anchor for read-side sync.

ALTER TABLE recording ADD COLUMN started_at_ms INTEGER; -- epoch ms capture began (NULL for legacy rows)
