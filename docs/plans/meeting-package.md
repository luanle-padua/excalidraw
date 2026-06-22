# Meeting Package — bản tổng kết sau họp (curated deliverable)

**Trạng thái:** SPEC (chốt hướng 2026-06-22) · chưa build · xếp sau team thumbnail + header redesign.

## Mục tiêu (giữ ĐƠN GIẢN — đây là app họp)

Sau cuộc họp, **host / user có quyền của project** ngồi lại tổng kết: chọn file + nội dung nào nên chia sẻ, **đóng gói thành 1 Package** rồi (a) gửi online cho người được chọn, (b) **export offline** để lưu máy. Bản họp gốc (meeting review) **giữ nguyên toàn bộ** như hiện tại.

### KHÔNG làm (tránh ôm đồm)
- KHÔNG ACL per-file, KHÔNG "promote project asset" 3 tầng. Audience đặt ở **mức cả gói**, không phải từng file.
- KHÔNG tự động chia sẻ. Curate là **thao tác tay** của host → đơn giản hoá quyền.
- KHÔNG đụng E2E của raw meeting. Package là **bản curated server-readable** riêng.

## Mô hình dữ liệu hiện có (đã verify — để bám vào)
- `meeting(id, project_id, ai_summary, confidentiality, status …)` — `0001_init.sql`, `0015_p0_parity.sql`.
- `file(id, meeting_id, project_id, kind('image|pdf|dxf|ifc|glb'), name, size, r2_key)` — `0001_init.sql:44`. Materials per-meeting, R2 `files/<roomId>/<fileId>`, **E2E room-key**.
- Transcript = R2 blob `transcripts/<roomId>/current` (E2E). `ai_summary` = D1 plaintext (server-readable).
- Quyền meeting = `canSeeMeeting` (worker/src/index.ts:580); grants: `meeting_invitee`, `project_member`. Cờ `confidential` = chỉ owner+invitee.

## Schema mới (tối thiểu)

```sql
-- 1 package = 1 lần curate của 1 meeting
meeting_package(
  id TEXT PK, meeting_id TEXT REFERENCES meeting(id), project_id TEXT,
  title TEXT, summary_text TEXT,            -- bản summary đã sửa tay (copy từ ai_summary, edit được)
  audience_kind TEXT,                       -- 'meeting' | 'project' | 'list'
  status TEXT,                              -- 'draft' | 'published'
  bundle_r2_key TEXT,                       -- zip offline (null tới khi export)
  created_by TEXT, created_at, published_at
)
meeting_package_file(package_id, file_id)   -- file nào được chọn vào gói
meeting_package_recipient(package_id, email) -- chỉ khi audience_kind='list'
```

R2 (server-readable, KHÔNG room-key): `packages/<pkgId>/files/<fileId>` (bản giải mã đã chọn), `packages/<pkgId>/recap.html`, `packages/<pkgId>/bundle.zip`.

## Luồng

1. **Trigger** — meeting `status='finished'`; người mở = host/organizer hoặc project authority (tái dùng `canEditMeeting`/authority arm của `canSeeMeeting`). Vào từ **meeting review** hoặc menu meeting.
2. **Curate (draft)** — UI chọn: `summary_text` (sửa được, mặc định = `ai_summary`) + tick các `file` + (tuỳ chọn) đoạn transcript / ghi chú. Chọn **audience**: `meeting` (invitee) / `project` (member) / `list` (nhập email cụ thể).
3. **Đóng gói (client-side, vì client giữ room-key):** giải mã các file đã chọn + transcript → upload **bản server-readable** vào `packages/<pkgId>/…`; render `recap.html` (summary + transcript + danh sách file + provenance link về meeting gốc).
4. **Publish** — set `status='published'`, `published_at`; (sau) notify recipients (email/in-app).
5. **Export offline** — `GET /v1/packages/:id/export` trả `bundle.zip` = các file + `recap.html`(hoặc PDF). Lưu máy, mở không cần mạng.

## Quyền xem package
- `GET /v1/packages/:id` gate theo `audience_kind`: `meeting`→`canSeeMeeting(meeting)`; `project`→`project_member`; `list`→có dòng `meeting_package_recipient`. Cộng admin/owner.
- Tôn trọng cờ `confidential`: meeting mật **không** cho audience `project` mặc định (phải override rõ ràng).
- `revoke ≠ delete`: thu hồi recipient = set trạng thái, không hard-delete (giữ provenance cho AI knowledge graph).

## Routes (worker)
- `POST /v1/meetings/:roomId/packages` — tạo draft.
- `PUT /v1/packages/:id` — sửa curate (summary/files/audience).
- `POST /v1/packages/:id/publish` — finalize + (sau) notify.
- `GET /v1/packages/:id` — xem recap (audience gate).
- `GET /v1/packages/:id/export` — tải zip offline.

## Client
- **Package builder** (trong meeting review): list file của meeting (tái dùng material list) + ô summary edit + chọn audience + nút Publish/Export.
- **Recap viewer**: trang đọc gói cho recipient (summary + transcript + file tải được).

## Quan hệ với các phần khác
- Khác nút **"Files"** header (thư viện vật liệu *trong* họp). Package = *sau* họp.
- Khác **meeting review** (bản gốc đầy đủ, read-only — giữ nguyên).
- Provenance link giữ cho [[ai-project-knowledge-strategy]] (retrieval xuyên chuỗi họp).

## Phasing
1. **P1**: tạo/curate/publish + recap viewer online (audience meeting/project). _Giá trị ngay._
2. **P2**: export offline (zip + recap.html/PDF).
3. **P3**: audience `list` (vài người cụ thể) + notify recipients.
