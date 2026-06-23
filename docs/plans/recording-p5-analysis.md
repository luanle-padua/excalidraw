# Phase 5 — Meeting Recording: build brief (analysis + decisions)

> **Trạng thái:** ACTIONABLE BUILD BRIEF (2026-06-23). Mục tiêu: đội build chiều
> nay implement được MVP recording. Trả lời 4 câu của owner anh Luân:
> **record CÁI GÌ · lưu Ở ĐÂU · lưu THẾ NÀO · có TẢI được không.**
>
> Đây là bản **build brief** đi kèm spec thiết kế đã có. KHÔNG lặp lại spec —
> mọi phần "tại sao" nằm ở **`docs/specs/video-and-recording.md`** (§3 RECORDING),
> doc này là phần **"làm gì, theo thứ tự, file nào, line nào"** + xác nhận
> Daily API thật. Cross-ref: `docs/plans/roadmap.md` Phase 5 (L114-121),
> `docs/specs/infrastructure.md` (stack thật), `docs/runbooks/backup.md`
> (R2 = HEAVY data, IA-tier + lifecycle).
>
> CONSTRAINT của task này: **docs only** — KHÔNG có code/migration thật, chỉ
> propose SQL inline. Đội build chiều nay biến brief này thành code.

---

## 0. TL;DR — quyết định MVP (decision-grade)

| Câu của owner | Quyết định MVP |
|---|---|
| **Record CÁI GÌ** | **Daily cloud recording** = A/V + screen share, **1 file MP4 composited**. Canvas/transcript/chat **KHÔNG re-record** — đã persist sẵn, chỉ **link** vào review-mode. Canvas-replay = Phase sau (differentiator). |
| **Lưu Ở ĐÂU** | Daily ghi vào **S3 của Daily** (không ghi thẳng R2). Webhook `recording.ready-to-download` → **Worker copy file về R2 PRIVATE** `recordings/<meetingId>/<recordingId>.mp4`; index trong **D1 bảng `recording`** (migration **`0035`**). |
| **Lưu THẾ NÀO** | Worker `fetch(download_link)` → `BUCKET.put(...)` (egress-free R2), insert D1 row, rồi **DELETE bản Daily-side** (khỏi trả phí 2 chỗ). R2 **IA-tier + lifecycle retention** trên prefix `recordings/`. |
| **Có TẢI được không** | **CÓ** — nhưng **KHÔNG link công khai**. Route Worker auth-gated `GET /v1/recordings/:id` (verify JWT + `canSeeMeeting` + host/organizer/admin) → **stream từ R2** (`new Response(obj.body)`). Surface trong **review-mode** của cuộc họp đã xong (play `<video>` + nút Download). |

**Câu chốt một dòng:** ship **Daily cloud recording → webhook → R2 private →
auth-gated review-mode playback**, host-only start/stop, consent banner cho cả
phòng. Đúng như roadmap Phase 5 đã vạch (L118-121) + spec §3.3 pipeline.

---

## 1. Record CÁI GÌ — options + đề xuất MVP

Spec `video-and-recording.md` §3.1 đã liệt kê 3 option (a/b/c) và chốt **(c)
hybrid, ship (a) trước**. Doc này giữ nguyên quyết định đó và làm rõ "MVP ghi gì,
reference gì":

### MVP GHI (record mới):
- **(a) Daily cloud recording** — `type: "cloud"`, layout composited 1 file MP4:
  audio (mic) + camera (nếu bật) + **screen share** đều nằm trong file đó.
  Đây là artefact "xem lại được" duy nhất phải tạo mới.

### MVP REFERENCE (đã có sẵn, chỉ LINK — không record lại):
- **Canvas** — scene Excalidraw đã autosave E2E vào R2 `scenes/<roomId>/current`
  (index.ts:1374), immutable khi `finished`. Review-mode mở scene read-only sẵn.
