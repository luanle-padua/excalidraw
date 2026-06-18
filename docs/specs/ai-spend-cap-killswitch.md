# Global AI / STT / Daily daily spend ceiling + kill-switch

Status: spec (not built). Author: cost-audit lane. Date: 2026-06-18.
Owner to decide the USD numbers: anh Luân (PM). See **Open questions** at the end.

## 1. Why

The Worker calls three paid upstreams with server-side keys: **Gemini**
(`worker/src/ai.ts`, 4 routes), **Deepgram STT** (`worker/src/stt.ts`), and
**Daily** (`worker/src/index.ts` `/v1/daily/token`, L3871). Today the only
spend guards are:

- **Per-isolate, per-IP, in-memory** rate buckets (`ai.ts:88` `rateBuckets`,
  `stt.ts:135` `sttOpenLog`). These reset on isolate rotation and are not shared
  across colos — a soft anti-spam cap, **not** a spend cap.
- Manual **kill-switches** the worker lane is adding: `AI_ENABLED` /
  `STT_ENABLED` / `DAILY_ENABLED` → 503 when set to the literal `"off"`
  (`index.ts:376` `aiKillSwitch`, `stt.ts:235`, `index.ts:3875`). These are
  **human-flipped**, not automatic.

There is no automatic global ceiling. A loop bug, a leaked JWT, or a forgotten
streaming tab can burn real money overnight with nobody watching. This spec adds
an **automatic** ceiling on top of the manual switches, reusing the
`est_cost_usd` we already stamp on every billable call via `logUsageEvent`
(`worker/src/usage.ts:98`).

This is the cheap, good-enough guard for the **free Workers plan** internal/test
phase. It is a spend *circuit breaker*, not accounting — the upstream invoice is
always authoritative.

## 2. What we already have to build on

- `usage_events` table (`worker/schema/0028_usage_events.sql`): one row per
  successful billable call, with `est_cost_usd REAL` and `ts INTEGER` (ms epoch).
  Indexed `idx_usage_ts (ts DESC)`.
- Rows are written best-effort, fire-and-forget via `c.executionCtx.waitUntil`
  (`ai.ts:288`) / `ctx.waitUntil` (`stt.ts:328`). `logUsageEvent` never throws.
- The three kill-switch env vars are already wired (above). We extend that exact
  pattern.
- A `scheduled()` cron handler + trigger already exist (`wrangler.jsonc:73`,
  `"0 3 * * SUN"`) — reused for retention (§9).

**Important data caveat (affects the cap number):** the per-unit prices stamped
into `est_cost_usd` are **stale and low** (§7). So the cap throttles on a number
that *under-states* real spend. Pick the cap conservatively, or fix the
constants first (recommended — it's a one-line edit per constant).

## 3. Design overview

Add one cheap question to each paid route, *after* the kill-switch and *after*
auth, *before* the upstream fetch:

> "Has today's total `est_cost_usd` already crossed `AI_DAILY_USD_CAP`?"

If yes → return **503** (same shape as the kill-switch) and do **not** call the
upstream. If no → proceed; the call's own `usage_events` row pushes today's
total up for the next request to read.

"Today" = the current **UTC calendar day** (matches D1's daily-quota reset and
is unambiguous across the multi-country user base; see Open Q4 if a business-TZ
day is wanted instead).

Two storage options for the running total — **pick A for the free plan**:

### Option A (RECOMMENDED for free plan): D1 SUM, cached ~60 s in isolate memory

A module-level cache in each isolate:

```ts
// worker/src/spendcap.ts (new file)
type SpendSnapshot = { dayKey: string; totalUsd: number; fetchedAt: number };
let spendCache: SpendSnapshot | undefined;
const SPEND_TTL_MS = 60_000; // re-query D1 at most once/min per isolate

const utcDayKey = (ms = Date.now()): string =>
  new Date(ms).toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC)

const utcDayStartMs = (ms = Date.now()): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Today's (UTC) total est_cost_usd, cached ~60s per isolate. Fail-OPEN on
 *  any D1 error: a metering read failure must never hard-block paid features —
 *  the manual kill-switch is the backstop. Returns 0 when DB is unset. */
export const todaysSpendUsd = async (db: D1Database | undefined): Promise<number> => {
  if (!db) return 0;
  const dayKey = utcDayKey();
  const now = Date.now();
  if (spendCache && spendCache.dayKey === dayKey &&
      now - spendCache.fetchedAt < SPEND_TTL_MS) {
    return spendCache.totalUsd;
  }
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(est_cost_usd), 0) AS total
           FROM usage_events WHERE ts >= ?1`,
      )
      .bind(utcDayStartMs(now))
      .first<{ total: number }>();
    const totalUsd = row?.total ?? 0;
    spendCache = { dayKey, totalUsd, fetchedAt: now };
    return totalUsd;
  } catch {
    // fail open — return last known (if same day) else 0
    return spendCache?.dayKey === dayKey ? spendCache.totalUsd : 0;
  }
};

