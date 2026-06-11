# Supabase Auth — Setup (MCM)

Hướng dẫn cấu hình Supabase Authentication cho MAP CanvasMeet. Auth dùng để **đóng lỗ Worker API** (mọi `/v1/*` trừ `/v1/health` yêu cầu JWT hợp lệ) và là nền cho tải recording bảo mật. Làm 2026-06-05.

Kiến trúc: client đăng nhập bằng Supabase → nhận **access_token (JWT)** → gắn `Authorization: Bearer` vào mọi call Worker → **Worker verify JWT offline** bằng JWKS (ES256). Không có per-request call về Supabase.

---

## 1. Tạo Supabase project

1. Vào **supabase.com** → New project (free tier đủ dùng).
2. Project hiện tại: ref **`hwirblsheoodmjgarumf`** → URL `https://hwirblsheoodmjgarumf.supabase.co`.
3. **Authentication → Providers → Email**: bật (mặc định bật). Tắt "Confirm email" nếu muốn user vào ngay không cần xác nhận (hoặc dùng admin seed với `email_confirm: true` như dưới).

## 2. Lấy keys (Project Settings → API / API Keys)

| Key | Dùng ở đâu | Bí mật? |
|---|---|---|
| **Project URL** | client + worker | không |
| **anon / publishable key** | client (gắn vào supabase-js) | công khai theo thiết kế (chỉ làm được gì RLS cho phép) |
| **secret key** (`sb_secret_…`) | CHỈ server-side (seed user / admin) | 🔴 BÍ MẬT — không bao giờ lên git/client |
| **JWKS** | worker tự fetch | công khai: `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` |

> Project này dùng **asymmetric signing keys (ES256)** — đúng mặc định cho project mới (sau 10/2025). Worker verify bằng JWKS, **không cần lưu JWT secret**. (Kiểm: mở JWKS endpoint thấy `"alg":"ES256"`.)

## 3. Cấu hình env (đều gitignored — KHÔNG commit)

**Client** — `excalidraw/.env.local` (Vite `envDir: "../"` → đọc file ở **repo root**, không phải `excalidraw-app/`):
```
VITE_SUPABASE_URL=https://hwirblsheoodmjgarumf.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

**Worker** — `excalidraw/worker/.dev.vars` (cho `wrangler dev`):
```
SUPABASE_URL=https://hwirblsheoodmjgarumf.supabase.co
SUPABASE_SERVICE_API_KEY=sb_secret_…   # chỉ để seed user, KHÔNG dùng trong runtime gate
```
> Worker gate chỉ cần `SUPABASE_URL` (để dựng issuer + JWKS). `SUPABASE_SERVICE_API_KEY` chỉ cho script seed.

## 4. Cách Worker verify (đã code — `worker/src/index.ts`)

Middleware `app.use("/v1/*", …)` (sau `cors`, trước routes):
- Bỏ qua `/v1/health` (public).
- Đọc `Authorization: Bearer <jwt>` → thiếu = **401**.
- `jose` `createRemoteJWKSet(<JWKS url>)` + `jwtVerify(token, jwks, { issuer: "<url>/auth/v1", audience: "authenticated" })` → sai/hết hạn = **401**.
- OK → `c.set("userId", payload.sub)` + email cho handler dùng (authz sau).
- JWKS cache trong isolate (jose lo) → không gọi Supabase mỗi request.

Client gắn token: `data/fetchWithAuth.ts` (đọc `supabase.auth.getSession()` mỗi call) — **mọi** fetch Worker đi qua đây.

## 5. Seed user nội bộ

Script: **`scripts/seed-supabase-users.mjs`** (dùng admin API + secret key).
```
cd excalidraw
node scripts/seed-supabase-users.mjs
```
- Tạo 5 user "Architectural AI R&D Center" (từ `user.csv`): 유훈/루안/장도진/전희진/진효원 @mapgroup.co.kr.
- **Mật khẩu mặc định: `MapMeet@2026`** (đổi sau / sửa `DEFAULT_PASSWORD` trong script). `email_confirm: true` → đăng nhập ngay.
- `user_metadata`: name (Hàn) / display_name / title / company / division → app hiện **tên Hàn**.
- Idempotent (chạy lại bỏ qua email đã tồn tại). Thêm user mới = thêm vào mảng `USERS` rồi chạy lại.

## 6. Mô hình đăng nhập (đã code)

- **Nội bộ**: email + password. Màn login có **5 nút 1-click** (bấm = đăng nhập luôn bằng mật khẩu mặc định).
- **Khách (client ngoài)**: **magic-link** (nút "Khách? Nhận link đăng nhập qua email") → `signInWithOtp` → Supabase gửi link → click vào → đăng nhập (không cần mật khẩu). `detectSessionInUrl: true` lo phần redirect.
- **Login bắt buộc cho TẤT CẢ** — link mời không còn vào ẩn danh (`MeetingLobby` chặn trước).

## 7. Checklist trước production

- [ ] **Rotate** anon + secret key (key trong repo lịch sử coi như lộ) → cập nhật `.env.local` / `.dev.vars`.
- [ ] Worker deploy: `npx wrangler secret put SUPABASE_URL` (+ set qua dashboard env), KHÔNG để trong code.
- [ ] **Magic-link email**: built-in của Supabase bị **rate-limit mạnh** (~vài/giờ) + dễ vào spam → cấu hình **SMTP riêng** (Authentication → Email) cho khách hàng thật.
- [ ] Khoá **CORS Worker** về origin thật (đang `*`).
- [ ] Đổi mật khẩu mặc định của user nội bộ / bắt đổi lần đầu.
- [ ] (Phase 4) **per-meeting membership** + waiting room — Supabase mới cho *danh tính*, luật "ai vào meeting nào" phải tự viết (D1 + check `userId`/email trong Worker).

## 8. Troubleshooting

- **Mọi call Worker 401**: token không gắn → kiểm call có qua `fetchWithAuth` không; hoặc chưa login; hoặc `SUPABASE_URL` sai ở `.dev.vars` (worker cần restart `wrangler dev` để nạp .dev.vars mới).
- **Login 400** (`token?grant_type=password`): sai email/mật khẩu (autofill điền sai) → 5 nút 1-click dùng đúng `MapMeet@2026`.
- **JWKS / "invalid token"**: project đổi signing key → jose tự refetch JWKS; nếu vẫn lỗi kiểm issuer = `${SUPABASE_URL}/auth/v1`, audience = `authenticated`.
- **Crash `event.key.toLocaleLowerCase()`**: autofill bắn keydown phím undefined lên handler Excalidraw — đã guard `?.` (App.tsx).

Xem [[2026-06-05]] (log) + memory `mcm-auth` cho chi tiết quyết định.
