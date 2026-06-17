# Canvas M — Kiến trúc hiện thời

> **Generated doc** — tổng hợp từ khảo sát code ngày **2026-06-17** (cuối ngày).
> File này được sinh tự động và sẽ bị **ghi đè hoàn toàn** ở lần regenerate sau;
> **đừng sửa tay**. Nếu thấy sai lệch với code, regenerate thay vì vá tay.
>
> Nguồn chi tiết hơn: `docs/runbooks/deploy.md`, `docs/runbooks/backup.md`,
> `docs/plans/durable-objects-migration.md`, `docs/specs/video-and-recording.md`,
> `docs/specs/chairman-account.md`, `docs/dev-phase-notes.md`, và bộ nhớ dự án (memory).

---

## 1. Tổng quan hệ thống

Canvas M (rebrand từ "MAP CanvasMeet"; acronym **MCM** + prefix `mcm-` giữ nguyên)
là công cụ họp nội bộ xây trên **fork Excalidraw**: app client (`excalidraw-app/`)
"đắp" shell meeting (`MeetingShell`) quanh editor gốc (`packages/excalidraw`, alias
qua Vite, build thẳng từ source). Toàn bộ là **1 SPA không router** — điều hướng
bằng URL hash (`#room=<roomId>,<roomKey>`) + jotai atoms.

**Thay đổi lớn từ bản 06-11:** backend giờ là **một Worker Cloudflare duy nhất**
(`mcm-storage`). Room server Node + socket.io (`room/`) **đã retire** — không còn là
đường realtime. Realtime chạy **100% trên Durable Objects** (`RoomDO`, raw WebSocket
+ Hibernation) ngay trong Worker; AI (Gemini) + STT (Deepgram) cũng đã **dời lên
Worker** và được **đo chi phí** vào `usage_events`. App host trên **Cloudflare Pages**
(`map-canvasm.pages.dev`).

Backend hiện tại (1 Worker, nhiều phân hệ):

- **Worker `mcm-storage`** (`worker/`, Hono + Durable Objects, `src/index.ts` ~6.100
  dòng): API `/v1/*` có JWT, persistence **R2** (bytes) + **D1** (metadata/registry),
  **realtime DO** (`RoomDO`), **AI** (`ai.ts`), **STT proxy** (`stt.ts`), metering
  (`usage.ts`), email (`email.ts`), và **Cron backup** (`scheduled()`).
- **Daily.co** (managed SFU): audio + screen share + **camera (opt-in, mới)**.
- **Supabase Auth**: identity/JWT (ES256/JWKS, verify offline trong Worker).

Hạ tầng cụ thể (xác nhận từ `worker/wrangler.jsonc`): Worker `mcm-storage`,
D1 `mcm-db` (`database_id` 70c15c3f…, region APAC) ở migration **0030**,
R2 `mcm-storage` (binding `BUCKET`), DO binding `ROOM` → class `RoomDO`,
`ROOM_WS_CAP=500`, `STT_PROVIDER=deepgram`, Cron `0 3 * * SUN`. App deploy thủ công
lên Pages (`--branch=main`, PWA "Canvas M").

Nội dung meeting (scene/chat/transcript/library/cursor) **E2E-encrypted bằng `roomKey`**
nằm trong URL hash, không bao giờ gửi lên server — Worker/DO chỉ thấy ciphertext.
Lưu ý: `room_key` được lưu **managed** trong D1 (`meeting.room_key`, plaintext) → "E2E"
hiện là ranh giới **chính sách**, chưa phải mật mã thuần (cố ý — nền cho compliance +
Chairman, xem §6).

