# Daily.co usage in the Admin Console

Status: design / research only (2026-06-17). No code changed — the worker is being
edited in parallel. This doc grounds every Daily API claim in the real docs (URLs
cited inline) because earlier Daily details were fabricated and corrected twice.

Goal: an admin panel that reflects/manages **Daily.co media usage** (participant-
minutes, active rooms, recording usage, estimated cost) next to the existing AI &
Cost monitoring.

---

## 1. Verified Daily REST API (what is REALLY exposed)

Base URL: `https://api.daily.co/v1`. Auth: `Authorization: Bearer <DAILY_API_KEY>`
(already used in `worker/src/index.ts`, const `DAILY_API`).

There is **NO dedicated `/usage` or `/billing` endpoint.** I checked
`https://docs.daily.co/llms.txt` (the doc index) — the usage-relevant endpoints are
`/meetings`, `/rooms`, `/recordings`, `/presence`, and `/logs`. "Usage" must be
**aggregated by us** from `/meetings` (history) and `/presence` (live). This is the
single most important correction: do not claim a Daily usage/analytics endpoint.

### 1a. `GET /meetings` — session history (the backbone of usage)
Source: https://docs.daily.co/reference/rest-api/meetings/list-meetings.md

Query params (all verified): `room`, `timeframe_start` (int unix), `timeframe_end`
(int unix), `limit` (int), `starting_after` (string, cursor), `ending_before`
(string, cursor), `ongoing` (bool), `no_participants` (bool).
- Default/max `limit`: **unverified** (not stated in docs). Treat as paginated; use
  cursors `starting_after` / `ending_before`.

Response: `{ total_count: int, data: [ meeting ] }`. Each meeting:
- `id` (string) — meeting session id
- `room` (string) — room name
- `start_time` (int) — unix ts
- `duration` (int) — **seconds**
- `ongoing` (bool)
- `max_participants` (int) — peak simultaneous participants
- `participants` (array), each: `user_id` (string|null), `participant_id`
  (string), `user_name` (string|null), `join_time` (int unix), `duration` (int
  **seconds**).

**Participant-minutes** are therefore derivable (Daily does not hand them to us
pre-summed): `participant_minutes = Σ over meetings Σ over participants
(participant.duration / 60)`. Call-minutes (room-occupied minutes) =
`Σ meeting.duration / 60`. Both are computed by us, not returned as a field.

### 1b. `GET /presence` — live, domain-wide
Source: https://docs.daily.co/reference/rest-api/presence (verified domain-wide form
exists; the room-scoped `GET /rooms/{name}/presence` also exists:
https://docs.daily.co/reference/rest-api/rooms/get-room-presence.md)

Returns an object **keyed by room name**, each value an array of present
participants: `{ "<room>": [ { room, id, userId, userName, mtgSessionId, joinTime,
duration } ] }`. "Returns all active participants the requestor can see, grouped by
room."
- `total_count` on the **domain-wide** response: **unverified** (the room-scoped
  variant documents `total_count`; the domain-wide example shows the keyed object
  without it). MVP: compute active-room count = number of keys with a non-empty
  array; live participants = sum of array lengths. Don't rely on a `total_count`.

This is how we get **active rooms** and **live participant count** — NOT from
`/rooms`.

### 1c. `GET /rooms` — room inventory (NOT activity)
Source: https://docs.daily.co/reference/rest-api/rooms/list-rooms.md

Query: `limit`, `ending_before`, `starting_after`. Response `{ total_count, data:
[ { id, name, api_created, privacy, url, created_at, config } ] }`.
- **Verified: `/rooms` does NOT indicate which rooms are active / have
  participants** — it's static metadata only. Use `/presence` for "active". Use
  `/rooms` only for "total rooms provisioned on the Daily account" (orphan-cleanup
  signal, since `deleteDailyRoom` already exists in the worker).

### 1d. `GET /recordings` — recording inventory
Source: https://docs.daily.co/reference/rest-api/recordings/list-recordings.md

Query: `limit`, `ending_before`, `starting_after`, `room_name`. Response `{
total_count, data: [ recording ] }`. Recording fields verified: `id`, `start_ts`
(int), `status` (string), `max_participants` (int), `duration` (int, present on
finished recordings), `share_token`, `s3key`, `mtgSessionId`.
- `duration` **unit (sec vs ms): unverified** — docs show the field in examples but
  don't state units. Treat as seconds (consistent with `/meetings`) and label the
  estimate "approx" until confirmed against a real recording.