/** True once today's spend is at/over the cap. cap<=0 or unset => disabled. */
export const overSpendCap = async (
  db: D1Database | undefined,
  capUsd: number,
): Promise<boolean> => {
  if (!(capUsd > 0)) return false; // unset / 0 => cap disabled (off by default)
  return (await todaysSpendUsd(db)) >= capUsd;
};
```

Why A on the free plan:
- The `ts >= dayStart` SUM uses `idx_usage_ts`; at internal volume the rows-read
  per query is small. The 60 s cache means **at most ~1 SUM/min/isolate**, i.e.
  a few hundred reads/day — negligible against the **5,000,000 rows-read/day**
  D1 free quota.
- No new binding, no Durable Object class, no extra wrangler config. Simplest
  thing that works; matches "simplicity first".
- Trade-off: the cap is **eventually-consistent, up to ~60 s + isolate-spread
  late.** During a burst you can overshoot by (requests-in-the-window ×
  per-call cost). For a circuit breaker that's fine — see Open Q3 to tighten the
  TTL if overshoot matters.

### Option B (only if you later need a hard, near-real-time cap): a Durable Object counter

A single `SpendDO` (`idFromName("spend:<utcDayKey>")`) holding an in-memory +
`ctx.storage` running total; each metered call does an RPC `add(cost)` that
returns the new total, and the route blocks when it's over cap. Strongly
consistent (no overshoot window), self-resets by keying the DO name on the UTC
day. **Costs:** every paid call now also does a DO round-trip (latency + DO
requests — DO is **not** on the free plan in the same way; it needs the paid
Workers plan / has its own request billing). **Do not** adopt B while the goal
is "stay on the free plan." Documented here only as the upgrade path for Aug
(the Durable-Objects migration already brings a DO into the picture, so the
counter could ride along then).

**Decision: ship Option A now.**

## 4. Where to read it (per route)

Read the cap once per request, right after the existing kill-switch check, before
any upstream fetch. The cap value comes from `env.AI_DAILY_USD_CAP` (string var →
`Number(...)`).

### 4a. Gemini routes (`worker/src/ai.ts`)

Cleanest: add a second middleware next to `aiKillSwitch` in `index.ts` (so
`ai.ts` stays untouched, same as the kill-switch lives in `index.ts:372`):

```ts
// index.ts, beside aiKillSwitch
const aiSpendGate: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> =
  async (c, next) => {
    const cap = Number(c.env.AI_DAILY_USD_CAP);
    if (await overSpendCap(c.env.DB, cap)) {
      return c.json({ error: "AI daily spend limit reached", code: "spend_cap" }, 503);
    }
    return next();
  };
