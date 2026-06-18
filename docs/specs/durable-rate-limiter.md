# Durable per-user rate limiter

Status: spec (not built) · 2026-06-18 · audit follow-up to B7
Author: cost-audit subagent · target Worker: `mcm-storage`

## Problem

Today rate limiting is a **per-isolate, in-memory `Map`** in two places, and
**absent** everywhere else that spends real money:

| Surface | Current limiter | Where |
| --- | --- | --- |
| `/translate`, `/translate-batch` | `rateLimited(ip,"translate",20,60s)` | `worker/src/ai.ts:457,539` (Map at `ai.ts:88`, fn `ai.ts:90-105`) |
| `/chatbot` | `rateLimited(ip,"chatbot",5,60s)` | `worker/src/ai.ts:598` |
| `/summarize` | `rateLimited(ip,"summarize",1,60s)` | `worker/src/ai.ts:849` |
| `/stt` (WS open) | `sttOpenRateLimited(email)` 3/60s | `worker/src/stt.ts:135-149,275` |
| `/v1/daily/token` | **NONE** | `worker/src/index.ts:3871` |
| `PUT /v1/scenes/:roomId` (+ chats/transcripts/library/files) | **NONE** | `worker/src/index.ts:1046,1118,1141,1182,1210` |

Two structural problems with the `Map` approach (both already conceded in the
code comments at `ai.ts:14-18,80-85` and `stt.ts:131-135`):

1. **Keyed by IP, not identity.** `clientIp()` (`ai.ts:107-110`) reads
   `CF-Connecting-IP`; behind an office NAT every internal user shares one IP,
   so the AI limits punish the whole org as a single bucket. The `/stt` limiter
   already does it right (keyed by JWT `email`) — the AI routes have the verified
   `email` on the same Hono context (`ai.ts:43-47`, set at `index.ts:332-335`)
   but ignore it.
2. **Per-isolate, not durable.** Each Worker isolate keeps its own `Map`; it
   resets on isolate rotation and isn't shared across colos. So `N` isolates ×
   `M` colos = effective limit is `N·M ×` the configured number. It is a soft
   speed-bump, **not a spend cap** — exactly the gap the cost audit flagged.

We want a **durable limiter keyed by JWT email + route** so the cap is per
*user* and (ideally) global, on the **free Workers plan**.

## The two options

### Option A — native Workers Rate Limiting binding (`ratelimits` in wrangler)

A first-party binding. You declare it in `wrangler.jsonc` and call
`env.LIMITER.limit({ key })`; the key is **any string you choose** — so
`` `${route}:${email}` `` works directly (docs explicitly recommend keying by
user id over IP).

```jsonc
// wrangler.jsonc  (note: key is "ratelimits", sibling of "vars")
"ratelimits": [
  { "name": "RL_AI",    "namespace_id": "2001", "simple": { "limit": 20, "period": 60 } },
  { "name": "RL_HEAVY", "namespace_id": "2002", "simple": { "limit": 5,  "period": 60 } },
  { "name": "RL_STT",   "namespace_id": "2003", "simple": { "limit": 3,  "period": 60 } },
  { "name": "RL_DAILY", "namespace_id": "2004", "simple": { "limit": 10, "period": 60 } },
  { "name": "RL_PUT",   "namespace_id": "2005", "simple": { "limit": 60, "period": 60 } }
]
```

```ts
const { success } = await env.RL_AI.limit({ key: `chatbot:${email}` });
if (!success) return c.json({ error: "rate limited" }, 429);
```

Hard constraints (current docs, `workers/runtime-apis/bindings/rate-limit`):

- **`period` MUST be `10` or `60` seconds.** Nothing else. No hour/day windows,
  no token-bucket refill tuning. `limit` is an integer (tokens per period).
- **Counters are per-Cloudflare-location, NOT global.** "For each unique key …
  there is a unique limit per Cloudflare location." A user hitting Tokyo and
  Seoul gets two independent buckets. For a single-region internal tool this is
  near-global in practice, but it is *not* a hard global cap.
- One limit **per namespace_id** → you need a separate binding per
  limit/period pair (hence the 5 above). Bindings sharing a `namespace_id` share
  counters (even across Workers).
- Distinct from **WAF rate-limiting rules** (those are the ones whose
  periods/actions "vary by plan", Free = 10s only). The **Workers binding** is
  part of the Workers runtime and works on the **free Workers plan**.
- Granularity is coarse: only the count is decremented; there's no "cost N
  tokens" weighting, no per-key introspection, no reset.

### Option B — `RateLimiterDO` keyed by `email+route`

