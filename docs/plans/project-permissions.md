# Kế hoạch — Mô hình phân quyền dự án (division → leader → delegate → member)

> Chốt 2026-06-15 bởi team 4 agent (3 lăng kính: org-model · permission-matrix · migration-UX → 1 tổng hợp). Yêu cầu anh Luân: dự án do 1 phòng ban lead; người phòng khác tham gia **không** được quyền guest-manager; division head gán project leader; head + leader (+ người được uỷ quyền) quản dự án + guest. — **Phân tích + plan, KHÔNG code.**

## Bối cảnh & gốc bug
Hôm nay **không có khái niệm division** trong DB. `project` chỉ có `host_email`; `project_member(project_id, email, role)` với `role` = `'owner' | 'member'`. **Gốc lỗi:** `canManageProjectGuests` (worker/src/index.ts ~1707) trả `true` cho **BẤT KỲ** dòng `project_member` (không lọc role); `projectAccess` trả `'full'` cho mọi member. → người **phòng ban khác** add làm `'member'` để **tham gia** lại tự động **quản guest + thấy surface quản trị**. Đây là chỗ "rối".

Nguyên tắc: **right-sized**, KHÔNG xây RBAC tổng quát. Tách "tham gia" khỏi "quản lý" + thêm lớp division mỏng. Tổng: **1 bảng + 2 cột + 1 enum value**.

## 1. Phân cấp vai trò
- **Admin** — Supabase `app_metadata.role='admin'`. Toàn quyền, short-circuit. Không đổi.
- **Internal** — `isInternalEmail()` (@mapgroup.co.kr). Điều kiện cần để là non-guest role. Không đổi.
- **Division head** — trưởng phòng. Tạo dự án phòng mình, gán/đổi project leader, full-manage mọi dự án phòng mình lead.
- **Project leader** — head giao phụ trách 1 dự án. Full-manage dự án đó + phong/gỡ manager; **không** tự đổi leader (chỉ head/admin).
- **Delegated manager** — head/leader chỉ định phụ giúp. Manage guest + member + tổ chức họp + sửa metadata; **không** xoá dự án, **không** phong manager khác.
- **Member (participate-only)** — đồng nghiệp cùng phòng. Xem folder + dự họp. KHÔNG quản trị.
- **Cross-division participant** — người phòng khác tham gia. **Giống hệt member**: xem + dự họp, không quản trị. (Division = metadata, không phải tier quyền.)
- **Guest** — login synthetic theo dự án. Chỉ dự cuộc họp được mời. Không bao giờ quản lý.

## 2. Schema tối thiểu (additive)
- **`0022_division.sql`**: `division(id TEXT PK, name TEXT NOT NULL, head_email TEXT NOT NULL, created_at, updated_at)`. **Head là COLUMN**, không phải role row (mỗi phòng đúng 1 head → single source of truth). Tuỳ chọn `division_member(division_id, email, PK(...))` nếu muốn suy "cùng phòng" — June có thể bỏ qua.
- **`0023_project_org.sql`**: `project.lead_division_id TEXT REFERENCES division(id)` (nullable — NULL = không gate theo phòng, chỉ leader/admin manage, an toàn) + `project.leader_email TEXT`. Backfill `leader_email = host_email`, `lead_division_id = phòng của host`.
- **`0024_member_role.sql`**: mở rộng enum `project_member.role` → `'owner' | 'manager' | 'member'`. Giữ `'owner'` (= leader, backward-compat), thêm `'manager'`, **định nghĩa lại** `'member'` = participate-only. **KHÔNG rewrite data**: owner cũ vẫn leader; member cũ tự thành participate-only ngay khi auth-check đổi. `'manager'` opt-in từ giờ.

## 3. Permission matrix & check chính xác

| Action | Ai được làm |
|---|---|
| Create project | Admin · head (phòng mình) · leader |
| Assign/đổi leader | Admin · head-of-lead-division |
| Designate manager | Admin · head · leader |
| **Manage guests** (issue/revoke/clean/edit) | Admin · head · leader · manager |
| Manage members · sửa project · tổ chức họp | Admin · head · leader · manager |
| Delete project | Admin · head · leader (siết owner-only cũ) |
| **Participate** (xem folder, dự họp) | member (kể cả cross-division) · invitee |

**Helper mới (load-bearing):**
```
canManageProject(db, projectId, email, role) =
  role === 'admin'
  OR project_member.role IN ('owner','manager')
  OR email === division.head_email của project.lead_division_id
  OR email === project.leader_email
```
Đổi `canManageProjectGuests` từ "any project_member" → điều kiện trên. **Fix bug tận gốc**: cross-division thêm làm `'member'` → không pass `canManageProject` → participate được nhưng KHÔNG chạm guest/management. **Tách tham gia (`projectAccess`/`canSeeMeeting`) khỏi quản lý (`canManageProject`)** — chốt thiết kế.

**Routes swap cùng lúc:** 6 route `/guests/*`, EXISTS filter trong `GET /v1/me/project-guests` (thêm `AND pm.role IN ('owner','manager')` + nhánh head), member add/remove (relax sang `canManageProject` để manager phụ giúp), project PATCH (relax), DELETE (giữ leader/head). `projectAccess` thêm nhận diện head → `'full'`.

