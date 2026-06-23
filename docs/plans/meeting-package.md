# Meeting Package — bản tổng kết sau họp (curated deliverable)

**Cập nhật lần cuối: 2026-06-23**
**Trạng thái: SHIPPED (full feature LIVE)** · migration **0032** + **0034** đã apply remote · routes worker + UI builder/distribution/management đã chạy.

> Bản trước (06-22) là SPEC. Tài liệu này đã viết lại theo **đúng những gì đã ship** (commit `dd073366` → `056b8466`). Mọi tham chiếu file/route là code thật.

## Mục tiêu (giữ ĐƠN GIẢN — đây là app họp)

Sau cuộc họp **đã kết thúc** (`status='finished'`), **host / user có quyền của project** ngồi lại tổng kết: chọn file + nội dung nào nên chia sẻ, **đóng gói thành 1 Package** rồi (a) **publish** cho người được chọn xem online, (b) **export offline** (zip) để lưu máy. Bản họp gốc (meeting review, E2E) **giữ nguyên toàn bộ** — Package là **bản curated server-readable RIÊNG**.

### KHÔNG làm (giữ nguyên chủ trương)
- KHÔNG ACL per-file. Audience đặt ở **mức cả gói**, không phải từng file.
- KHÔNG tự động chia sẻ. Curate là **thao tác tay** của host → đơn giản hoá quyền.
- KHÔNG đụng E2E của raw meeting. Package giải mã client-side rồi upload **plaintext** vào `packages/<id>/…`.

## Mô hình dữ liệu

### Schema (đã apply: 0032 + 0034)
`worker/schema/0032_meeting_package.sql`:
- `meeting_package(id, meeting_id, project_id, title, summary_text, audience_kind, status, bundle_r2_key, created_by, created_at, published_at)` — 1 package = 1 lần curate của 1 cuộc đã finished. `summary_text` seed từ `meeting.ai_summary`, sửa được. `audience_kind ∈ {meeting, project, list}`. `status ∈ {draft, published}`.
- `meeting_package_file(package_id, file_id)` — subset file được chọn vào gói.
- `meeting_package_recipient(package_id, email, status, added_at)` — chỉ khi `audience_kind='list'`. `status ∈ {active, revoked}` — **revoke = lật status, KHÔNG hard-delete** (giữ provenance cho AI knowledge graph).

`worker/schema/0034_meeting_package_manage.sql` (management):
- `ALTER TABLE meeting_package ADD COLUMN deleted_at INTEGER` — **soft-delete**. Mọi list/read filter `deleted_at IS NULL` → gói "xoá" biến khỏi UI nhưng row + R2 blob còn nguyên (provenance). Restore = clear cột.
- Recipient revoke/restore KHÔNG cần schema mới — lật `meeting_package_recipient.status` (đã có ở 0032).

### R2 (server-readable, KHÔNG room-key)
- `packages/<pkgId>/files/<fileId>` — bytes file đã giải mã client-side.
- `packages/<pkgId>/recap.html` — recap render sẵn (xem dưới).
- `packages/<pkgId>/bundle.zip` — zip offline (NULL tới lần export đầu; cache lại + ghi `bundle_r2_key`).
- (board PNG của recap cũng được lưu như asset standalone để vào zip).

## Recap = bản tổng kết "cuộc họp THỰC SỰ là gì"

`recap.html` (render client-side trong `MeetingPackageBuilder.tsx`, self-contained — inline style + ảnh data-URL nên mở standalone, offline). Thứ tự:
1. **Board image** — PNG canvas (dark theme) export từ scene đã giải mã: "cuộc họp về mặt hình ảnh LÀ gì".
2. **Summary** — `summary_text` đã sửa tay.
3. **Chat** — toàn bộ hội thoại chat đã giải mã.
4. **File list** — các file đã chọn (tải được).

## Curate: file của họp + **local attachment**

- Picker liệt kê `file` của meeting (per-meeting material), **loại trừ file canvas nội bộ** (ifc-snap/snapshot/anchor…) — chỉ hiện deliverable thật.
- **Local attachment:** curator kéo thêm file từ máy → mỗi cái mang id ổn định `attach-<uuid>`, bytes chỉ upload lúc publish; server tạo **`file` row backing** cho nó (materialised) → vào package như file thường.
- **Naming convention mặc định** cho package title (seed sẵn, sửa được).

## Luồng (đã ship)

1. **Trigger** — meeting `finished`; người mở = host/organizer hoặc project authority. Gate `canEditMeeting` (worker). `POST /v1/meetings/:roomId/packages` (409 nếu chưa finished).
2. **Curate (draft)** — chọn `summary_text` (mặc định = `ai_summary`) + tick file + (tuỳ chọn) thêm attachment local. Chọn audience: `meeting` (invitee) / `project` (member) / `list` (**member picker** nhập email cụ thể).
3. **Đóng gói (client-side):** client (giữ room-key) giải mã file đã chọn + export board PNG + giải mã chat → upload bản plaintext + render `recap.html` vào `packages/<pkgId>/…`. Fail-soft cho board/chat.
4. **Publish** — `POST /v1/packages/:id/publish` → `status='published'`, `published_at`; audience `list` được **notify email**.
5. **Export offline** — `GET /v1/packages/:id/export` build **STORE-zip in-worker** = `recap.html` + `files/<name.ext>`. Tự thêm **đuôi file đúng** (tên gốc thường extension-less, vd `ifc-snap-…`) qua `withExtension(name, contentType)` + de-dupe tên trùng. Zip cache vào R2, ghi `bundle_r2_key`.

