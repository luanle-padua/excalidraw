# Đề xuất tính năng Admin Console — chốt 2026-06-11

> Đường dẫn `docs/...` trong file là vị trí CŨ trước reorg docs 06-11 (xem `docs/README.md`).

Tổng hợp từ 4 báo cáo (hiện trạng, data-hygiene, statistics, benchmark), đã đối chiếu code (`worker/src/index.ts`, `worker/schema/0001→0016.sql`, `AdminConsole.tsx`).

**Bối cảnh chốt:** anh Luân (non-CS) tự vận hành; stack D1 + R2 + Supabase + Daily.co; remote worker vừa live, DB remote còn trống. Yêu cầu gốc: **quản lý data chung, dọn empty data, statistic**.

**Nguyên tắc xếp ưu tiên:** (1) đúng yêu cầu gốc → (2) tính được từ dữ liệu CÓ SẴN, không cần instrumentation mới → (3) đơn giản để 1 người maintain lâu dài.

**Đính chính đã verify trên code:**

- Cột owner của project là `project.host_email` (báo cáo benchmark ghi nhầm `owner_email`).
- `PATCH /v1/admin/users/:id` (dòng 2053) đã nhận `role`/`password`/`disabled` — **chưa** nhận `user_metadata` (tên/직급/phòng ban) → sửa hồ sơ cần mở rộng route, không chỉ thêm UI.
- Worker **không có** handler `scheduled()` → `retention_days` trong Settings hiện không ai đọc.
- `deleteMeetingCascade` (dòng 2264) + tombstone `deleted_meeting` (migration 0015) có sẵn, tái dùng được.
- `meeting` có sẵn: `duration_s`, `discipline`, `participant_count`, `scheduled_at`, `ai_summary`, `last_opened_at`, `scene_r2_key`; `project` có `branch`. Mọi query thống kê nhóm A chạy được ngay.

---

## (a) Bảng TOP đề xuất theo ưu tiên

| # | Tính năng | Giải quyết gì cho anh Luân | Dữ liệu nguồn | Effort | Nhóm |
| --- | --- | --- | --- | --- | --- |
| 1 | **Tab "Dọn dẹp": quét meeting/project trống + row `file` mồ côi** | Đúng yêu cầu gốc "empty data": thấy rác → tick → xoá, không cần SQL | CÓ SẴN — thuần D1, API xoá cascade có sẵn; chỉ thêm route scan | **S** | Dọn rác |
| 2 | **Nút "Reset dữ liệu demo" (wipe hàng loạt meeting, giữ project/user)** | Lần 06-04 phải wipe tay bằng SQL; demo June cần làm lại nhiều lần | CÓ SẴN — loop `deleteMeetingCascade` + confirm gõ chữ | **S/M** | Dọn rác |
| 3 | **Tab Statistics: trend 12 tuần + cắt theo branch/discipline + 3 thanh chất lượng + storage theo project** | Trả lời "mọi người có thực sự dùng không?" cho sếp trong 2 giây; đúng yêu cầu gốc "statistic" | CÓ SẴN — toàn SQL trên `meeting`, `meeting_participant`, `file`, `project`; không migration | **S** | Statistics |
| 4 | **Export CSV (users / meetings / audit / analytics)** | Anh Luân báo cáo bằng Excel; CSV là "export" tự nhiên nhất cho non-CS | CÓ SẴN — client-side từ JSON các route admin hiện có, không API mới | **S** | Khác đáng giá |
| 5 | **Users: dropdown gán/thu hồi role admin + form sửa hồ sơ** | Bỏ `scripts/set-admin.mjs`; bỏ sửa hồ sơ qua Supabase dashboard | CÓ SẴN một nửa — PATCH nhận `role` rồi (chỉ thiếu UI); hồ sơ cần mở rộng PATCH thêm `user_metadata` | **S** (role) / **S-M** (hồ sơ) | Data chung |
| 6 | **Storage quét R2 THẬT + dọn blob mồ côi (scan → preview → purge)** | Tab Storage hiện chỉ SUM bảng `file`, đếm thiếu; blob `chats/ library/ transcripts/ userfiles/` vô hình | CẦN THÊM route — nhưng dữ liệu là R2 list + D1 anti-join, không bảng mới | **M** | Data chung + Dọn rác |
| 7 | **Banner cảnh báo đầu Dashboard** | Non-CS không tự đi soi tab Integrations/Storage — cảnh báo phải đập vào mắt | CÓ SẴN — ghép `/storage` + `/integrations` + ngưỡng từ `system_settings`, thuần frontend | **S** | Khác đáng giá |
| 8 | **Sửa metadata meeting (title/status/force-end) từ console** | API `PATCH /v1/meetings/:id` admin-bypass ĐÃ có, chỉ thiếu UI; hết cảnh sửa D1 tay | CÓ SẴN — chỉ UI | **S** | Data chung |
| 9 | **Thùng rác meeting (restore metadata từ `deleted_meeting`)** | Lưới an toàn cho solo admin bấm nhầm | MỘT NỬA — tombstone có sẵn nhưng cascade xoá blob R2 ngay → chỉ cứu được metadata; muốn cứu blob phải đổi sang soft-delete | **S** (metadata) / **M** (kèm blob) | Khác đáng giá |
| 10 | **Offboard nhân viên nghỉ việc (deactivate → bàn giao → xoá)** | DELETE user hiện chỉ xoá Supabase, để lại `user_file`/`project_member`/blobs mồ côi (verify: route 2087 không đụng D1/R2) | MỘT NỬA — ban user có sẵn (`disabled`); bàn giao cần route mới UPDATE `host_email`/`owner_email` D1 | **M** | Data chung |
| 11 | **Dọn Daily.co room mồ côi** | Xoá meeting không xoá room bên Daily, tích rác bên thứ ba | CẦN proxy Daily REST (key có sẵn server-side) | **S/M** | Dọn rác |
| 12 | **Retention tự động (Cron Trigger + dry-run)** | Biến `retention_days` từ "trang trí" thành thật; dọn không cần nhớ | CẦN THÊM `scheduled()` handler; logic xoá tái dùng cascade | **M** | Dọn rác |