- **Transcript + Chat** — E2E blob R2 `transcripts/<roomId>/current` (index.ts:1431),
  `chats/<roomId>/current` (index.ts:1441). Đã persist.
- **AI summary** — D1 `meeting.ai_summary`.
- **Event-log timeline** — D1 `meeting_event` (migration `0033`, server-readable
  plaintext, ordered by `(ts, seq)`; route `GET /v1/meetings/:roomId/events`
  index.ts:2790). Đây là "dòng thời gian" để sau này dựng canvas-replay.

**Vì sao KHÔNG record canvas trong MVP:** Canvas M = canvas-centric, nhưng canvas
**đã được lưu đầy đủ** (scene versions + event-log). Record-lại canvas = dư thừa
+ build lớn. Canvas-replay (scrub whiteboard theo `meeting_event` timeline, đồng
bộ với track A/V) là **Phase sau / differentiator** (spec §3.2 option b) — phần
lớn chỉ là *expose data đã có*, không phải record cái mới. **Đừng làm trong MVP.**

> ⚠️ Lưu ý canvas-centric: Daily chỉ thấy canvas **nếu có người screen-share
> canvas**. Trong Canvas M canvas là surface native → thường KHÔNG share. Nên
> file Daily MVP = "audio + faces + bất cứ thứ gì được share". Đó là lý do canvas
> phải dựa vào scene snapshot + event-log, KHÔNG dựa vào video Daily (spec §3.1).

### Vấn đề HAI Daily room (bắt buộc xử lý trước khi record)

Hiện tại 1 meeting = **2 Daily room** (spec §1.3, infrastructure.md):

| Daily room | Track | Join |
|---|---|---|
| `<roomId>-audio` | mic audio + **camera** (token `canSend: audio, video`) | join listener-only, mic on-demand |
| `<roomId>` | screen video (+ sys audio) | lazy: chỉ khi share |

Token mint hiện strip `-audio` để gate trên base id (index.ts:5685), và **một
token shape phục vụ cả hai room** với `permissions.canSend: ["audio","video",
"screenVideo","screenAudio"]` (index.ts:5809-5811). Nhưng **media vẫn là 2 call
object / 2 Daily room riêng**.

→ Daily cloud recording record theo **room**. 2 room = **2 file rời** (1 voice/cam,
1 screen). Hai lựa chọn:

- **(i) MERGE mic+camera+screen vào 1 room rồi mới record** — cho ra **1 file
  composited** sạch. ĐÂY LÀ ĐỀ XUẤT (spec §3.3 prerequisite, roadmap L197). Move
  này cũng đúng cho video (spec §2.1). Nhưng screen-share đang có **lazy-join +
  single-share lock** (DailyScreenShare, spec §1.2) load-bearing → merge screen
  vào room voice là việc không nhỏ.
- **(ii) MVP record CHỈ room `<roomId>-audio`** (voice + camera) — bỏ qua screen
  trong file recording ở MVP, vì **screen content vốn cũng là canvas/file đã
  persist**. Đơn giản nhất, ship được chiều nay; screen-in-recording để Phase
  sau cùng lúc merge room.

**ĐỀ XUẤT cho MVP chiều nay:** đi **(ii)** nếu cần ship gấp (record room
`-audio`, là nơi đã có cả voice + camera), **flag merge-room (i) là việc kế tiếp**
để có screen trong file. Owner chốt (xem §6 Open decision D1). Việc record gọi
theo **room name** nên đổi (i)↔(ii) chỉ là đổi tham số room, không phá pipeline.

---

## 2. Lưu Ở ĐÂU / THẾ NÀO — Daily → webhook → R2 → D1

### 2.1 Daily cloud recording — sự thật API (đã verify 06-23)

Verify trực tiếp trên docs.daily.co (không đoán):

