-- Richer CONTACT details for a project guest (06-15 follow-up). A guest is not
-- just a synthetic login: the host needs to record WHO the real person is —
-- their representative/contact name (kept in `label`), real email (`real_email`),
-- plus company, phone, and address — so the roster reads like a contact card,
-- not just credentials.
--
-- These are REFERENCE/CRM fields only: they live in D1 next to the guest row and
-- never touch the Supabase auth identity (the login stays synthetic). All are
-- optional, free-text, and nullable — SQLite ADD COLUMN is a cheap metadata-only
-- change (no table rewrite). `label` already exists (the representative's name)
-- and `real_email` already exists (the email), so we only add the three new ones.

ALTER TABLE project_guest ADD COLUMN company TEXT;  -- công ty
ALTER TABLE project_guest ADD COLUMN phone   TEXT;  -- số điện thoại
ALTER TABLE project_guest ADD COLUMN address TEXT;  -- địa chỉ