```
                         ┌────────────────────────────────────────────┐
                         │  CLIENT (excalidraw-app, SPA)              │
                         │  Cloudflare Pages: map-canvasm.pages.dev   │
                         │  MeetingShell ▸ Excalidraw editor          │
                         │  Collab/Portal (E2E encrypt, roomKey)      │
                         │  RawWsTransport (raw WS → DO)              │
                         └─┬────────┬─────────┬──────────┬───────────┘
       raw WS (E2E bytes)  │        │ HTTPS   │ /stt WS  │ Daily SDK   │ Supabase
       /rooms/:id/ws       │        │ /v1/*   │ + AI     │ audio +     │ Auth SDK
       (mcm.v1,<jwt>)      │        │ (JWT)   │ POSTs    │ screen +    │ (JWT ES256)
                           ▼        ▼         ▼ (JWT)    │ camera      ▼
        ┌─────────────────────────────────────────────┐ │      ┌──────────────┐
        │      CLOUDFLARE WORKER  (mcm-storage)        │ │      │ Supabase Auth│
        │  Hono /v1/* · JWT gate · admin/owner gate ·  │ │      │ password +   │
        │  roomGate · canSeeMeeting · knock gate       │ │      │ magic link   │
        │                                              │ │      └──────┬───────┘
        │  ┌──────────────┐   ┌──────────────────────┐ │ │   JWKS     │ verify
        │  │ RoomDO (DO)  │   │ ai.ts  /translate*    │ │ │   offline  │ (jose)
        │  │ raw WS relay │   │        /chatbot       │◄┘ │◄───────────┘
        │  │ + Hibernation│   │        /summarize     │   │
        │  └──────────────┘   │ stt.ts /stt → Deepgram│   ▼
        │   usage.ts: logUsageEvent → usage_events     │ ┌──────────┐
        │   scheduled(): weekly → R2 backups/          │ │ Daily.co │
        └───────────────┬──────────────────┬───────────┘ │ SFU      │
                        ▼                   ▼             └──────────┘
                  ┌──────────┐        ┌───────────┐
                  │    R2    │        │    D1      │
                  │ mcm-storage│      │  mcm-db    │
                  │ E2E blobs│        │ 20 bảng    │
                  │ + userfiles│      │ registry + │
                  │ + backups/ │      │ audit +    │
                  │ + trash/   │      │ usage/cost │
                  └──────────┘        └───────────┘

   ✗ RETIRED: room/ (Node Express + socket.io relay). Không còn là đường realtime.
```

---

## 2. Các phân hệ

### 2.1 Client shell & dashboard

- Khởi động: `excalidraw-app/index.tsx` → `App.tsx` (`ExcalidrawApp` = TopErrorBoundary →
  jotai Provider (`app-jotai.ts`, 1 store) → `ExcalidrawWrapper` render `MeetingShell`
  bọc `<Excalidraw>`). `initializeScene()` đọc hash `#room=` → auto
  `collabAPI.startCollaboration`.
- **`MeetingLobby.tsx`** là front door tuần tự: chờ `authReadyAtom` → chưa login →
  `LoginScreen` (bắt buộc cho mọi người, kể cả link-join) → admin → `AdminConsole` →
  đang collab/có `#room`/start-gate → canvas → còn lại → project home.
- **`ProjectBrowser.tsx`**: dashboard "Glass Desk" (Apple Liquid Glass 2026) — sidebar
  (Calendar/Invited/MyFiles/projects), meeting cards, `CalendarX` (Schedule-X). Vào phòng:
  `enterRoom()` pushState `#room=...` → `startCollaboration` (`finished` → `viewOnly`).
- State: jotai atoms — `collabAPIAtom`, `isCollaboratingAtom`, `meetingViewOnlyAtom`,
  `startGateAtom`, `sessionAtom`/`authReadyAtom`, `hostSocketIdAtom`, `screenShareStateAtom`,
  `videoTilesAtom`/`cameraStateAtom` (mới), …
- **De-brand + self-hosted fonts**: PWA manifest/`cacheId`/sitemap đã rebrand "Canvas M";
  font UI (Assistant) self-hosted tại `packages/excalidraw/fonts/fonts.css` (woff2 local,
  **không** dùng `fonts.excalidraw.com` / CDN excalidraw). Còn sót (không user-facing):
  link blog trong `EncryptedIcon.tsx`, env map theo hostname trong `sentry.ts`, và 1 font
  trang trí Google Fonts (`Cormorant Garamond`) trong `index.html`.
- **Dev proxy STALE (cleanup item)**: `vite.config.mts` `server.proxy` còn trỏ
  `/translate /translate-batch /chatbot /summarize /stt /socket.io` → room server `:3002`
  (di sản trước DO migration). App code thực tế gọi Worker qua `VITE_APP_STORAGE_URL` nên
  các rule này **dead**; `/v1` → `:8787` (Worker) là đúng. Nên dọn: trỏ AI/STT về Worker,
  bỏ `/socket.io`.

### 2.2 Realtime collab + persistence trong phòng (100% Durable Objects)

