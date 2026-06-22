# Runbook — Key rotation (xoay toàn bộ secret)

Mọi key từng commit vào repo phải coi như **đã lộ** → tạo mới hết, gỡ key cũ.
Nguyên tắc: **tạo key mới trước**, set vào worker/host, deploy/restart, xác nhận
chạy được, **rồi mới revoke key cũ** (tránh downtime).

Nơi secret sống:
- **Worker (`mcm-storage`)** — set bằng `npx wrangler secret put NAME` (chạy trong `worker/`).
  Đã set là lưu trong Cloudflare, không nằm trong file. **Mọi secret (gồm AI/STT) giờ ở đây
  — room server đã retire 06-17.**
- **Local dev Worker** — `worker/.dev.vars` (gitignored).

---

## Bảng xoay secret

| Secret | Dùng ở đâu | Tạo mới (dashboard) | Set vào đâu | Revoke key cũ |
| --- | --- | --- | --- | --- |
| `RESEND_API_KEY` | Worker (gửi email mời khách) | resend.com → API Keys → Create | Worker: `npx wrangler secret put RESEND_API_KEY` (trong `worker/`). Local: `worker/.dev.vars` | Resend → API Keys → xoá key cũ |
| `DAILY_API_KEY` | Worker (screen share) | dashboard.daily.co → Developers → API keys | Worker: `npx wrangler secret put DAILY_API_KEY`. Local: `worker/.dev.vars` | Daily → revoke/delete key cũ |
| `SUPABASE_SERVICE_API_KEY` | Worker (admin user mgmt — service role) | Supabase → Project → Settings → API → service_role (Reset/Rotate) | Worker: `npx wrangler secret put SUPABASE_SERVICE_API_KEY`. Local: `worker/.dev.vars` | Supabase → Settings → API → rotate (key cũ tự vô hiệu khi rotate) |
| `GEMINI_API_KEY` | Worker (dịch chat / summary) | Google AI Studio (aistudio.google.com → API keys) hoặc Google Cloud Console | Worker: `npx wrangler secret put GEMINI_API_KEY` (trong `worker/`). Local: `worker/.dev.vars` | AI Studio / Cloud Console → xoá key cũ |
| `DEEPGRAM_API_KEY` | Worker (STT live) | console.deepgram.com → API Keys → Create | Worker: `npx wrangler secret put DEEPGRAM_API_KEY`. Local: `worker/.dev.vars` | Deepgram → API Keys → xoá key cũ |

> `SUPABASE_ANON_KEY` (dùng ở app, public) KHÔNG phải secret — nó công khai theo thiết kế.
> Khi rotate service_role, anon key có thể đổi tuỳ thao tác → kiểm tra lại
> `VITE_SUPABASE_ANON_KEY` trong Pages còn đúng không.

> **`CLOUDFLARE_TURN` (token TURN) — KHÔNG còn dùng.** Code TURN đã gỡ 06-17.
> Chỉ cần **revoke** token cũ ở Cloudflare (Calls/TURN), KHÔNG tạo lại, KHÔNG set lại.

---

## Lệnh mẫu

### Worker (chạy trong `worker/`)

```bash
cd worker
npx wrangler secret put RESEND_API_KEY            # dán key mới khi được hỏi
npx wrangler secret put DAILY_API_KEY
npx wrangler secret put SUPABASE_SERVICE_API_KEY
npx wrangler secret put GEMINI_API_KEY            # AI/STT giờ ở Worker (room đã retire)
npx wrangler secret put DEEPGRAM_API_KEY

# xem danh sách secret đang set (không lộ giá trị)
npx wrangler secret list

# deploy lại để chắc chắn worker chạy với secret mới
npx wrangler deploy
```

Cập nhật `worker/.dev.vars` cho dev local (file dạng `KEY=value`, mỗi dòng 1 secret),
ví dụ:

```
RESEND_API_KEY=...
DAILY_API_KEY=...
SUPABASE_SERVICE_API_KEY=...
GEMINI_API_KEY=...
DEEPGRAM_API_KEY=...
```

---

## Sau khi xoay xong — checklist

- [ ] Email mời khách gửi được → `RESEND_API_KEY` OK.
- [ ] Present / screen share join được → `DAILY_API_KEY` OK.
- [ ] Trang admin (quản lý user) chạy → `SUPABASE_SERVICE_API_KEY` OK.
- [ ] Dịch chat ra → `GEMINI_API_KEY` OK.
- [ ] Subtitle/STT ra transcript → `DEEPGRAM_API_KEY` OK.
- [ ] Đã **revoke** mọi key cũ ở từng provider (gồm cả token TURN cũ).
- [ ] Đã xoá key cũ khỏi mọi file local đã lộ.
