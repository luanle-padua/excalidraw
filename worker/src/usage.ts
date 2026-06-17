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
 * Deepgram realtime STT (Nova) list pricing: $0.0043 per audio MINUTE.
 * (https://deepgram.com/pricing.)
 */
export const DEEPGRAM_STT_USD_PER_MINUTE = 0.0043;

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