- **Transport client = `RawWsTransport`** (`collab/RawWsTransport.ts`): native WebSocket
  giả lập đúng slice `Socket` của socket.io (`.on/.off/.once/.emit/.id/.close/.connect`).
  `collab/Collab.tsx` `startCollaboration` (~L1131) tạo `RawWsTransport` **vô điều kiện** —
  **không còn nhánh socketio/do**. Connect tới `${base}/rooms/<roomId>/ws`; JWT đi qua
  **subprotocol** `Sec-WebSocket-Protocol: mcm.v1, <jwt>` (không qua query, tránh leak log).
  Frame nhị phân `[type:1B (1=broadcast,2=volatile)][iv:12B][ciphertext]`.
- **`realtime_backend` flag không còn route**: `data/projects.ts` `resolveRealtimeBackend()`
  bỏ qua tham số, luôn trả `"do"`. Cột `meeting.realtime_backend` (migration 0027, default
  `socketio`) chỉ còn dùng cho **observability** ở admin (`GET /v1/admin/realtime`), không
  điều khiển transport.
- **`socket.io-client` đã chết** như đường realtime: vẫn còn trong `package.json` + vài
  `import type { Socket }` (chỉ type cho cast cấu trúc); không còn `io(...)` runtime nào
  trong app (chỉ còn trong test mock).
- **Server: `RoomDO`** (`worker/src/roomDO.ts`): 1 DO per roomId, raw WS + **Hibernation API**
  (`ctx.acceptWebSocket` + `webSocketMessage/Close/Error`), ping/pong tự động (`setWebSocket-
  AutoResponse`) → không đánh thức DO, giữ hibernation $0 idle. DO là **relay DUMB E2E**: chỉ
  re-frame byte-identical, không bao giờ giải mã. Identity per-socket lưu qua
  `serializeAttachment` (sống sót hibernation). Mirror đủ socket.io: `init-room` (gửi ngay
  trước 101) / `join-room` → `first-in-room` (driven by persisted `roomEverInitialized`, **không**
  dùng `getWebSockets().length` — chống wipe scene khi wake) hoặc `new-user`; `room-user-change`
  (debounce 250ms gộp burst close khi deploy); `server-broadcast`/`server-volatile-broadcast`
  (volatile drop khi `bufferedAmount > 512KiB`); `rtc-signal`/`request-room-clients` (giữ
  forward-compat, hiện UNUSED do Daily thay WebRTC mesh); `user-follow`.
- Sync (client): broadcast incremental theo `version`, full-sync throttle; join phòng eager
  prefetch scene từ R2 song song; reconcile = `restoreElements` + `reconcileElements` + bump
  version.
- Persistence qua Worker (`data/storage.ts`): scene/chat/transcript/library autosave
  throttle/debounce lên R2 (reconcile scene trước PUT, từ chối ghi scene rỗng), flush khi
  rời phòng, `resetScene()` chống contamination chéo phòng.
- **Host election vẫn client-side** (`data/userProfile.ts`); `HOST_COMMAND` END/KICK/MUTE peer
  tự validate với election local (xem §5 — đây là blocker August).
- **Review mode**: nguồn quyết định = **registry status** — `getMeeting(roomId)` `finished`
  → ép `viewOnly` trên MỌI đường vào kể cả raw `#room`; `scheduled/cancelled` → park
  `WaitingForStart`. Server-side: WS upgrade vào finished → **409** (xem §5).

### 2.3 Worker API + gates (`worker/src/index.ts`, Hono ~6.100 dòng)

- **Thứ tự middleware**: CORS (allowlist `isAllowedOrigin`: localhost/LAN/`*.pages.dev`/
  `*.workers.dev`/`*.trycloudflare.com` + `ALLOWED_ORIGINS` — **không còn `*`**) → **JWT gate**
  `/v1/*` (trừ `/v1/health`; `jose` verify offline JWKS ES256, issuer `${SUPABASE_URL}/auth/v1`,
  audience `authenticated`; set `userId/email/role`; warm `internal_domains`) → JWT cho 4 route
  AI gốc → **admin gate** `/v1/admin/*` (`isAdminish(role)`) → **owner gate** `/v1/owner/*`
  (`role==="owner"`, stub) → **roomGate** per-meeting trên scenes/chats/library/files/transcripts/
  meetings.