- **Start:** `POST https://api.daily.co/v1/rooms/:name/recordings/start`, body
  `{ type: "cloud", layout: {...}, properties?: {width,height,fps,...} }`. Chạy
  **server-side thuần** (không cần SDK participant). Response = **`{"status":"sent"}`**
  — KHÔNG trả `recording_id` (async). `recording_id` sẽ đến qua **webhook**.
- **Stop:** `POST https://api.daily.co/v1/rooms/:name/recordings/stop`, body
  `{ type: "cloud" }` (hoặc `instanceId` nếu nhiều instance). 400 nếu không có
  recording đang chạy.
- **Room phải cho phép record:** thêm `enable_recording: "cloud"` vào room
  `properties` lúc tạo room. **Hook đã có sẵn:** `TODO(recording, July v1)` ngay
  trong `createRoom` (index.ts:5772-5776) — đúng chỗ để thêm field này.
- **Webhook `recording.ready-to-download`** (fire khi recording `finished` +
  duration > 0). Payload fields (verified): `recording_id`, `room_name`,
  `start_ts` (unix sec), `status`, `max_participants`, `duration` (sec),
  **`s3_key`**, `share_token`, `type`. **KHÔNG có download URL trực tiếp.**
- **Lấy link tải:** `GET https://api.daily.co/v1/recordings/:recording_id/access-link`
  → `{ download_link (S3 signed URL), expires (unix) }`. Worker dùng link này để
  fetch bytes.
- **Xoá bản Daily:** `DELETE https://api.daily.co/v1/recordings/:recording_id`.
  ⚠️ Docs KHÔNG khẳng định rõ DELETE có xoá file S3 hay chỉ xoá metadata →
  **xác nhận với Daily support trước khi dựa vào nó để cắt phí storage** (Open
  decision D5). Nếu DELETE không xoá S3, vẫn nên gọi (dọn list) nhưng đừng coi là
  đã hết phí Daily-side.

> **Daily KHÔNG ghi thẳng vào R2** — Daily ghi vào **S3 của Daily** (hoặc bucket
> AWS bạn cấu hình ở dashboard). Đó là lý do Worker phải **copy** sang R2 (R2
> egress free vs S3 ~$0.09/GB — roadmap L120, spec §3.4).

### 2.2 Pipeline (MVP, option a) — file:line cụ thể

```
[Start] Host bấm Record (UI gate: meeting.recording_enabled=1 + consent đã accept)
  → client: POST /v1/recordings/:roomId/start   (route MỚI)
     → Worker: verify JWT + host/organizer (reuse authority như End-for-all)
     → Worker: POST Daily /rooms/<room>/recordings/start {type:"cloud", layout}
     → Worker: broadcast RECORDING_STATE để cả phòng thấy banner "đang ghi"
        (reuse cơ chế pill đã có — spec §1.6/§3.5; nâng thành consent surface)
     → log usage_events (provider:"daily", kind:"recording_start") — mirror
        meterDailyMeeting (index.ts:2539) qua waitUntil

[Stop] Host bấm Stop → POST /v1/recordings/:roomId/stop  (route MỚI)
     → Worker: POST Daily /rooms/<room>/recordings/stop {type:"cloud"}
   ... Daily composite xong → fire webhook ...

[Webhook] Daily → POST /v1/webhooks/daily   (route MỚI, KHÔNG JWT-gate — verify
                                              bằng signature/HMAC của Daily)
     → verify chữ ký webhook (Daily webhook secret, set qua wrangler secret)
     → nếu type == "recording.ready-to-download":
        c.executionCtx.waitUntil( copyRecordingToR2(env, payload) )   ← TRẢ 200 NGAY
        // Daily yêu cầu 2xx nhanh, nếu không sẽ retry → việc nặng đẩy vào waitUntil

[Copy job] copyRecordingToR2(env, { recording_id, room_name, duration, ... }):
     1. GET Daily /recordings/<recording_id>/access-link → download_link
     2. const res = await fetch(download_link)
     3. const key = `recordings/${meetingId}/${recording_id}.mp4`
        await env.BUCKET.put(key, res.body, {
          httpMetadata: { contentType: "video/mp4" },
        })                                  ← stream, KHÔNG buffer cả file vào RAM
     4. INSERT D1 recording row (status:"ready", r2_key, bytes, duration, ...)
     5. (sau khi R2 put OK) DELETE Daily /recordings/<recording_id>  ← cắt phí 2 chỗ
        // chỉ delete khi D1 row đã ghi + R2 put confirmed (đừng mất data)

[Playback] review-mode: GET /v1/recordings/:id  (route MỚI, auth-gated)
     → verify JWT + canSeeMeeting + (host/organizer/authority/admin)
     → const obj = await env.BUCKET.get(row.r2_key)
     → return new Response(obj.body, {headers:{ "content-type":"video/mp4",
         "accept-ranges":"bytes", etag: obj.httpEtag }})   ← stream từ R2 (private)
```