- **No storage-size / bytes field is documented.** We cannot report GB of recording
  storage from this endpoint. Recording-minutes = `Σ recording.duration / 60`;
  storage cost is estimated from minutes (see pricing 1f), not bytes.
- Daily exposes `recording.type` values `local | cloud | cloud-audio-only |
  raw-tracks` (overview page). MCM currently does no recording (Phase 5 / B-item),
  so this panel section ships **empty/stub** until recording lands.

### 1e. `GET /logs` — NOT billing
Source: https://docs.daily.co/reference/rest-api/logs/list-logs.md

`includeLogs`/`includeMetrics` params, requires `userSessionId` or `mtgSessionId`.
Returns app/session logs (`time`, `message`, `level`, `code`, `peerId`, …). **Not a
usage/billing source** — ignore for this panel.

### 1f. Pricing (for the ESTIMATE only — invoice is authoritative)
Source: https://www.daily.co/pricing/video-sdk/ (figures as listed 2026-06-17;
volume discounts apply, so these are the **list/high-end** rates):
- Video+audio call: **$0.0015–$0.004 per participant-minute** (volume-tiered).
- Audio-only call: **$0.00036–$0.00099 per participant-minute**.
- Cloud video recording: **$0.01349 per recorded minute**.
- Cloud audio-only recording: **$0.005 per recorded minute**.
- Recording storage: **$0.003 per recorded minute** (stated per-minute, NOT
  per-GB — a per-GB rate is **unverified / not published**).
- Free allocation: **10,000 free minutes / month**.

MCM uses Daily for **audio + screenshare only** (webcam stays off — see room props
in §4), so the relevant call rate is closer to the audio-only tier, but screenshare
is a video track. **Which tier MCM actually bills at is unverified** — pick the
audio-only rate as the floor and the $0.004 video rate as the ceiling, and show a
**range**, or make the rate a worker constant the admin can tune. Mark the whole
number "estimate".

### 1g. Rate limits — UNVERIFIED
Daily's REST rate limits are **not documented** on the pages fetched. Treat as
unknown and be conservative: do NOT call `/meetings` (paginated, potentially large)
on every admin page load. Cache server-side (see §3 refresh model). `/presence` is
described as "quick" but still must not be polled tightly.

---

## 2. Existing pattern we mirror

- Worker, `worker/src/index.ts`:
  - `GET /v1/admin/cost` (~L4759) — raw measurable usage; returns `{ usage:{
    meetings, projects, storage_bytes, meeting_minutes, recording_minutes:0,
    ai_calls }, ai_cost_breakdown, cost_estimate_usd }`. Note it already reserves
    `recording_minutes: 0  // tracked once Phase 5 recording lands`.
  - `GET /v1/admin/usage` (~L4852) — summary (`by_provider`, `by_kind`),
    `daily_trend` (30-day, grouped by UTC day from `usage_events.ts`), paginated
    `recent`. Best-effort: missing `usage_events` table → empty shape, never 500.
- Pricing constants + metering: `worker/src/usage.ts` —
  `GEMINI_*`, `DEEPGRAM_STT_USD_PER_MINUTE`, `logUsageEvent(db, provider, kind,
  tokens_in, tokens_out, seconds, est_cost_usd, meeting_id, email)` writes one
  `usage_events` row, never throws.
- Client: `excalidraw-app/data/admin.ts` — `getAdminCost()` (unwraps `.usage`),
  `getAdminUsage()` returns `AdminResult<AdminUsage>` (dev falls back to
  `MOCK_USAGE`), all via `fetchWithAuth`.
- UI: `excalidraw-app/components/mcm/AdminConsole.tsx` — separate `cost` and `usage`
  tabs, loaded lazily per `tab ===` (L603/L605). There is already a `recordings`
  tab scaffold (L1079).
- Daily server calls already in the worker: token mint + room create at
  `GET /v1/daily/token` (L3620, `DAILY_API` const L3618), room create with props at
  L3687, and `deleteDailyRoom` (L4391). `DAILY_API_KEY` is a server secret
  (`Bindings.DAILY_API_KEY`, L61).

---

