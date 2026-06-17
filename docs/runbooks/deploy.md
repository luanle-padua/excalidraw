# Runbook — Deploy (Worker · App · Room server)

Hướng dẫn deploy 3 thành phần của Canvas M. Làm theo đúng thứ tự ở
[Thứ tự deploy + smoke check](#thứ-tự-deploy--smoke-check) cuối file.

Tên thật (đừng đoán):
- Worker: `mcm-storage` → `https://mcm-storage.<account>.workers.dev`
- D1: `mcm-db` (id `70c15c3f-6dc5-4dbf-bc9e-e011728c7c18`, region APAC, account `rnd_ai`)
- R2 bucket: `mcm-storage`
- App build output: `excalidraw-app/build`

Cần đăng nhập Cloudflare trước (1 lần/máy):

```bash
cd worker
npx wrangler login
```

---

## 1. Worker (`mcm-storage`)

Worker giữ API lưu trữ (R2 blob + D1 metadata). Deploy gồm 2 bước: **chạy migration D1 trước**, rồi mới deploy code.

### 1a. Áp migration D1 lên remote

`migrate.mjs` là trình chạy migration chuẩn. Nó tự quét `worker/schema/NNNN_*.sql`
theo thứ tự tên file, ghi nhận file nào đã áp vào bảng `schema_version`, và chỉ
chạy file còn thiếu. **Đừng** chạy `wrangler d1 execute --file` bằng tay (sẽ làm
lệch tracking).

```bash
cd worker

# Xem trạng thái trước (không đổi gì): file nào đã áp / còn PENDING trên remote
node migrate.mjs --status --remote

# Áp các migration còn thiếu lên D1 thật (mcm-db)
node migrate.mjs --remote
```

Khi thêm schema mới chỉ cần đặt file `worker/schema/NNNN_ten.sql` (số NNNN tăng dần)
— `migrate.mjs` tự nhận file mới, không cần sửa script.

### 1b. Deploy code Worker

```bash
cd worker
npx wrangler deploy
```

Lệnh này đẩy `src/index.ts`, đọc binding từ `wrangler.jsonc` (BUCKET → R2 `mcm-storage`,
DB → D1 `mcm-db`) và var `RESEND_FROM` + `ALLOWED_ORIGINS`.

> Secret KHÔNG nằm trong `wrangler.jsonc`. Lần đầu deploy phải set secret bằng
> `npx wrangler secret put NAME` (xem `key-rotation.md`): `RESEND_API_KEY`,
> `DAILY_API_KEY`, `SUPABASE_SERVICE_API_KEY`. Đã set 1 lần thì deploy sau giữ nguyên.

`ALLOWED_ORIGINS` (var trong `wrangler.jsonc`) là danh sách origin production được gọi
`/v1`, phân tách bằng dấu phẩy (vd `https://app.mapgroup.co.kr`). localhost / `*.pages.dev`
/ `*.workers.dev` / quick-tunnel luôn được phép sẵn.

---

## 2. App → Cloudflare Pages (B10)

App là build tĩnh (Vite). Build ở **root repo**, output ra `excalidraw-app/build`.

### 2a. Build

```bash
# ở root repo (D:\...\excalidraw)
yarn build
```

Output: `excalidraw-app/build` (cấu hình `outDir: "build"` trong
`excalidraw-app/vite.config.mts`).

### 2b. Deploy lên Pages

Hai cách, chọn một:

**(a) CLI — đẩy thẳng thư mục build:**

```bash
npx wrangler pages deploy excalidraw-app/build --project-name=<ten-project-pages>
```

**(b) Dashboard Git:** Cloudflare Pages → Create project → Connect to Git → trỏ vào repo,
đặt build command `yarn build`, output dir `excalidraw-app/build`. Mỗi lần push lên
nhánh production, Pages tự build + deploy.

URL ra là `https://<ten-project>.pages.dev` (domain thật gắn sau).

### 2c. Biến môi trường phải set trong Pages

App là build tĩnh nên các biến `VITE_*` được **nhúng lúc build** — phải khai báo trong
Pages (Settings → Environment variables, scope Production) trước/khi build:

| Biến | Giá trị | Ghi chú |
| --- | --- | --- |
| `VITE_APP_STORAGE_URL` | `https://mcm-storage.<account>.workers.dev` | URL Worker (API lưu trữ + projects/meetings/auth-admin). Bắt buộc. |
| `VITE_APP_WS_SERVER_URL` | URL room server (vd `https://room.<domain>` hoặc `http://<ip>:3002`) | Socket.io collab + STT. Bắt buộc. |
| `VITE_SUPABASE_URL` | URL project Supabase | Auth (login). |
| `VITE_SUPABASE_ANON_KEY` | anon/public key của Supabase | Auth — đây là key public, KHÔNG phải service key. |

> Daily.co (screen share) chạy server-side trong Worker (`DAILY_API_KEY` / `DAILY_DOMAIN`),
> KHÔNG có biến public ở app. Đừng thêm key Daily vào Pages.

Đổi `VITE_*` thì phải **build + deploy lại** (giá trị đã nhúng vào bundle, không đổi runtime).

---

## 3. Room server → host (B11)

Là Node socket.io server (`room/`, package `excalidraw-portal`). Phục vụ realtime canvas,
proxy dịch (Gemini) và STT (Deepgram). Cổng mặc định **80** ở production (override bằng
`PORT`), **3002** ở dev. Nó giữ secret `GEMINI_API_KEY` + `DEEPGRAM_API_KEY` trong file
`.env` **trên host** (không qua Cloudflare).

> Uptime check: `GET /health` → `{ "ok": true, "uptime": <giây> }` (HTTP 200) — dùng cho
> PM2/monitor. Route gốc `GET /` cũng trả `Excalidraw collaboration server is up :)`.

### Cách A — VM nhỏ ở APAC + PM2

```bash
cd room

# tạo file secret production (không commit)
cp .env.development.example .env.production
# rồi mở .env.production điền GEMINI_API_KEY, DEEPGRAM_API_KEY
# (PORT=80 hoặc cổng reverse-proxy dùng)

npm ci
npm run build          # tsc → dist/index.js
pm2 start pm2.production.json
pm2 save               # lưu process list để pm2 resurrect sau reboot
```

`pm2.production.json` chạy `./dist/index.js` (process `excalidraw-collab`, fork mode,
`NODE_ENV=production`, autorestart, max 4G). Xem log:

```bash
pm2 logs excalidraw-collab
pm2 restart excalidraw-collab
```

### Cách B — Docker

`room/Dockerfile` build từ source (`yarn build`) và `EXPOSE 80`, chạy `yarn start`
(`node dist/index.js`).

```bash
cd room
docker build -t mcm-room .
docker run -d --name mcm-room \
  -p 80:80 \
  --env-file .env.production \
  --restart unless-stopped \
  mcm-room
```

`--env-file` nạp `GEMINI_API_KEY` / `DEEPGRAM_API_KEY`. Probe: `curl http://<host>/`.

---

## Thứ tự deploy + smoke check

Deploy theo thứ tự này (mỗi cái phụ thuộc cái trước):

1. **D1 migration** — `cd worker && node migrate.mjs --status --remote` rồi `node migrate.mjs --remote`.
2. **Worker** — `npx wrangler deploy`. Smoke: mở `https://mcm-storage.<account>.workers.dev/`
   (không 500). Đã set đủ secret chưa? (`RESEND_API_KEY`, `DAILY_API_KEY`, `SUPABASE_SERVICE_API_KEY`).
3. **Room server** — deploy/restart trên host. Smoke: `curl http://<host>/` trả
   `Excalidraw collaboration server is up :)`.
4. **App (Pages)** — kiểm tra `VITE_APP_STORAGE_URL` + `VITE_APP_WS_SERVER_URL` trỏ đúng
   Worker/Room ở trên → `yarn build` → `wrangler pages deploy ...`.

Smoke check end-to-end sau khi cả 4 xong:

- [ ] Mở `https://<project>.pages.dev` → login Supabase được.
- [ ] Tạo / mở 1 meeting → canvas load (Worker `/v1/scenes` OK).
- [ ] Có người thứ 2 vào cùng phòng → thấy con trỏ nhau (room server OK).
- [ ] Gửi chat + bật dịch → có bản dịch (Gemini key OK).
- [ ] Bật subtitle/STT → có transcript (Deepgram key OK).
- [ ] Mời 1 khách qua email → nhận được link (Resend key OK).
- [ ] Bấm Present (screen share) → join được (Daily key OK).

Nếu một feature 500 ngay sau deploy → khả năng cao migration chưa áp remote:
`cd worker && node migrate.mjs --remote` (xem `incident.md`).
