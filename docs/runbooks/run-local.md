# Runbook — Chạy LOCAL (an toàn, không đụng prod)

> **Cập nhật lần cuối: 2026-06-17.** Mục tiêu: chạy toàn bộ Canvas M trên máy
> mình, **cách ly hoàn toàn khỏi production** (D1 / R2 / Durable Objects đều là
> bản local-emulation của `wrangler dev`). Không lệnh nào ở đây đụng tới dữ liệu
> thật. Để DEPLOY lên prod xem [`deploy.md`](./deploy.md).

## Chạy nhanh — `run-local.bat`

Ở **root repo** (`D:\...\excalidraw`), double-click hoặc chạy:

```bash
run-local.bat
```

Nó làm 3 việc, theo thứ tự:

1. `node migrate.mjs` (trong `worker/`) — áp migration lên **D1 LOCAL**
   (KHÔNG có `--remote`, nên không đụng DB thật).
2. `npx wrangler dev` — chạy **Worker @ :8787** với R2 / D1 / Durable Objects
   **emulation local**.
3. `yarn start` — chạy **app @ :3000** (Vite dev server).

Mở 2 cửa sổ (WORKER + APP). Vào trình duyệt: `http://localhost:3000`.
Tắt = đóng 2 cửa sổ. **Toàn bộ dữ liệu là local.**

`run-local.bat` được thiết kế để **không bao giờ** chạy `wrangler deploy` hay
`migrate.mjs --remote`, nên không thể vô tình đẩy lên prod.

## Secret local — `worker/.dev.vars`

Secret cho `wrangler dev` nằm ở **`worker/.dev.vars`** (đây là secret LOCAL,
KHÔNG phải prod). Nếu thiếu file này thì login / AI / Daily sẽ fail —
`run-local.bat` sẽ cảnh báo. Tạo từ `.dev.vars.example`.

> Secret **PROD** thì khác hẳn: set bằng `npx wrangler secret put NAME` (xem
> `deploy.md` mục 1b — và nhớ dùng bash pipe, KHÔNG dùng PowerShell `Out-File`
> vì nó nhét BOM làm hỏng secret).

## Biến `VITE_*` của app — đọc từ ROOT REPO

App đọc env từ **root repo**, không phải từ `excalidraw-app/` (Vite
`envDir: "../"` trong `excalidraw-app/vite.config.mts`). Các file env thật trong
repo:

| File | Dùng khi | Vai trò |
| --- | --- | --- |
| `.env.development` | `yarn start` (dev) | Mặc định dev (WS proxy localhost, v.v.) |
| `.env.local` | mọi mode | Override local — đặt `VITE_APP_STORAGE_URL=http://localhost:8787` (trỏ app vào Worker local) + Supabase URL |
| `.env.production` | `yarn build` (prod) | Base prod (kế thừa từ upstream) |
| `.env.production.local` | `yarn build` (prod) | **Trỏ app vào Worker thật** `https://mcm-storage.rnd-ai.workers.dev` + Supabase. Đây là file quyết định bản prod gọi đâu. |

Quy tắc Vite: mode `development` nạp `.env` → `.env.development` → `.env.local`;
mode `production` nạp `.env` → `.env.production` → `.env.production.local` (file
`*.local` thắng). Vì là build tĩnh, đổi `VITE_*` thì phải **build lại**, không
đổi runtime.

> Cảnh báo: file `*.local` chứa secret/anon-key nên **đừng commit**. Anon key
> Supabase là public-by-design (không phải service key).

## Khác biệt LOCAL vs PROD (1 bảng)

| | LOCAL (`run-local.bat`) | PROD |
| --- | --- | --- |
| Worker | `wrangler dev` @ :8787 | `mcm-storage.rnd-ai.workers.dev` |
| D1 / R2 / DO | emulation local | `mcm-db` / `mcm-storage` / `RoomDO` thật |
| App | `yarn start` @ :3000 | Cloudflare Pages `map-canvasm.pages.dev` |
| Worker secret | `worker/.dev.vars` | `wrangler secret put` |
| App env | `.env.development` + `.env.local` | `.env.production.local` |