---

## (b) Chi tiết 7 đề xuất đầu bảng

### 1. Tab "Dọn dẹp" — các lớp rác thuần D1 (S)

- **UI:** tab mới trong AdminConsole, ~4 thẻ tiếng Việt: _"Cuộc họp trống"_, _"Thư mục trống"_, _"File mồ côi"_, _"Khách mời đã thu hồi"_. Mỗi thẻ: nút **Quét** → bảng (tên, tuổi, owner, dung lượng) → tick chọn → **Xoá đã chọn** (confirm gõ số lượng). Nguyên tắc cứng: **không có nút nào quét-và-xoá trong một bước** — mọi purge đi qua preview.
- **Query/API:** route mới `GET /v1/admin/cleanup/scan?class=…` (chỉ đọc). Query mẫu meeting trống:
  ```sql
  SELECT m.id, m.title FROM meeting m
  LEFT JOIN meeting_participant p ON p.meeting_id = m.id
  WHERE m.scene_r2_key IS NULL AND p.meeting_id IS NULL
    AND m.created_at < :30d_trước
    AND (m.scheduled_at IS NULL OR m.scheduled_at < date('now'))
  ```
  (bộ lọc `scheduled_at` BẮT BUỘC để không xoá nhầm meeting đã lên lịch tương lai). Xoá đi qua `DELETE /v1/admin/meetings/:id` / `/v1/admin/projects/:id` **có sẵn** (cascade + tombstone + audit).
- **Vì sao #1:** trúng tim yêu cầu gốc "empty data"; backend gần như không phải viết logic xoá mới; rủi ro thấp nhất trong nhóm dọn rác (chỉ SQL, không đụng R2 list).

### 2. Nút "Reset dữ liệu demo" (S/M)

- **UI:** trong tab Dọn dẹp hoặc Settings — "Xoá toàn bộ meetings trước ngày X (giữ projects, users)". Preview số lượng + tổng dung lượng → confirm gõ chữ `XOA TAT CA` → progress bar.
- **Query/API:** route mới `POST /v1/admin/cleanup/wipe-meetings?before=…` loop `deleteMeetingCascade` (5 prefix R2 + 4 bảng D1 + tombstone), ghi 1 dòng `audit_log` tổng.
- **Vì sao #2:** đây chính là việc 06-04 làm tay bằng SQL; demo June 2026 sẽ cần lặp lại; tái dùng 100% hạ tầng cascade nên effort thấp so với giá trị.