## Phân phối (distribution — đã ship)

- **Nội bộ — `SharedWithMe.tsx`:** surface "Shared with me" trên dashboard, **nhóm theo project/meeting**, có **unread badge** ("new" trên nav) cho gói chưa xem.
- **Khách ngoài — `ClientPortal.tsx`:** mục "shared recaps" trên cổng khách.
- **Recap badge:** meeting card hiện badge **"Recap"** khi cuộc đó có package published.
- Phía worker: `GET /v1/me/packages` ("Shared with me" xuyên meeting — published + chưa xoá + mình là recipient/invitee/creator), `GET /v1/meetings/:roomId/packages` (gói của 1 cuộc).

## Quản lý (management — đã ship)

- **Unpublish:** `POST /v1/packages/:id/unpublish` (published → draft).
- **Soft-delete / restore:** `DELETE /v1/packages/:id` (set `deleted_at`) · `POST /v1/packages/:id/restore` (clear). **revoke ≠ delete** — không hard-delete.
- **Recipient revoke / restore** (audience `list`): `GET …/recipients`, `POST …/recipients/revoke`, `POST …/recipients/restore` (lật `status`). Người bị revoke mất quyền xem nhưng row còn (provenance).

## Quyền xem package — `canSeePackage`

`GET /v1/packages/:id` gate theo `audience_kind`:
- `meeting` → `canSeeMeeting(meeting)` (invitee/member/admin).
- `project` → `project_member` (tôn trọng cờ `confidential`).
- `list` → có dòng `meeting_package_recipient` với `status<>'revoked'`.
- Cộng admin/owner + creator. Gói `deleted_at IS NOT NULL` → ẩn với mọi người.

## Routes (worker — đã ship)

| Route | Việc |
|---|---|
| `GET  /v1/meetings/:roomId/files` | list file của meeting cho picker |
| `POST /v1/meetings/:roomId/packages` | tạo draft (gate `canEditMeeting`, 409 nếu chưa finished) |
| `PUT  /v1/packages/:id` | sửa curate (summary/files/audience/recipients) |
| `PUT  /v1/packages/:id/files/:fileId` | upload bytes file đã giải mã (gồm attachment) |
| `PUT  /v1/packages/:id/recap` | upload `recap.html` đã render |
| `POST /v1/packages/:id/publish` | finalize + notify list |
| `POST /v1/packages/:id/unpublish` | published → draft |
| `DELETE /v1/packages/:id` · `POST …/restore` | soft-delete / khôi phục |
| `GET …/recipients` · `POST …/recipients/revoke|restore` | quản recipient list |
| `GET  /v1/packages/:id` | xem recap (gate `canSeePackage`) |
| `GET  /v1/packages/:id/export` | tải STORE-zip offline |
| `GET  /v1/meetings/:roomId/packages` · `GET /v1/me/packages` | distribution / "Shared with me" |

## Client (đã ship)
- **`MeetingPackageBuilder.tsx`** — builder trong meeting review: picker file (loại file canvas nội bộ) + attachment local + ô summary edit + chọn audience (+ member picker) + Publish/Export + render recap (board+summary+chat+files). Modal portal + background giữ nguyên (fix `283552b5`).
- **`SharedWithMe.tsx`** — surface nội bộ (nhóm + unread badge).
- **`ClientPortal.tsx`** — "shared recaps" cho khách ngoài.

## Quan hệ với các phần khác
- Khác nút **"Files"** header (thư viện vật liệu *trong* họp). Package = *sau* họp.
- Khác **meeting review** (bản gốc đầy đủ, read-only — giữ nguyên).
- Recap đã capture board+chat → là **bản plaintext dẫn xuất** cùng họ với [[meeting-event-log]]; provenance giữ cho [[ai-project-knowledge-strategy]] (retrieval xuyên chuỗi họp).
- Rủi ro pháp lý của việc "nội dung họp thành server-readable": xem [[event-log-privacy-analysis]] (disclosure + retention).

## Đã xong vs còn lại
- ✅ Curate (file + attachment + naming) · recap (board+summary+chat+files) · audience (+picker) · publish · distribution (nội bộ + khách + badge + grouping) · management (unpublish/soft-delete/revoke) · export STORE-zip.
- ⏳ Sau: recap PDF (hiện chỉ HTML), Package đọc lại [[meeting-event-log]] thay vì re-parse blob (1 nguồn timeline), retention/TTL theo `event-log-privacy-analysis.md`.