## 3. Recommended approach: **(c) Hybrid**

Three options were on the table:

- **(a) Live proxy** of `/meetings`+`/presence` on each admin load. Pro: zero
  schema work, always current. Con: `/meetings` is paginated and unbounded over
  time; un-cached it risks Daily rate limits (which are **unverified**) and slow
  admin loads.
- **(b) Self-meter into `usage_events`** at meeting-end / via Daily webhooks
  (`provider='daily'`). Pro: matches our AI cost model exactly, cheap to read, gives
  history + 30-day trend for free, no Daily call on admin load. Con: needs a
  capture hook; MCM has no reliable "meeting end" yet and webhooks need a public
  endpoint.

**Recommend (c) hybrid:**
1. **Live, cached pull** for the *current snapshot* — active rooms + live
   participants from `GET /presence`, and "today's" participant-minutes from
   `GET /meetings?timeframe_start=<00:00 UTC>`. Cache the result in Worker memory
   or KV for **60–120 s** so repeated admin loads don't hammer Daily (respects the
   unverified rate limit). This is the MVP and needs no DB migration.
2. **Self-metering for history** (phase 2): on meeting finalize (the same place
   that already calls `deleteDailyRoom` / finishes a meeting), pull that room's
   `/meetings?room=<id>` once, sum participant-minutes + recording-minutes, and
   write a `usage_events` row with `provider='daily'`, `kind='media'` (or
   `'recording'`), `seconds=<participant-seconds>`, `est_cost_usd=<computed>`. Then
   the existing `/v1/admin/usage` trend/`by_provider` automatically includes Daily
   — **no new aggregation code**, and `getAdminCost`'s reserved `recording_minutes`
   gets real numbers. This also means cost survives even if a room is later deleted.

Rationale: (a) alone can't give history cheaply and is rate-limit-exposed; (b) alone
can't show *live* active rooms; together the live tile comes from `/presence`
(cheap) and the spend trend comes from our own `usage_events` (the proven pattern).

---

## 4. Cost-control levers (set at room creation)

Rooms are created in **`worker/src/index.ts` at the `POST ${DAILY_API}/rooms` call
inside `GET /v1/daily/token` (~L3687)**. Today it sets `enable_screenshare`,
`start_video_off: true`, `start_audio_off: true`. To cap spend, also set in
`properties` (these reduce billable participant-minutes — the lever the panel
should surface):
- `exp` (unix ts) — room auto-expiry, so abandoned rooms stop accruing minutes.
  Tie to the meeting's scheduled end (B5).
- `max_participants` — hard cap on simultaneous participants → caps peak
  participant-minutes.
- `start_video_off: true` (already set) — keeps MCM on the cheaper audio path.
- `eject_at_room_exp` / `eject_after_elapsed` — force-disconnect at expiry so
  minutes truly stop.

(Property names `exp`, `max_participants`, `start_video_off`, `enable_screenshare`
are the verified ones already in use; `eject_*` are Daily room props but their exact
names should be confirmed against
https://docs.daily.co/reference/rest-api/rooms/config before relying on them —
marked here as **to-confirm**.) The panel should show "rooms missing `exp`" as a
cost warning, mirroring the orphan-room cleanup intent of `deleteDailyRoom`.

---

## 5. Panel design

**Placement:** a new **"Media / Daily" card inside the existing `cost` (AI & Cost)
tab**, not a separate top-level tab — it's a cost concern and sits naturally beside
the AI cost breakdown. (The empty `recordings` tab stays separate for the recording
list itself.)

Tiles / sections:
1. **Live now** (from `/presence`, cached 60–120 s): Active rooms count, Live
   participants count. Small "as of <time>" caption.
2. **This month** (from `usage_events` provider='daily' once metering lands; until
   then a one-shot `/meetings` pull for the month): Participant-minutes, Call-minutes
   (room-minutes), Recording-minutes (stub/0 until Phase 5).
3. **Estimated cost** (range): `participant_minutes × rate`, shown as a low→high
   band using the audio-only floor and $0.004 ceiling (§1f), plus the
   `10,000 free min/month` allowance subtracted. Label **"estimate — see Daily
   dashboard for invoice"** with a link to Daily's billing, exactly like the AI tab
   links to provider consoles.
4. **Cost-control health**: count of rooms without `exp` set (warning), total rooms
   provisioned (`/rooms total_count`) vs deletable.

