-- Per-meeting participation log: who actually joined each meeting (the prior
-- participant_count was just a number — no list of who). One row per
-- (meeting, user); joined_at = first join, last_seen_at = most recent.
CREATE TABLE IF NOT EXISTS meeting_participant (
  meeting_id    TEXT NOT NULL,
  user_email    TEXT NOT NULL,
  name          TEXT,
  joined_at     INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_email)
);
CREATE INDEX IF NOT EXISTS ix_participant_meeting ON meeting_participant(meeting_id);
