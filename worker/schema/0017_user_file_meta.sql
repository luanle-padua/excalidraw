-- 0017 — user_file metadata cho "Tài liệu của tôi" v2: tag tự do (chuỗi
-- "a,b,c", NULL = chưa gắn) + cờ visibility cho bước copy-vào-meeting:
--   'private'  (mặc định) — client hỏi xác nhận trước khi sao chép vào meeting
--   'sharable'             — copy thẳng, không hỏi
-- Chỉ là metadata phía shelf; bytes R2 và snapshot trong meeting không đổi.

ALTER TABLE user_file ADD COLUMN tags TEXT;
ALTER TABLE user_file ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