- **`fetch()` default export** split TRƯỚC Hono: `/health` → `/rooms/:id/ws`
  (`handleRealtimeUpgrade`) → `/stt` (`handleSttUpgrade`, split để không bao giờ chạm RoomDO)
  → `app.fetch`.
- **Vòng đời meeting** (`PATCH /v1/meetings/:roomId`): canonical `scheduled / live / finished /
  cancelled`. Chuyển hợp lệ: `scheduled→live|cancelled`, `live→finished` (terminal), `cancelled
  →scheduled`. `finished` **immutable** → 409 mọi sửa nội dung & đổi status; content edit =
  organizer / project-authority (head/leader); Start = organizer/host/cohost/owning-dept member;
  End = host/cohost/organizer/authority. UPDATE có điều kiện `WHERE status IS ?` chống race
  (409 "status changed concurrently"). **Tombstone 410**: `deleted_meeting` chặn PUT "hồi sinh".
  Có **grace 10 phút** trên blob-write sau khi finished (anchored `updated_at`).
- **`canSeeMeeting`** (tier, theo thứ tự): admin/owner → organizer/host → invitee active
  (`status<>'revoked'`) → project_member tier owner/manager → project authority (leader_email
  hoặc head_email của division dẫn dắt). Ad-hoc room (chưa có row D1) mở cho mọi user login.
  `confidential` → chỉ organizer ∨ invitee (member/head/leader cũng không đủ). **project_guest**
  chỉ vào meeting qua `meeting_invitee` row tường minh (row guest là identity, không phải grant).
  `roomGate` thêm: guest (non-admin, non-internal) **không** xem được meeting `finished`.

### 2.4 AI + STT (đã dời lên Worker, có metering)

- **AI (`ai.ts`, Gemini)** mount tại ROOT (`app.route("/", aiRoutes)`) — giữ contract giống
  room server cũ để client chỉ đổi base-URL. **Đứng sau JWT gate** (4 path được gate trước khi
  mount). Routes: `POST /translate` (1 đích), `/translate-batch` (1 lần ra nhiều thứ tiếng,
  responseSchema JSON), `/chatbot` (MCM Bot, context meeting: participants/files/canvas/
  transcript/chat; luôn trả 200 + fallback khi Gemini lỗi), `/summarize` (recap JSON strict:
  summary/decisions/actionItems/participants/keyTopics). Rate-limit per-isolate in-memory theo
  IP; translation cache per-isolate Map. Model mặc định `gemini-2.5-flash`.
- **STT (`stt.ts` + `stt-provider.ts`)**: `/stt` WebSocket proxy. Mỗi tab mở 1 WS
  `/stt?lang=…`; Worker mở WS song song tới **Deepgram nova-3** (key server-side, ~120 keyterms
  BIM/kiến trúc vi/en/ko/ja/zh, endpointing tuning theo ngôn ngữ). PCM 16k mono client → provider;
  transcript JSON provider → client (forward verbatim, schema Deepgram giữ nguyên). **Auth gate
  mới (06-17)**: `/stt` verify Supabase JWT qua subprotocol `mcm.v1, <jwt>` (fail-closed 401) vì
  đây là stream tốn tiền. Provider seam (`SttAdapter`): Deepgram là default chạy thật; ElevenLabs
  + OpenAI Realtime là skeleton "provider not configured" — đổi provider = đổi var `STT_PROVIDER`,
  không sửa code.
- **Metering (`usage.ts`)**: mỗi call billable thành công ghi 1 row `usage_events` qua
  `logUsageEvent`, cost tính tại write-time (Gemini Flash token pricing; Deepgram per-minute).
  **CRITICAL fix**: INSERT chạy qua `executionCtx.waitUntil` (không thì context tear-down hủy
  in-flight INSERT → đó là lý do `usage_events` từng trống). Cũng có `dailyCostUsdRange` (Daily
  hiển thị dạng RANGE low→high vì tier chưa xác định). Admin tab **AI & Cost** đọc bảng này
  (`GET /v1/admin/cost`, `/usage`, `/daily`).

### 2.5 Auth + Identity (Supabase) + role tier

