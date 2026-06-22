# Hạ tầng MAP CanvasMeet (Canvas M) — đã chốt tới 2026-06-19

> **Trạng thái:** SPEC SỐNG — mô tả hạ tầng **đã chốt + đang chạy LIVE** tới 2026-06-19.
> Nguồn tên/URL thật: [`../runbooks/deploy.md`](../runbooks/deploy.md) (đừng đoán tên).
> Quy trình deploy từng-bước nằm ở deploy.md; doc này là **bức tranh kiến trúc + quyết định + gotcha**.
>
> ⚠️ **`generated/architecture.md` đang STALE** (sinh 2026-06-11): còn mô tả room-server socket.io đã khai tử, §5 known-gaps liệt kê nhiều thứ nay đã đóng. **Cần regenerate** (đừng sửa tay file generated). Trong lúc chưa regen, **doc này + deploy.md là trạng thái hạ tầng ĐÚNG hiện tại.**

Toàn bộ stack **đã online trên Cloudflare** từ 06-17 — không còn máy dev / room server / Fly. Chỉ còn **2 thứ phải deploy**: **Worker** (`mcm-storage`) và **App** (Pages `map-canvasm`).

---

## 1. Bảng STACK thật

| Thành phần | Tên / URL thật | Vai trò |
|---|---|---|
| **App (Pages)** | project `map-canvasm` → `https://map-canvasm.pages.dev` | Frontend tĩnh (Vite, Excalidraw fork). Branch production = `main` (git local = `master`). PWA. |
| **Worker** | `mcm-storage` → `https://mcm-storage.rnd-ai.workers.dev` | **Backend DUY NHẤT**: REST API (R2 blob + D1 metadata) · **realtime Durable Objects** (`RoomDO`) · **AI proxy** (Gemini) · **STT proxy** (Deepgram WS). |
| **D1 (DB)** | `mcm-db` (id `70c15c3f-6dc5-4dbf-bc9e-e011728c7c18`, region APAC, account `rnd_ai`) | Metadata: project/meeting/membership/invitee/knock/notes/`usage_events`/`schema_version`… Migration qua `worker/migrate.mjs`. |
| **R2 (storage)** | bucket `mcm-storage` (binding `BUCKET`) | Blob: scene/chat/transcript/library-file/branding + **`avatars/`** (avatar người dùng, `avatars/<hash>.png`) + `backups/` (cron dump) + `trash/` (soft-delete). Egress free. |
| **Durable Object** | `RoomDO` (binding `ROOM`), trong Worker `mcm-storage` | **1 DO = 1 phòng** realtime; raw WebSocket + Hibernation API (idle → $0). |
| **Auth** | Supabase | JWT/JWKS gate mọi `/v1` (trừ health); nội bộ email/pw 1-click, khách magic-link/synthetic login. |
| **Media (audio + screenshare)** | Daily.co | Audio SFU (`DailyAudio`) + screen share. Cap hiện: room expiry 6h, max 50 participants. |
| **STT** | Deepgram, model **`nova-3`** | Phiên âm live qua Worker `/stt` WS proxy. nova-3 monolingual có `ko`/`vi`/`en`; `multi` KHÔNG có KO/VI → mỗi người phiên âm theo ngôn ngữ mình nói. |
| **Dịch / Summary / Chatbot** | **Gemini 2.5 Flash** | Worker `/translate`, `/translate-batch`, `/summarize`, `/chatbot`. Dịch **per-viewer** (mỗi người xem theo ngôn ngữ của mình). Cần bật "Generative Language API" trong GCP project `365448382193`. |
| **STT provider: Gemini Live** | `gemini-3.5-live-translate-preview` (SẮP — skeleton) | Provider option mới qua REGISTRY (`gemini-live`); cần secret `GEMINI_LIVE_API_KEY`. Đang wire, chưa nối API thật (`stt-provider.ts` trả `null` tới khi xác nhận wire format). |
| **Email** | Resend (`RESEND_*`) | Mời khách qua email/magic-link. |

