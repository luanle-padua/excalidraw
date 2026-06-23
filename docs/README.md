# MAP CanvasMeet — Tài liệu dự án

Tool họp nội bộ trên nền Excalidraw fork: canvas chung realtime, chat + AI bot, dịch/STT, viewer DXF/IFC/PDF, screen share (Daily.co), auth Supabase, backend Cloudflare Worker + D1 + R2. Bắt đầu 2026-05-08.

## Đọc theo thứ tự này (người mới / quay lại sau nghỉ)

1. **`specs/infrastructure.md`** — **Hạ tầng đã chốt tới 2026-06-19** (bảng stack thật, sơ đồ luồng, decisions/gotchas, secrets, chi phí). Đọc TRƯỚC để nắm hạ tầng hiện tại. ⚠️ `generated/architecture.md` (sinh 2026-06-11) đang **STALE** — realtime giờ là Durable Objects, AI/STT trên Worker, app trên Cloudflare Pages; chờ regenerate. Trạng thái hạ tầng + deploy ĐÚNG hiện tại nằm ở `specs/infrastructure.md` + `runbooks/deploy.md`.
2. **`plans/master-plan-4-groups.md`** — Việc SẮP LÀM, chia 4 nhóm, thứ tự đã chốt với anh Luân 06-11. Đây là "kim chỉ nam" hiện hành.
3. **`plans/roadmap.md`** — Phase nào xong / đang dở (nguồn chuẩn duy nhất về phase).
4. **`plans/production-data-plan.md`** + **`plans/dev-phase-notes.md`** — Kế hoạch dữ liệu production và danh sách "việc tạm cần finalize".
5. **`specs/`** — Đọc KHI CẦN chi tiết thiết kế: host & lịch họp (`host-and-scheduling.md`), admin console (`admin-console.md`), model user (`user-data-model.md`), cấu hình auth (`supabase-setup.md`).
6. **`plans/waiting-room.md`** — Phòng chờ knock-to-join (Phase 4, ship 06-16, chốt 1a về auth canvas relay + ghi chú bảo mật production).
7. **`plans/client-portal.md`** — Thiết kế cổng khách (tách khỏi dashboard nhân viên, chốt 06-15; shell Glass-Desk đã ship 06-16, các panel cộng thêm materials/RSVP/recap còn hoãn).
7b. **`plans/design-system-unification.md`** — Chiến lược hợp nhất design-system token dashboard(Glass-Desk)↔canvas (06-19, mới có plan, chưa thực thi; P0→P3, 2 quyết định P3 treo: accent hue + typography).
7c. **`plans/meeting-package.md`** — Bản tổng kết sau họp (**SHIPPED 06-23**): curate → recap[board+summary+chat+files+attachment] → audience(+picker) → publish → distribution → management(unpublish/soft-delete/revoke) → export zip. Schema 0032+0034.
7d. **`plans/meeting-event-log.md`** — Dòng thời gian thống nhất server-đọc-được (**P1 MVP LIVE 06-23**, schema 0033 + consent gate). **REFRAME 06-23: tầng THÔNG TIN DỰ ÁN, không phải giám sát.**
7e. **`plans/event-log-privacy-analysis.md`** — Phân tích rủi ro PHÁP LÝ event-log + Chairman (06-23): covert + profiling = rủi ro cao; **disclosure + consent = đường an toàn**. Đọc TRƯỚC khi bật ra khách ngoài / Phi.
7f. **`specs/chairman-account.md`** — ⚠️ **REVISED 06-23**: stealth/chấm-điểm-người/quyền-tối-thượng = **SUPERSEDED**; reframe sang lãnh đạo đọc thông tin dự án CÓ CÔNG BỐ + consent.
8. **`audits/`** — Ảnh chụp đánh giá tại từng mốc (tên có ngày). Đọc khi cần hiểu "vì sao hồi đó quyết định vậy". KHÔNG coi là trạng thái hiện tại.
9. **`logs/`** — Nhật ký từng phiên làm việc (tiếng Việt), chi tiết kỹ thuật
   - gotchas. Tra cứu khi cần biết "hôm đó đã làm gì, vướng gì".
10. **`runbooks/`** — Hướng dẫn vận hành từng-bước, copy-paste được: chạy local (`run-local.md`), deploy (`deploy.md` — Worker + Pages, có gotcha `--branch=main`), backup/restore (`backup.md`), xoay key (`key-rotation.md`), xử lý sự cố (`incident.md`).

