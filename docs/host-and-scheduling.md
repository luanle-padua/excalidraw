# Host & Scheduling — thiết kế (chuẩn production)

> Làm rõ "host" và "lên lịch họp". Bàn 2026-06-08. Đây là thiết kế cho **Phase 4 (host control - live)** + một lớp **Scheduling** mới. KHÁC với [admin-console.md](admin-console.md) (back-office). Liên quan: meeting đã xong = immutable review.

## Cốt lõi: tách 2 khái niệm (chỗ hay confuse)
**Organizer sở hữu cái lịch; Host cầm trịch buổi họp.** Thường cùng 1 người, nhưng tách ra mới xử lý được "người tạo vắng", "chuyển quyền", "co-host".

| Vai | Là ai | Quyền |
|---|---|---|
| **Organizer** (người tổ chức) | Người **tạo/lên lịch**. Sở hữu record (`meeting.created_by`). | Sửa, **dời lịch, huỷ**, mời, chỉ định host/co-host |
| **Host** (chủ trì) | Điều khiển phiên **LIVE**. Mặc định = organizer. | **Start/End**, duyệt phòng chờ, mute/kick, present, chỉ định co-host, chuyển host |
| **Co-host** | Host phụ (host/organizer chỉ định) | Như host, trừ End-for-all/huỷ |
| **Attendee nội bộ** | Được mời, @mapgroup.co.kr | Auto-admit, tự vào |
| **Guest** (khách/client) | Email ngoài, vào qua link | Vào **phòng chờ** → host duyệt |

## Quyết định đã chốt (2026-06-08)
1. **Host vắng khi tới giờ → ACTING HOST:** người **nội bộ đầu tiên** vào sẽ tự thành *host tạm* (đủ quyền điều khiển, kể cả Start/End). Khi organizer/host thật vào → quyền **tự trả về** cho họ (acting host nhường lại). Mục đích: buổi họp không bao giờ bị kẹt vì host vắng.
2. **Lên lịch (bản đầu):** **in-app + mục "Sắp tới" + link mời**. Email mời tự động làm sau (khớp [[mcm-access-model]] "mời theo link, email sau").
3. **Ai lên lịch:** **mọi user nội bộ** (@mapgroup) đều tạo/lên lịch được.

## Hai kiểu tạo họp
- **Họp ngay (instant):** tạo + vào liền (như hiện tại). Organizer = host = người tạo. `status = live`.
- **Họp đã lên lịch (scheduled):** chọn giờ + mời người → `status = scheduled` → hiện ở "Sắp tới" → tới giờ vào.

## Vòng đời (state machine)
```
            dời lịch / sửa
             ┌────────┐
             ▼        │
  ┌──────────────┐  (tới giờ, host/acting host bấm Start)   ┌──────┐   End for all   ┌──────────┐
  │  scheduled   │ ───────────────────────────────────────> │ live │ ──────────────> │ finished │
  └──────────────┘                                          └──────┘                 └──────────┘
        │ huỷ                                                                     (read-only review,
        ▼                                                                          immutable — đã chốt)
   ┌───────────┐
   │ cancelled │
   └───────────┘
```
→ dùng `meeting.status` (đã có field): `scheduled | live | finished | cancelled`.

## Luồng lên lịch (chuẩn)
1. **Organizer** (user nội bộ bất kỳ): New meeting → project, tiêu đề/agenda, **ngày giờ + thời lượng**, **mời** (nội bộ: chọn từ list user; khách: nhập email), settings (phòng chờ on/off, recording on/off).
2. **Hệ thống**: tạo record (`scheduled_at`, organizer, danh sách mời) → sinh **link mời** → hiện ở mục **"Sắp tới"** của người được mời (nội bộ).
3. **Tới giờ**: mở link → nếu chưa Start: "Host chưa bắt đầu / chờ"; host/co-host (hoặc nội bộ đầu tiên = acting host) bấm **Start** → `live`. Guest → phòng chờ.
4. **Trong họp**: host control (mute/kick/admit/present/co-host/transfer).
5. **Host End for all** → `finished` → review read-only.

## Acting-host (luật chi tiết)
- Host election hiện tại: host = `created_by` (qua `meetingCreatorAtom`). Bổ sung: nếu **creator/host/co-host chưa có mặt**, **nội bộ đầu tiên** join → **acting host** (đủ quyền live).
- Real host/organizer vào → **quyền tự trả về**; acting host về attendee.
- Guest KHÔNG bao giờ thành acting host (phải nội bộ).
- Acting host được End-for-all (cần có người kết thúc được); huỷ/sửa lịch thì chỉ organizer.

## Membership & Mời (invite) — chốt 2026-06-08 (team phân tích)

> Trả lời câu hỏi: "folder project tổ chức sao? mời 1 user chưa có project thì sao? add nhầm thì sao?"

### Nguyên tắc cốt lõi: **2 quyền TÁCH BIỆT, không suy ra nhau**
| Quyền | Lưu ở | Cho phép | Ai được |
|---|---|---|---|
| **project_member** | bảng `project_member` | Xem **CẢ folder**: mọi meeting, mọi file, lịch sử, tạo meeting mới. Folder hiện trong danh sách project của họ. | **Chỉ nội bộ** (mặc định). **KHÔNG bao giờ là khách.** |
| **meeting_invitee** | bảng `meeting_invitee` | Vào/xem **ĐÚNG 1 meeting** (canvas, chat, file của meeting đó, recording). Không gì khác. | Bất kỳ ai được mời — nội bộ hoặc khách. |

