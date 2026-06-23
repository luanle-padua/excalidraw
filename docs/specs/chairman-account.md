# Tài khoản lãnh đạo đọc thông tin dự án — ~~Giám sát vô hình + AI suy luận hành vi~~

> ## ⛔ REFRAME LỚN (2026-06-23, product owner) — đọc TRƯỚC TOÀN BỘ doc
>
> Anh Luân (chủ sản phẩm) đã **đóng khung lại** tính năng này. Bản thiết kế cũ bên
> dưới — tiêu đề *"Giám sát vô hình + AI suy luận hành vi"*, §2 **stealth/tàng
> hình**, §3.3 **chấm điểm hành vi từng người** (sentiment/engagement/influence),
> §4.5 *"quyền tối thượng kể cả 1:1/HR"* — **ĐÃ BỊ THAY THẾ (SUPERSEDED). KHÔNG
> build theo bản đó.**
>
> **Khung MỚI (đúng với event-log đã ship):** đây là **tầng THÔNG TIN / KIẾN THỨC
> dự án**, KHÔNG phải giám sát nhân viên. Cuộc họp được ghi lại **như dữ liệu dự
> án** để (a) **AI hiểu DÒNG CHẢY cuộc họp** và (b) **cấp lãnh đạo cao đọc được
> thông tin dự án đó**. Ba nguyên tắc thay cho 3 thứ đã bỏ:
>
> | ĐÃ BỎ (superseded) | THAY BẰNG |
> |---|---|
> | **Stealth / giám sát tàng hình** (đọc ngầm, không để dấu) | **Đọc CÓ CÔNG BỐ** — sự tồn tại của quyền lãnh đạo-đọc + AI xử lý phải được công bố (consent gate đã ship); leadership đọc qua gate `canSeeMeeting`, không phải đường ẩn. |
> | **AI chấm điểm hành vi per-person** (`chairman_insight`: sentiment/engagement/influence) | **AI hiểu cuộc họp + thông tin DỰ ÁN**, KHÔNG hồ sơ cá nhân, KHÔNG chấm điểm người. Schema `0033` nói thẳng: *"NO per-person behavioral scoring, sentiment, profiling."* |
> | **"Quyền tối thượng kể cả 1:1/HR", không tier nào chặn** | **Disclosure + consent + retention** là đối trọng; HR/1:1/sensitive cần consent riêng hoặc **loại khỏi** AI (xem `event-log-privacy-analysis.md` §3, §6). |
>
> **Vì sao đổi:** phân tích pháp lý `docs/plans/event-log-privacy-analysis.md`
> (06-23) chỉ ra **giám sát NGẦM + AI profiling hành vi = rủi ro pháp lý CAO/RẤT
> CAO** ở KR (PIPA + Comms-Secrets Act hình sự với 1:1), PH (NPC bác covert,
> AO 2018-084), VN (PDPL 2025), EU (GDPR Đ.22 + DPIA). **Disclosure + consent =
> đường an toàn.** Việc đã ship (`meeting_event` + `meeting_consent`,
> `meeting-event-log.md`) đi đúng khung mới: disclosed, consent-by-notice, không
> profiling.
>
> **Cách đọc doc này:** phần kỹ thuật vẫn còn giá trị **chỉ ở** chỗ "lãnh đạo cấp
> cao đọc thông tin dự án xuyên cuộc họp" (org-wide read theo gate, audit truy
> cập). Mọi đoạn nói **stealth / vô hình / chấm điểm người / quyền tối thượng vượt
> consent** = **đã chết**, giữ lại chỉ để truy nguyên quyết định cũ. KHÔNG dùng làm
> spec build.

> ~~Design doc, **chưa code**~~. Bản gốc (dưới banner này) thiết kế một vai trò
> **Chairman** với 2 năng lực: (1) ~~giám sát vô hình~~ → **đọc thông tin dự án
> org-wide CÓ CÔNG BỐ**; (2) AI ~~suy luận hành vi~~ → **AI hiểu dòng chảy cuộc họp
> + tổng hợp thông tin dự án** cho cấp điều hành.
>
> Doc này **bám hệ thống thật** đang chạy. Mọi tham chiếu file/hàm là code hiện
> tại. Liên quan: `docs/plans/event-log-privacy-analysis.md`,
> `docs/plans/meeting-event-log.md`, `docs/generated/architecture.md`,
> `docs/plans/ai-project-knowledge-strategy.md`,
> `docs/plans/project-permissions.md`, `docs/specs/user-data-model.md`.

---

## 0. TL;DR cho anh Luân (1 phút)

**Chairman là gì:** một vai trò mới `app_metadata.role = "chairman"` — như "admin
+", nhưng thay vì màn quản trị vận hành (users/cost/settings) thì có **một trang
duy nhất**: nhìn xuyên **toàn bộ** dự án + cuộc họp, **không ai trong phòng thấy
mình**, cộng một **AI cố vấn riêng** chuyên đọc + suy luận về cuộc họp và con
người. Toàn bộ dựng lại trên **2 thứ đã có sẵn trong code**, không phải xây mới
từ đầu:

1. **Stealth pattern** mà admin compliance đang dùng — đọc snapshot R2 phía server,
   **không join socket/Durable Object**, nên không phát presence/cursor/participant
   row (`worker/src/index.ts` `/v1/admin/meetings/:roomId/open`, `excalidraw-app/data/reviewMode.ts` `markStealthRoom`). Chairman = mở rộng quyền này ra **org-wide** + ghi log riêng.
2. **Retrieval-grounded AI** mà `ai-project-knowledge-strategy.md` đã chốt — KHÔNG
   fine-tune, KHÔNG nhồi data vào weights. Chairman AI = thêm **một prompt suy luận
   mới** đọc context cuộc họp (đã giải mã server-side bằng managed `room_key`) + lưu
   insight vào D1.

