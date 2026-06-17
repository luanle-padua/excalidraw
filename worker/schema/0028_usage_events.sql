-- AI cost & usage metering (Admin Console P0 — "AI cost & usage").
--
-- One row per BILLABLE upstream call: a successful Gemini generateContent
-- (translate / translate-batch / chatbot / summarize) or a Deepgram STT
-- session. The Worker writes these best-effort (never blocking the response;
-- see logUsageEvent in src/index.ts) so the admin console can show real spend
-- instead of the hardcoded `ai_calls: 0` placeholder.
--
-- Cost is computed at write-time from the pricing constants in src/usage.ts
-- (Gemini Flash token pricing, Deepgram per-minute) and stored as
-- `est_cost_usd` — denormalised so the admin queries are pure SUM/GROUP BY
-- with no pricing logic in SQL, and a later price change doesn't silently
-- rewrite history.
--
-- Token columns apply to Gemini (tokens_in/out); `seconds` applies to STT
-- (Deepgram). The unused dimension is simply 0 for that provider.
CREATE TABLE IF NOT EXISTS usage_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT,                              -- 'gemini' | 'deepgram' | ...
  kind         TEXT,                              -- 'translate'|'chatbot'|'summarize'|'stt'|...
  tokens_in    INTEGER,                           -- Gemini promptTokenCount
  tokens_out   INTEGER,                           -- Gemini candidatesTokenCount
  seconds      REAL,                              -- Deepgram STT seconds
  est_cost_usd REAL    NOT NULL DEFAULT 0,        -- computed at write-time (USD)
  meeting_id   TEXT,                              -- request context, when known
  email        TEXT,                              -- caller, when known
  ts           INTEGER NOT NULL,                  -- event time (ms epoch)
  created_at   INTEGER NOT NULL                   -- row insert time (ms epoch)
);

-- Admin queries filter/sort by provider, caller, meeting, and recency.
CREATE INDEX IF NOT EXISTS idx_usage_provider_ts ON usage_events (provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_email_ts    ON usage_events (email, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_meeting_ts  ON usage_events (meeting_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ts          ON usage_events (ts DESC);