- **Supabase Auth** client (`data/supabaseClient.ts`) ↔ Worker verify JWT offline (`jose`/JWKS,
  ES256). `sessionAtom` mirror live session. Login: password (internal) + magic link OTP (guest,
  giữ `#room` hash). Identity = **verified login email** (lower-case) — khoá toàn hệ.
  `fetchWithAuth` = chokepoint gắn Bearer tươi mỗi call.
- **Role tier** (`app_metadata.role` trong JWT):
  - **`owner`** — dev super-admin tối thượng. `isAdminish(role)` = `admin || owner` → owner
    **⊇** admin (qua mọi admin gate). Là người **duy nhất** mint được role
    `owner`/`chairman` (`PRIVILEGED_ROLES`; admin thường chỉ tạo được `admin`). Owner đọc nội
    dung khi vận hành/debug để lại vết ở **`owner_audit`** (`logOwnerAudit` → `owner.open_content`,
    qua `waitUntil`). Xác định owner thuần từ JWT role — **không** env var/`OWNER_EMAILS`.
  - **`admin`** — `/v1/admin/*`; compliance open meeting (audit-before-access).
  - **`chairman`** — **SPEC-only** (`docs/specs/chairman-account.md`), chưa build: chỉ tồn tại
    như tên role grantable, không gate/hành vi nào tiêu thụ.
  - **normal / guest** — nội bộ vs khách project-scoped.

### 2.6 Domain Meeting + Project + Division + Guest

- Project model B+: `project_member` (internal, thấy cả folder, role owner/manager/member) vs
  `meeting_invitee` (1 meeting; kind internal/guest; role cohost/attendee; **revoke = soft**
  giữ audit). `meeting_participant` = ai thực join (email từ JWT).
- **Division layer** (Phase 2 perms): `division` (1 head auto-suy từ rank cao nhất, có cột
  `deputy_email` — **lưu ý drift**: model 06-16 đã bỏ deputy nhưng **cột SQL vẫn còn**),
  `user_division` (email→division). `project.lead_division_id` + `leader_email` (0023) cho head/
  leader auto-authority trên project mà không cần add từng project.
- **Guest model project-scoped** (`project_guest`, 0019): mỗi project phát login synthetic riêng
  (`pg-<hex>@guest.canvasm.app`, **không** dùng email thật), guest theo project xuyên mọi meeting
  của nó. Cùng 1 người được 2 phòng ban mời → 2 row độc lập, không thấy nhau (confidentiality
  giữa các phòng ban). **Revoke ≠ delete**: ban Supabase + `status='revoked'` + `revoked_at`,
  **không hard-delete** (giữ history/moat). "clean" khi project xong mới xoá.
  Branding khách (0029): `country`/`logo_key` per-guest.
- **Waiting room / knock** (`meeting_knock`, 0025): khách ngoài "gõ cửa" chờ host admit; internal
  auto-admit. Gate enforced ở Daily-token + WS upgrade (admitted mới qua).
- **Client branding / portal** (`PortalBackdrop.tsx`, `data/backdrops.ts`): backdrop crossfade
  multinational (admin-managed rotation từ R2 `portal_backdrop`, có **country tag** + multi-upload;
  fallback bundled THEMES VN/USA/Africa/PL/IN/forest), overlay logo công ty khách. `GET /v1/portal/me`
  resolve country/company/logo cho trang entry.

### 2.7 Media — Daily.co (audio + screen share + camera)

- **Audio**: Daily SFU (`audio/DailyAudio.ts`). **Camera (mới, opt-in)**: `setCamera(on)` bật
  camera 640×360@24fps **trên CHÍNH call object audio** (không phải room mới) → `videoTilesAtom`/
  `cameraStateAtom` (`audio/videoState.ts`) → render tile video ở **dải participant đáy**
  (`components/mcm/ParticipantsBar.tsx` `TileVideo`, fallback `MCMAvatar` khi không có stream).
- **Screen share**: call object Daily **thứ 2** (`screenshare/DailyScreenShare.ts`,
  `allowMultipleCallInstances`), lazy-join + single-share lock qua DO. Token: `GET /v1/daily/token`
  — Worker giữ `DAILY_API_KEY`, gate `canSeeMeeting` + finished-lock + admitted-knock (khách).
- (Spec: `docs/specs/video-and-recording.md`.)

### 2.8 Tài liệu DXF/IFC/PDF + My Files