**3 quyết định thiết kế lớn nhất:**
- **(A) Chairman là role MỚI, KHÔNG phải admin.** Admin = vận hành (xem §1). Chairman
  = quan sát + AI. Tách ra để (a) quyền giám sát hành vi không lẫn với quyền sửa
  user/xoá dự án, (b) audit gọn, (c) UI rẽ nhánh sạch.
- **(B) Chairman vượt ranh giới E2E — y như admin compliance đã vượt.** Nội dung cuộc
  họp E2E bằng `room_key`, nhưng `room_key` **managed trong D1** (architecture §6 +
  bảng `meeting`). Admin compliance đã giải mã server-side để đọc. Chairman AI cần
  **đúng cây cầu đó**. Đây là **quyết định chính sách**, không phải kỹ thuật — phải
  nói thẳng (xem §4).
- **(C) AI suy luận = retrieval-grounded, BẮT BUỘC trích dẫn nguồn.** Mọi nhận định
  hành vi ("X chặn quyết định", "Y ít tương tác") phải neo vào segment transcript/
  chat/canvas cụ thể. Không trích được = không khẳng định. Đây là phanh chống vu
  oan + chống hallucinate (xem §3).

**MVP đề xuất:** role `chairman` + trang org-wide read-only (tái dùng admin
meetings/projects list bỏ filter) + **AI suy luận cho cuộc họp ĐÃ KẾT THÚC** (1 lần
gọi/cuộc, lưu `chairman_insight`). Live monitoring + behavioral cross-project synthesis = phase sau.

---

## 1. Vai trò & định danh

### 1.1 Provisioning — role mới `chairman`

Identity của Canvas M = **email login đã verify** (architecture §2.4). Vai trò
được mang trong **Supabase JWT `app_metadata.role`** và Worker đọc nó offline:

- Worker set `role` từ JWT tại `worker/src/index.ts:254-255`
  (`c.set("role", appMeta?.role)`).
- Client đọc `app_metadata.role` trong `deriveSession()`
  (`excalidraw-app/data/session.ts:133-148`) → `Session.role`/`Session.isAdmin`.

Hôm nay role có: `admin` · `guest` · undefined (nội bộ thường). **Thêm một giá trị
mới: `"chairman"`.** Provisioning đúng theo cách admin đang được tạo: qua Supabase
Admin API (`POST/PATCH /v1/admin/users` set `app_metadata: { role }` —
`worker/src/index.ts:3857, 3886`). Vì cực kỳ nhạy cảm:

- **Chỉ cấp thủ công**, không có nút self-serve. Ban đầu cấp qua `scripts/seed-supabase-users.mjs` hoặc 1 lần PATCH có chủ đích.
- **Khuyến nghị: chỉ 1–2 người** (đúng nghĩa "Chủ tịch" + có thể 1 trợ lý). Không
  phải tier mở rộng.

### 1.2 Chairman khác Admin thế nào

| | **Admin** (đang có) | **Chairman** (mới) |
|---|---|---|
| Bản chất | Vận hành hệ thống | Quan sát điều hành + AI suy luận |
| Surface | `AdminConsole` (users, cost, storage, settings, audit, backups) | **Chairman page** (org-wide read-only + AI cố vấn) |
| Sửa dữ liệu | Có (CRUD users, xoá dự án, đổi settings) | **KHÔNG** — read-only tuyệt đối |
| Thấy nội dung họp | Có, qua compliance `/open` (audit-before-access) | Có, org-wide, **mặc định stealth** |
| AI | Trong họp (chatbot/summarize) + Ask-this-project (admin-scope, kế hoạch) | **Reasoning mode** riêng: hiểu + phân tích hành vi |
| Số người | Vài người (IT/ops) | 1–2 người (lãnh đạo cao nhất) |

**Tại sao tách role, không gộp vào admin?** (i) Quyền giám sát **hành vi nhân viên**
nặng đô hơn quyền vận hành — gộp vào admin nghĩa là mọi ops-admin tự nhiên có quyền
"đọc tâm lý" mọi người. (ii) Audit gọn: log `chairman.*` tách khỏi `admin.*` để biết
chính xác ai đang dùng quyền nào. (iii) Code path rẽ nhánh sạch: gate
`/v1/chairman/*` riêng (xem §5), không nhồi thêm vào `/v1/admin/*`.

**Quan hệ "trên/cạnh admin":** đặt **cạnh**, không phải kế thừa. Chairman KHÔNG tự
động có quyền admin (không xoá user/dự án) và admin KHÔNG tự động là chairman. Nếu
một người cần cả hai → cấp cả hai role (hoặc, đơn giản hơn ở giai đoạn này: chairman
được phép gọi các route **read-only** của admin, xem §5.3). `canSeeMeeting` hiện
short-circuit `role === "admin"` (`index.ts:417`) → thêm nhánh
`role === "chairman"` song song.

### 1.3 Client: hiện/ẩn trang Chairman

`MeetingLobby.tsx` là "front door" tuần tự (architecture §2.1): chờ `authReadyAtom`
→ login → **admin → `AdminConsole`** → collab/room → project home. Thêm một nhánh:

- Sau khi login, nếu `session.role === "chairman"` → render **`ChairmanConsole`**
  (mới) thay vì dashboard thường. Thêm cờ tiện dụng `Session.isChairman` trong
  `deriveSession()` (cạnh `isAdmin`, `session.ts:142`).
- Trang Chairman **không xuất hiện** với bất kỳ ai khác (gate trên role đã verify,
  không phải domain). Worker re-check độc lập trên mọi route `/v1/chairman/*` (403
  nếu role ≠ chairman) — y hệt admin gate (`index.ts:293-298`).
