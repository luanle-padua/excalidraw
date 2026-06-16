# Dev-phase notes — provisional, finalize later

> Đang **develop** (chưa production). Nhiều thứ làm **tạm / soft** để chạy demo, **chưa chính thức**. Doc này neo lại để sau hoàn thiện. Bổ sung cho [roadmap.md](roadmap.md) (feature phases + infra), [host-and-scheduling.md](../specs/host-and-scheduling.md), [admin-console.md](../specs/admin-console.md). Cập nhật 2026-06-16.

## 🚪 Waiting room knock-to-join (Phase 4, 06-16) — đọc kỹ phần "1a vs 1b"

- [x] **Cổng duyệt ép server ở Daily token** (decision **1a**, `plans/waiting-room.md`): external chưa `admitted` → 403 token → **không audio**; blob/meeting routes vẫn qua `canSeeMeeting`. Migration `0025_meeting_knock` (PK room_id+email; status invited|admitted|denied; cooldown 30s server-enforced cho re-knock).
- [ ] **1b — canvas relay VẪN trust-the-key** (🔴 blocker trước khi mở cho khách NGOÀI thật): socket canvas nối room-server gốc (`VITE_APP_WS_SERVER_URL`) **không auth** — ai có `#room=ID,KEY` vẫn đọc/vẽ stroke + presence, dù chưa admitted/chưa mời. Cổng audio + blob đã chặn; canvas thì chưa (lỗi sẵn có, gắn track I-2 Durable Objects / room-server JWT). **Phải đóng trước external exposure.**
- [x] **Kick-via-link đóng cho external** (06-16): external chưa admitted không lấy được Daily token; nhưng canvas vẫn vào được tới khi 1b (xem trên).

## 🔴 Bảo mật / Auth (làm trước khi production)

- [x] **API mở toang**: ĐÃ có per-meeting/project authz (`canSeeMeeting`/`canSeeProject` + roomGate, commit `6d860a69`/`997a09ea` 06-09). Lưu ý dev rule còn lại: **nội bộ pass mọi meeting** — siết về project_member trước prod.
- [x] **Daily-token mint** ĐÃ check membership (`canSeeMeeting` trong `/v1/daily/token`, 06-09).
- [x] **PATCH `/v1/projects/:id` ĐÃ authz** (06-10): chỉ project owner (`project_member.role='owner'`) hoặc admin — đóng finding #4 audit. POST project: internal-only, owner stamp từ JWT + tự insert member row (fix "tạo project xong biến mất", backfill `0014`).
- [x] **canSeeMeeting = invited-only** (06-10): bỏ internal-allow — chỉ organizer/host, invitee active, project_member, admin. Project visibility 3 mức qua `projectAccess`: full (member) / partial (nội bộ được mời ≥1 meeting → folder lọc) / null.
- [x] **PATCH `/v1/meetings/:id` ĐÃ guard state machine** (06-10): value whitelist (400), transition hợp lệ scheduled→live|cancelled · live→finished · cancelled→scheduled (409 nếu sai), **`finished` = immutable** (admin bypass cho ops), huỷ/khôi phục = **organizer-only** (403; legacy không organizer → internal). Organizer/host*email giờ stamp từ **JWT** lúc POST tạo meeting — client không gửi/đổi identity được. *(06-11 verify lại: `scheduled_at` ĐÃ nằm trong `touchesContent` → organizer-only như mọi content field — note "chưa check organizer" cũ là stale.)\_
- [ ] **CORS** Worker `origin:"*"` → khoá về origin thật.
- [ ] **Chưa rate-limit** (Worker + room server).
- [ ] **Mật khẩu mặc định hardcode** (`MapMeet@2026`, `MapAdmin@2026`) + **auto-login 1-click** → bỏ + bắt đổi mật khẩu lần đầu trước prod. (Secrets thật: KHÔNG lộ git, đã verify.)
- [ ] **`room_key` lưu D1** (server đọc được) — chưa E2E thật.
- [x] **Internal domain — WORKER đã đọc `system_settings.internal_domains`** (06-10 P0.2): cache per-isolate 60s, fallback hardcode khi bảng trống — setting admin sửa giờ có hiệu lực THẬT với authz. **(06-11) Client cũng đã đồng bộ**: worker mở `GET /v1/config` (mọi user đã đăng nhập) trả list live; `session.ts` fetch sau login và thay `INTERNAL_DOMAINS` in-place, `AdminConsole.tsx` bỏ hardcode riêng dùng chung `isInternalEmail` — hardcode chỉ còn là fallback offline.
- [ ] **Compliance open meeting LIVE = admin tàng hình** (chốt 06-10): hiện admin mở nội dung qua snapshot R2 không join socket (không hiện presence). Nếu sau này cần xem realtime live thì phải làm silent-observer ở room server.

## 🟠 Host control (Phase 4 — hiện là SOFT enforcement)

- [ ] **HOST_COMMAND tin thẳng** (không validate host election) — peer giả mạo về lý thuyết gửi được lệnh. Prod: server-side validate/enforce.
- [ ] **Kick là client-side**: người bị kick tự rời, nhưng **có thể vào lại bằng link** (chưa chặn ở server). Cần membership + server enforce (gắn Phase 4.5).
- [ ] **Mute là soft-mute** (máy target tự tắt mic) — không phải hard-mute ở server/SFU.
- [ ] **`mutedByHost` chỉ local ở host** — nút toggle theo lệnh host gửi, không theo state thật của peer (icon mic thì đã theo state thật qua AUDIO_STATE).
- [ ] **Acting-host broadcast email** trong room — cân nhắc privacy cho prod (khách thấy email nội bộ?).
- [ ] **Remote mute icon**: cần test 2 máy có **mic thật** (chưa verify).

## 🟡 Data / Migrations

- [x] **Migration tracking ĐÃ có** (06-10 P0.1): bảng `schema_version` + **`worker/migrate.mjs`** — `node migrate.mjs` (local) / `--remote` / `--status`; KHÔNG execute file tay nữa. **(06-11) Remote ĐÃ tạo + 16/16 applied** — D1 `mcm-db` (APAC) + R2 `mcm-storage` + Worker deploy `https://mcm-storage.rnd-ai.workers.dev` (4 secrets đã put). Remote DB trống, client dev vẫn trỏ local; cutover = đổi `VITE_APP_STORAGE_URL`.
- [x] **Wrangler 3 → 4.99** (06-10, lệnh anh Luân) — d1/r2/dev đều OK trên state local cũ; tiến trình `wrangler dev` đang chạy cần restart để dùng bản mới.
- [x] **`meeting.status` ĐÃ chuẩn hoá** (06-10): 1 bộ `scheduled|live|finished|cancelled` — migration `0013_status_canonical.sql` (đã chạy local) + client ghi giá trị chuẩn, đọc tolerant qua `components/mcm/meetingStatus.ts`.
- [ ] **`0025_meeting_knock` mới chạy LOCAL** (06-16) — nhớ `migrate.mjs --remote` khi deploy worker (waiting room sẽ 500 nếu thiếu bảng).
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

_Quy ước: khi một mục được làm CHÍNH THỨC, tick `[x]` + ghi commit. Mục mới phát sinh trong lúc dev → thêm vào đây ngay để khỏi quên._