### 3. Tab Statistics (S — toàn nhóm A, không migration)

- **UI:** 1 tab gộp: 4 card "tuần này" → bar chart 12 tuần (SVG đơn giản, không cần lib chart) → 3 thanh % chất lượng → bảng division → bảng "project nặng nhất" (có nút nhảy sang Dọn dẹp).
- **Query/API:** mở rộng `/v1/admin/analytics` (A1 tuần, A2 division, A3 chất lượng) và `/v1/admin/storage` (A4 theo project). Lưu ý kỹ thuật đã verify: timestamp D1 là **ms epoch** → `strftime('%Y-W%W', created_at/1000, 'unixepoch')`; `duration_s`/`discipline`/`branch` đều có sẵn trong schema (0002/0003). A2 kèm dòng cảnh báo "X meeting chưa gán branch" để biết chỗ cần điền.
- **Vì sao #3:** yêu cầu gốc thứ ba; 100% dữ liệu có sẵn; benchmark xác nhận đây là thứ cả Zoom/Teams/Meet đều mở đầu console bằng nó (trend chart, không phải số tổng).

### 4. Export CSV (S)

- **UI:** nút "Tải CSV" trên các bảng Users / Meetings / Audit / Statistics.
- **Query/API:** KHÔNG cần API mới — client chuyển JSON từ `/v1/admin/users|meetings|audit|analytics` thành CSV + `Blob` download. **Bắt buộc BOM UTF-8** để Excel mở đúng tiếng Việt/Hàn.
- **Vì sao #4:** effort nhỏ nhất bảng; mở khoá luôn workflow báo cáo Excel; đồng thời là bước "export trước khi purge" mà các lớp dọn audit/log sau này cần.

### 5. Users: gán role admin + sửa hồ sơ (S / S-M)

- **UI:** dropdown role (member/admin) trong panel user + form sửa tên/직급/phòng ban/company.
- **Query/API:** role — `PATCH /v1/admin/users/:id` **đã nhận `role`** (verify dòng 2053-2085), chỉ thêm dropdown gọi API sẵn. Hồ sơ — mở rộng route này nhận thêm `user_metadata` (hiện CHƯA có, đính chính so với cảm giác "chỉ thiếu UI") rồi forward sang Supabase Admin API như flow tạo user.
- **Vì sao #5:** xoá 2 thao tác console/dashboard tay thường gặp nhất (`set-admin.mjs`, sửa qua Supabase dashboard); nửa đầu (role) ship được trong vài chục phút.

### 6. Storage quét R2 thật + dọn blob mồ côi (M)

- **UI:** tab Storage thêm nút **"Quét kho thật"** → bảng so sánh "D1 nghĩ là X GB / R2 thật là Y GB"
  - danh sách blob mồ côi (2 nhóm: thuộc `deleted_meeting` → xoá ngay được; không thuộc đâu → chỉ xoá nếu uploaded > 7 ngày, tránh room đang live lưu chat trước lần save scene đầu).
- **Query/API:** route mới `GET /v1/admin/storage/scan` — `BUCKET.list()` theo 6 prefix (`scenes/ files/ chats/ library/ transcripts/ userfiles/`) với cursor paging, tách roomId, anti-join `meeting` ∪ `deleted_meeting` (và `user_file.r2_key` cho `userfiles/`). `POST /v1/admin/cleanup/purge` nhận danh sách key từ preview.
- **Vì sao #6:** gốc rễ của "đếm thiếu" — PUT chats/library/transcripts ghi R2 không tạo row D1 (verify keys dòng 137–143); không làm cái này thì số Storage và Cost mãi sai. Xếp sau 1-5 vì cần paging R2, là món M đầu tiên.

### 7. Banner cảnh báo Dashboard (S)

