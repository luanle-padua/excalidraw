# Kế hoạch — Quản lý dữ liệu khách (revoke ≠ delete)

> Chốt 2026-06-15 bởi team 4 agent (3 lăng kính: mất-gì-khi-xoá · access-vs-data · retention/PII → 1 tổng hợp). Yêu cầu anh Luân: cần **full dữ liệu lịch sử**; câu hỏi: có nên dọn bớt/xoá guest user về sau không? — **phân tích + plan, KHÔNG code.**

> ✅ **ĐÃ SHIP (verify code 2026-06-23):** plan này đã được thực thi — KHÔNG còn hard-delete guest. `DELETE /v1/projects/:projectId/guests/:id` (`worker/src/index.ts:4332`) giờ là **soft-revoke**: `UPDATE project_guest SET status='revoked', revoked_at=…` + Supabase **BAN** (`ban_duration`) thay vì DELETE + **cascade `meeting_invitee` → status='revoked'** (đóng cửa "revoke=kick" ngay request kế). `POST /v1/projects/:projectId/guests/clean` (`index.ts:4387`) retire tất cả = loop ban+revoke, comment ghi thẳng "NEVER deletes — … attendance/attribution, and the AI moat are preserved". Phần CÒN để sau: route `anonymize-on-erasure` cho GDPR (§4), `status='purged'` cho junk row, snapshot label vào `meeting_invitee` (§5.6). Phần phân tích bên dưới giữ nguyên làm cơ sở thiết kế.
>
> ⚠️ _(LỊCH SỬ — trạng thái cũ trước khi sửa)_ Trước 06-23 cả "Revoke" lẫn "Clean all guests" **HARD-DELETE** — `DELETE /admin/users/{supaId}` (Supabase) **+ `DELETE FROM project_guest`**, không cascade nên `meeting_invitee`/`meeting_participant`/blob R2 mồ côi. Plan này đã đổi nó sang revoke-không-delete (đã ship).

## Câu trả lời thẳng: KHÔNG xoá guest theo vòng đời dự án

**KHÔNG** hard-delete guest user/row như bước "dọn khi dự án xong". Lý do cấu trúc: `project_guest` là **nơi DUY NHẤT** ánh xạ synthetic email `pg-<hex>@guest.canvasm.app` → người thật (label, real_email, company, supa_id). Xoá row = mồ côi mọi `meeting_invitee`, `meeting_participant`, attribution tác giả trong blob → "pg-a1b2@… là ai?". Phá thẳng **AI knowledge moat** ([[ai-project-knowledge-strategy]]: full history = the moat) — entity-graph nối quyết định → người/nhà thầu sẽ dereference về row đã chết.

## (1) Phân biệt cốt lõi: REVOKE-access vs DELETE-data

Hai trục đang **gộp nhầm** trong code:
- **Access lifecycle** = đăng nhập được + nằm trong invitee list + vào live room. **NÊN** gỡ khi dự án xong.
- **Data lifecycle** = row `project_guest` (ánh xạ identity) + nội dung lịch sử. **KHÔNG** được xoá.

"Dọn khi dự án kết thúc" là việc của **access**, không phải **data** → hai mục tiêu **không xung đột**.

## (2) State model: active → revoked → [hiếm] purged

**REVOKE (per-guest, giữ semantic 06-11 "revoke = kick"):**
- `UPDATE project_guest SET status='revoked', revoked_at=…` — **GIỮ** row + contact fields.
- Flip/gỡ `meeting_invitee` → poll 60s đá khỏi live room, hết thấy project.
- **BAN/DISABLE** Supabase user (`banned_until` xa) thay vì DELETE → `supa_id` vẫn resolve, guest có thể được mở lại xem finished meeting (read-only) mà không fork identity.

**"Clean all guests" → đổi tên "Đóng quyền khách / Retire project guests":**
- Loop revoke-không-delete trên mọi guest. **Không bao giờ** `DELETE FROM project_guest`.
- Audit `project_guest.retire` (hạ tầng audit có sẵn ~L2012).
- Mượn đúng precedent đã chứng minh của `meeting_invitee` soft-revoke (`status='revoked', revoked_at`) — guest là outlier duy nhất đang hard-delete.

## (3) An toàn gỡ vs KHÔNG BAO GIỜ xoá

- **An toàn gỡ:** quyền truy cập — disable/ban Supabase credential (credential ngủ đông sau dự án = pure attack surface, không mang lịch sử).
- **KHÔNG BAO GIỜ xoá:** row `project_guest` (resolver duy nhất), `meeting_participant`, `meeting_invitee`, blob nội dung — đây là records + moat.
- Hard-delete row chỉ chấp nhận cho **junk/test row chưa author gì** — admin + xác nhận + audit.

## (4) PII / quyền được lãng quên — anonymize-on-erasure

Tách 2 trigger:
- **Routine project-end (99%)** = revoke credential + `status='revoked'`, **GIỮ contact card**. Đây là lưu trữ business-records hợp pháp của firm, KHÔNG phải erasure.
- **Yêu cầu erasure thật (GDPR, hiếm)** = scrub PII **tại chỗ**: `label='Khách (đã ẩn)'`, NULL `real_email/company/phone/address`; GIỮ `id/login/project_id/created_at/status`.

Vì row là **điểm resolve duy nhất** synthetic-login → display name, anonymize **lan toả miễn phí** ra mọi historical view. **KHÔNG rewrite blob R2** (immutable, đắt). Synthetic login tự nó là privacy feature (blob chưa từng chứa real email). Moat cần **content + decisions**, KHÔNG cần tên/điện thoại guest → erasure **tốn 0 chi phí cho moat**.

## (5) Next steps (mô tả, KHÔNG code — chờ anh chốt)

1. **Migration** (sau 0020): `ADD COLUMN revoked_at INTEGER`; cho phép `status='purged'`.
2. **Worker:** đổi revoke + clean từ `DELETE FROM project_guest` → `UPDATE SET status='revoked'` + Supabase **ban** thay DELETE; thêm route admin-only `POST .../guests/:id/anonymize`.
3. **Resolution path:** tách 2 read — lookup **status-agnostic** để RENDER tên lịch sử; list **status='active'** cho access/management (hiện mọi SELECT filter active hoặc delete → cần thêm read display-only).
4. **Roster UI:** mặc định ẩn `revoked` (dự án trông "sạch") + toggle "show archived"; revoked hiển thị gạch ngang như invitee precedent.
5. **Client + i18n:** sửa JSDoc + đổi chữ "Clean/Delete" → "Đóng quyền khách / Revoke access" để host hiểu history được giữ.
6. **Defense-in-depth:** snapshot label vào `meeting_invitee` lúc invite (giống `meeting_participant` đã cache name) — đừng để `project_guest` là bản copy DUY NHẤT cho attribution KB-critical.

**Net:** chuyển từ *delete-to-tidy* → *disable-and-archive-to-tidy*. Cùng workflow operator, cùng kết quả access (guest bị đá, không login được), nhưng mapping + attendance + attribution sống nguyên — giữ records + AI moat. Dành xoá thật cho legal erasure (chỉ PII columns, row giữ lại) + junk test data.

> Liên quan: [[mcm-access-model]] (project-scoped guest) · [[ai-project-knowledge-strategy]] (full history = moat) · `worker/src/index.ts` (revoke ~L1953, clean ~L1988).
