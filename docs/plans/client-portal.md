# Brainstorm — Trải nghiệm Client (cổng khách, không phải dashboard nhân viên)

> Chốt 2026-06-15 bởi team 4 agent (3 lăng kính: confidentiality-scope · UX-pattern · build → 1 tổng hợp). Câu hỏi anh Luân: client nên dùng dashboard ntn? có nên có dashboard như người công ty không? — **phân tích + plan, KHÔNG code.**

## 1. Verdict: Client portal RIÊNG, KHÔNG phải staff dashboard (dứt khoát)

Khách phải có **một cổng riêng, tối giản (`ClientPortal`)** — không phải `ProjectBrowser` đã lọc bớt. `ProjectBrowser` xây quanh *sở hữu project, lên lịch, quản lý file/guest* — thứ một project-scoped guest không có. "Lọc bớt staff dashboard" là cái bẫy hiện tại: mỗi widget nội bộ phải nhớ gắn `isInternal &&`, dễ rò, dễ vỡ khi staff feature đổi, và **vẫn** trông như công cụ nội bộ bị tháo động cơ. Cổng riêng **safe-by-construction**: bảo mật đến từ "view này chỉ bao giờ fetch meeting của chính guest", không phải từ việc nhớ ẩn N widget.

**Verify code:** `MeetingLobby.tsx` branch `session.isAdmin → AdminConsole` (L183), còn lại rơi thẳng `<ProjectBrowser/>` (L302) — **không có nhánh guest**. `session.ts` chỉ có `isInternalEmail`; `deriveSession` đọc `appMd.role === "admin"` nhưng **BỎ RƠI** `role:"guest"` + `project_id` mà Worker đã set (L1817).

> ⚠️ **Quan trọng: KHÔNG phải lỗ hổng data.** Server-side gate đã chặn đúng: guest không là `project_member` nên `/v1/projects` sidebar **rỗng**, `/v1/me/files` **403**, `/v1/projects/:id/members` cần access `full` → 403, `/v1/me/meetings` + `canSeeMeeting` chỉ trả meeting của dự án guest, **loại confidential**. Đây là **vấn đề UX/scope**, không rò dữ liệu. Đừng nới server gate.

## 2. Khách thấy gì — bề mặt tối thiểu + ranh giới

**THẤY (chỉ chừng này):**
- Header gọn: brand Canvas M, "Chào <tên contact>", `LangSwitcher` + `ThemeToggle` + `UserMenu` (profile + đăng xuất — đã guest-safe).
- Danh sách **đơn cột "Cuộc họp của bạn với MAP"**, nguồn duy nhất `/v1/me/meetings` (server scope đúng qua nhánh UNION `project_guest`). Chia **Upcoming / Past**; mỗi dòng = tiêu đề + thời gian + trạng thái + nút **Tham gia** (live/scheduled) hoặc **Xem lại** (finished — read-only, đúng luật finished=immutable).
- Empty state trấn an: "Chưa có cuộc họp nào — MAP sẽ thêm bạn vào đây."

**KHÔNG thấy (ẩn hoàn toàn):** sidebar project, tab My Meetings/Invited, cột Calendar, card color/emoji/edit, New project, My Files, Manage Projects, Guest Manager, member directory nội bộ, WallpaperPicker, ActivityLog, NotificationBell. Nên **làm mờ tên/email staff** trên dòng meeting.

**Ranh giới bảo mật:** giữ NGUYÊN mọi server-side gate. Nhánh `isGuest` ở client **chỉ là UX, không bao giờ là security boundary**.

## 3. UX pattern + vì sao hợp firm nhỏ + client không rành kỹ thuật

Khách firm kiến trúc: dùng thưa, một dự án, thường không rành tech, đến làm **một việc** — vào đúng cuộc họp được mời. Họ cần *rõ ràng, tin tưởng, zero cognitive load*. Staff dashboard phát tín hiệu "bạn lạc vào back office" → phản chuyên nghiệp. Trang branded "Cuộc họp của bạn với MAP" phát tín hiệu "MAP làm cái này cho bạn". Với PM non-CS tự maintain: portal gần-như-không bộ phận động → hầu như không vỡ khi staff feature đổi, ít trông coi hơn nhiều so với giữ `ProjectBrowser` an toàn cho guest.

## 4. Build nhỏ nhất + rollout (mô tả, KHÔNG code — chờ anh chốt)

- **Detect guest:** thêm `isGuestEmail(email)` vào `session.ts` (mirror `isInternalEmail`, key `@guest.canvasm.app`). **Hardening (nên làm cùng):** plumb `app_metadata.role` + `project_id` vào `Session` trong `deriveSession` → `isGuest` suy từ **JWT role đã verify** thay vì string-match domain.
- **Branch:** trong `MeetingLobby.tsx`, *sau* nhánh admin và *trước* `<ProjectBrowser/>`: `if (isGuest) return <ClientPortal/>;` — guest **không bao giờ mount** staff shell. Trim header chrome cho guest.
- **Reuse, đừng rebuild:** `ClientPortal` dùng lại `getMyMeetingsChecked()` + card/list + đường join sẵn có. Chỉ chrome là mới.
- **Ship first:** danh sách meeting scoped + lobby guest sạch. **Defer:** shared-materials, RSVP, recap, guest notifications — panel cộng thêm vào `ClientPortal` sau.

## 5. Leak/gap cần đóng

(a) **`deriveSession` drop `role`/`project_id`** — gap chính, làm `isGuest` phải domain-sniff; **vá ngay.** (b) Map `project_guest.label` → display name để guest thấy tên thật (không phải "Pg A1b2"). (c) Belt-and-suspenders: Worker reject `/v1/me/files` + project-creation + guest-management với `role === "guest"` rõ ràng. (d) Honor revoke=kick (list rỗng) + review-on-every-entry (finished = "Xem lại" read-only).

**Files (khi build):** `excalidraw-app/data/session.ts` (`isGuestEmail` + plumb role/project_id) · `excalidraw-app/components/mcm/MeetingLobby.tsx` (~L302 nhánh guest + trim header) · mới `excalidraw-app/components/mcm/ClientPortal.tsx` · `worker/src/index.ts:1805/1817` (giữ synthetic-login + `app_metadata.role`).

> Liên quan: [[mcm-access-model]] (project-scoped guest) · [[mcm-guest-data-lifecycle]] (revoke=kick) · [[mcm-finished-meeting-immutable]] (review read-only).