- `MeetingLibrary.tsx` + `data/meetingLibrary.ts`: ingest image/DXF/PDF/IFC; IFC bake web-ifc WASM
  → GLB + storeys; PDF probe pdfjs; DXF render dxf-viewer (Three.js). Trên canvas: DXF = anchor +
  overlay; **PDF & IFC = image element thật** (snapshot), IFC focus mount `IFCRenderer` interactive
  rồi bake lại + persist camera. Sync: ≤256KB inline socket E2E | lớn → metadata + PUT per-file R2;
  persist library blob slim debounce.
- **My Files** (`/v1/me/files`): tủ cá nhân internal-only, ≤50MB, bytes R2 `userfiles/<email>/…`
  **server-readable**, ownership qua D1 `user_file` (có `tags`/`visibility`). Copy vào meeting = đi
  lại pipeline → meeting giữ snapshot riêng.

---

## 3. Các luồng chính end-to-end

### 3.1 Tạo → Join/Start gate → Collab (DO) → End → AI summary → Review

1. **Tạo**: `ScheduleMeetingForm` → `POST /v1/meetings` atomic (Worker stamp organizer/host từ
   JWT; `realtime_backend='do'`) → invite từng invitee.
2. **Join**: `enterRoom()` pushState `#room=id,key` → `startCollaboration` `getMeeting`:
   `scheduled` → park `WaitingForStart` (internal Start = PATCH `live`; guest poll); `live` → vào
   thẳng; `finished/cancelled` → review/thoát. Mọi link-join login trước.
3. **Collab (DO)**: `RawWsTransport` connect `/rooms/:id/ws` với `mcm.v1,<jwt>` →
   `handleRealtimeUpgrade` gate (xem §5) → 101 → `RoomDO` relay E2E. Broadcast incremental
   encrypted; autosave R2 qua Worker (JWT + roomGate).
4. **End-for-all**: host PATCH `status:"finished"` (server guard race + terminal) → broadcast
   `HOST_COMMAND END_MEETING` → fire-and-forget `POST /summarize` (Gemini) → `POST /v1/meetings/:id/
   summary` → D1 `meeting.ai_summary` (plaintext queryable) → client flush + rời phòng.
5. **Review**: mở lại `finished` (mọi đường) → `viewOnly`; server: PATCH/invite/blob-PUT/WS vào
   finished → 409 (xem §5). Admin/owner compliance: `POST /v1/admin/meetings/:id/open`
   (audit-before-access bắt buộc; owner thêm `owner_audit`) → trả `room_key` → stealth read R2.

### 3.2 Backup / DR (LIVE)

```
Admin "Backup DB"  → GET /v1/admin/backup        → dump mọi bảng D1 (metadata) → JSON tải về
Admin "Archive &   → GET /v1/admin/projects/:id/archive → D1 rows + R2 blob bytes (base64, cap 8MB)
  Delete project"     → tải về → DELETE /v1/admin/projects/:id
Weekly Cron        → scheduled() "0 3 * * SUN"   → dump D1 → R2 backups/db-<date>.json (waitUntil)
Cascade delete     → deleteMeetingCascade: copy blob → trash/<ts>/ (soft) rồi xoá live key,
                     xoá D1 rows, xoá 2 Daily room, ghi tombstone deleted_meeting
```
(Runbook: `docs/runbooks/backup.md`.)

---

## 4. D1 schema + R2 layout

### Bảng D1 (**20 bảng**, migrations 0001→**0030**, runner `worker/migrate.mjs` + `schema_version`)

