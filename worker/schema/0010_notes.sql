-- Phase 4.5 calendar — per-user notes. A note is keyed by (scope, ref, email):
--   scope 'day'     · ref 'YYYY-MM-DD'  → the user's note for a calendar day
--   scope 'meeting' · ref roomId        → the user's note for one meeting
-- Strictly per-user: the owner email comes from the verified JWT and is part of
-- the primary key, so no two users ever share a note row. Upserted in place.

CREATE TABLE IF NOT EXISTS note (
  scope TEXT NOT NULL,            -- 'day' | 'meeting'
  ref   TEXT NOT NULL,            -- 'YYYY-MM-DD' or roomId
  email TEXT NOT NULL,            -- owner (from JWT)
  body  TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, ref, email)
);
