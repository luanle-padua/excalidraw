-- Meeting Event Log — a unified, SERVER-READABLE timeline of one meeting, so an
-- AI can later read the FLOW of what happened (and company leadership can read
-- that project information). See docs/plans/meeting-event-log.md §4.1 (P1 MVP).
--
-- SCOPE (product owner, 06-23): this is a PROJECT-INFORMATION / KNOWLEDGE layer,
-- NOT employee surveillance. Each row is one meaningful meeting event. There is
-- NO per-person behavioral scoring, sentiment, profiling or covert monitoring
-- anywhere in this schema — it is plain, disclosed meeting record-keeping.
--
-- E2E content (transcript / chat / canvas text) enters here as PLAINTEXT that the
-- client decrypts with the room key and POSTs in a batch — exactly the
-- meeting_package (0032) pattern. This is a DERIVED copy; the original E2E blobs
-- (scenes|chats|transcripts/<roomId>/current) are left untouched.

CREATE TABLE IF NOT EXISTS meeting_event (
  id           TEXT PRIMARY KEY,            -- stable id "<meetingId>:<kind>:<seq>" → idempotent upsert
  meeting_id   TEXT NOT NULL,               -- REFERENCES meeting(id)
  project_id   TEXT,                         -- denormalised at write → department-wall filtering
  ts           INTEGER NOT NULL,            -- event time (ms epoch) — the timeline source of truth
  seq          INTEGER,                      -- stable ordering within the same ts (segIdx / counter)
  actor_email  TEXT,                         -- who caused it (NULL = system)
  kind         TEXT NOT NULL,               -- taxonomy §3 (transcript.segment | chat.message | ...)
  payload_json TEXT,                         -- small JSON; plaintext content lives here
  r2_ref       TEXT,                         -- optional: large blob / thumbnail (NULL for P1)
  source       TEXT,                         -- 'client' | 'server' (provenance + trust)
  created_at   INTEGER NOT NULL             -- row insert time (≠ ts when consolidate-on-end)
);

-- Read the timeline ordered by (ts, seq); also the natural per-meeting filter.
CREATE INDEX IF NOT EXISTS ix_event_meeting_ts ON meeting_event(meeting_id, ts, seq);
-- Cross-meeting, per-project reads (leadership / AI reading a project's flow).
CREATE INDEX IF NOT EXISTS ix_event_project    ON meeting_event(project_id, ts);
-- Filter one meeting's timeline to a single kind (e.g. only transcript).
CREATE INDEX IF NOT EXISTS ix_event_kind       ON meeting_event(meeting_id, kind);

-- Join-time CONSENT record. A user accepts a short, disclosed notice that the
-- meeting may be recorded and processed by AI as project data before they
-- proceed. One row per (meeting, person) per consent version; re-accepting the
-- same version is a no-op upsert (so we don't nag on every entry).
--
-- A SEPARATE table (not a meeting_event kind) is chosen deliberately: consent is
-- a compliance fact keyed by (meeting_id, email) with a clean PK for "have they
-- accepted version X yet?" lookups, and it must NOT be mixed into the timeline
-- the AI reads as meeting flow.
CREATE TABLE IF NOT EXISTS meeting_consent (
  meeting_id  TEXT NOT NULL,                -- REFERENCES meeting(id)
  email       TEXT NOT NULL,                -- the accepting user (from the verified JWT)
  version     TEXT NOT NULL,                -- consent text VERSION accepted (client constant)
  accepted_at INTEGER NOT NULL,             -- ms epoch of acceptance
  PRIMARY KEY (meeting_id, email)
);
