-- Client-page BACKDROPS (admin-managed). The client portal + guest waiting
-- room used to crossfade a HARDCODED array of bundled WebP themes
-- (PortalBackdrop.tsx). This table lets an admin upload / rename / reorder /
-- delete the rotation from the admin console; the client reads it dynamically
-- and falls back to the bundled defaults when the list is empty or the fetch
-- fails (so the page never breaks).
--
-- Image bytes live in R2 at `backdrops/<id>` (the row's r2_key); served by the
-- worker's GET /v1/portal/backdrops/:id/image stream route. `sort_order` drives
-- the rotation order (admin up/down buttons PATCH it); lower shows first.

CREATE TABLE IF NOT EXISTS portal_backdrop (
  id         TEXT PRIMARY KEY,                 -- random id (also the R2 key suffix)
  title      TEXT,                             -- optional admin label
  r2_key     TEXT NOT NULL,                    -- backdrops/<id>
  sort_order INTEGER NOT NULL DEFAULT 0,       -- ascending = rotation order
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backdrop_sort ON portal_backdrop(sort_order);