| Bảng | Vai trò | Cột/bổ sung đáng chú ý |
| --- | --- | --- |
| `project` | folder meeting, owner = host_email | + stage/desc/code/client/location/type/branch, cover, color/icon, **lead_division_id**, **leader_email** (0023) |
| `meeting` | registry, `id==roomId`; scene bytes R2 | + status canonical, topic/conf/priority/scheduled_at, organizer/host_email, waiting_room/recording_enabled, color/icon, `ai_summary`(+_at), **`realtime_backend`** (0027, default `socketio`, không còn route) |
| `file` | index per-file R2 trong meeting | kind/name/size/r2_key |
| `project_member` | membership nội bộ (thấy cả folder) | role owner/manager/member |
| `meeting_invitee` | mời per-meeting | kind internal/guest, role cohost/attendee, status (revoke=soft, `revoked_at`) |
| `meeting_participant` | ai thực join (email từ JWT) | joined_at/last_seen_at |
| `note` | ghi chú per-user | scope+ref+email |
| `client` | CRM-lite contact (không phải identity) | name/company/email |
| `user_file` | index My Files (ownership) | + `tags`, `visibility` (0017) |
| `audit_log` | mutation nhạy cảm + compliance open | actor/action/target/meta |
| `system_settings` | `internal_domains` admin-editable | key/value |
| `deleted_meeting` | tombstone → 410 | deleted_by/at |
| `schema_version` | migration tracking | version/applied_at |
| `division` | phòng ban, 1 head auto-suy theo rank | head_email; **`deputy_email` (0024)** — model bỏ deputy nhưng cột SQL còn (drift) |
| `user_division` | email → home-division | division_id |
| `project_guest` | guest project-scoped (login synthetic) | login/label/real_email/supa_id/status; + company/phone/address; + **country/logo_key** (0029) |
| `meeting_knock` | waiting room (knock-to-join) | status invited/admitted/denied, last_seen |
| `portal_backdrop` | backdrop client-portal (admin, R2) | r2_key/sort_order; + **country** tag (0029) |
| `usage_events` | metering AI/STT (1 row/call billable) | provider/kind/tokens/seconds/`est_cost_usd`/meeting_id/email |
| `owner_audit` | vết owner truy cập nội dung (chairman spec) | owner_email/action/target/meta |

### R2 key prefixes (bucket `mcm-storage`)

| Prefix | Mã hoá | Nội dung |
| --- | --- | --- |
| `scenes/<roomId>/current` | E2E roomKey | scene blob `[u32 ver][ivLen][iv][cipher]` |
| `chats/<roomId>/current` | E2E roomKey | chat log |
| `library/<roomId>/current` | E2E roomKey | manifest DXF/IFC/PDF (slim) |
| `transcripts/<roomId>/current` | E2E roomKey | STT log |
| `files/<roomId>/<fileId>` | E2E roomKey | bytes per-file (ảnh, GLB) |
| `userfiles/<email>/<fileId>` | **server-readable** | My Files (≤50MB) |
| `backdrops/<id>` | server-readable | client-portal backdrop bytes |
| `guest-logos/<id>` | server-readable | logo công ty khách |
| `backups/db-<date>.json` | server-readable | dump D1 hàng tuần (Cron) |
| `trash/<ts>/<key>` | giữ mã gốc | soft-delete khi cascade (chờ R2 lifecycle expire) |
| `recordings/` | — | **chưa dùng** (Phase 5/2, recording→R2 chưa build) |

---

## 5. Ranh giới server-enforced vs client-soft + known gaps

### Server-enforced (Worker — thật)

- JWT bắt buộc mọi `/v1/*` (trừ health) + 4 route AI gốc; admin/owner gate độc lập; CORS
  allowlist (không còn `*`).
- **Realtime WS upgrade** (`handleRealtimeUpgrade`) gate ĐẦY ĐỦ TRƯỚC 101: verify JWT
  (`verifyRealtimeJwt`) → `canSeeMeeting` → **finished-lock 409** → **knock gate** (khách phải
  `admitted`) → **WS-count cap** (`ROOM_WS_CAP=500`, RPC `__count`; RPC lỗi chỉ fail-open ở cap,
  KHÔNG bypass auth). Identity re-trust qua header `x-mcm-sub/email/role` (DO không verify JWKS
  hot-path).
- **STT `/stt`**: verify JWT qua subprotocol (fail-closed 401).
- **Blob PUT vào `finished` ĐÃ bị chặn** (gap 06-11 đã đóng): `isFinishedLocked` gate scenes/chats/
  transcripts/library/files → 409 "review only". Lưu ý: có grace 10 phút trên `updated_at`, và
  admin PATCH chạm field khác refresh `updated_at` → mở lại cửa sổ (soft spot ghi nhận). Summary
  POST cố ý không gate (land sau finish).
- Lifecycle state machine + race-safe 409; `finished` immutable; organizer/host stamp từ JWT;
  tombstone 410 + cascade delete (+ trash soft-delete).
- `canSeeMeeting`/roomGate invited-only; `confidential` invitee-only; guest không thấy folder &
  không xem finished; **revoke = kick** (cascade flip `meeting_invitee.status` → request kế tiếp
  bị từ chối trước khi JWT TTL hết).
