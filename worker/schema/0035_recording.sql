-- 0035_recording.sql
-- Meeting Recording (Phase 5) — index of Daily cloud recordings copied into R2.
--
-- The media file itself lives in R2 (recordings/<meetingId>/<recordingId>.mp4),
-- server-readable (NOT E2E — a deliberate policy boundary, exactly like the
-- managed room_key + AI summary; see docs/specs/video-and-recording.md §3.6 and
-- docs/plans/recording-p5-analysis.md §2.6). This table is the metadata INDEX
-- that the auth-gated download/stream route (GET /v1/recordings/:id), the
-- per-meeting list (GET /v1/recordings/:roomId) and the future Admin Recordings
-- tab read. One row per Daily cloud recording (one composited MP4).
--
-- Lifecycle: a row is inserted with status='processing' when Daily fires the
-- recording.ready-to-download webhook; it is flipped to 'ready' once the R2 copy
-- succeeds (r2_key/bytes/ready_at filled); the Daily-side copy is then deleted to
-- stop double storage billing. The PRIMARY KEY is the Daily recording_id, so a
-- webhook retry is an idempotent upsert (ON CONFLICT) — never a duplicate row.

CREATE TABLE IF NOT EXISTS recording (
  id          TEXT PRIMARY KEY,                   -- Daily recording_id (idempotent on webhook retry)
  meeting_id  TEXT NOT NULL,                      -- REFERENCES meeting(id) (Daily room_name with -audio stripped)
  project_id  TEXT,                               -- denormalised at write → leadership / department filtering
  r2_key      TEXT,                               -- recordings/<meetingId>/<id>.mp4 (NULL until copied)
  duration    INTEGER,                            -- seconds (from the webhook payload)
  bytes       INTEGER,                            -- file size after the R2 put (NULL until copied)
  status      TEXT NOT NULL DEFAULT 'processing', -- 'processing' | 'ready' | 'failed' | 'deleted'
  started_by  TEXT,                               -- host email who pressed Record (NULL if unknown)
  created_at  INTEGER NOT NULL,                   -- row insert time (ms epoch)
  ready_at    INTEGER                             -- when the R2 copy completed (NULL until ready)
);

-- Per-meeting list (review-mode "Recordings" section), newest first.
CREATE INDEX IF NOT EXISTS ix_recording_meeting ON recording(meeting_id, created_at DESC);
-- Cross-meeting per-project reads (Admin Recordings tab / leadership).
CREATE INDEX IF NOT EXISTS ix_recording_project ON recording(project_id);
-- Operational sweeps (find stuck 'processing', drive retention / lifecycle).
CREATE INDEX IF NOT EXISTS ix_recording_status  ON recording(status);
