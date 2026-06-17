# Runbook — Deploy (Worker + App)

> **Cập nhật lần cuối: 2026-06-17.** Tài liệu này thay thế bản cũ (mô tả "room
> server" socket.io — đã KHAI TỬ). Realtime giờ chạy 100% trên Durable Objects
> bên trong Worker. Để chạy LOCAL (an toàn, không đụng prod) xem
> [`run-local.md`](./run-local.md).

Canvas M giờ chỉ có **2 thứ phải deploy**: **Worker** (`mcm-storage`) và **App**
(Cloudflare Pages, project `map-canvasm`). Không còn server thứ 3 nào nữa.

Tên thật (đừng đoán):

| Thành phần | Tên / URL thật |
| --- | --- |
| Worker | `mcm-storage` → `https://mcm-storage.rnd-ai.workers.dev` |
| App (Pages) | project `map-canvasm` → `https://map-canvasm.pages.dev` |
| D1 (DB) | `mcm-db` (id `70c15c3f-6dc5-4dbf-bc9e-e011728c7c18`, region APAC, account `rnd_ai`) |
| R2 (storage) | bucket `mcm-storage` |
| Auth | Supabase |
| Media (screen share / audio) | Daily.co |
| App build output | `excalidraw-app/build` |

Cần đăng nhập Cloudflare 1 lần/máy:

```bash
cd worker
npx wrangler login
```

---

## 1. Worker (`mcm-storage`)

Worker là backend duy nhất: API lưu trữ (R2 blob + D1 metadata), **realtime
Durable Objects** (`RoomDO`, 1 instance/phòng), **AI** (Gemini: dịch / chatbot /
summarize) và **STT** (Deepgram `/stt`). Tất cả AI/STT đo đếm vào bảng
`usage_events`. Deploy gồm 2 bước: **chạy migration D1 trước**, rồi deploy code.

### 1a. Áp migration D1 lên remote

`migrate.mjs` tự quét `worker/schema/NNNN_*.sql` theo thứ tự tên file, ghi nhận
file nào đã áp vào bảng `schema_version`, và chỉ chạy file còn thiếu. **Đừng**
chạy `wrangler d1 execute --file` bằng tay (sẽ làm lệch tracking).

```bash
cd worker

# Xem trạng thái (không đổi gì): file nào đã áp / còn PENDING trên remote
node migrate.mjs --status --remote

# Áp các migration còn thiếu lên D1 thật (mcm-db)
node migrate.mjs --remote
```

Thêm schema mới chỉ cần đặt file `worker/schema/NNNN_ten.sql` (số tăng dần) —
`migrate.mjs` tự nhận, không cần sửa script.

### 1b. Deploy code Worker

```bash
cd worker
npx wrangler deploy
```

Lệnh này đẩy `src/index.ts` + `RoomDO`, đọc binding từ `wrangler.jsonc`
(`BUCKET` → R2 `mcm-storage`, `DB` → D1 `mcm-db`, `ROOM` → Durable Object
`RoomDO`) và các var không-bí-mật (`RESEND_FROM`, `STT_PROVIDER`, ...).

#### Secret (KHÔNG nằm trong wrangler.jsonc)

Set 1 lần bằng `wrangler secret put NAME` (deploy sau giữ nguyên):
`RESEND_API_KEY`, `DAILY_API_KEY`, `SUPABASE_SERVICE_API_KEY`,
`GEMINI_API_KEY`, `DEEPGRAM_API_KEY` (xem `key-rotation.md`).

> ⚠️ **Set secret bằng bash pipe — TUYỆT ĐỐI KHÔNG dùng PowerShell `Out-File` /
> `>`.** PowerShell ghi file UTF-8 kèm **BOM**, BOM lẫn vào giá trị secret và
> làm hỏng nó (ví dụ `SUPABASE_SERVICE_API_KEY` méo → 401 sau deploy). Cách
> đúng:
> ```bash
> printf '%s' 'gia-tri-secret' | npx wrangler secret put SUPABASE_SERVICE_API_KEY
> ```

#### Cron Trigger (backup tự động hằng tuần)

`wrangler.jsonc` khai báo `triggers.crons: ["0 3 * * SUN"]` (Chủ nhật 03:00 UTC →
gọi `scheduled()` dump D1 ra R2 `backups/`). Khi `wrangler deploy` chạy, nó cố
**đăng ký cron luôn**.

> ⚠️ **Gotcha (đã gặp thật 06-17):** Cloudflare **TỪ CHỐI** chuỗi cron dạng số
> ngày-trong-tuần `0 3 * * 0` — `wrangler deploy` báo `Some triggers failed to
> deploy ... /schedules failed` (và dashboard báo `validate 400`). KHÔNG phải do
> token thiếu quyền. **Cách đúng: dùng dạng chữ `0 3 * * SUN`** — cả `wrangler
> deploy` lẫn dashboard đều nhận (`schedule: 0 3 * * SUN`, không lỗi).
> Nếu cần set tay: Cloudflare → **Workers & Pages → `mcm-storage` → Settings →
> Triggers → Cron Triggers → tab "Cron expression" → `0 3 * * SUN`**.

---

## 2. App → Cloudflare Pages (project `map-canvasm`)

App là build tĩnh (Vite). Build ở **root repo**, output ra `excalidraw-app/build`.
Biến `VITE_*` được **nhúng lúc build** (đọc từ root repo, xem `run-local.md`).
Bản prod đọc `.env.production.local` (trỏ app vào Worker thật + Supabase).

### 2a. Build

```bash
# ở root repo (D:\...\excalidraw)
yarn build
```

Output: `excalidraw-app/build` (`outDir: "build"` trong
`excalidraw-app/vite.config.mts`).

### 2b. Deploy lên Pages

```bash
npx wrangler pages deploy excalidraw-app/build --project-name=map-canvasm --branch=main
```

> 🚨 **GOTCHA QUAN TRỌNG NHẤT — nhánh production của Pages là `main`, nhưng git
> local là `master`.**
>
> Deploy mà **thiếu `--branch=main`** (hoặc lỡ ghi `--branch=master`) → Cloudflare
> coi đó là **PREVIEW deployment**. Preview **KHÔNG** cập nhật
> `https://map-canvasm.pages.dev` → thay đổi **âm thầm không lên production**,
> không báo lỗi gì. Đây chính là lỗi đã đốt thời gian debug hôm 06-17.
> **Luôn luôn** kèm `--branch=main`.

> Pages **KHÔNG** nối Git (không auto-build khi push). Deploy **luôn thủ công**
> bằng lệnh trên. `git push` chỉ để **backup code lên GitHub**, không deploy gì.

### 2c. Sau khi deploy: xóa cache Service Worker

App là PWA (`registerType: "autoUpdate"`). Sau deploy, **service worker vẫn cache
bundle CŨ** → user mở lại vẫn thấy bản cũ. Để thấy bản mới:

- DevTools → **Application → Service Workers → Unregister** rồi reload, **hoặc**
- mở **tab incognito / cửa sổ mới sạch**.

Nhớ note cho người test/khách: nếu "deploy rồi mà không thấy đổi" → 90% là SW cache.

---

## Thứ tự deploy + smoke check

Deploy theo thứ tự (cái sau phụ thuộc cái trước):

1. **D1 migration** — `cd worker && node migrate.mjs --status --remote` rồi
   `node migrate.mjs --remote`.
2. **Worker** — `cd worker && npx wrangler deploy`. Đã set đủ secret chưa?
   Cron đăng ký được chưa (nếu không → thêm tay trên dashboard)?
3. **App (Pages)** — kiểm tra `.env.production.local` trỏ đúng Worker thật →
   `yarn build` → `npx wrangler pages deploy excalidraw-app/build --project-name=map-canvasm --branch=main`.

Smoke check end-to-end (mở `https://map-canvasm.pages.dev`, **tab incognito** để
khỏi dính SW cache):

- [ ] Login Supabase được.
- [ ] Tạo / mở 1 meeting → canvas load (Worker `/v1/scenes` OK).
- [ ] Người thứ 2 vào cùng phòng → thấy con trỏ nhau (Durable Object realtime OK).
- [ ] Gửi chat + bật dịch → có bản dịch (Gemini OK, chạy trên Worker).
- [ ] Bật subtitle/STT → có transcript (Deepgram `/stt` OK, chạy trên Worker).
- [ ] Mời 1 khách qua email → nhận được link (Resend OK).
- [ ] Bấm Present (screen share) → join được (Daily.co OK).

Nếu một feature 500 ngay sau deploy → khả năng cao migration chưa áp remote:
`cd worker && node migrate.mjs --remote` (xem `incident.md`). Nếu auth/Supabase
401 → kiểm tra secret có dính BOM không (mục 1b).

---

## Backup & data lifecycle

Worker tự lo backup, không cần job ngoài:

- Admin Console: **"Backup DB"** (dump thủ công) + **"Archive & Delete project"**.
- **Cron Trigger** hằng tuần → dump D1 ra R2 `backups/`.
- Xóa mềm qua `trash/` (soft-delete, không hard-delete).

Chi tiết + cách restore: [`backup.md`](./backup.md).