### Endpoints thêm/đổi (06-19 chiều — surface User Settings + video quality)

| Endpoint | Vai trò |
|---|---|
| `GET /v1/me` | "Who am I" gọn: profile + org row đọc thẳng từ JWT (`decodeJwt`, KHÔNG re-verify — gate đã verify). Trả `email/name/title/division/company/avatar/role/isAdmin/isGuest`. Org fields chỉ có cho nội bộ (guest về rỗng). Tránh fan-out `/v1/directory` (admin-gated) chỉ để render Settings panel. `index.ts:3694`. |
| `PUT /v1/me/avatar` | Upload avatar (Avatar SSOT). Nhận `image/*` raw HOẶC `data:image/...;base64,` body; cap **512KB** (413); lưu R2 `avatars/<hash>.png` (key STABLE = `avatarHash(email)` → re-upload OVERWRITE, không orphan), mirror reference vào Supabase `user_metadata.avatar` (best-effort). Trả `{avatar:"/v1/me/avatar/<hash>.png"}` (relative path, client resolve theo STORAGE_URL). `index.ts:3758`. |
| `GET /v1/me/avatar/:key` | Serve avatar từ R2; JWT-gated nhưng mọi user login đọc được (avatar hiện khắp app). `:key` = hash hex (validate `^[a-f0-9]{1,64}$`, chặn path-traversal khỏi prefix `avatars/`). Cache `private, max-age=86400, must-revalidate` (key stable → overwrite đổi etag). `index.ts:3848`. |
| `GET /v1/config` *(thêm field)* | Bổ sung `video_quality_cap` (∈ `low|medium|high`, default `high`) cạnh `internal_domains`. Client clamp sender resolution theo cap này. `index.ts:1125`. |
| `PUT /v1/admin/settings` *(thêm validate)* | Upsert generic `system_settings`, nhưng nếu body chứa `video_quality_cap` mà KHÔNG hợp enum → **400 cả write** (fail loud, không để value rác lọt row); ghi xong reset `videoQualityCapAt=0` để `/v1/config` isolate này thấy ngay (không lag 60s). `index.ts:6016`. |

**`system_settings` keys liên quan:** `internal_domains`, `daily_room_max_participants`, `daily_room_exp_hours`, **`video_quality_cap`** (mới — `low|medium|high`, default `high`; `readVideoQualityCap` validate enum cả READ lẫn WRITE, cache per-isolate 60s mirror `internalDomains`; `index.ts:4166-4195`).

---

## 2. Sơ đồ luồng (gọn)

```
Client (browser, PWA)
  │
  ▼
Cloudflare Pages (map-canvasm)      ← app tĩnh, VITE_* nhúng lúc build
  │   (gọi API tới Worker thật)
  ▼
Worker mcm-storage  ──────────────────────────────────────────────
  │  REST /v1/*  ──► D1 (mcm-db)  metadata + usage_events
  │             └─► R2 (mcm-storage)  blob (scene/chat/transcript/library/branding, trash/, backups/)
  │
  │  WS realtime  ──► RoomDO (1 DO/phòng)   ← handshake verify JWT+canSeeMeeting+knock TRƯỚC khi 101
  │
  │  WS /stt      ──► STT proxy ──► Deepgram nova-3   (server.binaryType="arraybuffer")
  │
  │  /translate /summarize /chatbot ──► Gemini 2.5 Flash
  │
  └─ /daily/token ──► Daily.co (mint token)   ; media (audio/screenshare) đi thẳng client ↔ Daily SFU
```

