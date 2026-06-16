-- Meeting WAITING ROOM (knock-to-join). External invited guests don't join a
-- LIVE meeting straight away: they "knock" and wait for a host/manager to admit
-- them. Internal @mapgroup users auto-admit (they never knock — the server
-- short-circuits them). One row per (meeting, guest email).
--
--   status flow:  invited ──admit──> admitted   (the Daily-token gate checks this)
--                    │
--                    └──deny──> denied   (SOFT: knock-only, never meeting_invitee;
--                                         re-knockable after a 30s cooldown)
--
-- `email` is always stored lower-cased (the caller lower-cases before writing).
-- `last_seen` is bumped on every (re)knock + on the guest's own poll so a
-- denied row's re-knock cooldown is measured from the last attempt. The admit
-- gate is enforced on the Daily token endpoint; the canvas relay stays
-- trust-the-key (pre-existing condition).

CREATE TABLE IF NOT EXISTS meeting_knock (
  room_id    TEXT NOT NULL,                  -- meeting id (room)
  email      TEXT NOT NULL,                  -- guest email, lower-cased
  name       TEXT,                           -- display name from the knock body
  status     TEXT NOT NULL DEFAULT 'invited', -- 'invited' | 'admitted' | 'denied'
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (room_id, email)
);
CREATE INDEX IF NOT EXISTS ix_knock_room ON meeting_knock(room_id);
