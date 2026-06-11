# MAP CanvasMeet — Kiến trúc hiện thời

> **Generated doc** — tổng hợp từ khảo sát code ngày **2026-06-11**. File này được sinh tự động và sẽ bị ghi đè hoàn toàn ở lần cập nhật sau; không sửa tay.
>
> Nguồn chi tiết hơn: `docs/roadmap.md`, `docs/dev-phase-notes.md`, `docs/production-data-plan.md`, `docs/host-and-scheduling.md`, `docs/2026-06-01-plan-ha-tang-cloudflare.md`.

---

## 1. Tổng quan hệ thống

MAP CanvasMeet (MCM) là công cụ họp nội bộ xây trên **fork Excalidraw**: app client (`excalidraw-app/`) "đắp" shell meeting (`MeetingShell`) quanh editor gốc (`packages/excalidraw`, alias qua Vite, build thẳng từ source). Toàn bộ là **1 SPA không router** — điều hướng bằng URL hash (`#room=<roomId>,<roomKey>`) + jotai atoms.

Backend gồm 2 nửa:
- **Room server** (`room/`, Node Express + socket.io, port 3002 dev): relay realtime "dumb" (chỉ forward ciphertext) + proxy AI/STT/TURN.
- **Cloudflare Worker** (`worker/`, Hono, `mcm-storage`): API `/v1/*` có JWT, persistence **R2** (bytes) + **D1** (metadata/registry). **Hai môi trường song song (P1 xong 06-11):** dev = miniflare local qua cloudflared tunnel (`meeting.ps1` chạy 4 process: vite :3001, room :3002, worker :8787, tunnel); remote = deploy thật tại **`https://mcm-storage.rnd-ai.workers.dev`** (D1 `mcm-db` APAC 16/16 migrations, R2 `mcm-storage`, 4 secrets) — remote DB còn trống, client dev vẫn trỏ local, cutover = đổi `VITE_APP_STORAGE_URL`.

Nội dung meeting (scene/chat/transcript/library) **E2E-encrypted bằng `roomKey`** nằm trong URL hash, không bao giờ gửi lên server — server chỉ thấy ciphertext. Lưu ý: `room_key` được lưu managed trong D1 → "E2E" hiện là ranh giới **chính sách**, chưa phải mật mã thuần (xem §6).

```
                         ┌────────────────────────────────────────────┐
                         │  CLIENT (excalidraw-app, Vite SPA :3001)   │
                         │  MeetingShell ▸ Excalidraw editor          │
                         │  Collab/Portal (E2E encrypt, roomKey)      │
                         │  jotai store · localStorage/IndexedDB      │
                         └───┬──────────┬──────────┬─────────┬────────┘
            socket.io (ciphertext)      │          │         │
            + WS /stt + /translate      │ HTTPS    │ Daily   │ Supabase
            + /summarize /chatbot       │ /v1/*    │ SDK     │ Auth SDK
                         ▼              │ (JWT)    ▼         ▼
        ┌────────────────────────┐      │   ┌──────────┐ ┌──────────────┐
        │ ROOM SERVER (room/)    │      │   │ Daily.co │ │ Supabase Auth│
        │ Express + socket.io    │      │   │ SFU audio│ │ password +   │
        │ :3002 — dumb relay     │      │   │ + screen │ │ magic link   │
        │ (không auth, không     │      │   │ share    │ │ (JWT ES256)  │
        │  đọc được nội dung)    │      │   └────▲─────┘ └──────┬───────┘
        └──┬─────────────┬───────┘      ▼        │ token        │ JWKS
           │ WS proxy    │ REST   ┌──────────────┴─────────┐    │ verify
           ▼             ▼        │ CLOUDFLARE WORKER      │◄───┘ offline
    ┌──────────┐  ┌───────────┐   │ (worker/, Hono, /v1/*) │
    │ Deepgram │  │  Gemini   │   │ JWT gate · roomGate ·  │
    │ STT      │  │ translate │   │ admin gate · Daily     │
    │ nova-3   │  │ summarize │   │ token mint             │
    └──────────┘  │ chatbot   │   └────┬──────────┬────────┘
                  └───────────┘        ▼          ▼
                                  ┌────────┐ ┌─────────┐
                                  │   R2   │ │   D1    │
                                  │ blobs  │ │ 12 bảng │
                                  │(cipher │ │ registry│
                                  │ + user │ │ + audit │
                                  │ files) │ │         │
                                  └────────┘ └─────────┘
```