- **Realtime**: client mở WS tới Worker; Worker route theo `pathname` — `/stt` đi STT proxy (KHÔNG chạm RoomDO), còn lại upgrade vào `RoomDO`. Handshake verify Supabase JWT → `canSeeMeeting` → knock `admitted` (external) → WS-count cap **trước khi trả `101`** (đóng lỗ relay-không-verify cũ).
- **STT**: client đẩy PCM (clone track mic, downsample trong worklet) → Worker `/stt` WS → forward nhị phân tới Deepgram → transcript về client → (tuỳ chọn) dịch per-viewer qua Gemini.
- **Media**: audio + screenshare KHÔNG qua Worker — client lấy Daily token từ Worker rồi nói chuyện thẳng với Daily SFU.

---

## 3. Quyết định & gotcha đã chốt (đừng tái phạm)

**(a) Realtime = 100% Durable Objects.** Room server socket.io / Fly.io bridge đã **khai tử** (chốt 06-17, `c25a929e`) — dự án đi đa quốc gia (Phi/Africa) nên serverless all-in Cloudflare, không SPOF Node 1-instance. Cờ `realtime_backend` (D1, per-meeting) chỉ là công tắc TẠM trong build/test; meeting mới default `'do'`. Đích = pure DO, bỏ hẳn `room/`.

**(b) AI + STT chạy trên Worker (I-1).** Gemini routes → `worker/src/ai.ts`; Deepgram `/stt` → `worker/src/stt.ts` (WS proxy, route riêng trước DO). Tất cả **JWT-gated** (đóng lỗ cost-abuse public 06-17). Cache/rate-limit **per-isolate** (đủ cho internal; nâng DO/KV-limiter chỉ khi external lạm dụng thật).

