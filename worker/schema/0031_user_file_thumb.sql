-- 0031 — server-side thumbnail for "Tài liệu của tôi" image files. Bandwidth
-- fix: the My Files grid must load a SMALL stored thumb (~tens of KB), never
-- the full-resolution original. thumb_r2_key points at a downscaled WebP baked
-- client-side at upload (and lazily backfilled for legacy images on first view).
-- NULL = no thumb yet (non-image kinds, or pre-0031 images not yet backfilled);
-- the GET …/thumb route 404s and the client falls back to backfill/icon.
-- R2 key convention: userfiles/<email>/<fileId>/thumb (webp).
ALTER TABLE user_file ADD COLUMN thumb_r2_key TEXT;