---

## 2. Các phân hệ

### 2.1 Client shell & dashboard

- Khởi động: `excalidraw-app/index.tsx` → `App.tsx` (`ExcalidrawApp` = TopErrorBoundary → jotai Provider (`app-jotai.ts`, 1 store duy nhất) → `ExcalidrawWrapper` render `MeetingShell` bọc `<Excalidraw>`). `initializeScene()` đọc hash `#room=` → auto `collabAPI.startCollaboration`.
- **`MeetingLobby.tsx`** là front door tuần tự: chờ `authReadyAtom` → chưa login → `LoginScreen` (bắt buộc cho mọi người, kể cả link-join; hash `#room` giữ nguyên nên login xong tự join) → admin → `AdminConsole` (chỉ bypass khi compliance review có mark `isReviewRoom`) → đang collab/có `#room`/start-gate → canvas → còn lại → project home.
- **`ProjectBrowser.tsx`** (~926 dòng): dashboard 3 cột kiểu Notion — sidebar (Calendar/Invited/MyFiles/projects), meeting cards (preview/edit/schedule inline), `CalendarX` (Schedule-X). Vào phòng: `enterRoom()` pushState `#room=...` → `startCollaboration` (`finished` → `viewOnly`). Rời phòng: `MeetingShell.handleLeave` → clear hash → về lobby. `ProjectFolder.tsx` = modal in-canvas cho host đổi project không rời canvas (nút host-only, soft).
- State: jotai atoms — `collabAPIAtom`, `isCollaboratingAtom`, `meetingViewOnlyAtom`, `startGateAtom`, `sessionAtom`/`authReadyAtom`, `hostSocketIdAtom`, `screenShareStateAtom`… Theme: `useHandleAppTheme.ts`. i18n 2 tầng: locales Excalidraw (`app-language/`) + dictionary MCM (`i18n/mcm/`, baseline `vi.ts` typed).
- Dev proxy (`vite.config.mts`): `/socket.io /stt /translate* /chatbot /summarize /turn-credentials` → room :3002; `/v1` → worker :8787.
- Legacy chưa dọn: `CalendarView.tsx`, `CalendarSplit.tsx`, `InvitedMeetings.tsx` (không còn importer); PWA manifest/sitemap còn branding excalidraw.com; `MOCK_PARTICIPANTS`.

### 2.2 Realtime collab + persistence trong phòng

