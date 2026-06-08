# MCM Admin Console — spec

> Lớp **back-office** quản trị toàn hệ thống. KHÁC với **Host** (quyền trong 1 cuộc họp — Phase 4). Bàn 2026-06-05. Đây là một track riêng (**Phase A**) trong [roadmap.md](roadmap.md).

## Nguyên tắc
- **Admin = ROLE, account RIÊNG** (không phải meeting user). Account hệ thống: `admin@mapgroup.co.kr` (tạo bằng `scripts/create-admin.mjs`). **Không meeting host nào là admin** (Luan = host, KHÔNG admin).
- Role đặt ở Supabase **`app_metadata.role = "admin"`** — server-set (user không sửa được), **có trong JWT** → Worker check `payload.app_metadata.role === "admin"`.
- Gán/thu hồi admin: `scripts/set-admin.mjs <email>` (cần re-login để JWT mới có role).

## Kiến trúc
- **Worker `/v1/admin/*`** — gate riêng (yêu cầu role admin). Dùng **Supabase service key server-side** cho thao tác user. Nguồn: D1 (meetings/projects) + Supabase Admin API (users) + provider APIs (cost) + bảng D1 mới (`usage_events`, `audit_log`, `system_settings`).
- **Trang `/admin`** trong app (gated theo role) — không tách app riêng.

## Các module (toàn diện — ✅ = đã nêu, ➕ = bổ sung khi nhìn dưới góc admin)

| Module | Admin làm gì | Nguồn | Ưu tiên |
|---|---|---|---|
| ➕ **Dashboard/Overview** | Đang có bao nhiêu meeting LIVE, user online, cost hôm nay, sức khoẻ hệ thống, cảnh báo | tổng hợp | v1 |
| ✅ **Users & Roles** | List/tạo/khoá-ban/reset pass/**set role** (admin/host/member/guest); **import CSV** (như user.csv); last-login; **force logout (session)** | Supabase Admin API | v1 |
| ➕ **Roles & domain rules** | Định nghĩa role + quyền; **auto-admit theo domain** (@mapgroup.co.kr vào thẳng, ngoài → waiting room) | D1 + settings | v1-2 |
| ✅ **Meetings** | List MỌI meeting (mọi host/project); search/filter (ngày/host/status); xem (participants, duration); **force-end**; **xoá (cascade R2)** | D1 | v1 |
| ➕ **Projects** | Quản project folder; đổi owner; archive | D1 | v2 |
| ➕ **Recordings** | List tất cả bản ghi; dung lượng; tải/xoá; **retention policy** | R2 + D1 (Phase 5) | v2 |
| ✅ **Cost & Usage** | Chi phí từng provider; **breakdown theo user/project**; metrics (meeting-phút, recording-phút, AI/STT calls, storage GB); xu hướng; **budget alert** | usage-meter D1 + provider API + link dashboard | v2 |
| ✅ **API / Integrations** | Trạng thái khoẻ Daily/Supabase/Gemini/Deepgram/TURN/Cloudflare; config; quota; **nhắc rotate key** | health-check + config | v2 |
| ➕ **Storage** | R2 usage; **orphan cleanup**; storage theo meeting | R2 + D1 | v2 |
| ➕ **Audit log** | Ai làm gì, khi nào (admin actions, login, xoá, truy cập data) — bảo mật + compliance | D1 `audit_log` | v2 |
| ➕ **Security** | Failed logins; rate-limit hits; banned users; hoạt động bất thường; quản session | D1 + Supabase | v2-3 |
| ➕ **System settings** | Chính sách waiting-room; recording mặc định; retention; **allowed domains**; branding; feature flags | D1 `system_settings` | v2-3 |
| ➕ **Analytics/Reports** | Xu hướng usage; active users; thống kê meeting; feature adoption | D1 (aggregate) | v3 |
| ➕ **Compliance / Data** | **GDPR export/delete** theo user; data residency; legal hold | Worker + R2/D1 | v3 |
| ➕ **Announcements** | Broadcast thông báo tới mọi user (bảo trì...) | socket/DB | v3 |

> **Tóm "còn thiếu gì" so với 4 mảng ban đầu:** Dashboard tổng quan, Roles+domain-rules, Recordings, Storage, **Audit log**, Security/session, **System settings**, Analytics, **Compliance/GDPR**, Announcements.

## Bảng D1 mới cần (cho admin + gắn P4/P5)
- `usage_events(id, type, user_email, meeting_id, qty, unit, ts)` — metering cost.
- `audit_log(id, actor_email, action, target, ts, meta)` — admin/sensitive actions.
- `system_settings(key, value)` — cấu hình hệ thống (domain auto-admit, retention, recording-default...).
- *(P4)* `membership`, `waiting_room`, `meeting.status` — admin cũng đọc/ghi.

## Lộ trình build (Phase A — Admin Console)
- ✅ **A1 (foundation + core):** admin role + Worker `/v1/admin/*` gate + trang `/admin` shell + **Dashboard** + **Users** + **Meetings** + **chi tiết cuộc họp** (project/participant/file) + quick-login admin.
- ✅ **A2 (vận hành):** **Cost & Usage** (estimate + provider billing links) + **API/Integrations status** + **Storage** + **Audit log** (Recordings = placeholder chờ Phase 5).
- ✅ **A3 (chín):** **System settings** (domain nội bộ, waiting-room/recording mặc định, retention) + **Analytics** + **Security overview**. *(Compliance/GDPR + theo dõi đăng nhập sai = cần log-drains → để sau; Announcements = sau.)*
- Polish đã làm: admin = account riêng (không phải host), không cho action lên chính admin, **gom nhóm theo phòng ban + sort theo cấp bậc 직급 + collapse/expand**, tách **Khách hàng (client)** khỏi nội bộ theo domain.

## Phụ thuộc / liên quan
- **Cost** cần **usage-meter** (log `usage_events`) — nên cài sớm để tích luỹ số liệu.
- **Recordings/Storage** gắn **Phase 5** (recording → R2).
- **Roles/domain/waiting-room** gắn **Phase 4** (host control + membership).
- **API backend** (Gemini/Deepgram/TURN) hiện trên room server → khi dời lên Cloudflare (track hạ tầng I-1) thì status/cost dễ đọc hơn.

## Bảo mật
- Service key chỉ ở Worker (server-side), không bao giờ ra client.
- Admin gate kiểm `app_metadata.role` từ JWT đã verify (không tin client).
- Mọi thao tác admin → ghi `audit_log`.
- Đổi mật khẩu admin mặc định (`MapAdmin@2026`) trước production; cân nhắc 2FA cho admin.
