-- 0016 — "Tài liệu của tôi" (My Files, quyết định 06-10 #2): tủ tài liệu cá
-- nhân của user nội bộ. Bytes ở R2 `userfiles/<email>/<fileId>` (server-readable
-- — KHÔNG mã hoá room-key vì chưa thuộc meeting nào); kéo vào meeting bằng COPY
-- qua pipeline ingest/encrypt sẵn có ở client. Mỗi blob có row index (quy tắc
-- production-data-plan.md §2: prefix mới bắt buộc có bảng index).

CREATE TABLE IF NOT EXISTS user_file (
  id          TEXT PRIMARY KEY,        -- uuid
  owner_email TEXT NOT NULL,           -- JWT email (lower-case)
  name        TEXT,
  kind        TEXT,                    -- pdf | dxf | ifc | image | other
  size        INTEGER,
  r2_key      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_file_owner
  ON user_file (owner_email, created_at DESC);