- `collab/Collab.tsx` (~3160 dòng) + `collab/Portal.tsx`: mọi broadcast encrypt AES-GCM client-side; room server chỉ forward `server-broadcast` → `client-broadcast`. Sự kiện: `init-room/join-room/first-in-room/new-user/room-user-change` + relay `rtc-signal`, TURN proxy, các WS_SUBTYPES (INIT/UPDATE/CHAT/LIBRARY_FILE*/RAISE_HAND/SCREEN_SHARE/STT_SEGMENT/USER_PROFILE/HOST_COMMAND/RECORDING_STATE…).
- Sync: broadcast incremental theo `version`, full-sync throttle 20s; reconcile = `restoreElements` + `reconcileElements` + bump version. Join phòng: **eager prefetch** scene từ R2 song song với socket, fallback 5s.
- Persistence qua Worker (`data/storage.ts`; `data/firebase.ts` chỉ là shim tên legacy): scene throttle 20s (reconcile với bản R2 trước khi PUT, từ chối ghi scene rỗng), chat debounce 800ms, transcript 5s, library 1.2s. **Flush khi rời phòng** (`flushPendingRoomSaves`, mới 06-11) chống mất dữ liệu cửa sổ debounce cuối; `resetScene()` chống contamination chéo phòng.
- **Host election hoàn toàn client-side** (`data/userProfile.ts`): (1) match `host_email` registry → (2) legacy match name → (3) acting host = internal vào sớm nhất → (4) joinedAt nhỏ nhất chỉ khi không ai có email; phòng toàn guest → hostless. `HOST_COMMAND` END/KICK được peer tự validate với election local; MUTE trusted (low-harm).
- **Review mode**: nguồn quyết định là **registry status** — `startCollaboration` gọi `getMeeting(roomId)`, `finished` → ép `viewOnly` trên MỌI đường vào kể cả raw `#room` link (đã verify code `Collab.tsx` ~L922–942); `scheduled/cancelled` → park ở `WaitingForStart`. Mọi `persist*` skip khi viewOnly. **Stealth** (admin compliance): không join socket, đọc snapshot R2 thuần — không lộ presence; trade-off: meeting live chỉ thấy autosave cuối.

### 2.3 Worker API + Database (`worker/src/index.ts`, ~2.500 dòng, Hono)

- Middleware theo thứ tự: CORS (`*`, dev-phase) → **JWT gate** `/v1/*` (trừ `/health`; verify offline JWKS ES256 của Supabase, set `userId/email/role`; refresh cache `internal_domains` TTL 60s) → **admin gate** `/v1/admin/*` → **roomGate** per-meeting trên scenes/chats/library/files/transcripts/meetings.
- **`canSeeMeeting`**: admin ∨ organizer/host ∨ invitee active ∨ project_member; ad-hoc room (chưa có row D1) mở cho mọi user đã login; **không còn blanket internal-allow** (siết 06-10). `confidential` → invitee-only (membership project không đủ). `projectAccess` 3 mức full/partial/null; guest không bao giờ thấy folder (surface duy nhất: `/v1/me/invitations`).
- **Lifecycle state machine** (PATCH /v1/meetings): `scheduled→live→finished` (terminal, immutable, 409) + `scheduled↔cancelled`; content edit = organizer-only 403 (đã verify code ~L1103–1134 — comment cũ trong `MeetingDetailPreview.tsx` là stale); UPDATE có điều kiện chống race; POST /meetings atomic, `organizer/host_email` stamp từ JWT (không tin client), ON CONFLICT chỉ COALESCE fill-gap. **Tombstone 410**: `deleted_meeting` chặn mọi PUT "hồi sinh" meeting đã xoá; `deleteMeetingCascade` dọn R2 prefix + rows D1.
- Routes chính: blobs E2E (`/scenes /chats /library /transcripts /files` — server chỉ giữ ciphertext), projects + members (owner-only), meetings + invitees (revoke soft) + participants + `POST .../summary` (D1 `ai_summary`, server-readable), `/me/*` (invitations, meetings calendar, notes, **My Files** ≤50MB server-readable), directory/clients (proxy Supabase Admin), `/daily/token` (gate `canSeeMeeting`, mint token 4h), `/config`, `/admin/*` (users CRUD, compliance open — **audit-before-access**: insert `audit_log` fail → từ chối, settings, stats).
- Migration runner `worker/migrate.mjs` + bảng `schema_version`; 16 migrations đã apply local; không bao giờ execute SQL tay.

### 2.4 Auth + Identity

