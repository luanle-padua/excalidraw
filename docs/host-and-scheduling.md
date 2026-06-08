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

## Data model cần
- `meeting` (có sẵn): `created_by`(=organizer), `scheduled_at`, `status`, `duration_s`, `title/topic`. **Thêm:** `waiting_room` (bool), `recording_enabled` (bool), `host_email` (host hiện hành, mặc định = created_by).
- **`meeting_invitee`** (mới): `(meeting_id, email, kind: 'internal'|'guest', role: 'cohost'|'attendee', status: 'invited'|'accepted', invited_at)` — ai được mời + co-host chỉ định trước. Đây cũng là **membership** (Phase 4) cho per-meeting authz.
- `meeting_participant` (đã có, hôm nay): ai **thực sự** join + giờ.
- Acting-host / live host state = runtime (socket/Durable Object), không cần D1.

## Build order (gắn roadmap)
- **Phase 4 — Host control (LIVE):** phòng chờ + admit · **acting-host election** · co-host · transfer host · kick/mute · End-for-all. Cần `meeting_invitee` (membership) + `meeting.status`/`host_email`.
- **Phase 4.5 — Scheduling:** form lên lịch (giờ + invitee) · mục **"Sắp tới"** · state machine scheduled→live→finished/cancelled · join-by-link + màn "chờ Start" · dời lịch/huỷ. (Email mời, calendar sync = sau.)
- Admin console: thêm filter theo `status` + xem scheduled/live/finished (đã có list + detail).

## Để sau (không làm bản đầu)
- Email mời tự động (cần SMTP — [[mcm-auth]]) · Google/Outlook **calendar sync** (.ics) · **họp định kỳ (recurring)** · nhắc lịch (notification) · múi giờ hiển thị (lưu UTC, hiện local).