// order: kill-switch -> spend-gate -> jwtGate -> aiRoomGate -> aiRoutes
app.use("/translate", aiSpendGate);
app.use("/translate-batch", aiSpendGate);
app.use("/chatbot", aiSpendGate);
app.use("/summarize", aiSpendGate);
```

Note `/chatbot` deliberately returns 200 + a graceful fallback on Gemini errors
(`ai.ts:809`), but a middleware that returns 503 short-circuits **before** the
handler, so the client's normal "AI unavailable" path is exercised — acceptable
(the bot shows "couldn't reach the assistant"). If you'd rather the bot show the
soft fallback string instead of a 503, special-case `/chatbot` to fall through to
the handler with a flag — Open Q5.

### 4b. STT (`worker/src/stt.ts handleSttUpgrade`)

Add right after the `STT_ENABLED==="off"` check (`stt.ts:235`), before auth /
provider open:

```ts
if (await overSpendCap(env.DB, Number(env.AI_DAILY_USD_CAP))) {
  return new Response("stt daily spend limit reached", { status: 503 });
}
```

STT is the **highest-risk** lane: it bills for the *whole* session duration, and
the row is only written on teardown (`stt.ts:316`), so an in-flight 90-min
session (cap `STT_MAX_SESSION_MS`) is **not yet reflected** in today's SUM. The
ceiling blocks *new* opens once crossed; it can't retroactively stop sessions
already streaming. The existing session caps (`STT_MAX_SESSION_MS` 90 min,
`STT_AUDIO_IDLE_MS` 60 s) bound that tail. Acceptable for a circuit breaker.

### 4c. Daily (`worker/src/index.ts /v1/daily/token`, L3871)

Add right after the `DAILY_ENABLED==="off"` check (L3875), before minting:

```ts
if (await overSpendCap(c.env.DB, Number(c.env.AI_DAILY_USD_CAP))) {
  return c.json({ error: "video daily spend limit reached", code: "spend_cap" }, 503);
}
```

**Caveat for Daily:** we do **not** currently write a `usage_events` row for
Daily participant-minutes (only Gemini + Deepgram are metered;
`dailyCostUsdRange` in `usage.ts:75` exists but nothing calls `logUsageEvent`
with `provider='daily'`). So Daily spend is **invisible** to this SUM today.
Two choices (Open Q6):
  (i) **Share** the one `AI_DAILY_USD_CAP` across all three and accept that the
      cap only *sees* Gemini+Deepgram spend — Daily token minting still gets
      blocked once *AI/STT* spend crosses the cap (a coarse but real backstop),
      **or**
  (ii) meter Daily too (post-call/room-tick row) so its $ counts — more work,
      and Daily minutes aren't known at token-mint time (only at room close),
      so this needs a usage webhook or a periodic room-usage poll. **Out of
      scope for this spec**; (i) ships now, (ii) is a follow-up.

## 5. Interaction with the kill-switch

Precedence per route, top to bottom:

1. `*_ENABLED === "off"`  → 503 "temporarily disabled" (manual, absolute).
2. `overSpendCap`         → 503 "spend limit reached" (automatic).
3. provider-not-configured (no key) → 503 "not configured".
4. auth / membership gates → 401 / 403.
5. upstream call.

The kill-switch always wins (it's the human override / panic button). The spend
cap is the automatic layer underneath. They are independent env vars — flipping
`AI_ENABLED off` does not change the cap and vice-versa. When the cap trips, the
human can still **raise** `AI_DAILY_USD_CAP` (or set it to `0`/unset to disable
the cap) to restore service without touching the kill-switch, all via
`wrangler secret put` / dashboard var edit, **no redeploy**.

**Default-off-by-design:** `overSpendCap` returns `false` when the cap is
`<= 0`/unset/non-numeric. So shipping this code with no `AI_DAILY_USD_CAP` set
changes nothing until Luân picks a number. Safe to merge before the number is
decided.

## 6. What the user sees

All trips return **HTTP 503** so existing client "service unavailable" paths
fire (the AI/STT routes already 503 for "not configured", so the client handles
it). Bodies:
- Gemini / Daily (JSON): `{ "error": "...spend limit reached", "code": "spend_cap" }`.
- STT (WS upgrade): a non-101 503 → the browser surfaces a failed WS open, which
  the client's `onerror` already reports (same path as `STT_ENABLED off`).

Client copy suggestion (frontend lane, not this Worker): when a 503 carries
`code:"spend_cap"`, show a calm banner — VN: *"Tính năng AI tạm dừng hôm nay do
đã đạt hạn mức chi phí. Sẽ tự mở lại vào ngày mai."* / EN: *"AI features are
paused for today (daily cost limit reached). They'll resume tomorrow."* — so it
reads as a planned limit, not a crash. Avoids a support ticket storm.

## 7. Alert threshold (warn at 80%)

Two cheap, no-new-service options:

- **Log-line + Cloudflare Workers Logs alert (recommended).** In
  `todaysSpendUsd`, when a *fresh* (cache-miss) read crosses
  `AI_SPEND_WARN_RATIO` (default `0.8`) of the cap, emit a structured
  `console.warn`:
  `console.warn("SPEND_WARN", { day, totalUsd, capUsd, ratio })`. `observability`
  is already on (`wrangler.jsonc:21`), so set a Logs / Logpush alert (or a Workers
  Alert) matching `SPEND_WARN`. Throttle to once per isolate-per-day with a
  module flag so it doesn't spam.
- **Email via Resend** (the Worker already has `RESEND_API_KEY` +
  `RESEND_FROM`, `wrangler.jsonc:31`): from the **daily cron** `scheduled()`
  handler, SUM today's spend and, if ≥ warn ratio, send Luân one email. Simpler
  to reason about (one mail/day max) but coarser (only fires at cron time).
  **Recommendation:** ship the `console.warn` now; add the cron email when Luân
  wants a push. Open Q7 = warn ratio + where the alert goes.

The 80% warn is informational only — it does **not** throttle. Only crossing
100% (the cap) returns 503.

## 8. Env vars / secrets — exact list

Add to `worker/src/index.ts Bindings`, `AiBindings` (`ai.ts:29`), and
`SttBindings` (`stt.ts:38`) as needed, and to `wrangler.jsonc vars` (so a missing
var is explicit, not silently undefined):

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `AI_DAILY_USD_CAP` | plain var (or secret) | unset → cap **disabled** | Today's (UTC) est-cost ceiling in USD across Gemini+Deepgram (+Daily mint, coarsely). `<=0`/unset/non-numeric ⇒ no cap. |
| `AI_SPEND_WARN_RATIO` | plain var | `0.8` | Fraction of cap at which to emit `SPEND_WARN`. |
| `AI_ENABLED` | plain var | `"on"` | Existing manual Gemini kill-switch. |
| `STT_ENABLED` | plain var | `"on"` | Existing manual Deepgram kill-switch. |
| `DAILY_ENABLED` | plain var | `"on"` | Existing manual Daily kill-switch. |

Set the cap with no redeploy:
`npx wrangler secret put AI_DAILY_USD_CAP` (or edit the `vars` block + `wrangler
deploy`). A plain var in `wrangler.jsonc` is fine and visible in the dashboard;
use a secret only if you'd rather not show the number. **No new binding** beyond
the existing `DB` D1 binding.

One cap var, shared by all three lanes, is the simplest mental model for a
non-CS PM: "the app may spend at most $X of AI/voice/video per day, then it
pauses till tomorrow." If per-lane caps are ever wanted, add
`STT_DAILY_USD_CAP` / `DAILY_DAILY_USD_CAP` later and have each gate prefer its
own var, falling back to `AI_DAILY_USD_CAP` (Open Q2).

## 9. Unbounded-growth note (D1 retention) — ship alongside

The audit flagged `usage_events` and `audit_log` (`schema/0030_owner_audit.sql`,
`0005_audit_log.sql`) growing forever. On the **free plan** the binding limits
are **5 GB total storage** and **100,000 rows written/day**
(D1 free, reset 00:00 UTC — confirmed at developers.cloudflare.com/d1/platform/pricing).
Two reasons this matters here:
- the spend-cap SUM scans `ts >= dayStart`; with retention the table stays small
  and the SUM stays cheap;
- a metering row is itself a D1 *write*, so runaway calls eat the write quota too
  — the cap indirectly protects it.

Add to the existing weekly cron `scheduled()` (`wrangler.jsonc:73`,
`index.ts` scheduled handler) a prune:

```sql
DELETE FROM usage_events WHERE ts < ?1;  -- ?1 = now - RETENTION_DAYS*86400_000
DELETE FROM audit_log    WHERE ts < ?1;  -- match audit_log's ts column name
```

Default `USAGE_RETENTION_DAYS = 90` (plain var). Keep daily aggregates if long
history is wanted: before deleting, roll up into a tiny `usage_daily(day,
provider, total_usd, calls)` table — optional, Open Q8. This keeps the spend
math fast and the free-plan storage bounded.

## 10. Test plan (brief)

- `utcDayKey` / `utcDayStartMs` around a UTC midnight boundary.
- `overSpendCap`: unset cap ⇒ false; below ⇒ false; at/over ⇒ true; D1 throw ⇒
  fail-open false (or last-known same-day).
- Cache: two calls within 60 s ⇒ one D1 query; after TTL ⇒ re-query; day
  rollover ⇒ cache invalidated.
- Each route returns 503 (correct body / non-101) when over cap, and proceeds
  when under.
- Kill-switch precedence: `AI_ENABLED off` returns the disabled-503 even when
  under cap.

## 11. Real per-unit costs (so the PM can pick a number)

Sources fetched 2026-06-18. **The numbers in `worker/src/usage.ts` are stale —
fix them before trusting the cap, or the cap leaks more real money than it
shows.**

| Upstream | Code constant (`usage.ts`) | Real list price (Jun 2026) | Note |
|---|---|---|---|
| Gemini 2.5 Flash **input** | `0.075` /1M (L16) | **$0.30 /1M** | ~4x under-stated |
| Gemini 2.5 Flash **output** | `0.30` /1M (L17) | **$2.50 /1M** | **~8x under-stated** — the big one |
| Deepgram Nova-3 streaming | `0.0043` /min (L23) | **$0.0048 /min** PAYG monolingual (multilingual ~$0.0058) | ~12% under |
| Daily participant-min | `0.00036`–`0.004` (L64-65) | audio-only floor `~$0.00036`, video ceiling **$0.004**; free **10,000 min/mo** | MCM = audio+screenshare, exact tier unverified — keep the low→high range |

Practical sizing for the internal/test phase (rough, after fixing constants):
- **Gemini:** a `/summarize` of a long meeting ≈ thousands of in-tokens + up to
  4096 out-tokens → on the order of **$0.01–0.03 per summary**; `/translate`
  calls are tiny (sub-cent). Dozens of meetings/day ⇒ low single-digit dollars.
- **Deepgram:** $0.0048/min ⇒ **~$0.29/hour** of audio, *per speaking
  participant stream*. A 1-hour meeting with 5 mic-on participants ⇒ ~$1.45.
  This is usually the largest line item.
- **Daily:** first 10,000 participant-min/month are free; above that, audio
  ~$0.00036–$0.004/participant-min.

So a sane **starting** `AI_DAILY_USD_CAP` for internal testing is small — order
**$5–$20/day** would hard-stop a runaway loop while never tripping on real
internal usage. **This is Luân's call (Open Q1).**

## Open questions (PM to decide — the USD numbers)

1. **`AI_DAILY_USD_CAP` value (USD/day).** The whole point. Suggest starting
   ~$10/day for internal test; raise for Aug external. Set to unset/0 to keep
   the cap off until you're ready.
2. **One shared cap, or per-lane caps?** Ship one shared `AI_DAILY_USD_CAP` now;
   add `STT_DAILY_USD_CAP` / `DAILY_DAILY_USD_CAP` only if you want separate
   ceilings.
3. **Overshoot tolerance / cache TTL.** 60 s cache can overshoot during a burst.
   OK, or tighten to 15–30 s (more D1 reads, still tiny)?
4. **"Today" = UTC day, or a business-timezone day** (e.g. Asia/Seoul or
   Asia/Ho_Chi_Minh)? UTC is simplest and matches D1's reset; a business day
   shifts when the cap resets relative to working hours.
5. **`/chatbot` on cap-trip:** hard 503 (client shows "AI unavailable"), or fall
   through to the soft in-bot fallback string?
6. **Daily metering:** accept that the shared cap only *sees* Gemini+Deepgram
   spend (Daily mint still blocked once that crosses), or invest in metering
   Daily participant-minutes too (follow-up)?
7. **Warn threshold + destination:** confirm 80%; alert via Workers Logs
   (`SPEND_WARN`) only, or also a daily Resend email to Luân?
8. **Retention:** `USAGE_RETENTION_DAYS` (suggest 90) and whether to keep a tiny
   rolled-up `usage_daily` aggregate before pruning.
9. **Fix the stale price constants first?** (Recommended — one-line edits in
   `usage.ts`: Gemini output 0.30→2.50, input 0.075→0.30, Deepgram 0.0043→
   0.0048.) Until fixed, the cap throttles on an under-count.
