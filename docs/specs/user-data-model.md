# Mô hình dữ liệu người dùng — hiện trạng & đề xuất production

_Cập nhật 2026-06-10. Liên quan: bug "mọi tài khoản trùng avatar" (đã fix client-side cùng ngày)._

## 1. Hiện trạng — dữ liệu user đang nằm ở đâu

| Nơi lưu | Nội dung | Khóa |
| --- | --- | --- |
| **Supabase Auth** `user_metadata` | `name`, `display_name`, `title`, `division`, `department`, `company`, `emp_no` (seed từ CSV — `scripts/seed-from-csv.mjs`); **mới thêm `avatar`** (`"lib:NN.png"`) | `user.id` (UUID) + email |
| **Supabase Auth** `app_metadata` | `role: "admin"` (gate admin console, Worker re-check) | UUID |
| **localStorage** `mcm:userProfile:v1` | `{username, company, avatar, email}` — cache hồ sơ + nguồn broadcast | **1 key / TRÌNH DUYỆT** (không theo tài khoản) |
| **localStorage** khác | session Supabase (SDK tự lưu), `mcm:hostClaim:v1` (per-room) | per-browser |
| **D1 (Worker)** | `project_member(project_id, email)`, `meeting_invitee(meeting_id, email)`, `meeting_participant(meeting_id, user_email, name)`, `client(email)`, `project.host_email`, `meeting.host_email/organizer_email/created_by` | **email lower-case** |
| **Socket broadcast** | `USER_PROFILE {username, company, avatar, email, joinedAt}` — chỉ sống trong phòng, không persist | socketId |

## 2. Vấn đề

1. **Hồ sơ theo trình duyệt, không theo tài khoản** — `mcm:userProfile:v1` là 1 key chung; trên máy demo nhiều người login lần lượt, effect sync cũ giữ nguyên `avatar` của người trước → **mọi tài khoản hiển thị cùng một avatar** (đã fix: avatar hydrate từ account, profile của email khác bị loại bỏ).
2. **Avatar không có ở cấp tài khoản** — trước đây `user_metadata` không có avatar → đổi máy/trình duyệt là mất; nay đã lưu `avatar: "lib:NN.png"` (ref nhỏ) vào `user_metadata`. Ảnh upload (data URL ~100KB) vẫn **local-only** — chưa được roam.
3. **Email làm khóa ngoại thay vì UUID** — toàn bộ D1 (`project_member`, `meeting_invitee`, `meeting_participant`, `client`) key bằng email lower-case. Email đổi (đổi tên miền, kết hôn…) = mất toàn bộ quyền/lịch sử; Supabase UUID mới là định danh bất biến.
4. **Không có bảng profile riêng** — `user_metadata` do chính user sửa được qua `updateUser` (không kiểm soát schema/size), trộn lẫn dữ liệu HR (title/division) với tùy chọn cá nhân (avatar).

## 3. Mô hình đích cho production

- **Định danh**: Supabase Auth là system-of-record. Mọi FK mới dùng `user_id` (UUID); email chỉ là thuộc tính tra cứu (để mời người chưa có tài khoản — giữ `meeting_invitee.email`, "claim" về `user_id` ở lần login đầu).
- **Hồ sơ**: tách bảng **D1 `user_profile`** do Worker quản (`user_id PK, email, display_name, company, division, avatar_key, updated_at`), mirror từ Supabase khi login (JWT đã có sẵn trong Worker). `user_metadata` chỉ giữ dữ liệu seed HR + `avatar` ref nhỏ trong giai đoạn chuyển tiếp; client KHÔNG còn là nguồn sự thật.
- **Avatar upload → R2**: key `avatars/<user_id>`, upload qua Worker (auth bằng JWT), `user_profile.avatar_key` trỏ vào đó; `"lib:NN.png"` vẫn là ref tĩnh. Bỏ hẳn data URL trong broadcast (chỉ gửi URL/ref → payload socket nhỏ).
- **localStorage**: chỉ còn là cache offline theo `user_id`, bị ghi đè vô điều kiện khi login bằng tài khoản khác (đã làm).
- **Lộ trình migrate**: (1) thêm cột `user_id` nullable vào `project_member`/`meeting_invitee`/`meeting_participant`, backfill bằng admin listUsers map email→UUID; (2) Worker ghi song song email+user_id; (3) chuyển authz check sang user_id, email chỉ fallback cho invite-chưa-claim; (4) avatar R2 + bảng `user_profile`; (5) dọn các key localStorage cũ.

## 4. Việc đã làm trong đợt fix này (client)

- `UserProfileModal` save → `supabase.auth.updateUser({data:{avatar}})` (chỉ ref `lib:`; data URL giữ local, TODO R2).
- `Session.avatar` đọc từ `user_metadata.avatar`; effect sync trong `MeetingShell` hydrate avatar TỪ tài khoản và **loại bỏ avatar cũ của email khác** trong localStorage.
- Fallback avatar mặc định hash theo **email** (định danh ổn định) thay vì socketId ở mọi surface (ParticipantsBar / Chat / STT / MeetingLog / AuthorBadge); socketId chỉ còn cho khách anonymous.
