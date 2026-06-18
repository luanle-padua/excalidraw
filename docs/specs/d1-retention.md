# D1 retention / pruning — append-only tables

**Status:** spec (not built) · **Date:** 2026-06-18 · **Plan:** FREE Workers plan for now
**Scope:** the D1 tables in `mcm-storage` that grow forever and are never trimmed.
**Owner decisions needed:** see [§7 Retention decisions for the PM](#7-retention-decisions-for-the-pm).

---

## 0. Why this exists (the real constraint)

Today **nothing prunes**. Every AI/STT call, every admin action, every knock, every
realtime rejection writes a row that lives forever. On the **Free Workers plan** the
ceilings are hard (Cloudflare D1 platform limits, verified 2026-06-18):

| Free-plan limit | Value | Why it bites us |
| --- | --- | --- |
| Max database size | **500 MB** | unbounded `usage_events`/`audit_log` eventually fill it; then **no inserts/DDL at all** |
| Storage per account | **5 GB total** | shared across all DBs |
| Rows **read** / day | **5,000,000** | a full-table `SELECT *` backup re-reads everything every run |
| Rows **written** / day | **100,000** | a `DELETE` counts toward *writes* — so pruning itself must be budgeted |
| Queries per Worker invocation | **50** | batched prune loop must stay well under this |
| Max SQL statement length | **100,000 bytes (100 KB)** | rules out one giant `DELETE ... IN (huge list)` |
| Max bound parameters / query | **100** | a batch can bind at most 100 ids |
| Time Travel (point-in-time recovery) | **7 days** | our only free "undo"; shorter than Paid's 30d |
| Cron Triggers / account | **5** (included on Free) | we can afford one daily prune cron |

Two concrete harms from "keep forever":

1. **Query slowness.** Admin dashboards scan `audit_log` (`action='realtime.reject'`,
   `index.ts:5035`) and `usage_events` with `ts > now()-24h` GROUP BYs. These ride the
   `ts DESC` indexes, but the tables and indexes still grow without bound; vacuum/scan
   cost and storage climb monotonically.
2. **The backup loads the whole DB into memory.** `GET /v1/admin/backup`
   (`worker/src/index.ts:4517`) enumerates every table from `sqlite_master` and does
   `SELECT * FROM "<name>"` into a single in-memory JSON object
   (`tables[name] = results`), then `JSON.stringify(..., null, 2)`. The code itself
   admits "we build it in memory; revisit if the row count ever explodes" (`index.ts:4516`).
   The same shape is what the weekly CI `.sql` export dumps. As `usage_events` /
   `audit_log` grow into the hundreds of thousands of rows this **OOMs the isolate**
   (Workers have a 128 MB memory ceiling) and burns the 5M/day **read** budget in one run.

Pruning fixes both: it caps table size (storage + scan cost) and caps what the backup
has to load.

---

## 1. The tables in scope

| Table | Source | What it's for | Grows on |
| --- | --- | --- | --- |
| `usage_events` | `schema/0028_usage_events.sql`, written by `logUsageEvent` (`worker/src/usage.ts:98`) | one row per **billable** Gemini/Deepgram call, `est_cost_usd` stamped at write-time; powers the admin cost dashboard | every AI translate/chatbot/summarize + every STT session |
| `audit_log` | `schema/0005_audit_log.sql`, written by `logAudit` (many call sites, e.g. `index.ts:2458`) | every admin mutation (user/role/meeting/project) for security + compliance | every admin action |
| `audit_log` rows with `action='realtime.reject'` | written by `logAudit`, read at `index.ts:5035` | realtime join rejections (denied / revoked / finished / room_full) for the live ops panel; reason lives in `meta` JSON, **no separate table** | every rejected room join |
| `owner_audit` | `schema/0030_owner_audit.sql` | Owner (dev super-admin) content-access trail; "even the Owner leaves a trace" — clean-hands evidence | every `owner.open_content` |
| `meeting_knock` | `schema/0025_meeting_knock.sql` | waiting-room knock state per (room, guest); `last_seen` bumped on re-knock/poll | every external guest knock/poll |
| `deleted_meeting` (tombstones) | `schema/0015_p0_parity.sql:15`, checked by `meetingIsDeleted` (`index.ts:496`) | proves a roomId was permanently deleted so a stray scene/file PUT can't **resurrect** it | every permanent meeting delete |

> Note: `realtime.reject` is **not its own table** — it is a subset of `audit_log`.
> Pruning `audit_log` by age automatically prunes reject rows. We still call it out
> below because the PM asked, and because reject rows are high-volume/low-value and a
> case can be made to age them out *faster* than the rest of `audit_log` (see §3).

---

## 2. Recommended retention windows (defaults)

| Table | Retention default | Rationale |
| --- | --- | --- |
| `usage_events` | **400 days** | covers a full 13-month billing/audit cycle (12 monthly rollups + 1 month slack) so year-over-year cost comparisons survive. Rollups (below) let us keep the *aggregate* forever while dropping raw rows. |
| `audit_log` (incl. `realtime.reject`) | **180 days** | 6 months of admin-action history — enough for internal security review; older actions have near-zero operational value. |
| `audit_log` `realtime.reject` rows (optional faster tier) | **30 days** | the live panel only queries the last 24h (`index.ts:5031`); these are pure noise after a month. Optional — only adopt if `audit_log` volume is reject-dominated. |
| `owner_audit` | **keep ≥ 365 days (default 730)** | this is a *protective* evidence trail for the Owner, required once Canvas M goes external/multi-national (`0030_owner_audit.sql` header). Prune conservatively or not at all; volume is tiny. **PM decision.** |
| `meeting_knock` | **30 days** | knock state is ephemeral; the re-knock cooldown is 30s. After a meeting ends the rows are dead weight. Archived into the per-project archive at delete-time anyway (`index.ts:4597`), so pruning live rows loses nothing. |
| `deleted_meeting` (tombstones) | **KEEP FOREVER — never prune** | see §4. |

These are **defaults**, tunable from one place (see §5 config).

---

## 3. Confirm: realtime.reject rows

Confirmed against code: there is **no `realtime_reject` table**. Rejections are written
as `audit_log` rows with `action = 'realtime.reject'` and `{ reason }` inside `meta`,
and read back with a `json_extract(meta,'$.reason')` GROUP BY over the last 24h
(`worker/src/index.ts:5032-5039`). Therefore:

- Pruning `audit_log` by `ts` (default 180d) covers reject rows automatically.
- If reject rows dominate `audit_log` growth, add a **second, tighter** prune pass for
  just that `action` (30d). It is the same DELETE with an extra `AND action='realtime.reject'`.

---

## 4. Tombstones (`deleted_meeting`) — MUST be kept

**Confirmed: do NOT prune `deleted_meeting`.** The table is the resurrection guard.
`meetingIsDeleted` (`index.ts:496`) does `SELECT 1 FROM deleted_meeting WHERE id=?1`, and
the upsert/PUT paths refuse to write if a tombstone exists (`index.ts:4836`,
"deleted stays deleted"). If a tombstone is pruned, a delayed/retried client blob PUT
(scene/file/chat) for that old roomId would **recreate the meeting**. The rows are tiny
(`id, deleted_by, deleted_at` — `0015_p0_parity.sql:15`) and bounded by the number of
meetings ever deleted, so they cost almost nothing. **Never include this table in any
prune job.** Encode that as an explicit deny-list constant in the prune code so a future
"prune everything" refactor can't sweep it up.

---

## 5. Pruning mechanism

### 5.1 Where it runs — a daily Cron Trigger (new `scheduled()` handler)

Today the Worker exports only `fetch` (`worker/src/index.ts:6323`); there is **no
`scheduled()` handler**. Add one. Free plan includes **5 Cron Triggers/account**, so a
daily prune is free.

`wrangler.jsonc`:
```jsonc
"triggers": { "crons": ["17 3 * * *"] }   // 03:17 UTC daily, off-peak, jittered minute
```

Daily (not "extend the Sunday backup cron") is the better choice because:
- It keeps each run **small** — one day's growth, not a week's — so a single prune never
  approaches the 100K-writes/day budget or risks a long-running statement.
- It is **independent of the backup**: the backup should run *after* pruning so it never
  loads soon-to-be-deleted rows. If you prefer a single cron, run prune → backup in the
  same `scheduled()` invocation (prune first).

> Do **not** put pruning inside `GET /v1/admin/backup` — that route is the very thing
> that OOMs; pruning must happen *before* and *independently* of it.

### 5.2 How it deletes — batched, budget-aware DELETEs

A naive `DELETE FROM usage_events WHERE ts < ?` can touch arbitrarily many rows in one
statement, count as that many **writes** against the 100K/day free cap, and risk the 30s
statement ceiling. Instead, loop in **bounded batches** using SQLite's `LIMIT` on DELETE
(D1 supports `DELETE ... WHERE ... ORDER BY ... LIMIT n` via the underlying SQLite):

```sql
DELETE FROM usage_events
 WHERE ts < ?1            -- cutoff = now() - retentionDays*86400_000
 LIMIT ?2;                -- BATCH = 500
```

Driver loop (pseudocode, runs in `scheduled()`):
```ts
const BATCH = 500;            // rows per statement
const MAX_BATCHES = 40;       // hard cap per table per run → ≤20k writes/table/run
const MAX_TOTAL_WRITES = 80_000; // stay under the 100k/day free write cap
for (const t of PRUNE_TABLES) {          // never includes deleted_meeting
  const cutoff = now() - t.retentionDays * 86_400_000;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await env.DB.prepare(t.deleteSql).bind(cutoff, BATCH).run();
    const n = r.meta.changes ?? 0;        // D1 returns rows changed
    totalWrites += n;
    if (n < BATCH || totalWrites >= MAX_TOTAL_WRITES) break; // caught up / budget hit
  }
}
```

Why these numbers:
- `BATCH=500` keeps each statement tiny (well under the 100 KB / 30s limits) and each
  DELETE far below the 100-bound-param limit (we bind only `cutoff` + `LIMIT`, 2 params).
- `MAX_BATCHES`/`MAX_TOTAL_WRITES` cap a single run so a first-ever prune over a huge
  backlog **can't blow the 100K writes/day cap or the 50-queries-per-invocation limit**;
  leftover rows are mopped up by tomorrow's run (steady state, daily growth ≪ batch caps).
- Pruning by the indexed `ts` column means each DELETE walks the existing
  `ix_audit_ts` / `idx_usage_ts` (`0005`/`0028`) — no full-table scan.

### 5.3 First-ever run / backfill

The very first prune may face a large backlog. The batch caps make it **self-throttling**:
it deletes up to ~20K rows/table/run and finishes the backlog over a few nights. No manual
intervention; no risk of tripping the free write cap. (If you want it gone immediately, an
admin can run the same DELETEs via `wrangler d1 execute` ad hoc — but the cron will get there.)

### 5.4 Safety
- **Time Travel (7 days, free)** is the undo for a mis-set retention window — a too-short
  default is recoverable for a week. Set windows conservatively first, tighten later.
- The prune job must be **best-effort and never throw** (mirror `logUsageEvent`'s
  swallow-and-continue, `usage.ts:131`): a prune failure must not wedge the cron or the backup.
- Log one `audit_log` row per run (`action='admin.prune'`, `meta={ perTable counts }`)
  so the PM can see what was trimmed — and so prune activity is itself auditable.
  (This is self-limiting: one row/day.)

---

## 6. Keep the aggregate, drop the raw (usage_events rollups)

So that pruning `usage_events` at 400d never loses **billing history**, add a tiny
monthly rollup *before* the prune cutoff bites:

```sql
CREATE TABLE IF NOT EXISTS usage_rollup_monthly (
  month       TEXT NOT NULL,   -- 'YYYY-MM'
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  calls       INTEGER NOT NULL,
  tokens_in   INTEGER NOT NULL,
  tokens_out  INTEGER NOT NULL,
  seconds     REAL    NOT NULL,
  est_cost_usd REAL   NOT NULL,
  PRIMARY KEY (month, provider, kind)
);
```

The daily cron upserts the current month's SUM/COUNT (cheap, indexed by `ts`). Rollup
rows are kept **forever** (a few rows/month). Then raw `usage_events` can be pruned at
400d with zero loss of the numbers the cost dashboard actually reports. This is optional
for v1 but recommended before the first prune deletes any billing-relevant rows.

---

## 7. Retention decisions for the PM

Defaults proposed — change any number and the prune job follows (single config block):

| # | Table | Proposed default | Keep this? Or change to… |
| --- | --- | --- | --- |
| 1 | `usage_events` (raw billable rows) | **400 days** | |
| 2 | `usage_rollup_monthly` (aggregate) | **forever** | (recommend building first; §6) |
| 3 | `audit_log` (admin actions) | **180 days** | |
| 4 | `audit_log` `realtime.reject` subset | same 180d, or faster **30 days** | adopt faster tier? Y/N |
| 5 | `owner_audit` | **730 days** (≥365 min) | external-customer/legal driven — your call |
| 6 | `meeting_knock` | **30 days** | |
| 7 | `deleted_meeting` (tombstones) | **KEEP FOREVER (never prune)** | confirmed — do not change |

Operational defaults (engineering, not PM): daily cron `17 3 * * *`, batch 500,
≤20K rows/table/run, ≤80K writes/run, prune runs **before** the backup.

---

## 8. Implementation checklist (for the dev team)

1. Add `usage_rollup_monthly` migration (`schema/0031_usage_rollup.sql`) + daily upsert. *(optional v1, recommended)*
2. Add a `scheduled()` handler to the default export (`worker/src/index.ts:6323`) — or a
   small `prune.ts` it calls — with the batched loop in §5.2 and the **deny-list**
   (`PRUNE_TABLES` MUST NOT contain `deleted_meeting`).
3. Add `"triggers": { "crons": ["17 3 * * *"] }` to `worker/wrangler.jsonc`.
4. Centralise the windows in one `RETENTION_DAYS` constant block (the §7 table).
5. Order the cron: rollup → prune → (optional) backup, each best-effort/non-throwing.
6. Emit one `audit_log` `admin.prune` summary row per run.
7. Confirm DELETEs hit `ix_audit_ts` / `idx_usage_ts` / `ix_knock_room`+ts via `EXPLAIN QUERY PLAN`.
