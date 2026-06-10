-- 0015 — P0 local=production parity (production-data-plan.md §4 + quyết định 06-10):
--   1. schema_version — migration tracking (SSOT; chạy qua worker/migrate.mjs,
--      không bao giờ execute tay nữa).
--   2. deleted_meeting — tombstone chặn scene/file-PUT "hồi sinh" meeting đã xoá.
--   3. meeting.ai_summary — AI summary-first: summary là TEXT D1 (server-readable,
--      query được cho hỏi-xuyên-meeting + admin), KHÁC transcript (E2E blob R2).
--   4. seed system_settings.internal_domains — worker giờ ĐỌC setting này
--      (hết hardcode); seed để bảng không trống ở DB cũ.

CREATE TABLE IF NOT EXISTS schema_version (
  version    TEXT PRIMARY KEY,   -- "0001_init" … (tên file không .sql)
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_meeting (
  id         TEXT PRIMARY KEY,   -- roomId đã xoá vĩnh viễn
  deleted_by TEXT,
  deleted_at INTEGER NOT NULL
);

ALTER TABLE meeting ADD COLUMN ai_summary TEXT;
ALTER TABLE meeting ADD COLUMN ai_summary_at INTEGER;

INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('internal_domains', 'mapgroup.co.kr', 0);

-- Backfill: các migration đã chạy tay trước khi có tracking. (INSERT OR IGNORE
-- nên chạy lại trên DB mới qua migrate.mjs cũng vô hại — script tự ghi đè.)
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES
  ('0001_init', 0), ('0002_metadata', 0), ('0003_tier1_metadata', 0),
  ('0004_project_cover', 0), ('0005_audit_log', 0), ('0006_participants', 0),
  ('0007_settings', 0), ('0008_membership', 0), ('0009_meeting_schedule', 0),
  ('0010_notes', 0), ('0011_meeting_color', 0), ('0012_clients', 0),
  ('0013_status_canonical', 0), ('0014_project_owner_backfill', 0);
