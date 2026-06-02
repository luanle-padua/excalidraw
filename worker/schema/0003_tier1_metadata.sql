-- Tier-1 flat metadata for the project/meeting browser + canvas header.
-- SQLite ADD COLUMN is cheap (no rewrite). All TEXT; selects store the
-- option value verbatim; scheduled_at is an ISO date string (YYYY-MM-DD).
-- project.stage already exists (0002) and is reused as the "Phase" select.

ALTER TABLE meeting ADD COLUMN type            TEXT;
ALTER TABLE meeting ADD COLUMN status          TEXT;
ALTER TABLE meeting ADD COLUMN discipline      TEXT;
ALTER TABLE meeting ADD COLUMN priority        TEXT;
ALTER TABLE meeting ADD COLUMN confidentiality TEXT;
ALTER TABLE meeting ADD COLUMN scheduled_at    TEXT;

ALTER TABLE project ADD COLUMN code     TEXT;
ALTER TABLE project ADD COLUMN client   TEXT;
ALTER TABLE project ADD COLUMN location TEXT;
ALTER TABLE project ADD COLUMN type     TEXT;
ALTER TABLE project ADD COLUMN branch   TEXT;
