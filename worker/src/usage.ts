// AI cost model — pricing constants + cost functions (Admin Console P0).
//
// Single source of truth for "what an upstream AI call costs". Imported by the
// AI routes (ai.ts) and the STT proxy (stt.ts) to stamp each usage_events row
// with `est_cost_usd` at write-time, and re-exported so the admin endpoints can
// show the per-unit rates if they want to. Prices are list prices in USD; tweak
// here and every estimate follows. These are ESTIMATES (the upstream invoice is
// authoritative) — good enough for the internal cost dashboard.

/**
 * Gemini 2.5 Flash list pricing (per 1M tokens), text-in / text-out.
 *   input : $0.075 / 1M tokens
 *   output: $0.30  / 1M tokens
 * (https://ai.google.dev/pricing — Flash tier.)
 */
export const GEMINI_FLASH_INPUT_USD_PER_1M = 0.075;
export const GEMINI_FLASH_OUTPUT_USD_PER_1M = 0.3;

/**
 * Deepgram realtime STT list pricing, per audio MINUTE. Verified 2026-06-18
 * against https://deepgram.com/pricing: Nova-3 MONOLINGUAL streaming = $0.0048
 * (PAYG). The old $0.0043 was a stale/lower rate (likely an old Nova batch tier)
 * and UNDER-counted the admin Cost tab. Note: lang=multi (Nova-3 Multilingual
 * streaming) is $0.0058 AND does not even cover VI/KO, so MCM pins one language
 * per stream and bills at the monolingual rate.
 */
export const DEEPGRAM_STT_USD_PER_MINUTE = 0.0048;

/**
 * Estimated USD cost of one Gemini Flash generateContent call from its token
 * counts (response.usageMetadata.promptTokenCount / candidatesTokenCount).
 * Missing/garbage counts are treated as 0 so a cost can always be computed.
 */
export const geminiFlashCostUsd = (
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): number => {
  const tin = Number.isFinite(tokensIn) ? (tokensIn as number) : 0;
  const tout = Number.isFinite(tokensOut) ? (tokensOut as number) : 0;
  return (
    (tin * GEMINI_FLASH_INPUT_USD_PER_1M +
      tout * GEMINI_FLASH_OUTPUT_USD_PER_1M) /
    1e6
  );
};

/**
 * Estimated USD cost of a Deepgram STT session from its duration in SECONDS.
 * (seconds / 60) * per-minute rate. Missing/garbage → 0.
 */
export const deepgramSttCostUsd = (seconds: number | undefined): number => {
  const s = Number.isFinite(seconds) ? (seconds as number) : 0;
  return (s / 60) * DEEPGRAM_STT_USD_PER_MINUTE;
};

/**
 * Daily.co list pricing — PER PARTICIPANT-MINUTE (https://www.daily.co/pricing/
 * video-sdk/, figures 2026-06-17). MCM uses audio + screenshare only (webcam
 * off), so the real billing tier sits somewhere between the audio-only floor
 * and the $0.004 video ceiling — which tier MCM actually lands at is UNVERIFIED
 * (see docs/specs/daily-usage-admin.md §1f), so every Daily $ is shown as a
 * low→high RANGE, never a single number.
 *   audio-only floor: $0.00036 / participant-min
 *   video ceiling:    $0.004   / participant-min
 *   free allowance:   10,000 participant-min / month
 * Tweak here and every Daily estimate follows.
 */
export const DAILY_PARTICIPANT_MIN_USD_LOW = 0.00036;
export const DAILY_PARTICIPANT_MIN_USD_HIGH = 0.004;
export const DAILY_FREE_MINUTES = 10_000;

/**
 * Estimated USD cost RANGE for a block of Daily participant-minutes, with the
 * monthly free allowance subtracted. Returns { low, high }; negative billable
 * minutes (still inside the free tier) clamp to 0. `freeRemaining` lets a
 * per-meeting meter pass how much of the free allowance is already spent so the
 * subtraction isn't double-counted (default: full allowance available).
 */
export const dailyCostUsdRange = (
  participantMinutes: number | undefined,
  freeRemaining: number = DAILY_FREE_MINUTES,
): { low: number; high: number } => {
  const mins = Number.isFinite(participantMinutes)
    ? Math.max(participantMinutes as number, 0)
    : 0;
  const free = Number.isFinite(freeRemaining) ? Math.max(freeRemaining, 0) : 0;
  const billable = Math.max(mins - free, 0);
  return {
    low: billable * DAILY_PARTICIPANT_MIN_USD_LOW,
    high: billable * DAILY_PARTICIPANT_MIN_USD_HIGH,
  };
};

/**
 * Best-effort write of ONE usage_events row (Admin Console P0). Called after a
 * SUCCESSFUL billable upstream call (Gemini generateContent / Deepgram STT). It
 * stamps a UUID + now() timestamps and NEVER throws — a metering failure (table
 * missing on an un-migrated DB, transient D1 error) must not block or fail the
 * response it's measuring. Lives here (not index.ts) so both ai.ts and index.ts
 * can import it without a circular dependency; index.ts re-exports it.
 */
export const logUsageEvent = async (
  db: D1Database,
  provider: string,
  kind: string,
  tokens_in: number,
  tokens_out: number,
  seconds: number,
  est_cost_usd: number,
  meeting_id?: string,
  email?: string,
): Promise<void> => {
  try {
    const ts = Date.now();
    await db
      .prepare(
        `INSERT INTO usage_events
           (id, provider, kind, tokens_in, tokens_out, seconds,
            est_cost_usd, meeting_id, email, ts, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      )
      .bind(
        crypto.randomUUID(),
        provider,
        kind,
        Math.round(tokens_in) || 0,
        Math.round(tokens_out) || 0,
        seconds || 0,
        est_cost_usd || 0,
        meeting_id ?? null,
        email ?? null,
        ts,
      )
      .run();
  } catch {
    // metering is best-effort — never block/break the measured response
  }
};
