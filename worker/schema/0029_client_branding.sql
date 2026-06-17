-- CLIENT BRANDING (06-17). A project guest is the external CLIENT; the host can
-- now record the client's COUNTRY + COMPANY + LOGO so their entry page is
-- branded: the country picks the backdrop, the logo overlays it. This attaches
-- to the EXISTING project_guest row (no new "company" entity): `company` already
-- exists (added in 0020); we add `country` (ISO-3166 alpha-2, e.g. "VN") and
-- `logo_key` (R2 object key under guest-logos/<id>, NULL until a logo is set).
-- Both nullable + metadata-only (SQLite ADD COLUMN never rewrites the table).
ALTER TABLE project_guest ADD COLUMN country  TEXT;  -- ISO alpha-2, NULL = unset
ALTER TABLE project_guest ADD COLUMN logo_key TEXT;  -- R2 guest-logos/<id>, NULL = none

-- Backdrops get an optional COUNTRY tag so the client entry page can resolve
-- "the backdrop for country X". NULL = a GLOBAL/default backdrop (the fallback
-- rotation shown when a client's country has no tagged backdrop, or before the
-- client is identified). Indexed for the per-country resolve lookup.
ALTER TABLE portal_backdrop ADD COLUMN country TEXT;  -- ISO alpha-2, NULL = global
CREATE INDEX IF NOT EXISTS ix_backdrop_country ON portal_backdrop(country);