→ **Luật then chốt: là `meeting_invitee` KHÔNG cho quyền gì ở mức project.** Khách mời 1 meeting → chỉ có 1 dòng invitee → **không thấy folder, không thấy meeting/file khác**. Bảo mật đúng "by construction".

### Trả lời 4 câu hỏi
1. **Mời 1 meeting → thấy cả project?** → **KHÔNG.** Chỉ thấy đúng meeting đó. (Khách tuyệt đối không thấy phần còn lại của dự án.)
2. **User chưa "có" project đó thì sao? Tự tạo folder?** → **KHÔNG auto-tạo/auto-share folder.** Meeting được mời hiện ở **mục "Sắp tới / Được mời"** riêng (chỉ là các thẻ meeting, KHÔNG lộ folder). *(Team cân 3 phương án: A=share cả project→loại vì lộ bí mật; B=list "Được mời" riêng→**chọn**; C=folder ảo→loại vì rối.)*
3. **Add nhầm → thu hồi?** → **Rẻ vì không copy gì.** Xoá (soft) dòng `meeting_invitee` (status=`revoked`+audit). Nếu có dòng `project_member` *auto-tạo từ lời mời này* → gỡ luôn (chỉ khi auto, không gỡ nếu họ vốn là member). Nếu đang LIVE + đang trong phòng → kick + huỷ Daily token. *(Lưu ý: thu hồi chặn tương lai, không lấy lại được dữ liệu họ đã tải.)*
4. **Nội bộ vs khách?** → **Bất đối xứng nhưng tường minh:** form lên lịch có checkbox **"thêm vào project"** — nội bộ mặc định **BẬT** (được cả invitee + project_member → thấy folder); **khách bị ÉP TẮT** (chỉ invitee → meeting-scoped). Không lỡ tay nâng quyền khách.

### Surface (UI)
- **Dự án của tôi** = folder mà tôi là `project_member` (thay câu query "trả về tất cả" hiện tại).
- **Được mời / Sắp tới** = list phẳng thẻ meeting tôi được mời (theo `scheduled_at`), nhóm Sắp tới / Đang họp / Đã xong. **Đây là chỗ DUY NHẤT khách thấy gì đó** — không bao giờ render folder.

### ⚠️ Phụ thuộc sống còn
API hiện **mở toang** (`GET /v1/projects` trả về MỌI project; **không có authz per-meeting** — [[roadmap]] I-3/§hardening). **Phải ship middleware membership cùng lúc với UI invite**, nếu không thì bảo mật chỉ là hình thức. Cần check: `can_see_project` (là project_member / admin), `can_see_meeting` (là invitee CỦA meeting đó **HOẶC** project_member **HOẶC** admin), `can_see_file` (theo meeting). Daily-token mint cũng phải check `can_see_meeting` (lỗ ở roadmap).

## Data model cần
- `meeting` (có sẵn): `created_by`(=organizer), `scheduled_at`, `status`, `duration_s`, `title/topic`. **Thêm:** `organizer_email`, `host_email` (host hiện hành, mặc định = organizer), `duration_min`, `waiting_room` (bool, mặc định 1), `recording_enabled` (bool). Chuẩn hoá `status`: hiện DB dùng `Completed/Cancelled`, doc dùng `finished/cancelled` → thống nhất 1 bộ.
- **`project_member`** (mới): `(project_id, email, role: 'owner'|'member', added_by, added_at)` — quyền xem **cả folder**. Backfill từ `project.host_email` (role=owner). Thay query "trả về MỌI project" bằng join theo email từ JWT.
- **`meeting_invitee`** (mới): `(meeting_id, email, kind: 'internal'|'guest', role: 'cohost'|'attendee', status: 'invited'|'accepted'|'declined'|'revoked', invited_by, invited_at, revoked_at)` — ai được mời + co-host chỉ định trước + là **membership per-meeting** cho authz. Key = email (lower-case, khớp email trong JWT đã verify).
- `meeting_participant` (đã có, hôm nay): ai **thực sự** join + giờ.
- Acting-host / live host state = runtime (socket/Durable Object), không cần D1.

## Build order (gắn roadmap)
- **Phase 4 — Host control (LIVE):** phòng chờ + admit · **acting-host election** · co-host · transfer host · kick/mute · End-for-all. Cần `meeting_invitee` (membership) + `meeting.status`/`host_email`.
- **Phase 4.5 — Scheduling:** form lên lịch (giờ + invitee) · mục **"Sắp tới"** · state machine scheduled→live→finished/cancelled · join-by-link + màn "chờ Start" · dời lịch/huỷ. (Email mời, calendar sync = sau.)
- Admin console: thêm filter theo `status` + xem scheduled/live/finished (đã có list + detail).

## Để sau (không làm bản đầu)
- Email mời tự động (cần SMTP — [[mcm-auth]]) · Google/Outlook **calendar sync** (.ics) · **họp định kỳ (recurring)** · nhắc lịch (notification) · múi giờ hiển thị (lưu UTC, hiện local).
