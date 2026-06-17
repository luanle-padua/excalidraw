# Quản trị dữ liệu Canvas M — R2 (storage) + D1 (database)

> Audit 2026-06-17. READ-ONLY (không sửa code). Nguồn: `worker/src/index.ts`, `worker/schema/0001–0028`, `worker/wrangler.jsonc`. Khán giả: PM internal-tool, "simplicity first", chuẩn bị go multi-country (Hàn + Việt + châu Phi). Mục tiêu: "quản trị chuẩn chỉnh nhất" mà KHÔNG over-engineer (không DLP doanh nghiệp, không k8s).

**TL;DR.** Cấu trúc R2/D1 hiện tại **sạch và đủ tốt** cho giai đoạn này: khóa blob theo `roomId`, D1 là registry/metadata, soft-delete `trash/` đã đúng hướng. 3 lỗ hổng quản trị thật sự cần đóng trước khi scale: **(1)** `trash/` chưa có lifecycle rule trên R2 dashboard → rác tích vô hạn (tốn tiền) hoặc xóa nhầm tay; **(2)** R2 ↔ D1 drift không có công cụ phát hiện (orphan blob / orphan row) → không ai biết storage thật chứa gì; **(3)** R2 **không có backup** native (D1 có Time Travel, R2 không) → một sự cố xóa/ghi đè là mất vĩnh viễn. Tất cả đều rẻ để vá, không cần hệ thống lớn.

---

## §1. Bản đồ R2 (storage)

R2 bucket: `mcm-storage` (`worker/wrangler.jsonc:59-63`, binding `BUCKET`). **Không có S3 versioning** — ghi đè là vĩnh viễn (xác nhận trong comment `worker/src/index.ts:4081`). Khóa được sinh bằng các helper tập trung ở `worker/src/index.ts:285-291` và `:4563`.

| Prefix | Key scheme (file:line) | Nội dung | Ai ghi / đọc | Lifecycle | Size profile |
|---|---|---|---|---|---|
| `scenes/` | `scenes/<roomId>/current` (`:285`) | Toàn bộ canvas Excalidraw (1 blob/phòng, ghi đè), E2E-encrypted | PUT `/v1/scenes/:roomId` (`:825`), GET (`:878`) | Tạo khi autosave; **ghi đè liên tục**; chặn ghi nếu meeting deleted (410) hoặc finished-locked (409) | Trung bình–lớn (cảnh + ảnh nhúng); 1 key/phòng |
| `files/` | `files/<roomId>/<fileId>` (`:286`) | Bytes file thư viện meeting (DXF/IFC/PDF/ảnh/thumb) — có **row D1 `file` tương ứng** | PUT `/v1/files/:roomId/:fileId` (`:989`), GET (`:1034`) | Tạo 1 lần/file; ghi đè cùng id; GET trả 204 (không 404) khi thiếu | Lớn nhất (IFC/DXF nặng); nhiều key/phòng |
| `chats/` | `chats/<roomId>/current` (`:287`) | Log chat E2E (1 blob/phòng) — **KHÔNG có row D1** | PUT `/v1/chats/:roomId` (`:897`), GET (`:946`) | Ghi đè; chặn khi deleted/finished | Nhỏ |
| `library/` | `library/<roomId>/current` (`:288`) | Manifest thư viện (metadata + source bytes gộp 1 blob) — **KHÔNG có row D1** | PUT `/v1/library/:roomId` (`:961`), GET (`:977`) | Ghi đè; chặn khi deleted/finished | Trung bình–lớn |
| `transcripts/` | `transcripts/<roomId>/current` (`:289`) | Transcript STT đầy đủ, E2E — **KHÔNG có row D1** (artifact queryable là `meeting.ai_summary` trong D1) | PUT `/v1/transcripts/:roomId` (`:920`), GET (`:936`) | Ghi đè; chặn khi deleted/finished | Trung bình (text) |
| `userfiles/` | `userfiles/<email>/<fileId>` (`:290`) | "My Files" — kệ cá nhân của user nội bộ — có **row D1 `user_file`** | PUT `/v1/me/files/:fileId` (`:3399`), GET content (`:3503`), DELETE (`:3533`, **hard-delete cả blob lẫn row**) | Tạo/ghi đè theo id; DELETE thật sự xóa | ≤ 50MB/file (`MAX_USER_FILE_BYTES`, `:3409`) |
| `backdrops/` | `backdrops/<id>` (`:4563`) | Ảnh nền portal/waiting-room do admin upload — có **row D1 `portal_backdrop`** | POST `/v1/admin/backdrops` (`:4575`), DELETE (`:4675`, **hard-delete cả blob lẫn row**) | Tạo/xóa theo id | ≤ 5MB/ảnh (`MAX_BACKDROP_BYTES`, `:4562`) |
| `trash/` | `trash/<deletedAt>/<originalKey>` (`:4101`) | Bản sao soft-delete của TẤT CẢ blob phòng khi xóa meeting | `deleteMeetingCascade` (`:4076-4143`) | Tạo khi xóa meeting; customMetadata `trashedFrom`/`trashedAt`; **chưa có rule hết hạn** | Tổng dồn của scenes+files+chats+library+transcripts của phòng đã xóa |