- Chairman **vẫn có thể** vào họp như người thường nếu muốn (nhưng đó KHÔNG phải
  chế độ stealth — xem §2.4 về phân biệt "tham gia công khai" vs "giám sát ẩn").

### 1.4 Owner / super-admin — tầng TRÊN Chairman (CHỐT 06-17, anh Luân)

Mô hình **3 tầng** (chốt 06-17):

| Tầng | Ai | Quyền | Bị ai kiểm |
|---|---|---|---|
| **Owner** (`role = "owner"`) | **anh Luân — người phát triển/vận hành app** (1 người) | **Operational tối thượng:** deploy, DB/data, sửa-cứu sự cố, **cấp MỌI role** (kể cả chairman) + **đọc `chairman_audit`** (auditor của Chairman) | chính mình + `owner_audit` (xem dưới) |
| **Chairman** (`role = "chairman"`) | Chủ tịch (**1 người** — chốt 06-17) | **Giám sát hành vi tối thượng**, read-only, thấy mọi cuộc (§4.5) | **Owner** (qua `chairman_audit`) |
| **Admin** (`role = "admin"`) | vận hành thường ngày | quản trị user/project/compliance như hiện tại | audit_log thường |

**Tách bạch 2 loại quyền (nguyên tắc cốt lõi):**
- **Operational/kỹ thuật** (deploy, sửa data, cấp role, cứu sự cố) = **Owner**. Đây là việc thật của người dựng app.
- **Giám sát hành vi** (đọc nội dung + AI phân tích người) = **Chairman**. KHÔNG phải daily-tool của dev.
- Owner *có thể* truy cập nội dung khi cần vận hành/debug, **nhưng mọi truy cập nội dung của Owner cũng ghi `owner_audit`** — không phải để trói Owner mà để **bảo vệ** Owner (bằng chứng tay-sạch khi có tranh chấp, bắt buộc khi ra khách ngoài + đa quốc gia). "Quyền giám sát phải tự bị giám sát" áp cho **cả Owner**.

→ **Hệ quả gọn:** Owner làm luôn vai "người thứ ba kiểm Chairman" → **không cần đẻ thêm vai DPO** ở giai đoạn này. Gate Worker: `/v1/owner/*` (operational + đọc `chairman_audit`) tách khỏi `/v1/chairman/*` (giám sát). Provisioning: chỉ **Owner** mới cấp được role `chairman`/`admin`/`owner`.

---

## 2. ~~Giám sát vô hình (Invisible monitoring)~~ — ⛔ SUPERSEDED (06-23)

> **CẢ MỤC NÀY ĐÃ BỎ.** "Giám sát vô hình / stealth / không để lại dấu vết" là
> **thuộc tính sản phẩm bị loại** sau reframe 06-23 + phân tích pháp lý
> (`event-log-privacy-analysis.md` §2: covert monitoring bất hợp pháp KR/PH, rủi ro
> cao VN). **Thay bằng:** lãnh đạo cấp cao đọc thông tin dự án **qua gate
> `canSeeMeeting` CÓ CÔNG BỐ** (consent gate đã ship), audit truy cập vẫn giữ. Sự
> *tồn tại* của quyền đọc phải được công bố; KHÔNG đọc ngầm. Nội dung kỹ thuật dưới
> đây giữ lại chỉ để truy nguyên — KHÔNG build "stealth".

### 2.1 Stealth pattern đã có sẵn — đây là nền

Code đã có sẵn một đường "đọc mà không lộ", dựng cho admin compliance:

1. **Server trả key có kiểm soát:** `POST /v1/admin/meetings/:roomId/open`
   (`index.ts:4006-4046`) — **route DUY NHẤT** trả `room_key` cho người không phải
   participant, và **không bao giờ trả key trước khi audit_log ghi thành công**
   (insert fail → 500 "access denied", `index.ts:4037-4039`). Đây là pattern
   **audit-before-access**.
2. **Client đọc snapshot, KHÔNG join phòng:** `markStealthRoom(roomId)`
   (`reviewMode.ts:46-60`) → client đọc **snapshot R2 thuần** (scene/chat/transcript/
   library) và **không join socket/Durable Object**. Hệ quả (comment ngay trong
   file, dòng 37-42): *"no presence, no cursor, no participant row — nothing
   observable to the people in the meeting."*
3. **Không tạo `meeting_participant`:** participant row chỉ ghi khi thực join realtime
   (architecture §2.5, bảng `meeting_participant` "ai thực join"). Stealth không join
   → không có row → không hiện trong ParticipantsBar / "In the room".

Chairman **tái dùng nguyên si cơ chế này**. Điểm khác duy nhất: **phạm vi** (org-wide,
§2.2) + **ghi log riêng** (`chairman_audit`, §2.5) + **mặc định luôn stealth** (admin
phải chủ động "open"; chairman quan sát ẩn là mặc định).

### 2.2 Phạm vi = TOÀN tổ chức

`canSeeMeeting(db, email, role, roomId)` (`index.ts:411-477`) quyết định ai thấy
cuộc họp nào. Nó **đã** short-circuit `if (role === "admin") return true`
(`index.ts:417`). Mở rộng:

```
if (role === "admin" || role === "chairman") return true;
```

→ Chairman thấy **mọi** cuộc họp bất kể confidentiality, project membership, invitee.
Tương tự `projectAccess()` (`index.ts:489+`) thêm nhánh chairman → `"full"` mọi dự
án. Các route admin list đã sẵn org-wide (`GET /v1/admin/meetings` `index.ts:3939`
— mọi meeting; `GET /v1/admin/projects` `index.ts:4050` — mọi project): Chairman có
**bản sao read-only** dưới `/v1/chairman/*` (xem §5).