All numbers labelled "estimate" and the free-minute caveat shown. Mirror
`AdminResult` so the card distinguishes 403/load-fail from genuinely-empty.

---

## 6. Worker endpoint + exact Daily calls

New: **`GET /v1/admin/daily`** (mirrors `/v1/admin/cost` shape, best-effort, never
500; returns a zeroed shape if `DAILY_API_KEY` missing — like the all-zero AI
fallback).

```
GET /v1/admin/daily
-> 200 {
  configured: boolean,            // !!DAILY_API_KEY
  live: { active_rooms, live_participants, as_of },   // from /presence
  month: { participant_minutes, call_minutes, recording_minutes },
  rooms: { total, missing_exp },  // from /rooms
  cost_estimate_usd: { low, high }, // computed, free-tier subtracted
  rates: { participant_min_low, participant_min_high, rec_video_min,
           rec_storage_min, free_minutes },           // echo §1f for transparency
  unverified: ["rate_limits","recording_duration_unit","billing_tier"]
}
```

Worker-side Daily calls (server, `DAILY_API` const, Bearer `DAILY_API_KEY`):
```ts
// live
GET `${DAILY_API}/presence`
  // active_rooms = Object.keys(json).filter(r => json[r].length).length
  // live_participants = Σ json[r].length

// month-to-date (cache ≥60s; paginate via starting_after until data shorter than limit)
GET `${DAILY_API}/meetings?timeframe_start=${startOfMonthUnix}&limit=100`
  // call_minutes        = Σ data[].duration / 60
  // participant_minutes = Σ data[].participants[].duration / 60

// inventory
GET `${DAILY_API}/rooms?limit=100`            // total, missing_exp (config.exp absent)

// recordings (stub until Phase 5)
GET `${DAILY_API}/recordings?limit=100`       // recording_minutes = Σ data[].duration/60
```
Add a Daily-pricing block to `worker/src/usage.ts` next to the Gemini/Deepgram
constants (e.g. `DAILY_PARTICIPANT_MIN_USD_LOW/HIGH`, `DAILY_REC_VIDEO_MIN_USD`,
`DAILY_FREE_MINUTES`) so cost math has one source of truth, same as AI rates.

Client: add `getAdminDaily(): Promise<AdminResult<AdminDaily>>` in
`excalidraw-app/data/admin.ts` (copy `getAdminUsage`, `fetchWithAuth`, dev mock),
render in the `cost` tab card.

---

## 7. MVP (smallest shippable)

1. Worker: `GET /v1/admin/daily` calling **only `/presence` + `/rooms`** (both
   cheap, non-paginated-or-small), server-side cache 60 s. Returns `live` +
   `rooms` + `configured`. No DB change.
2. Add Daily pricing constants to `worker/src/usage.ts`; compute a coarse cost
   range from a single `/meetings?timeframe_start=<month>` pull (cached), shown as
   "estimate (range)".
3. Client `getAdminDaily()` + a "Media / Daily" card in the `cost` tab: Active
   rooms, Live participants, Rooms provisioned, This-month participant-minutes,
   Estimated cost range, free-tier note, link to Daily dashboard.
4. Phase 2 (after recording / reliable meeting-end lands): self-meter into
   `usage_events` (`provider='daily'`) so it flows into the existing
   `/v1/admin/usage` trend automatically, and wire `exp` + `max_participants` into
   the room-create props at L3687.

---

## 8. Could NOT verify (do not invent)

- No Daily `/usage` or `/billing` aggregate endpoint exists (confirmed absent in
  `llms.txt`). Participant-minutes must be summed by us.
- REST API **rate limits** — not documented anywhere fetched. Cache conservatively.
- `/meetings` and `/rooms` **default/max `limit`** — not stated. Paginate.
- Recording **`duration` unit** (sec vs ms) and any **storage-bytes** field — not
  documented; storage is priced per-minute, no per-GB rate published.
- Which **billing tier / exact per-minute rate** MCM lands at (audio-only vs video
  because of screenshare) — show a range, not a single number.
- `eject_at_room_exp` / `eject_after_elapsed` exact property names — confirm against
  the rooms `config` reference before use.
- Domain-wide `/presence` `total_count` presence — derive counts from the keyed
  object instead.
