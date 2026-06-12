-- Glass Desk dashboard (06-12): light personalisation accents.
-- project.color / project.icon — folder accent colour (hex) + emoji/icon id;
-- meeting.icon — emoji/icon id next to the existing meeting.color (0011).
-- All nullable; NULL = no accent assigned, client falls back to defaults.
-- Like meeting.color, these are COSMETIC (not content) — the worker exempts
-- them from the organizer-only / finished-immutable guards.
ALTER TABLE project ADD COLUMN color TEXT;
ALTER TABLE project ADD COLUMN icon TEXT;
ALTER TABLE meeting ADD COLUMN icon TEXT;