**(c) ⚠️ STT binary forward PHẢI `server.binaryType="arraybuffer"`** — **gốc rễ con bug `[object Blob]`** ám STT suốt 06-17/06-18, fix 06-19 (`61bc0b00`, `worker/src/stt.ts`). Cloudflare Workers giao frame nhị phân của client dưới dạng **`Blob`** (không phải `ArrayBuffer` như Node Buffer). `providerWs.send(blob)` coerce Blob thành chuỗi `"[object Blob]"` gửi **text frame** → Deepgram trả `{type:Error, variant:SchemaError}` mỗi frame → STT câm KHẮP NƠI, MỌI provider. Fix 1 dòng `ws.binaryType = "arraybuffer"` trị tất cả. **Bài học:** bug nằm ở **biên runtime** (CF WS giao Blob ≠ Node), chỉ lộ khi dump raw payload lỗi (chrome://inspect trên iPad).

**(d) STT provider seam.** Adapter qua REGISTRY (`worker/src/stt-provider.ts`): `deepgram` (default, đang chạy) · `elevenlabs` · `openai` · `gemini-live` (skeleton). Chọn bằng var `STT_PROVIDER` (global) hoặc per-session `?provider=` (A/B trong họp, không cần đổi global). Id lạ → fallback Deepgram (typo không hạ STT). Gemini Live = `gemini-3.5-live-translate-preview`, chưa nối API thật.

**(e) Dịch per-viewer qua `useTranslate`.** STT + chat đều dùng `preferredLanguageAtom` của **người xem** làm target → mỗi người thấy nội dung theo ngôn ngữ mình chọn, độc lập với ngôn ngữ người nói. `seg.lang='multi'` → `assumedSource=undefined` để backend auto-detect (không dịch sai nguồn). Caption nguồn `translation.ts` / `SpeechToTextPanel.tsx` / `LiveCaptionDock.tsx`.

**(f) Env build.** App là build tĩnh; biến `VITE_*` **nhúng lúc build** từ **ROOT repo**. Bản prod đọc **`.env.production.local` ở ROOT repo** (trỏ app vào Worker thật `mcm-storage` + Supabase). Sai env build = app trỏ nhầm backend, không báo lỗi.

**(g) Caption routing qua `captionSurfaceAtom`.** Selector trung tâm (`captionState.ts`, 06-19) là **nguồn sự thật duy nhất** quyết định **đúng 1 surface** sở hữu caption cho mỗi view → dập double-mount / rò ra canvas trần. 4 case: canvas trần = chỉ panel STT; gallery = dock đáy; viewer + Floating-Presenter = gộp 1 surface; ngôn ngữ đúng viewer. Có toggle CC ở header bật/tắt mọi view.

**(h) Avatar SSOT (single source of truth — 06-19).** Avatar 1 nguồn duy nhất là **account-of-record**: `user_metadata.avatar` ở Supabase, chấp nhận đúng 2 dạng canonical — `lib:NN.png` (gallery built-in) hoặc `/v1/me/avatar/<hash>.png` (R2 upload, do `PUT /v1/me/avatar` sinh). `resolveAvatarUrl` (`data/userProfile.ts:81`) là HÀM resolve duy nhất (lib→`/decorations/avatars/`, R2 ref→`{STORAGE_URL}/v1/me/avatar/...`); `deriveSession` (`data/session.ts:142`) nhận R2 ref vào session để avatar **roam xuyên thiết bị**; icon collaborator trên canvas (cursor/tile) cùng đi qua resolver này → một thay đổi avatar đồng bộ MỌI surface. R2 key STABLE per-identity (`avatarHash(email)`) nên re-upload không tạo blob mồ côi và URL canvas không stale.

**(i) Video quality 3 tầng (06-19).** `videoQuality.ts` là nguồn duy nhất map level→Daily-settings + `clampQuality`. 3 tầng độc lập: (1) **Daily ABR** luôn-on (simulcast `quality-optimized`, tự hạ khi uplink yếu); (2) **trần USER** (`mcm:videoQuality` localStorage, `auto|low|medium|high`); (3) **cap ADMIN** (`system_settings.video_quality_cap` → `/v1/config` → `videoQualityCapAtom`, default `high`). Hiệu lực = `clampQuality(userPref, adminCap)` (auto = ride cap), KHÔNG bao giờ vượt cap dù user chọn cao hơn. `DailyAudio.applyVideoQuality` apply qua `updateInputSettings` (constraints width/height/frameRate, RE-SEND processor blur/image cùng lúc kẻo bị wipe) + `updateSendSettings` (preset). Tier: high 1280×720@30 quality-optimized · medium 960×540@25 balanced · low 640×360@20 bandwidth-optimized.

**(j) Join LISTENER-ONLY (06-19).** User luôn join `audioSource:false` — KHÔNG `getUserMedia` lúc join (mic + camera đều OFF, `localStream=null`), nhưng `subscribeToTracksAutomatically:true` để vẫn NGHE peers. Mic chỉ acquire **on-demand** qua `DailyAudio.ensureMic()` (lần unmute đầu / STT start). Bỏ prompt mic phiền lúc vào phòng + tránh chiếm mic khi chỉ muốn nghe. `DailyAudio.ts:193-244,304`.

**(k) Daily virtual background (06-19, desktop-only).** Blur / company-image qua `updateInputSettings({video:{processor}})` (`toDailyProcessor` map VideoBg→Daily processor shape); Daily no-op trên mobile web. Processor persist trước cả khi camera bật và re-apply mỗi lần đổi resolution (xem (i)).

**Gotcha vận hành (từ deploy.md — nhắc lại để khỏi đốt thời gian):**
- Pages production branch = **`main`** (git local = `master`). Deploy thiếu `--branch=main` → **PREVIEW deployment**, không lên production, không báo lỗi.
- **Set secret bằng bash pipe**, KHÔNG PowerShell `Out-File`/`>` → PowerShell thêm **BOM** vào giá trị secret → 401/502 sau deploy (đã cháy thật 06-17 với `SUPABASE_SERVICE_API_KEY`, `DAILY_API_KEY`, `RESEND_API_KEY`). Worker có `cleanSecret()` guard read-side strip U+FEFF, nhưng vẫn set sạch từ nguồn.
- Cron expression dùng dạng chữ **`0 3 * * SUN`** (CF từ chối số `0 3 * * 0`).
- Sau deploy app: xoá cache Service Worker (PWA `autoUpdate`) hoặc mở incognito, không thì thấy bundle cũ.

---

## 4. Secrets cần có (tên — KHÔNG ghi giá trị)

Set 1 lần bằng `wrangler secret put NAME` trong thư mục `worker/` (deploy sau giữ nguyên). Var **không-bí-mật** (`RESEND_FROM`, `STT_PROVIDER`, `DAILY_ROOM_EXP_HOURS`, `DAILY_ROOM_MAX_PARTICIPANTS`…) nằm trong `wrangler.jsonc`.

| Secret | Dùng cho |
|---|---|
| `GEMINI_API_KEY` | Gemini 2.5 Flash (translate / summarize / chatbot) |
| `DEEPGRAM_API_KEY` | Deepgram nova-3 STT |
| `DAILY_API_KEY` (+ `DAILY_DOMAIN`) | Daily.co token / room (audio + screenshare) |
| `SUPABASE_SERVICE_API_KEY` (+ `SUPABASE_URL`) | Supabase admin (verify, add-member, directory) |
| `RESEND_API_KEY` (+ var `RESEND_FROM`) | Email mời / magic-link |
| `GEMINI_LIVE_API_KEY` | **SẮP** — provider `gemini-live` (`gemini-3.5-live-translate-preview`), set khi wire xong |

> Bindings (KHÔNG phải secret, ở `wrangler.jsonc`): `BUCKET` → R2 `mcm-storage`; `DB` → D1 `mcm-db`; `ROOM` → DO `RoomDO`.
> Chi tiết rotate: `../runbooks/key-rotation.md`. **B3 rotate toàn bộ key vẫn CÒN NỢ** (việc anh Luân, trước khi mở external).

---

## 5. Chi phí / đo đếm

- **`usage_events` (D1)** — mọi lượt AI/STT/media đo vào đây (migration `0026`/`0028`). Metering đã FIX bằng `waitUntil` (06-17). Hiện trên **Admin Console → AI&Cost tab + System-status tab**.
  - Gemini: provider `gemini`, đếm token in/out → ước cost.
  - Deepgram: provider `deepgram`, tính **phút × người** (multi-person STT đắt → cần consent banner cho đa quốc gia).
  - Daily: provider `daily`, kind `media` — ước cost media.
- **Daily caps:** room expiry **6h**, max **50 participants** (hardcode `DAILY_ROOM_EXP_HOURS=6` / `DAILY_ROOM_MAX_PARTICIPANTS=50`). Kế hoạch chuyển sang `system_settings` + ô trong Admin Settings (spec `daily-usage-admin.md`) — **chưa làm**.
- **Hàng rào tiền CỨNG (B1)** = đặt budget/quota ở **dashboard GCP-Gemini + Deepgram + Daily** — **CÒN NỢ, việc anh Luân, ưu tiên #1**. Rate-limit per-isolate ở Worker (B7 ✅) KHÔNG phải trần tiền cứng.
- **Backup:** cron `0 3 * * SUN` dump D1 → R2 `backups/`; soft-delete blob → `trash/` (R2 không có S3 versioning). Còn nợ: R2 lifecycle rule trên `trash/` (việc anh Luân).

---

## 6. Liên quan

- Deploy từng-bước + gotcha: [`../runbooks/deploy.md`](../runbooks/deploy.md)
- Phase / trạng thái: [`../plans/roadmap.md`](../plans/roadmap.md)
- Đồng bộ design-system (token dashboard↔canvas): [`../plans/design-system-unification.md`](../plans/design-system-unification.md)
- Auth: [`supabase-setup.md`](supabase-setup.md) · Admin: [`admin-console.md`](admin-console.md) · Chairman: [`chairman-account.md`](chairman-account.md)
- Kiến trúc sinh-tự-động (STALE, chờ regen): [`../generated/architecture.md`](../generated/architecture.md)