A tiny Durable Object: one instance per `` `${route}:${email}` `` (via
`idFromName`), holding a sliding-window or fixed-window counter in
`ctx.storage` (or just in-memory + `alarm` for cleanup). The Worker calls it
before the metered work.

```ts
// roomDO-style binding already exists; add a second class.
const id   = env.RL.idFromName(`${route}:${email}`);
const ok   = await env.RL.get(id).check(limit, windowMs); // RPC → {allowed:boolean}
if (!ok.allowed) return c.json({ error: "rate limited" }, 429);
```

```jsonc
// wrangler.jsonc additions
"durable_objects": { "bindings": [
  { "name": "ROOM", "class_name": "RoomDO" },
  { "name": "RL",   "class_name": "RateLimiterDO" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["RoomDO"] },
  { "tag": "v2", "new_sqlite_classes": ["RateLimiterDO"] }
]
```

Properties:

- **Globally consistent per key** — a DO instance is single-homed, so the count
  is one true number regardless of colo/isolate. This is the real "spend cap".
- **Arbitrary windows** — you choose ms; a 5/`hour` chatbot cap or a 200/`day`
  PUT cap is trivial, unlike Option A's 10/60s ceiling.
- **Free-plan caveat — this is the catch.** DO **SQLite-backed** classes are
  available on the **Workers Free plan** (the project already runs `RoomDO` as
  `new_sqlite_classes`, `wrangler.jsonc:61-66`). BUT every `check()` is an extra
  request hop + DO wall-time; the free plan's DO request/duration allowances are
  finite, and routing every Daily/PUT/AI call through one more DO adds latency
  and burns the very free-tier budget we're trying to protect. A hot key (one
  chatty meeting) funnels all its traffic to a single DO instance =
  single-threaded bottleneck.
- More code to write, test, and keep alive (alarms for GC of idle counters).

## Recommendation

**Use Option A (native binding) as the primary limiter; do NOT build the DO.**

Reasoning, given the constraints (free plan, non-CS PM who self-maintains,
internal/single-region for now):