- **Supabase Auth** client (`data/supabaseClient.ts`, persistSession + autoRefresh) ↔ Worker verify JWT offline bằng `jose`/JWKS. `sessionAtom` (`data/session.ts`) mirror live session qua `onAuthStateChange`.
- Login (`LoginScreen.tsx`): password (internal) + magic link OTP (guest, giữ `#room` hash qua redirect). Dev: quick-login 5 demo users, password chung `MapMeet@2026` (admin `MapAdmin@2026`) — sẽ thay bằng SSO.
- **Identity = verified login email** (lower-case) — khoá duy nhất toàn hệ: owner project, `organizer/host_email`, host election, `meeting_invitee/participant`. Admin = `app_metadata.role === "admin"` (client ẩn/hiện console; server re-check độc lập 403).
- `fetchWithAuth` = chokepoint: đọc access_token tươi mỗi call, gắn Bearer. `INTERNAL_DOMAINS` client chỉ là mirror hiển thị, sync từ `GET /v1/config`; nguồn thật = D1 `system_settings.internal_domains` (fallback `mapgroup.co.kr`).
- Avatar: gallery `lib:NN.png` sync vào `user_metadata` (theo account, qua máy); data-URL upload local-only (TODO R2 `avatars/<user_id>`, Phase P2). Seed users: `scripts/seed-supabase-users.mjs`.

### 2.5 Domain nghiệp vụ Meeting + Project

