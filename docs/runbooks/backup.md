# Backup & Restore Runbook — Canvas M

Plain-language plan for keeping Canvas M data safe and getting it back. Three
data stores, each with its own backup + restore path. None of this requires a
deploy.

---

## The three data stores

| Store | What's in it | Backup strategy |
| --- | --- | --- |
| **D1** (`mcm-db`) | All metadata: projects, meetings, members, invitees, participants, knocks, notes, settings, audit log | (1) Weekly `.sql` export → R2 `backups/` (CI). (2) On-demand JSON dump (admin Backup button). (3) Cloudflare **Time Travel** — 30-day in-place rewind, automatic. |
| **R2 small blobs** (`mcm-storage`) | Scene drawings, library files, chats, transcripts (per meeting) | (1) **Soft-delete**: a deleted meeting's blobs are moved to `trash/<timestamp>/...` instead of being erased (recoverable). (2) On-demand **project archive** download (admin, base64 in JSON) before deleting a project. |
| **R2 HEAVY blobs** (`mcm-storage/recordings/`, Phase 5) | Meeting recordings (large media) | **No 2× duplication.** Rely on R2's own durability + soft-delete + an **Infrequent-Access** storage tier + a **lifecycle retention** rule. Download a *specific* recording offline if/when one matters — never bulk-copy them all. |
| **Supabase** (auth) | User identities / logins | **Managed by Supabase** — automatic daily backups + PITR on their side. Nothing for us to run. |

Why recordings are treated differently: a single recording can be hundreds of
MB. Base64-ing all of them into a JSON archive (or duplicating the whole prefix)
would be wasteful and could OOM the worker. R2 is already redundant; we add a
retention/IA-tier policy and pull individual files on demand.

---

## How to: Backup the database (on demand)

Admin Console → **Backup DB** (calls `GET /v1/admin/backup`). Downloads
`canvasm-db-backup-<date>.json` — a full dump of every D1 table as
`{ generated_at, tables: { <table>: rows[] } }`. Metadata only (small); it does
**not** contain blob bytes.

The same export happens automatically every week via CI (see "The cron" below)
and lands as a `.sql` file in R2 `backups/`.

## How to: Archive & delete a project

When a project is finished and you want it off the platform but **restorable**:

1. Admin Console → on the project → **Archive** (calls
   `GET /v1/admin/projects/:id/archive`). Downloads
   `canvasm-project-<id>-<date>.json` — the project row, all its meetings, each
   meeting's D1 rows (invitees / participants / knocks / notes), and the R2 blob
   **contents** (scenes / files / chats / library / transcripts), base64-encoded.
   - Blobs larger than **8 MB** are listed but **not** embedded (flagged
     `skipped: true` with their key + size) so the archive can't balloon. Pull
     those individually if needed.
   - **Recordings are excluded** by design (see the table above).
2. **Keep that JSON file somewhere safe** (it is the only off-platform copy).
3. Then **Delete** the project (calls the existing
   `DELETE /v1/admin/projects/:id`). This cascades: each meeting's blobs are
   **soft-deleted to `trash/<timestamp>/...`** (not erased), D1 rows removed,
   meetings tombstoned. Recoverable from `trash/` until the lifecycle rule
   expires it.

## The cron (Cloudflare Cron Trigger — all-Cloudflare, no GitHub)

The weekly backup runs **inside the Worker itself** via a Cloudflare Cron
Trigger — no GitHub Action, no external runner, no machine to keep on.

- **Schedule:** `"0 3 * * 0"` (every Sunday 03:00 UTC), set in
  `worker/wrangler.jsonc` → `triggers.crons`.
- **What runs:** the `scheduled()` handler in `worker/src/index.ts` dumps every
  D1 data table and writes `backups/db-<date>.json` to R2 (`mcm-storage`).
- **Nothing to configure** — it uses the Worker's own `DB` + `BUCKET` bindings.
  No API token / account-id secret needed (that was the old GitHub-Action way).
- **Change cadence:** edit the cron string and redeploy — e.g. `"0 3 * * *"`
  (daily), `"0 3 */3 * *"` (every 3rd day).
- **Check it ran:** `npx wrangler tail mcm-storage` shows `[cron backup] wrote
  backups/db-<date>.json`, or list the prefix:
  `npx wrangler r2 object get mcm-storage/backups/ --remote` (dashboard: R2 →
  mcm-storage → backups/).

> Note: the scheduled handler writes a **JSON** dump (same shape as the
> Backup-DB button). A `.sql` dump is only produced by the manual
> `wrangler d1 export` path below — both restore the same data.

Set a lifecycle rule on the R2 `backups/` prefix (dashboard) to retain ~90 days.

---

## How to: RESTORE

### Restore the whole database (from a `.sql` export)

The `.sql` file from CI (R2 `backups/`) is a complete schema + data dump.

```bash
# 1. Pull a backup out of R2
npx wrangler r2 object get mcm-storage/backups/db-<date>.sql --file=restore.sql --remote

# 2. Re-import. For a clean restore, import into a fresh/empty DB to avoid
#    PRIMARY KEY collisions, then point the binding at it (or restore in place
#    only if you know the target is empty).
npx wrangler d1 execute mcm-db --remote --file=restore.sql
```

### Rewind recent damage (Time Travel — fastest, no files)

Cloudflare keeps 30 days of D1 history. To undo a bad migration / mass delete:

```bash
npx wrangler d1 time-travel info mcm-db --remote      # find a bookmark/timestamp
npx wrangler d1 time-travel restore mcm-db --remote --bookmark <bookmark>
```

No `.sql` file needed — this is the first thing to try for "we broke the DB an
hour ago."

### Re-create a project (from a project archive JSON)

The `canvasm-project-<id>-<date>.json` is self-contained. To restore:

1. Re-insert the `project` row and each `meetings[].meeting` row into D1.
2. Re-insert each meeting's `invitees` / `participants` / `knocks` / `notes`.
3. For each `blobs[]` entry that has `data` (not `skipped`), base64-decode it and
   `PUT` it back to its `key` in R2 (`scenes/...`, `files/...`, etc.).
4. `skipped` blobs (>8 MB) and any recordings must be restored from their own
   copy (or recovered from `trash/<ts>/<key>` if the delete is recent).

> A small restore script that reads the archive JSON and replays steps 1–3 is
> the natural next tool here; until then it's a manual replay. The archive format
> is deliberately flat so it's easy to script.

### Recover a soft-deleted meeting blob (from `trash/`)

A deleted meeting's blobs live at `trash/<timestamp>/<original-key>`. List and
copy one back:

```bash
npx wrangler r2 object get "mcm-storage/trash/<ts>/scenes/<roomId>/current" --file=scene --remote
npx wrangler r2 object put  "mcm-storage/scenes/<roomId>/current" --file=scene --remote
```

(The D1 meeting row was tombstoned on delete; recovering blobs alone won't
un-delete the meeting — pair this with a metadata restore if you need the
meeting back in the app.)
