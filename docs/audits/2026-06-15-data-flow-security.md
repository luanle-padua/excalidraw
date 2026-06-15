# Audit bảo mật flow data — 2026-06-15

> Team AI (7 agent) quét adversarial: authN/authZ gates · cross-project/department isolation · blob/E2E/persistence scoping · identity/secrets/escalation. Mỗi finding nặng được **verify đối nghịch** (trace full request path để loại false-positive). Dev-phase deferrals (CORS `*`, default password, no rate-limit) được loại trừ có chủ đích. Phase-1 permission hardening (`canManageProjectGuests` = any member) đã fix song song — không tính vào đây.

**Kết quả: 3 finding, tất cả HIGH, tất cả CONFIRMED thật.** Không cái nào là dev-phase deferral — đều sống tới production. Cả 3 đều vi phạm bất biến anh đã chốt (confidentiality giữa phòng ban; "revoke = kick").

---

## H1 — `GET /v1/clients` rò toàn bộ sổ liên hệ khách (cross-department)

- **File:** `worker/src/index.ts` — route ~2336, gate `canManageClients` ~2330, auto-insert lúc mời ~1565; schema `0012_clients.sql` (không có cột scope).
- **Lỗ:** bảng `client` là sổ chung phẳng, không gắn project/department. Bất kỳ nhân viên nội bộ nào (kể cả phòng khác, không là member dự án nào) gọi `GET /v1/clients` → nhận **email + công ty + ghi chú** của **mọi** khách/consultant từng được mời vào **bất kỳ** cuộc họp nào — gồm cả liên hệ chỉ gắn với họp **confidential** họ không được thấy.
- **Vi phạm:** "STRICT confidentiality giữa các phòng ban" cho dữ liệu external-party.
- **Fix đề xuất:** thêm `project_id` vào `client`, populate từ `meeting.project_id` lúc auto-insert/tạo tay, rồi filter GET/PATCH/DELETE theo project caller **quản** (mirror EXISTS-against-`project_member` của `/v1/me/project-guests`; admin thấy tất cả). Dedupe auto-insert theo `(project_id, email)` thay vì email-global. *(Phương án nhẹ hơn nếu muốn giữ sổ phẳng: giới hạn read/edit theo `created_by = caller` + admin.)*

## H2 — Client tự gửi `projectId` lúc ghi → tiêm cuộc họp vào folder phòng khác

- **File:** `worker/src/index.ts` — `POST /v1/meetings` (projectId bind ~1201), `PUT /v1/scenes` (~474/485), `PUT /v1/files` (~621/628).
- **Lỗ:** ba route ghi này chỉ gate `admin || isInternalEmail`, rồi bind thẳng `projectId` từ client **không** gọi `projectAccess`/`canManageProject`. Nhân viên phòng A `POST /v1/meetings {roomId:<của mình>, projectId:<dự án confidential phòng B>}` → meeting row mang `project_id` của phòng B. Vì `confidentiality` mặc định NULL, confFilter coi nó "không confidential" → **hiện cho mọi member phòng B**, và scene/chat/library/file blob của nó **đọc được bởi mọi member phòng B** (qua `roomGate` nhánh member). Kẻ tấn công (là organizer/host) còn seed được canvas + room_key vào surface phòng B.
- **Lưu ý:** `project_id` của meeting **đã tồn tại** được COALESCE bảo vệ — nhưng roomId mới toanh (kẻ tấn công sở hữu) thì `project_id` hoàn toàn do client điều khiển ở lần ghi đầu; row cũ còn NULL cũng bị đóng dấu được.
- **Fix đề xuất:** trong cả 3 handler, trước khi bind `projectId` (khi non-null) yêu cầu `projectAccess(db, email, role, projectId) === 'full'` (hoặc `canManageProject` nếu muốn chặt hơn), 403 nếu không. Đóng luôn nhánh row cũ `project_id` NULL bị non-member đóng dấu.

## H3 — Revoke guest KHÔNG cascade `meeting_invitee` → guest vẫn vào được tới khi JWT hết hạn

- **File:** `worker/src/index.ts` — revoke `DELETE .../guests/:id` (~2044), clean (~2084), `canSeeMeeting` (~281), auth middleware (~104).
- **Lỗ:** revoke/clean chỉ `UPDATE project_guest SET status='revoked'` + ban Supabase login (`ban_duration`). **Không** đụng `meeting_invitee`. Mà `canSeeMeeting` / `/v1/me/meetings` / Daily-mint chỉ gate theo `meeting_invitee.status <> 'revoked'`, **không** đọc `project_guest.status`. Auth middleware verify JWT offline (JWKS, chỉ sig/iss/aud/exp), **không** check ban mỗi request. Supabase ban chỉ chặn **cấp token mới** — access token đã cấp vẫn hợp lệ tới `exp` (mặc định ~1h).
- **Hệ quả:** guest bị revoke giữa phiên ("add nhầm → cho ra", hoặc bắt quả tang leak) vẫn PUT/GET scene, chat, transcript (giải mã E2E được vì còn giữ roomKey), library, files và mint Daily token cho **mọi** cuộc họp đã mời — tới hết đời token. **Trực tiếp phá lời hứa "revoke = kick (06-11)".** *(Giảm nhẹ: finished-meeting guard vẫn chặn họp đã xong; cửa sổ bị giới hạn bởi TTL token ~1h, không vô hạn.)*
- **Fix đề xuất:** trên revoke/clean, cascade: `UPDATE meeting_invitee SET status='revoked', revoked_at=? WHERE email = (login của guest)`. Như vậy `canSeeMeeting`/Daily/`me-meetings` từ chối ngay request kế, không phụ thuộc TTL. Defense-in-depth: rút ngắn TTL token guest hoặc check ban/status per-request cho synthetic guest login.

---

## Khuyến nghị thứ tự fix
1. **H3** (nhỏ nhất, đóng đúng lời hứa "revoke = kick", không cần quyết định data-model) — cascade `meeting_invitee` trên revoke/clean.
2. **H2** (cross-tenant write injection) — thêm `projectAccess === 'full'` gate vào 3 write path.
3. **H1** (cần quyết: scope `client` theo `project_id` hay `created_by`) — chọn mô hình rồi thêm migration + filter.

> Đã loại false-positive nhờ vòng verify. CORS/`*`, default password, no rate-limit là dev-phase đã chốt — không nằm trong scope này (xem `docs/dev-phase-notes.md`).
