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
| **R2 (storage)** | bucket `mcm-storage` (binding `BUCKET`) | Blob: scene/chat/transcript/library-file/branding + `backups/` (cron dump) + `trash/` (soft-delete). Egress free. |
| **Durable Object** | `RoomDO` (binding `ROOM`), trong Worker `mcm-storage` | **1 DO = 1 phòng** realtime; raw WebSocket + Hibernation API (idle → $0). |
| **Auth** | Supabase | JWT/JWKS gate mọi `/v1` (trừ health); nội bộ email/pw 1-click, khách magic-link/synthetic login. |
| **Media (audio + screenshare)** | Daily.co | Audio SFU (`DailyAudio`) + screen share. Cap hiện: room expiry 6h, max 50 participants. |
| **STT** | Deepgram, model **`nova-3`** | Phiên âm live qua Worker `/stt` WS proxy. nova-3 monolingual có `ko`/`vi`/`en`; `multi` KHÔNG có KO/VI → mỗi người phiên âm theo ngôn ngữ mình nói. |
| **Dịch / Summary / Chatbot** | **Gemini 2.5 Flash** | Worker `/translate`, `/translate-batch`, `/summarize`, `/chatbot`. Dịch **per-viewer** (mỗi người xem theo ngôn ngữ của mình). Cần bật "Generative Language API" trong GCP project `365448382193`. |
| **STT provider: Gemini Live** | `gemini-3.5-live-translate-preview` (SẮP — skeleton) | Provider option mới qua REGISTRY (`gemini-live`); cần secret `GEMINI_LIVE_API_KEY`. Đang wire, chưa nối API thật (`stt-provider.ts` trả `null` tới khi xác nhận wire format). |
| **Email** | Resend (`RESEND_*`) | Mời khách qua email/magic-link. |

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
