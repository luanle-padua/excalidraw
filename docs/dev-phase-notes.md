# Dev-phase notes — provisional, finalize later

> Đang **develop** (chưa production). Nhiều thứ làm **tạm / soft** để chạy demo, **chưa chính thức**. Doc này neo lại để sau hoàn thiện. Bổ sung cho [roadmap.md](roadmap.md) (feature phases + infra), [host-and-scheduling.md](host-and-scheduling.md), [admin-console.md](admin-console.md). Cập nhật 2026-06-09.

## 🔴 Bảo mật / Auth (làm trước khi production)
- [ ] **API mở toang**: `GET /v1/projects` trả MỌI project; **chưa có per-meeting/project authz** → làm cùng **Phase 4.5** (middleware `can_see_project/meeting/file`).
- [ ] **Daily-token mint chưa check membership** — ai có JWT cũng mint token mọi room.
- [ ] **CORS** Worker `origin:"*"` → khoá về origin thật.
- [ ] **Chưa rate-limit** (Worker + room server).
- [ ] **Mật khẩu mặc định hardcode** (`MapMeet@2026`, `MapAdmin@2026`) + **auto-login 1-click** → bỏ + bắt đổi mật khẩu lần đầu trước prod. (Secrets thật: KHÔNG lộ git, đã verify.)
- [ ] **`room_key` lưu D1** (server đọc được) — chưa E2E thật.
- [ ] **Internal domain hardcode** `@mapgroup.co.kr` (`session.ts`, `AdminConsole.tsx`) → đọc từ `system_settings.internal_domains`.

## 🟠 Host control (Phase 4 — hiện là SOFT enforcement)
- [ ] **HOST_COMMAND tin thẳng** (không validate host election) — peer giả mạo về lý thuyết gửi được lệnh. Prod: server-side validate/enforce.
- [ ] **Kick là client-side**: người bị kick tự rời, nhưng **có thể vào lại bằng link** (chưa chặn ở server). Cần membership + server enforce (gắn Phase 4.5).
- [ ] **Mute là soft-mute** (máy target tự tắt mic) — không phải hard-mute ở server/SFU.
- [ ] **`mutedByHost` chỉ local ở host** — nút toggle theo lệnh host gửi, không theo state thật của peer (icon mic thì đã theo state thật qua AUDIO_STATE).
- [ ] **Acting-host broadcast email** trong room — cân nhắc privacy cho prod (khách thấy email nội bộ?).
- [ ] **Remote mute icon**: cần test 2 máy có **mic thật** (chưa verify).

## 🟡 Data / Migrations
- [ ] **Migrations chưa chạy trên REMOTE D1**: `0005_audit`, `0006_participants`, `0007_settings` (+ `0008/0009` Phase 4.5). Chạy trước deploy prod.
- [ ] **`meeting.status` chưa chuẩn hoá**: DB dùng `Completed/Cancelled`, doc dùng `finished/cancelled` → thống nhất 1 bộ (gắn Phase 4.5).
- [ ] **D1 backup + R2 versioning** chưa có.

## 🟢 Admin console (A1-A3 xong, vài chỗ tạm)
- [ ] **Cost** = ước tính (storage × giá) + link billing — **chưa nối billing API thật** từng provider.
- [ ] **GDPR export/delete** + **failed-login tracking** — cần log-drains → để sau.
- [ ] **Recordings tab** = placeholder (chờ Phase 5).
- [ ] **Seed full org (386 người)**: hiện chỉ Design wing (37) — bỏ filter `KEEP` trong `seed-from-csv.mjs` khi app hoàn thiện.

## 🔵 Audio / Media
- [ ] Test **nghe mic thật** (chưa có máy mic trong lúc dev).
- [ ] **Gộp 2 Daily room** (screen `<id>` + audio `<id>-audio`) thành 1.
- [ ] Dọn **mesh dead code** (`AudioRoom`/`AudioPeer`/`turnConfig`) sau khi verify mic.

## ⚙️ Hạ tầng (chi tiết ở roadmap.md — track I-1..I-6)
- [ ] **AI/STT/TURN backend** đang trên room server → dời lên Cloudflare.
- [ ] **Realtime socket.io** (1 instance) → **Durable Objects**.
- [ ] **Deploy production**: CI/CD, domain thật, staging.
- [ ] **Observability** (Sentry chưa wire) + runbooks (deploy/key-rotation/incident).

---
*Quy ước: khi một mục được làm CHÍNH THỨC, tick `[x]` + ghi commit. Mục mới phát sinh trong lúc dev → thêm vào đây ngay để khỏi quên.*