- State machine (`meetingStatus.ts`): `scheduled → live → finished` + `scheduled ↔ cancelled`; `normalizeMeetingStatus` map legacy khi đọc. Start (scheduled→live) = host hoặc bất kỳ internal (acting-host rule, gate UI `WaitingForStart`; guest poll 5s chờ live); End-for-all = host; Cancel/Reschedule/Restore/Delete = organizer-only; Delete vĩnh viễn chỉ khi `cancelled` (cascade).
- Form tạo (`ScheduleMeetingForm`) = form sửa (`EditMeetingForm`, 06-11 thêm Host/Co-host) cùng field set: title, schedule, topic, 4 vocabulary (type/discipline/priority/**confidentiality**), Host + Co-host (chỉ internal), waitingRoom/recording toggles (chưa thấy consumer — chưa wire), invitee picker, addToProject. Tạo = 1 call atomic `POST /v1/meetings`; edit = PATCH + diff invitees.
- Invitee model (`data/invite.ts`): `meeting_invitee` (kind internal/guest, role `cohost`/attendee, revoke = soft giữ audit) ≠ `meeting_participant` (ai thực join, email từ JWT). Project model **B+**: `project_member` (internal, thấy cả folder) vs invitee (1 meeting); internal được mời chéo → folder partial; guest meeting-scoped tuyệt đối.
- `MeetingDueNotice`: toast tới giờ, poll calendar 60s, cửa sổ [-10′,+5′], join qua start gate.

### 2.6 Media + AI

- **Audio**: Daily.co SFU (`audio/DailyAudio.ts`, drop-in thay mesh WebRTC cũ — `AudioRoom/AudioPeer/turnConfig` giờ là dead code). Daily room riêng `<roomId>-audio`; mic chỉ xin khi user bấm "Join audio"; socket.id nhét vào Daily token `user_id` để map participant.
- **Screen share** (Phase 1 done): call object Daily thứ 2 trên room `<roomId>`, **lazy-join** (chỉ nối khi mình Present hoặc có peer share), presence + single-share lock qua socket. Token: `GET /v1/daily/token` — Worker giữ `DAILY_API_KEY`, gate `canSeeMeeting`, room private, token 4h.
- **STT**: mic → AudioWorklet downsample 16k PCM → WS `/stt` lên room server → proxy **Deepgram nova-3** (~70 keyterms BIM; lang vi/en/ko/ja/zh/multi). Per-speaker: mỗi tab transcribe chính mình → attribution chính xác không cần diarization. Final segment broadcast socket; transcript persist localStorage + R2 E2E (debounce 5s).
- **Translate**: Gemini qua room server; chat = sender gọi `/translate-batch` 1 lần ra 3 thứ tiếng đính kèm broadcast (fix fan-out); transcript dịch per-viewer (chưa batch).
- **AI summary** (quyết định 06-10 "summary-first"): End-for-all → fire-and-forget `POST /summarize` (room server → Gemini, JSON schema strict) → `POST /v1/meetings/:id/summary` → D1 `meeting.ai_summary` (plaintext queryable, tách khỏi transcript E2E). Gemini lỗi không chặn end. Còn: summary thủ công (`MeetingLogModal`), Canvas bot (`CanvasBotTool` → `/chatbot`, ghi trả lời thành text element); `AIToolsPanel` Summarize + `MCMAssistant` = placeholder.
- **Recording**: host-only soft, mix mic + peers → MediaRecorder webm/opus → **download local máy host**, cố ý không upload (Phase 5: Daily cloud recording → webhook → R2 auth-gated — chưa làm).

### 2.7 Tài liệu kỹ thuật DXF/IFC/PDF + My Files

- `MeetingLibrary.tsx` + `data/meetingLibrary.ts` (`meetingFilesAtom`, cache IndexedDB, dedup fingerprint, tombstone, hydrate merge). Pipeline `ingestFiles`: chỉ nhận image/DXF/PDF/IFC; IFC bake bằng web-ifc WASM trong worker → **GLB** + metadata storeys (port từ Digital Twins ifc-pipeline); PDF probe pdfjs; DXF render bằng dxf-viewer (Three.js).
- Trên canvas: DXF = rectangle anchor + HTML overlay; **PDF & IFC = image element thật** (fileId `pdf-snap-/ifc-snap-`) → nét vẽ/sticker đè lên được; IFC anchor focus mới mount `IFCRenderer` interactive (orbit/storey/pick), thoát focus → bake lại snapshot + persist camera vào `customData`. Snapshot AWAIT PUT R2 xong mới broadcast (chống peer 404).
- Sync: file ≤256KB inline socket E2E; file lớn broadcast metadata-only + PUT per-file R2 nền (≤512MB), peer hydrate retry; fallback inline ≤40MB. Persist: blob library slim (strip bytes lớn) encrypt → `PUT /v1/library/:roomId`, debounce 1.2s; review viewOnly không ghi.
- **My Files** (`MyFilesPanel.tsx` + `/v1/me/files`): tủ cá nhân internal-only, ≤50MB (server 413), bytes R2 `userfiles/<email>/<fileId>` **server-readable** (ngoài meeting không có roomKey), ownership check qua row D1 `user_file`. Copy vào meeting = đi lại pipeline `ingestFiles` → meeting giữ **bản snapshot riêng** (xoá tủ không ảnh hưởng meeting).

---

## 3. Các luồng chính end-to-end

### 3.1 Tạo meeting → Join/Start gate → Collab → End → AI summary → Review

1. **Tạo**: ProjectBrowser → `ScheduleMeetingForm` ("now" | "schedule") → `POST /v1/meetings` atomic (Worker stamp organizer/host từ JWT, status `live`|`scheduled`) → `inviteToMeeting` từng invitee (co-host = role trên invite row).
2. **Join**: tile/link/Resume/DueNotice → `enterRoom()` pushState `#room=id,key` → `startCollaboration` gọi `getMeeting`: `scheduled` → park `startGateAtom` (`WaitingForStart` — internal thấy nút Start = PATCH `status:"live"`; guest poll 5s); `live` → vào thẳng; `finished/cancelled` → review/thoát. Mọi link-join đều phải login trước (hash giữ nguyên qua login).
3. **Collab E2E**: socket join room → eager prefetch scene R2 song song → reconcile; broadcast incremental encrypted; chat/transcript/library/scene autosave debounce/throttle lên R2 qua Worker (JWT + roomGate); host election client-side chạy trên `USER_PROFILE` broadcasts.
4. **End-for-all**: host bấm End (`MeetingHeader`) → PATCH `status:"finished"` (server guard race + terminal) → broadcast `HOST_COMMAND END_MEETING` (peer validate host) → fire-and-forget `/summarize` → Gemini → `ai_summary` vào D1 → mọi client flush pending saves + rời phòng.
5. **Review**: mở lại meeting `finished` (mọi đường vào, kể cả raw `#room` link) → `viewOnly` ép `viewModeEnabled`, mọi persist skip; server-side: PATCH/invite vào finished → 409; (lưu ý gap: blob PUT scenes/chats/library vào meeting finished chưa bị Worker chặn — xem §5). Admin compliance: `POST /v1/admin/meetings/:id/open` (audit bắt buộc trước khi trả key) → stealth read từ R2, không join socket.

### 3.2 Luồng tài liệu DXF/IFC/PDF

```
Upload/drag (hoặc copy từ My Files)
  → ingestFiles: detect theo extension → bake (IFC→GLB worker / PDF probe / DXF lazy)
  → publishLibraryFile: meetingFilesAtom + IndexedDB + seed Excalidraw file map
  → broadcastLibraryFileSmart: ≤256KB inline socket E2E | lớn → metadata ngay + bytes PUT R2 nền
  → insert lên canvas: DXF anchor+overlay | PDF/IFC = image element snapshot (focus IFC → 3D interactive → bake lại)
  → persistLibrary debounce 1.2s → blob slim encrypt → PUT /v1/library/:roomId
Reopen → loadLibrary blob + hydrate per-file R2 song song → merge IDB → re-broadcast
```

---

## 4. D1 schema + R2 layout

### Bảng D1 (12, migrations 0001→0016, runner `worker/migrate.mjs` + `schema_version`)

| Bảng | Vai trò |
|---|---|
| `project` | folder; owner = `host_email` (stamp JWT) |
| `meeting` | registry, `id == roomId`; status canonical; `room_key` managed (trade-off test phase); `ai_summary` server-readable |
| `file` | index per-file R2 trong meeting (kind/name/size) |
| `project_member` | membership nội bộ, role `owner` (last-owner guard) |
| `meeting_invitee` | mời per-meeting; kind internal/guest; role cohost; revoke = soft |
| `meeting_participant` | ai thực join (email từ JWT) |
| `note` | ghi chú per-user (scope+ref+email) |
| `client` | CRM-lite contact (không phải identity) |
| `user_file` | index My Files (ownership) |
| `audit_log` | mọi mutation nhạy cảm + compliance open (audit-before-access) |
| `system_settings` | `internal_domains` admin-editable |
| `deleted_meeting` | tombstone → 410 |
| `schema_version` | migration tracking |

### R2 key prefixes

| Prefix | Mã hoá | Nội dung |
|---|---|---|
| `scenes/<roomId>/current` | E2E roomKey | scene blob `[u32 ver][ivLen][iv][cipher]` |
| `chats/<roomId>/current` | E2E roomKey | chat log |
| `library/<roomId>/current` | E2E roomKey | manifest DXF/IFC/PDF (slim) |
| `transcripts/<roomId>/current` | E2E roomKey | STT log |
| `files/<roomId>/<fileId>` | E2E roomKey | bytes per-file (ảnh, GLB ≤512MB) |
| `userfiles/<email>/<fileId>` | **server-readable** | My Files (≤50MB) |
| `recordings/`, `avatars/` | server-readable | dự kiến (P5 / P2), chưa dùng |

---

## 5. Ranh giới server-enforced vs client-soft + known gaps

### Server-enforced (Worker — thật)
- JWT bắt buộc mọi `/v1/*` (trừ health); admin gate re-check độc lập.
- `canSeeMeeting`/roomGate invited-only (bỏ internal-allow); `confidential` invitee-only; `projectAccess` full/partial/null; guest không thấy folder.
- Organizer-only PATCH/cancel/delete; owner-only project; state machine + race-safe 409; `finished` immutable metadata; organizer/host stamp từ JWT; tombstone 410 + cascade delete.
- Daily token gate membership (`DAILY_API_KEY` server-only); My Files internal + ownership + 50MB 413; compliance open = audit-before-access; `internal_domains` từ D1.

### Client-soft (dev-phase, prod phải nâng cấp)
- **Host election + mọi quyền host** hoàn toàn client-side (payload E2E, server không validate); `USER_PROFILE`/host claim spoofable; kick = client tự rời (vào lại được bằng link); mute = soft-mute.
- **Review read-only** = `viewModeEnabled` client; blob PUT scenes/chats/library vào meeting `finished` **chưa bị Worker chặn** (chỉ chặn deleted 410).
- **Room server socket.io không auth** — ai có roomId join relay được (nội dung vẫn E2E); endpoints AI/STT/translate trên room server không có gate riêng; CORS Worker `*`.
- UI gates (nút Edit/Start/Folder, `INTERNAL_DOMAINS` mirror, lock file library theo username) chỉ là UX.

### Known gaps còn mở (từ docs-roadmap 06-11)
- ~~Remote chưa tồn tại~~ → **(06-11) P1 XONG**: D1/R2/Worker remote live tại `mcm-storage.rnd-ai.workers.dev`, song song local dev; còn lại của track = cutover client (`VITE_APP_STORAGE_URL`) + Pages hosting + khoá CORS/rate-limit/password.
- `room_key` plaintext trong D1 + `mcm:lastMeeting:v1` localStorage — chưa E2E thật.
- Rate-limit chưa có; password demo hardcode; Sentry chưa wire; backup/DR chưa bật; Daily room mồ côi không bị xoá; 2 Daily room/meeting chưa gộp; mesh WebRTC dead code chờ dọn.
- Waiting room per-guest (P4 leftover); recording→R2 (P5); email mời/.ics/recurring; identity email→UUID (P2); compliance live realtime (silent-observer); avatar data-URL chưa lên R2.
- Cost admin = ước tính (recording_minutes/ai_calls = 0); transcript dịch per-viewer chưa batch; waitingRoom/recordingEnabled flag gửi lên nhưng chưa wire consumer.

---

## 6. Kiến trúc đích June demo vs hiện trạng

| Hạng mục | Đích (plan 2026-06-01) | Hiện trạng 06-11 |
|---|---|---|
| Hosting client | Cloudflare Pages | Vite dev :3001 + cloudflared quick-tunnel |
| Realtime | **Durable Object `MeetingRoom`** (raw WS + Hibernation, adapter `RoomSocket`) | socket.io 1 instance trên `room/` (Node, SPOF) — track I-2 |
| AI/STT/TURN | Port lên Worker, `wrangler secret` | Vẫn room server, keys trong `room/.env.development` — track I-1 |
| Auth | Cloudflare Access SSO (`Cf-Access-Jwt-Assertion`) | **Đã rẽ hướng: Supabase Auth** (JWT/JWKS verify trong Worker) — ship Phase 3, hoạt động thật |
| Persistence | R2 ciphertext + D1 remote | ✅ **P1 remote XONG 06-11** (`mcm-storage.rnd-ai.workers.dev`, D1 APAC + R2 + 4 secrets); parity P0 ✅ (migrations SSOT, cùng key-scheme/secret names) — dev vẫn local, cutover client là bước riêng |
| Media | (ngoài plan DO) | Daily.co managed SFU — đã ship P1 screen share + P2 audio |
| E2E | `#room=<id>,<key>`, server chỉ thấy ciphertext | Giữ nguyên wire; nhưng `room_key` managed trong D1 (compliance) |
| Phases | — | ✅ P1/P2/P3/P4.5/Phase A · ⏳ P4 host control (waiting room, co-host live-test) · ⏳ P5 recording · 🏗️ I-1..I-6 · 🟠 Phase 6 hardening |