## Dòng thời gian dự án (qua logs/)

| Ngày | Mốc |
| --- | --- |
| 05-08 | Realtime collab chạy được qua Cloudflare Tunnel |
| 05-29 | AI bot trong canvas + attribution tác giả |
| 06-01 | Chốt kế hoạch hạ tầng Cloudflare serverless (plans/2026-06-01-…) |
| 06-02 | Tăng tốc mở lại meeting + chốt "meeting xong = bất biến" |
| 06-05 | Screen share + audio qua Daily.co; Supabase Auth |
| 06-10 | Phase 4.5 scheduling + siết quyền server-enforced + 3 audit dữ liệu |
| 06-11 | P1 hạ tầng Cloudflare remote LIVE + architecture.md + master plan 4 nhóm |
| 06-12 | Design-system **Glass Desk** cho dashboard (wallpaper + calendar/notes + color/icon) |
| 06-15 | Rebrand **Canvas M** + Glass-Desk login/admin + luồng login-bằng-link (merge từ feature branch) |
| 06-16 | Phân quyền "**chức vụ ≠ vai trò**" (division admin = head-only) · **Phòng chờ knock-to-join** (Phase 4, chốt 1a) · **Trang khách Glass-Desk** đa quốc gia (nền WebP xoay + calendar) · chi nhánh **Việt Nam** (division + user) · siết START theo phòng sở hữu |
| 06-17 | **Durable Objects realtime BUILT + DEPLOYED LIVE** (100% DO, khai tử room server socket.io/Fly; đóng 1b/B12) · **I-1** AI/STT → Worker · **B10** app LIVE trên **Cloudflare Pages** (https://map-canvasm.pages.dev) · go-live ops (migration remote 27/27 · backup restore-tested · CORS · secrets) · debug production sau go-live (SUPABASE_URL méo · BOM trong secrets · end-for-all stale-replica) |
| 06-18 | Test live PC↔iPad → dập cụm bug nền tảng: **audio** (iPad→PC nghe được, publish mic sau join) · **STT** (loại trừ ngôn ngữ nova-3, clone track iOS) · **guest deadlock** (portal-tile `room_key=null`) |
| 06-19 | **STT THỰC SỰ CHẠY** — root-cause `[object Blob]` (`server.binaryType="arraybuffer"`, fix 1 dòng mọi provider) · đại tu caption (`captionSurfaceAtom` 1-surface/view · Caption Dock per-viewer · Full/Compact · auto-scroll) · audio optimize (chống ồn + latency) · share-window resilience · chiến lược design-system (`plans/design-system-unification.md`) · **hạ tầng đã chốt → `specs/infrastructure.md`** |
| 06-23 | **Meeting Package full feature SHIPPED** (curate→recap[board+chat+files+attachment]→audience+picker→publish→distribution[Shared-with-me + Client portal + badge]→management[unpublish/soft-delete/revoke]→export zip; schema 0032+0034) · **Event-Log P1 MVP LIVE** (schema 0033 `meeting_event`+`meeting_consent`, consolidate-on-end, consent gate) · **REFRAME**: event-log/Chairman = **THÔNG TIN DỰ ÁN, không phải giám sát** (bỏ stealth + chấm-điểm-người; `event-log-privacy-analysis.md`) · dashboard sidebar IA + loạt fix (avatar public, meeting-card, AI summary cả cuộc) |

## Quy ước đặt file MỚI (từ 2026-06-11)

- `logs/YYYY-MM-DD.md` — nhật ký ngày; viết xong KHÔNG sửa lại (trừ typo).
- `audits/YYYY-MM-DD-<chủ-đề>.md` — báo cáo/đề xuất point-in-time; chốt xong ĐÓNG BĂNG; nếu sau này stale thì dán banner trỏ tới doc sống, không sửa nội dung.
- `plans/<tên-không-ngày>.md` — kế hoạch sống; dòng đầu file luôn có "Cập nhật lần cuối: YYYY-MM-DD".
- `specs/<tên-không-ngày>.md` — thiết kế sống; sửa trực tiếp khi quyết định đổi, ghi "(cập nhật YYYY-MM-DD)" cạnh mục đổi.
- `generated/` — KHÔNG sửa tay; regenerate bằng agent rồi ghi đè.
- Link giữa các doc: luôn dùng đường dẫn tương đối (`../specs/…`) để click được trên GitHub/editor.
- Tên file: kebab-case, không dấu, tiếng Anh cho plans/specs; nội dung tiếng Việt OK.