> **Lưu ý confidential:** `canSeeMeeting` cố tình KHÔNG cho cả division head đọc cuộc
> họp `confidential` trừ khi là owner/invitee (`index.ts:465-467`). Chairman **vượt
> cả carve-out này** — đó là toàn bộ ý nghĩa "Chủ tịch nhìn thấy tất cả". Phải ghi
> rõ trong policy (§4): confidential vẫn invisible với head, nhưng KHÔNG với chairman.

### 2.3 Live vs Finished — và trade-off thật

Stealth read = **đọc snapshot R2**, không phải feed realtime. Architecture §2.3 nói
thẳng: *"Stealth: không join socket, đọc snapshot R2 thuần... trade-off: meeting
live chỉ thấy **autosave cuối**."*

- **Finished meeting:** snapshot R2 là **đầy đủ + bất biến** (scene/chat/transcript
  flush khi rời phòng, `flushPendingRoomSaves`). Chairman đọc trọn vẹn → **đây là
  vùng MVP**.
- **Live meeting:** snapshot chỉ là autosave gần nhất (scene throttle 20s, transcript
  5s, chat 800ms — architecture §2.2). Chairman thấy ảnh chụp **trễ ~vài giây→20s**,
  KHÔNG phải xem trực tiếp từng cursor. **Vẫn vô hình** (vì chỉ đọc R2), nhưng KHÔNG
  real-time đúng nghĩa.
- **Live real-time đúng nghĩa (silent observer)** = phải join Durable Object `RoomDO`
  như một peer **ẩn** (không phát `USER_PROFILE`/presence). Đây là việc **mới**,
  architecture §5 liệt kê "compliance live realtime (silent-observer)" là **known
  gap chưa làm**. → **Defer sang full phase**, không vào MVP.

**Khuyến nghị thực dụng:** MVP Chairman = "review-after-the-fact" + "live snapshot
polling" (poll R2 mỗi ~15–20s cho cuộc đang `live`). Đủ cho 95% nhu cầu điều hành;
silent-observer realtime để sau.

### 2.4 Giữ vô hình thế nào — checklist enforce

Để KHÔNG để lại dấu, đường đi của Chairman phải tránh **mọi** chỗ tạo dấu vết:

| Dấu vết khả dĩ | Sinh ra khi | Stealth tránh bằng |
|---|---|---|
| Presence / cursor | Join socket/DO, broadcast `USER_PROFILE` | KHÔNG join DO — chỉ đọc R2 (`isStealthRoom`) |
| `meeting_participant` row | Thực join realtime | Không join → không ghi row |
| `last_opened_at` bump | Mở meeting qua route thường | Chairman read route KHÔNG bump `last_opened_at` (admin `/open` cũng không — chỉ `meeting` GET thường mới) |
| Daily audio/screen presence | Xin Daily token + join | Chairman read KHÔNG mint Daily token |
| `audit_log` mà participant thấy | — | Participant KHÔNG có quyền đọc `audit_log` (admin-only); chairman log vào bảng RIÊNG (§2.5) |

**Phân biệt rõ 2 chế độ cho Chairman:**
- **Giám sát ẩn (mặc định):** mọi thao tác từ Chairman page → stealth path, vô hình.
- **Tham gia công khai (tùy chọn):** nếu Chairman muốn *thật sự dự họp* (nói chuyện,
  để lộ mình) → vào như user thường qua `#room` link. Đây là lựa chọn có ý thức,
  KHÔNG phải mặc định. UI Chairman page nên tách 2 nút rõ ràng: **"Quan sát ẩn"** vs
  **"Tham gia"**.

### 2.5 Truy cập của Chairman CÓ được audit không? — CÓ

**Khuyến nghị mạnh: CÓ, ghi vào bảng riêng `chairman_audit`.**