- **UI:** dải banner đầu Dashboard: "R2 đang dùng X GB (ngưỡng Y)", "Daily.co chưa cấu hình", "Z meeting quá 30 ngày không mở — sang tab Dọn dẹp".
- **Query/API:** thuần frontend, ghép `/v1/admin/storage` + `/v1/admin/integrations` + ngưỡng đọc từ `system_settings` (bảng có sẵn, admin sửa được trong Settings).
- **Vì sao #7:** chi phí gần bằng 0, đổi lại console "tự nói" với người không có thói quen đi tuần từng tab; cũng là chỗ tiêu thụ đầu ra của #1/#6 (đếm rác) và #3 (ngưỡng).

---

## (c) KHÔNG nên làm bây giờ

| Hạng mục | Lý do |
| --- | --- |
| SCIM / directory sync, OU & group policy | Quá enterprise — 37–386 người quản tay qua tab Users + Supabase là đủ; cần đội IT vận hành |
| Phân cấp admin role chi tiết (RBAC matrix) | Chỉ 1–2 admin; thêm role matrix = thêm khái niệm phải học + bug quyền |
| eDiscovery / Legal hold / DLP / Vault | Tool nội bộ, chưa có yêu cầu pháp lý; chi phí xây ≫ giá trị |
| QoS per-call (MOS, packet loss) | Daily.co đã có dashboard riêng; tự xây telemetry media là L+ và không ai đọc |
| Billing / seat management, app marketplace, device management | MCM không bán seat, không hệ sinh thái app, không thiết bị phòng họp |
| Bảng `ai_usage` + cost thật (AI calls/tokens, STT phút) | **Cần instrumentation chưa có** (room server phải log mỗi call Gemini/Deepgram). Trước mắt dùng proxy có sẵn: `COUNT(ai_summary_at)` theo tuần, ghi chú "chỉ là summary" |
| Recording management (tab Recordings) | **Chờ Phase 5** — recording hiện là `.webm` download máy host, chưa bao giờ lên server; làm tab trước là làm vào khoảng không |
| Failed logins / session thật cho Security tab | Cần Supabase log drains (L); giá trị thấp ở quy mô hiện tại |
| Presence socket thật (user online realtime) | M và thuộc room server; bản S thay thế: COUNT `meeting.status='live'` — có thể nhét vào Statistics |
| Email digest / alert qua mail | Cần Cron + dịch vụ mail mới (M/L); banner #7 phủ 80% giá trị với 5% công sức |
| Retention cron tự động (đề xuất #12) | Đáng làm nhưng SAU khi tab Dọn dẹp chạy tay ổn 1–2 tháng — tự động hoá thao tác chưa từng chạy tay là rủi ro cho solo admin; và phải làm SAU #6 (tombstone là căn cứ phân loại blob rác) |
| Cutover console sang DB remote | Track riêng (track I trong kế hoạch infra), không phải tính năng console |

---

## (d) Gói "buổi làm việc đầu tiên" — combo S ship trong 1 buổi

Mục tiêu: cuối buổi anh Luân tự dọn được meeting trống và tự gán admin, không cần script.

1. **Dropdown gán role admin** (#5a) — ~30 phút, API có sẵn 100%, chỉ UI.
2. **Quét + xoá meeting trống / project trống** (#1 rút gọn) — 1 route `GET /v1/admin/cleanup/scan` với 2 query SQL ở mục (b).1, UI 2 thẻ + tick + gọi DELETE có sẵn. Phần nặng nhất buổi (~2-3 giờ).
3. **Export CSV cho Users + Meetings** (#4) — ~45 phút, thuần client, nhớ BOM UTF-8.
4. **Banner cảnh báo Dashboard** (#7, bản tối giản 2 dòng: storage + số meeting trống từ #2) — ~30 phút.

Nếu còn thời gian: **card "meeting đang live"** (`SELECT COUNT(*) FROM meeting WHERE status='live'`) vào Dashboard — 10 phút, mở màn cho tab Statistics buổi sau.

Buổi 2 gợi ý: Statistics nhóm A đầy đủ (#3) + sửa hồ sơ user (#5b). Buổi 3: wipe demo (#2) + R2 scan (#6).

---

_File liên quan:_ `worker/src/index.ts` (admin routes 1936–2492, cascade 2264, keys 137–143), `worker/schema/0001…0016`, `excalidraw-app/components/mcm/AdminConsole.tsx`, `docs/admin-console.md`, `docs/data-architecture-audit.md` (một phần đã stale, xem đính chính đầu file).
