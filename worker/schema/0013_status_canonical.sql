-- Phase 4.5: ONE canonical status vocabulary (docs/host-and-scheduling.md):
--   scheduled | live | finished | cancelled
-- The DB historically mixed capitalized variants from the metadata editor
-- ("Scheduled", "In progress", "Completed", "Cancelled"). Rewrite every row;
-- the client's normalizeMeetingStatus() stays tolerant on reads, but writes
-- are canonical from now on.
UPDATE meeting SET status = 'scheduled' WHERE lower(status) = 'scheduled';
UPDATE meeting SET status = 'live'      WHERE lower(status) IN ('in progress', 'in_progress', 'live');
UPDATE meeting SET status = 'finished'  WHERE lower(status) IN ('completed', 'done', 'finished');
UPDATE meeting SET status = 'cancelled' WHERE lower(status) IN ('cancelled', 'canceled');