Lý do: quyền này vượt E2E + giám sát hành vi nhân viên — nó **phải** có trail để
chính nó cũng accountable (đúng triết lý admin compliance: *"the immutable trail is
what keeps this power accountable"*, `index.ts:4004-4005`).

- **Tách bảng** (`chairman_audit`, không dùng chung `audit_log`) vì: (i) audit của
  admin và của chairman là 2 trách nhiệm khác nhau; (ii) participant/admin thường
  KHÔNG nên đọc được chairman đã xem gì (chính nó nhạy cảm); (iii) query gọn.
- **Ghi audit-before-access:** y như `/open`, insert `chairman_audit` **trước** khi
  trả nội dung/key; insert fail → từ chối. Cột tối thiểu:
  `{ id, chairman_email, action, target_meeting_id, target_project_id, meta, ts }`.
  `action` ví dụ: `chairman.view_meeting`, `chairman.run_reasoning`, `chairman.view_project`.
- **Vô hình với participant, ghi lại với tổ chức:** participant trong phòng KHÔNG
  thấy gì; nhưng tổ chức (qua một super-admin / DPO / hội đồng) **có thể** kiểm
  `chairman_audit` để biết Chairman đã soi ai. Đây là guardrail chống lạm quyền
  (xem §4).

---

## 3. Chế độ AI suy luận (Reasoning mode)

### 3.1 Khác gì AI trong họp

AI hiện tại (`worker/src/ai.ts`) phục vụ **người trong phòng, real-time**:
`/chatbot` (MCM Bot trả lời câu hỏi về cuộc họp đang diễn ra), `/summarize` (recap
JSON khi End-for-all → `meeting.ai_summary` D1). Prompt được tối ưu để **"đọc cuộc
họp như một LOG sống"** và **không bịa** (`CHATBOT_SYSTEM_PROMPT`, `ai.ts:161`).

Chairman AI khác về **mục đích + người dùng**: phục vụ **một người quan sát, sau/trên
cuộc họp**, để **hiểu + suy luận**, gồm cả **phân tích hành vi**. → Cần **prompt mới**
+ **endpoint mới** + **bảng lưu insight mới**. KHÔNG đụng prompt in-meeting.

### 3.2 Pipeline (đường đi 1 cuộc họp)

```
Chairman bấm "Phân tích cuộc họp X"
  → POST /v1/chairman/meetings/:id/reason   (gate: role==chairman; ghi chairman_audit TRƯỚC)
  → Worker GATHER context (server-side):
      • transcript  R2  transcripts/<id>/current   (E2E → giải mã bằng managed room_key)
      • chat        R2  chats/<id>/current          (E2E → giải mã)
      • canvas text R2  scenes/<id>/current         (E2E → trích text elements)
      • ai_summary  D1  meeting.ai_summary          (plaintext, đã có sẵn)
      • participants D1 meeting_participant          (ai thực join)
      • invitees     D1 meeting_invitee              (ai được mời nhưng vắng)
  → giải mã server-side bằng room_key (D1, như admin /open)
  → build REASONING prompt → gọi Gemini (model mạnh hơn Flash, §5.4)
  → nhận JSON có cấu trúc: meeting-understanding + per-person + cross-refs
  → lưu chairman_insight (D1)  +  meter usage_events
  → trả về Chairman page render
```

**Tái dùng:** context shape đã có sẵn — `meetingContext.ts` (`MeetingContext`:
participants/files/title/status) được thiết kế *"so a future retrieval-grounded
project AI can reuse the exact same shape"* (comment đầu file). Việc gather + giải mã
R2 tái dùng đúng đường admin compliance đã đi. Đây **không phải** xây mới hạ tầng.

### 3.3 Output — 3 tầng, retrieval-grounded

Prompt trả về JSON (responseSchema strict, như `/summarize` `ai.ts:908`). Mỗi nhận
định **bắt buộc** kèm `evidence` trỏ về segment nguồn (chỉ số segment / dòng chat /
label canvas) — **không trích được thì không khẳng định**:

**(a) Meeting understanding**
```
{ decisions[], openQuestions[], topics[], outcomes[],
  decisionsReversed[]  // quyết định cuộc này lật quyết định trước (tín hiệu giàu nhất) }
```

**(b) ~~Per-person behavioral analysis~~** — ⛔ **SUPERSEDED (06-23): ĐÃ BỎ HOÀN
TOÀN.** Chấm điểm hành vi từng người (sentiment / engagement / influence /
"blocked Y") = **profiling**, rủi ro pháp lý cao nhất (`event-log-privacy-analysis.md`
§2.4: GDPR Đ.22 + DPIA, KR Đ.37-2, PH proportionality). Schema đã ship (`0033`) nói
thẳng *"NO per-person behavioral scoring, sentiment, profiling."* **THAY BẰNG:** AI
chỉ trích **thông tin DỰ ÁN** ở mức cuộc họp (quyết định, action item, chủ đề,
turning-point) — KHÔNG hồ sơ cá nhân, KHÔNG điểm số người. Block JSON dưới đây giữ
lại chỉ để truy nguyên, KHÔNG implement:
```
{ name,
  roleInDiscussion,   // ❌ BỎ
  influence,          // ❌ BỎ
  contribution,       // ❌ BỎ
  sentiment,          // ❌ BỎ
  engagement,         // ❌ BỎ
  evidence[]          // (grounding vẫn đúng cho thông tin dự án, không cho chấm người)
}
```
Attribution **đã khả thi** vì transcript per-speaker chính xác (architecture §2.6:
*"mỗi tab transcribe chính mình → attribution chính xác không cần diarization"*) và
chat/canvas note đều label `Name: text` (`ai.ts:178-181`).

**(c) Cross-meeting / cross-project patterns** — retrieval xuyên lịch sử:
```
{ personPatterns,    // "X thường drive design decisions, ít theo dõi action item"
  projectMomentum,   // dự án đang tăng/giảm tốc; quyết định hay bị lật
  recurringBlockers } // chủ đề/người lặp lại gây nghẽn
```

### 3.4 Retrieval-grounded, KHÔNG fine-tune — bám đúng chiến lược

`ai-project-knowledge-strategy.md` đã chốt (và doc này **không được lệch**):
- **KHÔNG fine-tune, KHÔNG nhồi data vào weights.** Lý do then chốt còn ĐÚNG cho
  Chairman: nướng fact vào model = "xoá bức tường phòng ban" + không gỡ ra được +
  cũ + đắt. Chairman cần *đọc rộng*, không cần *model riêng*.
- **"1 model biết tất cả" = 1 Gemini/Claude chung + phạm vi truy hồi mở rộng + audit**
  (đúng câu chốt của plan: *"train trên mọi thứ = cho admin query xuyên mọi thứ"*).
  Chairman = đúng "admin-scope retrieval" đó, **bỏ filter `project_id`** vì chairman
  org-wide, **có audit** (`chairman_audit`).
- **Trí tuệ xuyên dự án; ranh giới là filter query enforce được, không phải weights.**
  Chairman có chủ đích bỏ filter → đây là **code path RIÊNG, có chủ đích, audit đầy
  đủ** (đúng risk #2 của plan: *"Admin xuyên-dự-án = code path riêng, có chủ đích,
  audit"*).
- **Cross-project memory** = retrieval trên kho `ai_summary` (D1, plaintext, đã gắn
  `project_id`) + `chairman_insight`. Vài chục→trăm cuộc: nối thẳng vào prompt, KHÔNG
  cần vector DB (đúng Phase 1 của plan: *"30 tóm tắt × ~1k token thừa sức"*). Chỉ khi
  kho quá lớn mới cân nhắc Vectorize (Phase 2, vượt lằn ranh E2E — báo trước).

### 3.5 Data model lưu insight — `chairman_insight`

Bảng D1 mới (migration cộng dồn, hiện next ~0025+ — kiểm runner `worker/migrate.mjs`):

```
chairman_insight(
  id            TEXT PK,
  meeting_id    TEXT,                 -- NULL nếu là insight cấp dự án/người
  project_id    TEXT,                 -- thừa kế tường phòng ban (kể cả khi chairman bỏ qua)
  subject_kind  TEXT,                 -- 'meeting' | 'person' | 'project'
  subject_ref   TEXT,                 -- email người / project_id / meeting_id
  payload       TEXT,                 -- JSON: output §3.3 (understanding/behavior/patterns)
  evidence      TEXT,                 -- JSON: refs segment nguồn (grounding)
  model         TEXT,                 -- provider+model+version (sovereignty seam)
  prompt_version TEXT,                -- version hoá prompt = IP (theo Nadella addendum)
  cost_usd      REAL,
  created_by    TEXT,                 -- chairman email
  created_at    INTEGER, ts INTEGER
)
```

Ghi chú:
- **Plaintext, server-readable** (như `ai_summary`) — đây là dữ liệu dẫn xuất do
  Chairman tạo, không E2E. Nhạy cảm → chỉ chairman đọc (gate `/v1/chairman/*`).
- **`project_id` luôn giữ** dù chairman query org-wide — để (i) lọc/audit về sau, (ii)
  nếu sau này cần "rút quyền chairman" thì insight vẫn truy nguyên được phạm vi.
- **Bất biến + version hoá:** lưu `model` + `prompt_version` để có thể regenerate khi
  đổi model (swap-the-model test) mà vẫn audit được cái cũ. Khớp `ai_signal` direction
  của plan (addendum a).
- **`evidence` tách cột** để render "click vào nhận định → nhảy tới segment nguồn" trên
  Chairman page (UX chống vu oan).

---

## 4. Riêng tư / quản trị / đạo đức — guardrails thực dụng

Đây là **giám sát hành vi nhân viên vô hình**. Nói thẳng, không lên giọng, nhưng phải
có phanh — nếu không, đây là tính năng dễ thành rủi ro pháp lý + văn hoá nhất sản
phẩm.

**1. Ai được giữ role.** Chỉ 1–2 người, lãnh đạo cao nhất, cấp thủ công. KHÔNG mở
   rộng thành tier. Việc cấp role nên có **2 người duyệt** (vd super-admin cấp, ghi
   lại) — không để 1 người tự cấp cho mình qua `/v1/admin/users`.

**2. Ranh giới E2E mà tính năng này VƯỢT — phải minh bạch nội bộ.** Code wire vẫn
   E2E (`#room=<id>,<key>`), nhưng `room_key` **managed trong D1** (architecture §6,
   bảng `meeting`). Nghĩa là "E2E hiện là ranh giới **chính sách**, chưa phải mật mã
   thuần" (architecture §1). Chairman + admin compliance **dựa hoàn toàn** vào việc
   key nằm server-readable. → Tổ chức phải **công bố chính sách** rằng nội dung họp
   *có thể* được lãnh đạo/giám sát đọc lại. Một "E2E thật" (key chỉ ở client) sẽ
   **phá** cả Chairman lẫn compliance — đây là đánh đổi đã chọn, cần ghi cho rõ.

**3. Consent / policy.** Nhân viên **nên được thông báo** (qua nội quy/onboarding)
   rằng cuộc họp nội bộ được ghi + có thể được phân tích bởi AI cho mục đích điều
   hành. Nhiều khu vực pháp lý (và "đi đa quốc gia — Phi sắp tới", theo memory) yêu
   cầu thông báo cho việc giám sát + phân tích AI hành vi. **Không** cần để participant
   thấy *từng lần* chairman soi (đó là chủ đích stealth), nhưng **chính sách tổng**
   phải công khai. Khuyến nghị: 1 dòng trong ToS nội bộ + 1 banner khi tạo cuộc họp
   ("Cuộc họp này được ghi và có thể được phân tích").

**4. Audit trail của chính Chairman.** `chairman_audit` audit-before-access (§2.5) —
   để một **người thứ ba** (DPO/super-admin/hội đồng) kiểm Chairman đã soi ai, chạy
   reasoning gì. Quyền giám sát phải tự nó bị giám sát.

**5. Giới hạn phạm vi (scope limits) — đề xuất.**
   - **Read-only tuyệt đối:** Chairman KHÔNG sửa/xoá gì (khác admin). Enforce ở Worker:
     `/v1/chairman/*` chỉ GET + POST reasoning, không có PATCH/DELETE nội dung.
   - **⛔ SUPERSEDED (06-23): "quyền tối thượng kể cả 1:1/HR" ĐÃ BỎ.** Đọc ngầm
     1:1/HR/sensitive là điểm phơi nhiễm pháp lý nặng nhất (`event-log-privacy-analysis.md`
     §3: KR Comms-Secrets Act = **hình sự**). **Khung mới:** HR/1:1/grievance cần
     **consent riêng hoặc LOẠI khỏi** AI/leadership-read; truy cập (nếu có) đi qua
     **break-glass có lý do + công bố sự tồn tại của quyền**. Đoạn cũ dưới đây
     (giữ truy nguyên, KHÔNG build):
     ~~**KHÔNG loại trừ — Chairman có QUYỀN TỐI THƯỢNG (CHỐT 06-17):**
     Chairman thấy **MỌI** cuộc họp, kể cả 1:1 / HR / đánh giá cá nhân / kỷ luật /
     `confidential`. Không có tier `private` nào chặn được Chairman.~~ → Hệ quả
     quan trọng: vì **không có nội dung nào ngoài tầm**, toàn bộ đối trọng (an toàn
     đạo đức/pháp lý) phải dồn sang **3 chỗ KHÁC, không phải việc giấu nội dung**:
     **(a)** `chairman_audit` audit-before-access — bên thứ ba (DPO/hội đồng) kiểm
     Chairman đã soi ai, chạy reasoning gì (§4) — bắt buộc, không bỏ; **(b)** **cực
     ít người** giữ role (đề xuất 1–2 người, do super-admin cấp); **(c)** consent/
     policy công khai (§3). Read-only tuyệt đối vẫn giữ (Chairman KHÔNG sửa/xoá).

**6. Data retention.** `chairman_insight` (phân tích hành vi) nhạy hơn cả transcript.
   Đề xuất: **TTL có hạn** (vd insight hành vi cá nhân giữ N tháng rồi auto-purge, trừ
   khi pin lại có lý do). Đừng để "hồ sơ hành vi" tích luỹ vô thời hạn — đó là rủi ro
   pháp lý + đạo đức lớn nhất.

**7. Khung "phương pháp vs fact" (từ AI strategy).** Cross-project synthesis của
   Chairman nên ưu tiên **pattern** ("nhóm hay để action item rơi") hơn là **dossier
   cá nhân** ("ông X điểm engagement 3/10"). Pattern giúp điều hành; điểm số cá nhân
   dễ thành công cụ ép người. Prompt nên **nghiêng về pattern + evidence**, tránh
   "chấm điểm" tuyệt đối hoá con người.

---

## 5. Kiến trúc & chi phí

### 5.1 Endpoint / page mới (chỉ bề mặt, không code)

**Worker — gate mới `/v1/chairman/*`** (mirror admin gate `index.ts:293-298`, check
`role === "chairman"`; mọi route ghi `chairman_audit` trước khi trả):
- `GET  /v1/chairman/meetings` — org-wide list (tái dùng query của `/v1/admin/meetings` `index.ts:3939`).
- `GET  /v1/chairman/projects` — org-wide (tái dùng `/v1/admin/projects` `index.ts:4050`).
- `GET  /v1/chairman/meetings/:id` — detail + **stealth content** (giải mã R2 server-side,
  không bump `last_opened_at`, không trả Daily token).
- `POST /v1/chairman/meetings/:id/reason` — chạy AI suy luận, lưu `chairman_insight`.
- `GET  /v1/chairman/insights?subject=...` — đọc insight đã lưu (meeting/person/project).
- `POST /v1/chairman/ask` — Q&A xuyên dự án (retrieval trên `ai_summary` + `chairman_insight`,
  org-wide, audit) — phase sau.

**Worker — AI reasoning** (`worker/src/ai.ts` hoặc module mới `chairman-ai.ts`):
- Prompt mới `REASONING_SYSTEM_PROMPT` (3 tầng §3.3, retrieval-grounded, bắt buộc
  evidence). Tách hẳn khỏi `CHATBOT_SYSTEM_PROMPT`/`SUMMARY_SYSTEM_PROMPT`.
- Meter qua `meterGemini`/`logUsageEvent` (`usage.ts`) — thêm `kind: "chairman_reason"`.

**Client — `ChairmanConsole`** (mới, song song `AdminConsole.tsx`):
- Org-wide browser (cây project → meeting, read-only).
- Mở 1 cuộc → stealth content view (tái dùng `markStealthRoom` `reviewMode.ts:46`).
- Panel AI: "Phân tích cuộc họp" → render understanding + per-person + patterns, mỗi
  nhận định click được về evidence.
- 2 nút rõ ràng: **Quan sát ẩn** (mặc định) vs **Tham gia** (§2.4).
- Rẽ nhánh ở `MeetingLobby.tsx` trên `session.isChairman`.

### 5.2 Tái dùng vs mới

| Hạng mục | Tái dùng | Mới |
|---|---|---|
| Stealth read (R2, no-join) | `reviewMode.ts` `markStealthRoom`, đường admin `/open` | — |
| Giải mã server-side bằng `room_key` | Đúng cây cầu admin compliance | — |
| Org-wide list query | `/v1/admin/meetings|projects` | Bản chairman read-only |
| Gather context shape | `meetingContext.ts` `MeetingContext` | Gắn thêm transcript/chat decrypt |
| AI call + metering | `ai.ts` fetch Gemini + `meterGemini` (`usage.ts`) | Prompt reasoning + bảng insight |
| Role gate | Admin gate pattern (`index.ts:293`) | `/v1/chairman/*` gate |
| canSeeMeeting | — | thêm nhánh `role==="chairman"` (`index.ts:417`) |

→ Phần lớn là **lắp ghép + bỏ filter + thêm prompt**, không phải hạ tầng mới.

### 5.3 Chairman có cần quyền admin read không?

Để gọn MVP: cho `/v1/chairman/*` tự query D1/R2 trực tiếp (không proxy admin). Nếu
muốn tiết kiệm: cho phép chairman gọi **các route read-only** của admin (meetings/
projects list) bằng cách nới gate admin thành `role === "admin" || role ===
"chairman"` **chỉ trên các GET read-only**. Khuyến nghị **route riêng** (rõ ràng +
audit riêng) hơn là nới admin gate (dễ rò quyền ghi).

### 5.4 Chi phí AI + chọn model

**In-meeting AI hôm nay = Gemini Flash** (`ai.ts:58` `gemini-2.5-flash`; giá
`usage.ts`: in $0.075/1M, out $0.30/1M). Rẻ vì task nhẹ (dịch/Q&A ngắn/summary).

**Chairman reasoning NẶNG hơn nhiều:**
- Input lớn: 1 cuộc 1h ≈ 8–15k token transcript (theo AI strategy) + chat + canvas +
  summary → ~10–20k token in/cuộc.
- Output có cấu trúc dài (per-person × N người + patterns) → ~2–4k token out.
- **Reasoning cần model mạnh hơn Flash.** Phân tích hành vi + suy luận nhân-quả +
  bám evidence là chỗ Flash dễ trượt. Lựa chọn:
  - **Gemini 2.5 Pro** (giữ cùng nhà cung cấp, đổi 1 biến model) — hợp nhất về độ
    phức tạp tích hợp.
  - **Claude (Sonnet cho thường, Opus cho ca khó)** — AI strategy plan thực ra đã
    nghiêng về Claude cho reasoning (*"Dành tier nặng nhất (Opus) chỉ cho reasoning
    xuyên-cuộc-họp thật khó"*). Cần thêm 1 provider seam.

  > **Khuyến nghị:** bọc model-call sau **một seam config `provider+model+version`**
  > (đúng "sovereignty seam" của AI strategy addendum) → đổi Flash↔Pro↔Claude là đổi
  > config, không viết lại. MVP có thể bắt đầu Gemini 2.5 Pro (ít việc tích hợp nhất),
  > nâng lên Claude Opus cho cross-project synthesis nếu chất lượng chưa đủ.

- **Ước tính chi phí (Gemini 2.5 Pro, ~$1.25/1M in, ~$10/1M out — kiểm giá hiện hành
  khi triển khai):** ~15k in + 3k out ≈ **$0.05/cuộc**. Cả tổ chức vài chục–vài trăm
  cuộc/tháng → **vài đô/tháng**. Không phải vấn đề chi phí; **prompt-caching** trên
  summary/brief tái dùng cắt thêm cho cross-project. Mọi call vẫn ghi `usage_events`
  (`kind="chairman_reason"`) → hiện trên admin cost dashboard.
- **Reasoning chạy ON-DEMAND** (chairman bấm), KHÔNG tự chạy mọi cuộc → chi phí theo
  nhu cầu thật, không phải theo số cuộc.

---

## 6. Phasing & open questions

### MVP (build trước — "thấy giá trị, rủi ro thấp")
1. **Role `chairman`** + `Session.isChairman` + Worker gate `/v1/chairman/*` +
   `canSeeMeeting`/`projectAccess` thêm nhánh chairman.
2. **`ChairmanConsole`** org-wide read-only list (tái dùng admin query), rẽ nhánh
   `MeetingLobby`.
3. **Stealth content view** cho cuộc đã/đang họp (tái dùng `markStealthRoom`); live =
   snapshot polling, KHÔNG silent-observer realtime.
4. **AI reasoning cho cuộc ĐÃ KẾT THÚC**: 1 lần gọi/cuộc → understanding + per-person +
   evidence → lưu `chairman_insight`. Model: Gemini 2.5 Pro qua seam config.
5. **`chairman_audit`** audit-before-access trên mọi truy cập.

→ MVP đã trả lời được 2 yêu cầu gốc: "nhìn thấy tất cả, ẩn" + "AI hiểu cuộc họp +
hành vi từng người". Rủi ro thấp vì chỉ đọc cuộc đã xong (snapshot bất biến).

### Full (sau MVP)
6. **Live silent-observer realtime** (join `RoomDO` ẩn, không phát presence) — lấp
   known gap architecture §5.
7. **Cross-project / cross-person synthesis** (`/v1/chairman/ask` org-wide retrieval
   trên `ai_summary` + `chairman_insight`; pattern xuyên dự án; decision-reversal).
8. **Behavioral trend over time** (engagement/influence của 1 người qua nhiều cuộc),
   với TTL retention (§4.6).
9. **Vectorize** chỉ khi kho quá lớn (vượt lằn ranh E2E — báo trước, theo AI strategy
   Phase 2).

**Build-order khuyến nghị:** 1→2→3→5 (nền + stealth + audit) trước, rồi 4 (AI) — vì
4 vô dụng nếu nền chưa vô hình + chưa audit. 6–9 chỉ làm khi MVP chứng minh giá trị.

### Open questions cho anh Luân quyết
1. ~~**Confidential vs Chairman / tier `private`?**~~ ✅ **CHỐT 06-17: Chairman
   quyền TỐI THƯỢNG — thấy MỌI cuộc (kể cả `confidential`, 1:1, HR). KHÔNG có tier
   `private` chặn Chairman.** Đối trọng dồn sang `chairman_audit` + cực ít người giữ
   role + consent công khai (xem §4.5). → vì vậy Q#2 (ai kiểm chairman) và Q#3 (bao
   nhiêu người) giờ là **bắt buộc trả lời**, không còn optional.
2. ~~**Audit của chairman ai được kiểm?**~~ ✅ **CHỐT 06-17: vai `owner` (anh Luân,
   người phát triển) đọc `chairman_audit`** — không cần DPO riêng (xem §1.4). Mọi
   truy cập nội dung của owner cũng ghi `owner_audit`.
3. ~~**Bao nhiêu người là chairman?**~~ ✅ **CHỐT 06-17: đúng 1 (chỉ Chủ tịch).**
4. **Consent/policy nội bộ:** có sẵn nội quy thông báo "họp được ghi + phân tích AI"
   chưa? (cần cho đa quốc gia — Phi). → §4.3.
5. **Model reasoning:** chấp nhận thêm provider Claude (chất lượng cao hơn cho hành
   vi/suy luận) hay giữ 1 nhà Gemini Pro cho gọn? → §5.4.
6. **"Chấm điểm người" tới đâu?** Per-person có nên xuất "điểm engagement" hay chỉ
   mô tả + evidence (tránh dossier)? → §4.7.

---

> **Tóm 1 câu:** Chairman = role mới `chairman` cạnh admin, tái dùng **stealth
> read** (R2, không join → vô hình) mở rộng **org-wide** + audit riêng, cộng một
> **AI suy luận retrieval-grounded** (giải mã server-side như compliance, prompt
> mới 3-tầng có evidence, lưu `chairman_insight`) — KHÔNG fine-tune, KHÔNG hạ tầng
> mới đáng kể. MVP = role + org-wide read-only + reasoning cho cuộc đã kết thúc.