## 4. Migration an toàn (không ai âm thầm giữ quyền)
Thuần additive, idempotent. **Tự bảo mật:** hiện chưa ai role `'manager'`, nên ngay khi gate lật, mọi `'member'` cũ **tức thì rớt xuống participate-only** mà **vẫn thấy folder** — đúng ý fix. Mọi project giữ 1 owner hoạt động. `lead_division_id = NULL` chạy như hôm nay (chỉ leader/admin manage) → lớp division không block bug fix.

## 5. Delegation UX (head → leader → manager)
Sống trong **ProjectManagerPanel → ProjectMemberRoster**. Mỗi member có **badge** (Leader / Manager / Participant). Leader/head thấy kebab per-row: *"Make manager" / "Remove manager"*; head/admin-only: *"Make project leader"*. Add member mặc định = participant. Endpoint mới `PATCH /v1/projects/:id/members/:email/role {role}`. **Gate UI** phần Guests/member-admin/danger trên prop `canManage` mới (thay `isOwner/!isInvitee`). Gán head↔phòng + project↔division làm trong **AdminConsole** (MVP), chưa cần màn self-serve.

## 6. Rollout theo phase
- **Phase 1 (FIX BUG — làm ngay, KHÔNG cần bảng division):** helper `canManageProject`; đổi `canManageProjectGuests` + 6 guest routes + member routes; thêm role `'manager'` + `PATCH .../role` + UI promote/demote; gate Guests section trên `canManage`. → Cross-division joiner thành participate-only ngay.
- **Phase 2:** bảng `division` + `project.lead_division_id`/`leader_email`; head kế thừa manage dự án phòng mình + đổi leader; AdminConsole gán head + project→division.
- **Phase 3 (defer):** màn self-serve division-admin, leader-handoff, audit/notifications.

## ✅ Mô hình CHỐT (06-15, brainstorm với anh Luân) — "đừng phức tạp"
**Quản lý dự án — 4 cấp, quyền chảy theo chuỗi (không ma trận):**
- **Head** (rank cao nhất phòng) · **Deputy** (rank 2, **NGANG head** — quản hết dự án phòng, assign leader) → tạo dự án + full-manage mọi dự án phòng.
- **Leader** (mỗi dự án, head/deputy assign) · **Co-operator** (mỗi dự án, leadership chỉ định) → quản dự án + tổ chức họp + client.
- **Member** = chỉ tham gia. **Tạo dự án** = Head/Deputy/admin. **Tạo cuộc họp** = canManageProject (Head/Deputy/Leader/Co-operator/admin), KHÔNG phải member thường.

**Cuộc họp — host/co-host:**
- **Host = NGƯỜI TẠO** cuộc họp (mặc định). Không gán host riêng.
- **Leader/Deputy/Head tự động có quyền host** (End/kick/mute) trên mọi cuộc họp của dự án — `viewer_is_authority`, không cần chỉ định.
- **Co-host = tùy chọn**: host HOẶC cấp trên đặt, chọn 1 nội bộ bất kỳ trong danh sách mời. Dùng khi trao quyền điều hành cho người NGOÀI chuỗi quản lý.
- Kick/mute realtime: broadcast kèm `fromAuthority` → peer chấp nhận KICK của authority kể cả khi host bầu là người khác.

## ✅ Đã SHIP (06-15)
- **Phase 1** (commit `4db1e587`): `canManageProject` (admin/owner/manager); tách participate↔manage; 6 guest routes + member routes + role-PATCH; cross-division joiner → participate-only. KHÔNG migration.
- **Phase 2** (commit `40a7df27`): bảng `division`(head_email) + `user_division` (migration `0022`), `project.lead_division_id`/`leader_email` (migration `0023`, backfill từ host's division). Head tự suy từ **rank cao nhất** mỗi Division (`worker/scripts/derive-divisions.mjs`, 21 phòng/385 user). `canManageProject`/`projectAccess` nhận head+leader; `isProjectLeadership` (admin/owner/leader/head, KHÔNG manager) gate delete + delegate-manager; `PATCH /v1/projects/:id/leader` (head/admin) assign leader; GET /v1/projects có LEAD arm + `can_assign_leader`; UI "Make leader". Verified: 유훈 hyu@ = head AI R&D Center, tự thấy/quản project của Luân.
- **Phase 3** (defer): self-serve division-admin, leader-handoff UI, audit/notifications.

## ✅ Đã chốt (anh Luân, 06-15)
**Division head CÓ quyền manage MẶC ĐỊNH trên MỌI dự án phòng mình lead** — qua check `head_of_lead_division` (Phase 2). Không cần add head làm member từng dự án.

**File liên quan:** `worker/src/index.ts` (helper + gates ~734/837/900/932/1040/1694-2000/2040); migration `worker/schema/` (next = 0022).

> Liên quan: [[mcm-access-model]] · [[mcm-guest-data-lifecycle]] · `docs/specs/host-and-scheduling.md`.
