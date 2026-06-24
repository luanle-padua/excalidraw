-- 0037_recording_per_speaker.sql
-- Per-source / per-speaker audio recording (#23) + recording-session grouping (#24).
--
-- A single recording SESSION (one owner, enforced by the room-DO recording lock,
-- #24) now produces MULTIPLE rows instead of one mixed file:
--   • one row per PARTICIPANT mic  → kind='mic', speaker_id/speaker_name set
--   • optional screen audio (owner) → kind='screen-audio'
--   • optional screen video (owner) → kind='screen-video'
-- Legacy single mixed files keep kind='mixed' (the DEFAULT, so old rows are valid).
--
-- Storage-optimised: mic = MONO opus ~32 kbps audio-only; a participant who never
-- speaks (muted / silent the whole session) uploads NOTHING (no empty row). No
-- redundant 'mixed' file is produced going forward — per-source IS the source of
-- truth; playback is composed in the UI.
--
-- session_id groups every file of one Record→Stop so the Recordings UI can show a
-- session with its per-speaker tracks and align them on a shared start.

ALTER TABLE recording ADD COLUMN kind         TEXT NOT NULL DEFAULT 'mixed'; -- 'mic' | 'screen-audio' | 'screen-video' | 'mixed'
ALTER TABLE recording ADD COLUMN speaker_id   TEXT;  -- authenticated email of the mic owner (NULL for non-mic)
ALTER TABLE recording ADD COLUMN speaker_name TEXT;  -- display name captured at record time (NULL for non-mic)
ALTER TABLE recording ADD COLUMN session_id   TEXT;  -- groups all files of one Record->Stop session (NULL for legacy)

-- Per-meeting listing grouped by session (newest session first via created_at).
CREATE INDEX IF NOT EXISTS ix_recording_session ON recording(meeting_id, session_id);