**Quan sát chính:**
- **3 prefix không có "ngôi nhà" trong D1**: `chats/`, `library/`, `transcripts/` chỉ tồn tại như blob khóa theo `roomId` (comment xác nhận "R2 only; no D1 row" tại `:895`, `:959`). D1 không biết chúng tồn tại — chỉ suy ra từ `meeting.id`. Reconcile phải dựa vào danh sách `meeting`, không phải danh sách row.
- **Soft-delete chỉ áp dụng cho meeting** (`deleteMeetingCascade`, `:4088-4094` copy 5 prefix sang `trash/` rồi delete). `userfiles/` và `backdrops/` **hard-delete** thẳng (`:3546`, `:4685`) — chấp nhận được vì là dữ liệu cá nhân/cosmetic, không phải lịch sử/moat.
- **Phân vùng = theo `roomId`**, KHÔNG theo project hay division. Không có cô lập per-tenant ở tầng key (xem §3 Naming).

---

## §2. Bản đồ D1 (database)

DB: `mcm-db` (`worker/wrangler.jsonc:66-75`), **region APAC**, tạo 2026-06-11. 28 migration (`0001`–`0028`). Phân loại các bảng theo vai trò quản trị:

### Registry (vòng đời meeting/project)
| Bảng | PK | Cột chính | Quan hệ | Migration |
|---|---|---|---|---|
| `project` | `id` | name, host_email, code, client, stage, **leader_email, lead_division_id** | ← meeting, file, project_member, project_guest | 0001; +0023 (org) |
| `meeting` | `id` (= roomId) | project_id, title, status, scene_r2_key, ai_summary, **realtime_backend** ('socketio'\|'do'), host_email | FK → project; ← file, invitee, participant, knock | 0001; +0009/0011/0015/0018/**0027** |
| `file` | `id` (= fileId) | meeting_id, project_id, kind, size, **r2_key** | FK → meeting, project; ↔ blob `files/` | 0001 |
| `project_member` | (project_id, email) | role (owner\|manager\|member) | logical → project | 0008 |
| `meeting_invitee` | (meeting_id, email) | kind, role, **status** (invited\|accepted\|declined\|**revoked**), revoked_at | logical → meeting | 0008 |
| `meeting_participant` | (meeting_id, email) | name, joined_at, last_seen_at | logical → meeting | 0006 |
| `meeting_knock` | (room_id, email) | status (invited\|admitted\|denied), last_seen | logical → meeting | 0025 |

### Identity
| Bảng | PK | Cột chính | Ghi chú | Migration |
|---|---|---|---|---|
| `project_guest` | `id` | project_id, login (UNIQUE), label, real_email, company/phone/address, **status** (active\|revoked), **revoked_at** | **Điểm resolve DUY NHẤT** synthetic login → người thật. Revoke≠delete. | 0019; +0020/**0021** |
| `division` | `id` (slug) | name, head_email, deputy_email | 21 division seed | 0022; +0024 |
| `user_division` | `email` | division_id | FK → division | 0022 |
| `user_file` | `id` | owner_email, kind, size, **r2_key**, tags, visibility | ↔ blob `userfiles/` | 0016; +0017 |
| `client` | `id` | name, company, email, created_by | CRM-lite | 0012 |
| `portal_backdrop` | `id` | title, **r2_key**, sort_order | ↔ blob `backdrops/` | 0026 |
| `note` | (scope, ref, email) | body | calendar/meeting notes per-user | 0010 |

### Governance
| Bảng | PK | Vai trò | Migration |
|---|---|---|---|
| `audit_log` | `id` | Nhật ký hành động admin (actor_email, action, target, meta JSON, ts). Index `ix_audit_ts`. Được gọi qua `logAudit` tại các route admin (vd `:4155`, `:4622`, `:4689`). | 0005 |
| `system_settings` | `key` | Chính sách admin key/value (vd `internal_domains`, đọc tại `:308`). | 0007 |
| `deleted_meeting` | `id` | **Tombstone**: meeting đã xóa "ở lại xóa" — PUT scene/file/chat bị chặn 410 (`:829`). Ghi tại `:4137`. | 0015 |
| `schema_version` | `version` | SSOT migration đã apply. | 0015 |
| `usage_events` | `id` | **Metering AI/STT**: 1 row/lần gọi billable (Gemini/Deepgram), est_cost_usd denormalized. Index theo provider/email/meeting/ts. Best-effort, không block response. | 0028 |

### `deleteMeetingCascade` (`worker/src/index.ts:4076-4143`) — cascade khi xóa meeting
1. Copy 5 prefix blob (`scenes/files/chats/library/transcripts` của roomId) sang `trash/<ts>/...` rồi `BUCKET.delete` bản gốc (`:4088-4113`).
2. DELETE rows: `file`, `meeting_invitee`, `meeting_participant`, `meeting_knock`, `note` (scope=meeting), `meeting` (`:4115-4131`).
3. Xóa 2 Daily room (screen-share + audio) (`:4133-4134`).
4. INSERT `deleted_meeting` tombstone (`:4137`).

### Mô hình revoke ≠ delete (memory + `docs/plans/guest-data-lifecycle.md`)
- `project_guest` và `meeting_invitee` dùng `status='revoked' + revoked_at` để **giữ history/moat** — KHÔNG hard-delete. `project_guest` là map duy nhất synthetic-login → người thật; xóa = mồ côi attribution + phá AI knowledge graph.
- **Lưu ý nợ kỹ thuật (đã ghi trong plan, không thuộc audit này):** code revoke/clean guest hiện tại đang HARD-DELETE (`guest-data-lifecycle.md:5`) — cần đổi sang soft-revoke. Đây là sai lệch giữa chính sách và code, nhưng nằm trong `worker/` do build team sở hữu.
- Finished meeting = immutable: `isFinishedLocked` chặn mọi PUT (409) trên scenes/files/chats/library/transcripts.

### Điểm R2 ↔ D1 tham chiếu nhau
- `file.r2_key` ↔ `files/<roomId>/<fileId>` (cặp row+blob, ghi cùng giao dịch `:1022-1029`).
- `user_file.r2_key` ↔ `userfiles/...` ; `portal_backdrop.r2_key` ↔ `backdrops/...`.
- `meeting.scene_r2_key` ↔ `scenes/<roomId>/current`.
- **KHÔNG có row** cho `chats/`, `library/`, `transcripts/` — chỉ suy ra từ `meeting.id`.

---

## §3. Đánh giá quản trị + khuyến nghị (xếp hạng)

Xếp theo **(tác động × dễ làm)**, calibrate cho internal-tool simplicity-first.

### R1 — [CAO] Lifecycle rule cho `trash/` (rẻ, đóng rủi ro tiền + xóa nhầm)
**Vấn đề:** `deleteMeetingCascade` copy mọi blob vào `trash/<ts>/...` nhưng **không có gì tự dọn**. Comment code (`:4085`) đã nói rõ "Set a dashboard lifecycle rule on `trash/` to expire after N days" — nhưng đây là việc cấu hình R2 dashboard, **chưa làm** (không có trong `wrangler.jsonc`). Hệ quả: rác blob tích vô hạn (tiền storage) HOẶC ai đó xóa tay sai.
**Khuyến nghị:** Tạo **R2 Object Lifecycle rule** trên dashboard: prefix `trash/` → expire (delete) sau **30 ngày** (cửa sổ khôi phục đủ rộng cho "lỡ tay xóa meeting"). Đây là 1 lần setup, 0 dòng code. Cân nhắc thêm **Bucket Lock / retention** để chặn xóa bucket-level ngoài ý muốn (comment `:4086` đã gợi ý).

### R2 — [CAO] Orphan scan / reconcile R2 ↔ D1 (công cụ admin rẻ)
**Vấn đề:** Không có cách biết storage thật chứa gì. Drift xảy ra khi:
- **Orphan blob (blob không row):** PUT file thành công nhưng INSERT row fail; hoặc `chats/library/transcripts` của meeting bị xóa-tay-D1 mà blob còn (3 prefix này vốn không có row để cascade biết).
- **Orphan row (row không blob):** `file.r2_key` trỏ blob đã bị trash/xóa; race GET trả 204.
**Khuyến nghị:** 1 route admin **read-only** `GET /v1/admin/storage/reconcile`: `BUCKET.list` từng prefix, đối chiếu với `SELECT id/r2_key` các bảng `file`/`user_file`/`portal_backdrop` + danh sách `meeting.id` (cho 3 prefix không-row). Trả về: blob mồ côi, row mồ côi, dung lượng theo prefix. **Chỉ báo cáo, không tự xóa** ở v1 (an toàn). Đây cũng là đầu vào cho stats storage thật (hiện `/v1/admin/stats:4161` chỉ đếm row, không đếm bytes).

### R3 — [CAO] Backup R2 (D1 đã an toàn, R2 thì không)
**Vấn đề:** D1 có **Time Travel** (30 ngày point-in-time) + có thể export — đã đủ DR cho database. R2 **không có backup native** và **không versioning** → ghi đè/xóa nhầm 1 scene = mất vĩnh viễn. `trash/` chỉ cứu được trường hợp xóa-meeting, KHÔNG cứu ghi đè scene thường ngày (`scenes/.../current` bị PUT đè liên tục).
**Khuyến nghị (chọn theo khẩu vị):**
- **(a) Accept-risk, dev phase:** ghi nhận chính thức trong `docs/dev-phase-notes.md` rằng scene/chat/transcript không có version — mất là mất. Hợp lý cho hiện tại.
- **(b) Rẻ + thật:** scheduled Worker (cron) hằng đêm copy `BUCKET.list` các prefix quan trọng sang **bucket R2 thứ hai** (`mcm-storage-backup`) — same-account, copy nội bộ rẻ. Hoặc bật R2 **event notification → R2 của vùng khác**.
- **Không khuyến nghị:** export ra S3/GCS (thêm vendor, trái simplicity-first).

### R4 — [TRUNG BÌNH] Naming/tổ chức prefix cho multi-tenant
**Hiện trạng:** khóa theo `roomId` phẳng. Sạch và đủ cho hôm nay, nhưng **không cô lập per-project/per-division** ở tầng storage. Khi đi đa quốc gia, "export/xóa toàn bộ dữ liệu 1 project" phải duyệt mọi room của project (join D1 `meeting.project_id` rồi list từng `roomId`) — làm được nhưng không 1-lệnh.
**Khuyến nghị:** **KHÔNG đổi schema hiện tại** (di trú khóa R2 đắt, không versioning để rollback an toàn). Thay vào đó, với **dữ liệu MỚI sau này**, cân nhắc tiền tố `projects/<projectId>/scenes/<roomId>/...` để cô lập + data-residency theo project. Hôm nay: chỉ cần đảm bảo reconcile (R2) join được room→project. Per-division isolation: chưa cần, division đã có trong D1.

### R5 — [TRUNG BÌNH] Retention chính sách rõ ràng (giữ gì / hết hạn gì)
| Loại dữ liệu | Hành động | Lý do |
|---|---|---|
| `trash/` (meeting đã xóa) | **Hết hạn 30 ngày** (R1) | Đã là bản sao soft-delete; chỉ là cửa sổ undo |
| Meeting finished cũ + scene/transcript | **GIỮ vĩnh viễn** | History = moat (AI knowledge). Immutable, không tốn ghi |
| Guest revoked (`project_guest`) | **GIỮ row + GIỮ blob** | Resolver duy nhất; revoke≠delete |
| `usage_events` (metering AI) | Giữ ≥ 1 năm rồi cân nhắc rollup | Đủ cho báo cáo chi phí; không phải moat |
| `meeting_knock` (waiting room) | Cascade-xóa theo meeting (đã có `:4125`) | Ephemeral, không giá trị lịch sử |
| GDPR erasure thật | Scrub **PII columns tại chỗ** (label/real_email/phone), GIỮ id/login/project_id | Anonymize lan tỏa miễn phí; không rewrite blob (đắt, immutable) |

### R6 — [THẤP] Data residency cross-country (Hàn + Việt + châu Phi)
**Kiểm soát được:** D1 hiện **APAC** (`wrangler.jsonc:71`). R2 có thể đặt **location hint** (jurisdiction) lúc tạo bucket — hiện `mcm-storage` tạo không có jurisdiction nên dùng auto/account-default. Daily.co (screen-share) có region riêng do Daily quản.
**Khuyến nghị:** với internal-tool + dev phase, **KHÔNG cần** multi-region phức tạp. Khi 1 quốc gia (vd châu Phi / EU-adjacent) yêu cầu data-residency cứng, tạo **bucket riêng có jurisdiction** (`eu`) cho project thuộc vùng đó — chỉ khả thi sạch NẾU đã làm R4 (prefix/bucket theo project). Ghi nhận đây là lý do thực để cân nhắc R4 sớm.

---

## §4. Công cụ data cho Admin Console (cần build)

Gắn vào admin console đang xây. Tất cả **admin-gated** (`app.use("/v1/admin/*")`), ưu tiên read-only/báo cáo trước, hành động phá hủy sau + audit.

1. **Storage browser (read-only)** — duyệt theo prefix, hiển thị bytes/đếm object mỗi prefix; mở rộng `/v1/admin/stats` (hiện chỉ đếm row D1) để có **dung lượng R2 thật**.
2. **Integrity check / Orphan scan** (R2) — báo cáo blob-mồ-côi & row-mồ-côi & drift; nút "reconcile" tách riêng (báo cáo trước, dọn sau, có confirm + audit).
3. **Retention config** — UI bật/sửa lifecycle `trash/` (N ngày) + xem `trash/` đang giữ gì; map thẳng vào R1.
4. **Per-project / per-guest export + delete (GDPR)** — "Export tất cả dữ liệu project X" (zip scenes/files/transcripts + rows) và "Anonymize guest" (scrub PII columns, giữ row — đúng `guest-data-lifecycle.md:41`). Đây là yêu cầu pháp lý khi đi đa quốc gia.
5. **Audit dữ liệu** — view `audit_log` lọc theo action data-ops (`meeting.delete`, `backdrop.*`, guest revoke/anonymize); hiện đã ghi nhưng chưa có UI duyệt.
6. **Usage/cost view** — `usage_events` (0028) đã sẵn schema; admin console hiển thị SUM(est_cost_usd) GROUP BY provider/meeting/user.
7. **Tombstone view** — danh sách `deleted_meeting` + thời điểm trash hết hạn (đối chiếu `trash/<ts>/`), để admin biết còn cứu được meeting nào.

---

## §5. Rủi ro / lỗ hổng (3 cái phải đóng trước khi scale)

1. **`trash/` chưa có lifecycle rule (R1).** Rác blob tích vô hạn → tốn tiền, hoặc bị xóa tay sai cửa sổ undo. **Vá:** 1 rule R2 dashboard (30 ngày), 0 code. *Đây là cái rẻ nhất, làm ngay.*
2. **Không có công cụ phát hiện drift R2 ↔ D1 (R2).** Không ai biết storage thật chứa gì; orphan tích lặng lẽ; `chats/library/transcripts` không có row nên cascade/reconcile dễ bỏ sót. **Vá:** 1 route reconcile read-only + storage stats theo bytes.
3. **R2 không có backup/versioning (R3).** D1 an toàn (Time Travel), R2 thì một lần ghi đè/xóa nhầm = mất vĩnh viễn; `trash/` không cứu được ghi đè scene thường ngày. **Vá:** quyết định dứt khoát — accept-risk-có-ghi-nhận (dev phase) HOẶC cron copy sang bucket backup thứ hai.

**Rủi ro thứ cấp (không chặn scale, nhưng theo dõi):**
- Code revoke/clean guest đang HARD-DELETE, lệch chính sách revoke≠delete (`guest-data-lifecycle.md:5`) — thuộc `worker/`, build team sửa.
- Quan hệ liên-bảng phần lớn là **logical join, không FK enforced** (chỉ `meeting→project`, `file→meeting/project`, `user_division→division`, `project.lead_division_id→division` là FK thật). Cascade đúng nhờ code, không nhờ DB. Chấp nhận được với SQLite/D1 nhưng nghĩa là **mọi đường xóa phải tự cascade** — bất kỳ route xóa mới nào quên 1 bảng sẽ tạo orphan (chính là lý do R2 cần tồn tại).
- Khóa R2 phẳng theo room (không per-project) → export/xóa theo project/jurisdiction phải duyệt qua D1; làm được nhưng không 1-lệnh (R4/R6).

---

*Trích dẫn: tất cả file:line theo `worker/src/index.ts` và `worker/schema/*.sql` tại thời điểm 2026-06-17. Không sửa code; `worker/` và `excalidraw-app/` do build team sở hữu.*
