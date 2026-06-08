-- System-wide settings (admin-editable key/value). Drives org-level policy:
-- internal email domains (auto-admit), default waiting-room / recording, data
-- retention, org branding. Read by the app at runtime; edited in the admin
-- console Settings tab.
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
