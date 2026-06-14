# MAP CanvasMeet — Tài liệu dự án

Tool họp nội bộ trên nền Excalidraw fork: canvas chung realtime, chat + AI bot,
dịch/STT, viewer DXF/IFC/PDF, screen share (Daily.co), auth Supabase,
backend Cloudflare Worker + D1 + R2. Bắt đầu 2026-05-08.

## Đọc theo thứ tự này (người mới / quay lại sau nghỉ)

1. **`generated/architecture.md`** — Bức tranh hệ thống HIỆN TẠI (sinh tự động
   2026-06-11). Hiểu cái gì đang chạy trước khi đọc kế hoạch.
2. **`plans/master-plan-4-groups.md`** — Việc SẮP LÀM, chia 4 nhóm, thứ tự đã
   chốt với anh Luân 06-11. Đây là "kim chỉ nam" hiện hành.
3. **`plans/roadmap.md`** — Phase nào xong / đang dở (nguồn chuẩn duy nhất về phase).
4. **`plans/production-data-plan.md`** + **`plans/dev-phase-notes.md`** —
   Kế hoạch dữ liệu production và danh sách "việc tạm cần finalize".
5. **`specs/`** — Đọc KHI CẦN chi tiết thiết kế: host & lịch họp
   (`host-and-scheduling.md`), admin console (`admin-console.md`),
   model user (`user-data-model.md`), cấu hình auth (`supabase-setup.md`).
6. **`audits/`** — Ảnh chụp đánh giá tại từng mốc (tên có ngày). Đọc khi cần
   hiểu "vì sao hồi đó quyết định vậy". KHÔNG coi là trạng thái hiện tại.
7. **`logs/`** — Nhật ký từng phiên làm việc (tiếng Việt), chi tiết kỹ thuật
   + gotchas. Tra cứu khi cần biết "hôm đó đã làm gì, vướng gì".

## Dòng thời gian dự án (qua logs/)

| Ngày | Mốc |
|---|---|
| 05-08 | Realtime collab chạy được qua Cloudflare Tunnel |
| 05-29 | AI bot trong canvas + attribution tác giả |
| 06-01 | Chốt kế hoạch hạ tầng Cloudflare serverless (plans/2026-06-01-…) |
| 06-02 | Tăng tốc mở lại meeting + chốt "meeting xong = bất biến" |
| 06-05 | Screen share + audio qua Daily.co; Supabase Auth |
| 06-10 | Phase 4.5 scheduling + siết quyền server-enforced + 3 audit dữ liệu |
| 06-11 | P1 hạ tầng Cloudflare remote LIVE + architecture.md + master plan 4 nhóm |
| 06-12 | Design-system **Glass Desk** cho dashboard (wallpaper + calendar/notes + color/icon) |
| 06-15 | Rebrand **Canvas M** + Glass-Desk login/admin + luồng login-bằng-link (merge từ feature branch) |

## Quy ước đặt file MỚI (từ 2026-06-11)

- `logs/YYYY-MM-DD.md` — nhật ký ngày; viết xong KHÔNG sửa lại (trừ typo).
- `audits/YYYY-MM-DD-<chủ-đề>.md` — báo cáo/đề xuất point-in-time; chốt xong
  ĐÓNG BĂNG; nếu sau này stale thì dán banner trỏ tới doc sống, không sửa nội dung.
- `plans/<tên-không-ngày>.md` — kế hoạch sống; dòng đầu file luôn có
  "Cập nhật lần cuối: YYYY-MM-DD".
- `specs/<tên-không-ngày>.md` — thiết kế sống; sửa trực tiếp khi quyết định đổi,
  ghi "(cập nhật YYYY-MM-DD)" cạnh mục đổi.
- `generated/` — KHÔNG sửa tay; regenerate bằng agent rồi ghi đè.
- Link giữa các doc: luôn dùng đường dẫn tương đối (`../specs/…`) để click được
  trên GitHub/editor.
- Tên file: kebab-case, không dấu, tiếng Anh cho plans/specs; nội dung tiếng Việt OK.