- Daily token gate (`DAILY_API_KEY` server-only) + finished-lock + admitted-knock; My Files
  internal + ownership + 50MB; compliance open = audit-before-access (owner thêm `owner_audit`);
  guest revoke **không** hard-delete.
- Backup/Cron/archive đều adminish-gated + audit.

### Client-soft (dev-phase, prod phải nâng cấp)

- **Host control / kick / mute trong phòng vẫn client-soft** — election + `HOST_COMMAND` peer tự
  validate (payload E2E, server không validate cohost claim). Server chỉ hard ở **lifecycle**
  (Start/End/cancel qua PATCH) và **access revocation** (revoke→cascade→deny). Kick/mute từng
  participant chưa có endpoint server. → **đây là blocker thật của August** (cohost server-validation
  chưa làm).
- **Review read-only** = `viewModeEnabled` client (server đã chặn blob-write + WS như trên).
- `room_key` **managed/plaintext** trong D1 (`meeting.room_key`) — ranh giới chính sách, **cố ý**
  (nền cho compliance + Chairman); chỉ compliance open trả key (sau audit).
- UI gates (`viewer_is_authority`/`viewer_can_start` hints, nút Edit/Start, `INTERNAL_DOMAINS`
  mirror) chỉ là UX; lifecycle re-check độc lập server-side.

### Known gaps còn mở

- **Cohost / host-control server-validation** chưa làm (August blocker, ở trên).
- `room_key` managed (policy boundary, cố ý — không phải bug).
- **Recording → R2 chưa build** (Phase 5/2): recording hiện host-only soft (MediaRecorder
  download local), `recordings/` prefix dành sẵn chưa dùng; Daily cloud recording → webhook → R2
  chưa làm. `recording_enabled` flag gửi lên nhưng chưa wire consumer.
- **Guest revoke ≠ delete** đã chuẩn ở guest model (soft + ban), nhưng còn chỗ code cũ hard-delete
  cần rà; "clean" chỉ chạy khi project xong.
- `division.deputy_email` còn trong schema dù model đã bỏ deputy (drift, nên dọn migration hoặc
  ignore ở code).
- Dev `vite.config.mts` proxy AI/STT còn trỏ room server `:3002` (dead config, cleanup).
- Cost Daily hiển thị RANGE (tier chưa xác định); waiting-room UX per-guest, email/.ics/recurring,
  identity email→UUID vẫn ở backlog.

---

## 6. Kiến trúc đích vs hiện trạng (2026-06-17)

| Hạng mục | Đích | Hiện trạng 06-17 |
| --- | --- | --- |
| Hosting client | Cloudflare Pages | ✅ **Pages live** `map-canvasm.pages.dev` (deploy thủ công `--branch=main`, PWA "Canvas M") |
| Realtime | Durable Objects (raw WS + Hibernation) | ✅ **100% DO** (`RoomDO`); room server socket.io **RETIRED**; client forced `RawWsTransport`; `realtime_backend` không còn route |
| AI / STT | Trên Worker, key qua `wrangler secret` | ✅ **Trên Worker** (`ai.ts` Gemini, `stt.ts` Deepgram); metered `usage_events`; admin AI&Cost tab |
| Auth | Supabase (JWT/JWKS verify trong Worker) | ✅ live; **+ role tier owner ⊃ admin ⊃ normal/guest**; chairman spec-only |
| Persistence | R2 ciphertext + D1 remote | ✅ R2 `mcm-storage` + D1 `mcm-db` @ migration **0030** (20 bảng) |
| Media | Daily managed | ✅ audio + screen share + **camera opt-in (mới)**; recording→R2 ⏳ |
| Backup / DR | Tự động + restorable | ✅ **LIVE**: admin Backup/Archive + Cron `0 3 * * SUN` → R2 `backups/` + `trash/` soft-delete |
| Branding | Per-guest country/company/logo, de-brand | ✅ guest branding + country-tagged backdrops + multi-upload (0029); de-brand + fonts self-hosted |
| E2E | `#room=<id>,<key>`, server chỉ thấy ciphertext | ✅ wire giữ nguyên; `room_key` managed D1 (policy, cố ý) |
| Host control | Server-validated cohost/kick/mute | ⏳ **chưa** — vẫn client-soft (**blocker August**) |