- The native binding is ~3 lines per route, zero new classes, zero storage to
  reason about, and the key can be `` `${route}:${email}` `` — it fixes the
  *identity* problem (the audit's main complaint) immediately.
- "Per-location, not global" is an acceptable weakening for an internal tool
  that is effectively one region (Fly Tokyo today; APAC D1). It is strictly
  better than today's per-isolate-per-IP.
- The 10/60s window limit is fine for **burst/abuse** control, which is what
  these caps are for. The **true monthly spend ceiling** is a *different*
  mechanism — the existing kill-switches (`AI_ENABLED`, `STT_ENABLED`,
  `DAILY_ENABLED`) plus a `usage_events` spend-cap cron — not a per-request
  limiter. Don't conflate the two.
- Build `RateLimiterDO` **only if** a future need appears for a true global
  hard cap or a >60s window (e.g. "50 summaries per user per day"). Note it here
  as the documented upgrade path.

## Surfaces to protect + suggested limits

All keyed by **JWT email** (fall back to `cf-connecting-ip` only when email is
absent, which for these authed routes means an attacker who stripped auth — they
get a stricter shared bucket). Format every key as `` `${route}:${email}` ``.

| Route | Binding | limit / period | Rationale |
| --- | --- | --- | --- |
| `/translate`, `/translate-batch` | `RL_AI` | 20 / 60s | matches today's `ai.ts:457`; cheap Flash calls, chat-speed |
| `/chatbot` | `RL_HEAVY` | 5 / 60s | matches `ai.ts:598`; larger context = pricier |
| `/summarize` | `RL_HEAVY` (or own ns) | 1 / 60s → use a 2nd ns if you want it separate | matches `ai.ts:849`; one recap/min is plenty |
| `/stt` open | `RL_STT` | 3 / 60s | matches `stt.ts:126`; caps reconnect storms (each open = metered Deepgram stream) |
| `/v1/daily/token` | `RL_DAILY` | 10 / 60s | **NEW**; token mint is cheap but precedes a billed media room — cap reconnect/multi-tab churn |
| `PUT /v1/scenes` + chats/transcripts/library/files | `RL_PUT` | 60 / 60s | **NEW**; autosave is frequent (1/few-sec is normal) so keep generous — this guards R2 write-amplification & runaway autosave loops, not cost-per-call |

Notes:
- `/summarize` at 1/60s and `/chatbot` at 5/60s have different limits → if you
  want both on `RL_HEAVY` they share the 5/60s bucket. Cleaner to give
  `/summarize` its own `namespace_id` with `limit:1`. Cheap to do.
- The `period` ceiling (60s) means you can't express the STT 90-min session cap
  or daily quotas here — those stay as the existing wall-clock guards in
  `stt.ts` (MAX_SESSION_MS, AUDIO_IDLE_MS) and the kill-switches.

## Free-plan compatibility

- **Option A binding: yes, free Workers plan.** It's a runtime binding, not a
  WAF feature. No paid add-on.
- **Option B DO (if ever built): yes**, SQLite DO classes run on Free (already
  proven by `RoomDO`), but it consumes the free DO request/duration budget on
  every gated call — the opposite of cost-saving for high-frequency PUTs.
- Neither needs D1/KV, so no extra storage line item for the PM.

## Fallback when the limiter is unavailable

Decide **fail-open vs fail-closed per surface by what the call costs**:

- **Fail-OPEN** for `/v1/scenes` and the other blob PUTs. These are
  correctness-critical (a dropped autosave loses canvas work) and cheap (R2
  write). If `env.RL_PUT.limit()` throws, log and proceed — never block a save
  on a limiter hiccup. Mirror the existing best-effort posture of
  `logUsageEvent` (`usage.ts:131` swallows errors).
- **Fail-CLOSED** for `/stt` and `/v1/daily/token`. These open/precede a
  **metered external stream** (Deepgram, Daily). `/stt` already fails closed on
  auth (`stt.ts:246`). If the limiter is unavailable, returning 429/503 is the
  safe default — a limiter outage must not become an unbounded-spend window.
- **AI routes**: fail-open is acceptable (Flash is cheap and the kill-switch is
  the real backstop), but wrap in `try/catch` so a binding error never 500s a
  user mid-meeting.

Implement as a thin helper so the policy is one place:

```ts
// fail = "open" | "closed"
async function rateOk(
  limiter: RateLimit | undefined,
  key: string,
  fail: "open" | "closed",
): Promise<boolean> {
  if (!limiter) return fail === "open";          // binding not deployed yet
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return fail === "open";                        // limiter errored
  }
}
```

## Minimal code shape (Option A)

1. Add the 5 `ratelimits` blocks to `wrangler.jsonc` (sibling of `vars`,
   `durable_objects`).
2. Add the bindings to the `Bindings`/`AiBindings` types:
   ```ts
   RL_AI?: RateLimit; RL_HEAVY?: RateLimit; RL_STT?: RateLimit;
   RL_DAILY?: RateLimit; RL_PUT?: RateLimit;
   ```
   (`RateLimit` is in `@cloudflare/workers-types`.)
3. **`ai.ts`**: delete `rateBuckets`/`rateLimited`/`clientIp` (`ai.ts:87-110`);
   replace each call site with
   `if (!(await rateOk(c.env.RL_AI, \`translate:${c.get("email")}\`, "open"))) return c.json({error:"rate limited"},429);`
   (and `RL_HEAVY` for chatbot/summarize). Keep the `rateOk` helper in a shared
   `worker/src/ratelimit.ts`.
4. **`stt.ts`**: replace `sttOpenRateLimited` (`stt.ts:135-149,275`) with
   `rateOk(env.RL_STT, \`stt:${callerEmail}\`, "closed")` → 429. Keep the
   wall-clock session/idle guards untouched (the binding can't express them).
5. **`index.ts` `/v1/daily/token`** (`index.ts:3871`): after the existing gates,
   `rateOk(c.env.RL_DAILY, \`daily:${c.get("email")}\`, "closed")` → 429.
6. **`index.ts` blob PUTs** (`:1046,1118,1141,1182,1210`): add a small
   `app.use("/v1/scenes/*", putRateGate)` style middleware (or inline) calling
   `rateOk(c.env.RL_PUT, \`put:${c.get("email")}\`, "open")`. Runs after
   `roomGate` so `email` is set.

The client contract is unchanged (still a 429 on limit), so no client edits.

## Open questions for the PM

1. Confirm per-user limits (table above) — esp. `/v1/daily/token` 10/60s and
   blob PUT 60/60s, which are brand new and have no prior tuning.
2. `/v1/scenes` PUT: fail-OPEN on limiter error (never lose a save) — confirm
   that's the right call vs. fail-closed.
3. Do we want `/summarize` on its own namespace (limit 1) or sharing
   `RL_HEAVY` (5) with `/chatbot`? Costs nothing to separate.
4. Per-location (not global) counting acceptable while we're effectively
   single-region? If a true global hard cap is ever required, that's the trigger
   to build `RateLimiterDO` (Option B).