`room_name` trong webhook = tên Daily room (`<roomId>-audio` hoặc `<roomId>`).
Worker **strip `-audio`** để ra `meetingId` (đúng pattern token mint
index.ts:5685) trước khi dựng R2 key + lookup meeting.

### 2.3 Pattern code đã có sẵn để mirror (đừng phát minh lại)

- **Stream R2 → Response:** index.ts:1381 (scene), :1435 (transcript), :1445
  (chat), :1476 (library) — tất cả `new Response(obj.body, {headers:{content-type,
  etag}})`. Recording download = y hệt, đổi content-type `video/mp4` + thêm
  `accept-ranges: bytes` cho `<video>` seek.
- **`waitUntil` cho việc nặng/đo phí:** `meterDailyMeeting` qua
  `c.executionCtx.waitUntil` (index.ts:2539). Copy-job dùng đúng cơ chế này.
- **`cleanSecret(DAILY_API_KEY)`** (index.ts:5670) — secret có thể dính BOM
  (infrastructure.md gotcha), luôn qua `cleanSecret`.
- **`canSeeMeeting` + finished-lock + knock** gate (index.ts:5690-5715) — copy y
  hệt cho download route.
- **Consent đã có:** route `POST /v1/meetings/:roomId/consent` (index.ts:2806) +
  D1 `meeting_consent` (migration `0033`) + flag `viewerHasConsented`
  (index.ts:2325). UI record button **gate trên cờ này** — "đã ghi" đã nằm trong
  notice consent join-time (migration 0033 comment: "meeting may be recorded and
  processed by AI"). KHÔNG cần consent table mới.

### 2.4 D1 — bảng `recording` (migration `0035`, propose SQL inline)

Số kế tiếp sau `0034_meeting_package_manage.sql` = **`0035_recording.sql`**.
Style mirror `0032`/`0033` (comment đầu, `IF NOT EXISTS`, index). **KHÔNG tạo file
thật trong task này — đây là propose:**

```sql
-- 0035_recording.sql
-- Meeting Recording — index of Daily cloud recordings copied into R2.
--
-- The media file itself lives in R2 (recordings/<meetingId>/<recordingId>.mp4),
-- server-readable (NOT E2E — deliberate policy boundary, see
-- docs/specs/video-and-recording.md §3.6). This table is the metadata index the
-- auth-gated download route (GET /v1/recordings/:id) and the Admin Recordings
-- tab read. One row per Daily recording (cloud composited file).
--
-- Lifecycle: row inserted with status='processing' when recording.ready-to-
-- download webhook arrives; flipped to 'ready' once the R2 copy succeeds; the
-- Daily-side copy is deleted after that to stop double storage billing.

CREATE TABLE IF NOT EXISTS recording (
  id          TEXT PRIMARY KEY,            -- Daily recording_id (idempotent on webhook retry)
  meeting_id  TEXT NOT NULL,               -- REFERENCES meeting(id) (room_name with -audio stripped)
  project_id  TEXT,                         -- denormalised at write → leadership/dept filtering
  r2_key      TEXT,                         -- recordings/<meetingId>/<id>.mp4 (NULL until copied)
  duration    INTEGER,                      -- seconds (from webhook payload)
  bytes       INTEGER,                      -- file size after R2 put (NULL until copied)
  status      TEXT NOT NULL DEFAULT 'processing', -- 'processing' | 'ready' | 'failed' | 'deleted'
  started_by  TEXT,                         -- host email who pressed Record (NULL if unknown)
  created_at  INTEGER NOT NULL,            -- row insert (ms epoch)
  ready_at    INTEGER                       -- when R2 copy completed (NULL until ready)
);

-- Per-meeting list (review-mode "Recordings" section), newest first.
CREATE INDEX IF NOT EXISTS ix_recording_meeting ON recording(meeting_id, created_at DESC);
-- Cross-meeting per-project reads (Admin Recordings tab / leadership).
CREATE INDEX IF NOT EXISTS ix_recording_project ON recording(project_id);
-- Operational sweeps (find stuck 'processing', drive retention/lifecycle).
CREATE INDEX IF NOT EXISTS ix_recording_status  ON recording(status, created_at);
```

> Migration apply qua `worker/migrate.mjs` (infrastructure.md). Schema files ở
> `worker/schema/`. **Đừng** edit file generated; chỉ thêm `0035_recording.sql`
> khi build thật (KHÔNG trong task docs-only này).

### 2.5 Storage / cost / retention (chốt theo backup.md, đừng tái tranh luận)

- R2 prefix **`recordings/`** đã reserved, server-readable, không-E2E (spec §1.8,
  architecture R2 table). Project-archive **cố ý loại** `recordings/<roomId>`
  (index.ts ~4213) → recording lấy riêng qua download route, **không** bulk vào
  archive JSON (sẽ OOM worker).
- **Không 2× duplicate:** dựa vào R2 durability + **DELETE bản Daily sau copy**
  (§2.1) + **R2 Infrequent-Access tier** + **lifecycle retention rule** trên
  `recordings/` (giống kế hoạch `trash/` — backup.md, roadmap L195). Retention N
  ngày là **việc owner chốt** (Open decision D3).
- Ballpark (spec §3.4): Daily composited ~0.5–1.5 GB/giờ; R2 storage vài cent/
  tháng/file; **egress free** (lý do copy về R2). Phí thật = volume × retention →
  IA-tier + lifecycle. Daily cũng tính **recorded-minutes** chồng lên participant-
  minutes → đo vào `usage_events` (infrastructure.md §5: admin Cost tab hiện
  `recording_minutes:0` "tracked once Phase 5 lands" — index.ts ~4748).

### 2.6 E2E boundary — ghi to (spec §3.6)

Scene/chat/transcript = **E2E (room_key)**; Daily recording = **composited
server-side, server-readable trong R2 — KHÔNG E2E**. Đây là ranh giới *chính
sách* có chủ ý (giống managed `room_key` + AI summary), để bật admin compliance +
Chairman AI. Phải document rõ là *lựa chọn*, không phải rò rỉ. (Chairman dùng
**transcript** làm grounding, không cần AI-xem-video — spec §3.7.)

---

## 3. Có TẢI được không — CÓ, auth-gated (không public link)

### 3.1 Route download/playback (MỚI)

`GET /v1/recordings/:id`:
- Verify Supabase JWT (gate sẵn cho mọi `/v1` trừ health — infrastructure.md).
- Load `recording` row → `meeting_id`.
- **`canSeeMeeting(DB, email, role, meeting_id)`** (index.ts:5690 pattern) **VÀ**
  authority = **host / organizer / project authority / admin** (reuse model
  End-for-all + meeting-lifecycle). Member thường có trong meeting → xem được;
  external guest **không** (recording = org-compliance surface).
- Stream từ R2: `new Response(obj.body, { headers: { "content-type":"video/mp4",
  "accept-ranges":"bytes", etag } })` (mirror index.ts:1381). Hỗ trợ `Range`
  header để `<video>` seek (R2 `get` nhận `range` option).
- **KHÔNG** signed public URL — luôn đi qua Worker gate. (roadmap L119-120:
  "Tải qua Worker có auth … không link công khai".)
- Nút **Download** = cùng route + `?download=1` → thêm `content-disposition:
  attachment; filename="<meeting>-<date>.mp4"`.

### 3.2 Ai truy cập được

| Vai trò | Xem/Tải recording |
|---|---|
| Host / organizer / co-host | ✅ |
| Project authority (leader/head sở hữu) | ✅ |
| Admin (Admin Console Recordings tab) | ✅ |
| Internal participant đã dự họp (canSeeMeeting) | ✅ (đề xuất; owner xác nhận D4) |
| External guest | ❌ (recording không trong E2E; guest không xem) |

### 3.3 Surface trong review-mode

Finished meeting = read-only review trên mọi entry path (reference_mcm-review-mode-
entry; isFinishedLocked index.ts:5697). Review-mode surfaces hiện có:
`MeetingPackageViewer.tsx`, `MeetingLogModal.tsx` (event-log timeline), AI summary.
Thêm **section "Recordings"**: list từ `GET /v1/meetings/:roomId/recordings` →
mỗi item `<video src="/v1/recordings/:id">` (stream) + nút Download. Cạnh AI
summary + transcript + event-log timeline. Admin Console thêm **Recordings tab**
(roadmap L104, L129 — đang chờ Phase 5).

---

## 4. Build checklist cho đội chiều nay (có thứ tự)

Theo thứ tự dependency. Mỗi mục ghi file/route đụng tới.

1. **Migration `0035_recording.sql`** (SQL ở §2.4) → apply remote qua
   `worker/migrate.mjs`. *Làm trước — mọi route phụ thuộc bảng này.*
2. **Bật recording trên room:** thêm `enable_recording: "cloud"` vào
   `createRoom` properties (index.ts:5772-5776, đúng chỗ `TODO(recording)`).
   ⚠️ Room **đã tạo** sẽ không có field này → cần `POST /rooms/:name` update
   hoặc cho idempotent re-create. (Decide D2.)
3. **Route start/stop** (host-gated): `POST /v1/recordings/:roomId/start` +
   `/stop` → gọi Daily `/rooms/<room>/recordings/start|stop` (§2.1). Reuse
   authority gate End-for-all; reuse `cleanSecret(DAILY_API_KEY)`. Broadcast
   `RECORDING_STATE`. **Chốt room nào record** (D1: `-audio` hay merged).
4. **Webhook endpoint** `POST /v1/webhooks/daily` (KHÔNG JWT — verify HMAC chữ ký
   Daily; set `DAILY_WEBHOOK_SECRET` qua `wrangler secret`, set sạch BOM bằng
   bash pipe — infrastructure.md gotcha). Trả **200 ngay**, đẩy việc nặng vào
   `waitUntil`. Đăng ký webhook config bên Daily (1 lần).
5. **Copy-job `copyRecordingToR2`** (`waitUntil`): access-link → `fetch` →
   `BUCKET.put(stream)` → INSERT/UPDATE `recording` row status `processing→ready`
   → `DELETE` Daily recording. Idempotent trên `recording_id` (webhook có thể
   retry). Strip `-audio` để ra `meetingId`.
6. **Route download/playback** `GET /v1/recordings/:id` (auth-gated, §3.1) +
   list `GET /v1/meetings/:roomId/recordings`. Stream từ R2, hỗ trợ `Range`.
7. **Review-mode UI:** section "Recordings" trong review surface
   (`MeetingPackageViewer.tsx` / `MeetingLogModal.tsx` vicinity) — `<video>` +
   Download. Gate record button trên `meeting.recording_enabled` +
   `viewerHasConsented` (index.ts:2325). Consent banner cho cả phòng từ
   `RECORDING_STATE`.
8. **Cost/usage:** đếm `recording_minutes` vào `usage_events` (provider `daily`,
   kind `recording`) → admin Cost tab đọc thật thay `0` (index.ts:~4748). Admin
   **Recordings tab** list `recording` rows.
9. **Ops (việc Luân, không chặn code):** R2 **lifecycle retention rule** +
   **IA-tier** trên prefix `recordings/`; xác nhận Daily DELETE có xoá S3 (D5);
   set `DAILY_WEBHOOK_SECRET`.

**Có thể ship MVP tối thiểu chỉ với mục 1–7** (8–9 là cost/ops, làm song song).

---

## 5. Open decisions cần owner chốt (decision-grade)

- **D1 — Room nào record?** Đề xuất MVP: record room `<roomId>-audio` (voice +
  camera), screen-in-recording để Phase sau cùng lúc **merge mic+camera+screen
  vào 1 room** (spec §3.3 prerequisite). Owner chốt: ship gấp (-audio only) hay
  làm merge-room trước để có screen ngay trong file?
- **D2 — Room đã tạo:** bật `enable_recording` chỉ áp cho room mới; room đang tồn
  tại cần update qua `POST /rooms/:name` hoặc re-create. OK update?
- **D3 — Retention:** recording auto-xoá sau N ngày (R2 lifecycle)? 30/90/180?
  Khác nhau internal vs client meeting? (spec open-q 2.)
- **D4 — Ai xem được:** chỉ host/organizer/admin, hay **mọi internal participant
  đã dự** (canSeeMeeting)? Đề xuất: cho participant nội bộ xem; external = không.
- **D5 — Daily DELETE có xoá S3 file không?** Docs không khẳng định → cần hỏi
  Daily support trước khi dựa vào DELETE để cắt phí storage Daily-side. Nếu
  không, phí Daily-side vẫn còn → cân nhắc retention bên Daily.
- **D6 — Consent đa quốc gia (Phi):** default-OFF + banner là đề xuất (đồng bộ B8
  STT consent). Có nước nào cần **opt-in per-participant** trước khi start record?
  (spec open-q 3 — quan trọng cho Philippines two-party-consent.)
- **D7 — Host-control:** start/stop host-only. Internal (tháng 7) host là
  **client-soft**. External (tháng 8) cần **server-side host validation** qua DO
  (track I-2, roadmap L170) trước khi mở.

---

## 6. Liên quan

- Spec thiết kế đầy đủ (lý do/why): [`../specs/video-and-recording.md`](../specs/video-and-recording.md) §3
- Phase 5 trong roadmap: [`roadmap.md`](roadmap.md) L114-121, L190
- Hạ tầng thật (stack/secrets/gotcha): [`../specs/infrastructure.md`](../specs/infrastructure.md)
- R2 heavy-data / IA-tier / lifecycle: [`../runbooks/backup.md`](../runbooks/backup.md)
- Review-mode entry (read-only): memory `reference_mcm-review-mode-entry`
- Chairman AI grounding (transcript, không AI-xem-video): [`../specs/chairman-account.md`](../specs/chairman-account.md)

### Daily API — nguồn đã verify (06-23)
- Start: `POST /rooms/:name/recordings/start` ({type:"cloud", layout, properties}) → `{"status":"sent"}`
- Stop: `POST /rooms/:name/recordings/stop` ({type:"cloud"})
- Webhook `recording.ready-to-download`: `recording_id, room_name, start_ts, status, max_participants, duration, s3_key, share_token, type`
- Access link: `GET /recordings/:recording_id/access-link` → `{download_link, expires}`
- Delete: `DELETE /recordings/:recording_id` (S3-file-removal behaviour: confirm với Daily — D5)
- Room property để bật: `enable_recording: "cloud"`
