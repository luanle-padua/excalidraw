-- Metadata for projects + meetings (rename is just updating name/title).
-- More fields will accrue over time (participants, durations, stage,
-- topic…); first-class columns for the ones we display/filter on now.
-- SQLite ALTER TABLE ADD COLUMN is cheap (no table rewrite).

ALTER TABLE project ADD COLUMN stage TEXT;
ALTER TABLE project ADD COLUMN description TEXT;

ALTER TABLE meeting ADD COLUMN topic TEXT;
ALTER TABLE meeting ADD COLUMN description TEXT;
ALTER TABLE meeting ADD COLUMN participant_count INTEGER;
ALTER TABLE meeting ADD COLUMN duration_s INTEGER;
