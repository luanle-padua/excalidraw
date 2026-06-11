# Audit kiến trúc dữ liệu — single source of truth & admin coverage

> ⚠️ **Snapshot sáng 2026-06-10 — nhiều finding (§2, §3, §4, §5) đã được fix trong P0+P1.** Trạng thái sống xem [production-data-plan.md](../plans/production-data-plan.md) §5. Đường dẫn `docs/...` trong file là vị trí cũ trước reorg 06-11.

_Cập nhật 2026-06-10. Trả lời câu hỏi: "dữ liệu đã được tổ chức chuẩn production chưa, admin có xem/quản lý được toàn bộ chưa, đâu là single source of truth?"_

Liên quan: [user-data-model.md](../specs/user-data-model.md) (phần định danh user — KHÔNG lặp lại ở đây), [host-and-scheduling.md](../specs/host-and-scheduling.md) (thiết kế invitee vs member), [dev-phase-notes.md](../plans/dev-phase-notes.md) (các mục tạm), [admin-console.md](../specs/admin-console.md).

**Kết luận nhanh:** Khung dữ liệu (D1 + R2 + Supabase) đã đúng hướng và hierarchy project → meeting → file là hợp lý, NHƯNG (a) toàn bộ "database" hiện chỉ là **miniflare local trên 1 máy dev** (`worker/.wrangler/state/v3/…`), chưa có D1/R2 remote; (b) một số dữ liệu nghiệp vụ quan trọng (transcript STT, AI summary, recording, avatar upload) **chỉ tồn tại trong trình duyệt của từng người**; (c) xoá meeting để lại **rác mồ côi** ở 3 bảng; (d) admin console **không thấy** project/membership/invitee/notes và không dọn được R2 mồ côi.

---

## 1. Bản đồ dữ liệu (datum → nơi lưu → ai ghi → authoritative?)

### 1.1 D1 (worker/schema/0001–0013) — metadata + cấu trúc thư mục

| Bảng | Khóa | Ai ghi (route trong `worker/src/index.ts`) | Authoritative? |
|---|---|---|---|
| `project` | `id` UUID | `POST/PATCH /v1/projects` (mọi JWT hợp lệ — xem §3.4) | ✅ nguồn duy nhất cho folder |
| `meeting` | `id` = roomId | `POST /v1/meetings` (internal), `PATCH /v1/meetings/:id` (organizer/state-machine), upsert ngầm từ `PUT /v1/scenes/:roomId` (index.ts:282) | ✅ — `status` canonical từ 0013 |
| `file` | `id` = fileId; FK meeting/project (chỉ khai báo ở 0001) | upsert từ `PUT /v1/files/:roomId/:fileId` (index.ts:375) | ✅ index của R2 `files/` |
| `audit_log` | `id` UUID | `logAudit()` (index.ts:1387) — mọi mutation admin + invite/revoke/client | ✅ append-only |
| `meeting_participant` | (meeting_id, user_email) | `POST /v1/meetings/:roomId/participant` — email lấy từ JWT (index.ts:789) | ✅ "ai đã thực sự vào" |
| `system_settings` | key | `PUT /v1/admin/settings` | ⚠️ admin sửa được nhưng **Worker chưa đọc** — `INTERNAL_DOMAIN` vẫn hardcode (index.ts:142) |
| `project_member` | (project_id, email) | backfill 0008 + `addToProject` trong invite (index.ts:890). **Không có API xoá/list** | ✅ nhưng chỉ ghi-thêm, không quản được |
| `meeting_invitee` | (meeting_id, email) | `POST/DELETE /v1/meetings/:roomId/invitees` (revoke = soft) | ✅ grant per-meeting |
| `note` | (scope, ref, email) | `PUT /v1/notes` — bound vào JWT email | ✅ per-user |
| `client` | `id` UUID | `POST/DELETE /v1/clients` + auto-create khi invite guest (index.ts:867-880) | ✅ contact card (KHÔNG phải identity) |

Không bảng nào (ngoài `meeting`/`file` ở 0001) khai báo FOREIGN KEY; **không có ON DELETE CASCADE ở bất cứ đâu** — toàn vẹn quan hệ là "do code tự dọn" (và đang dọn thiếu, xem §3).

### 1.2 R2 (bucket `mcm-storage`) — bytes

| Prefix (key builder index.ts:135-138) | Nội dung | Mã hoá | Admin đọc được? |
|---|---|---|---|
| `scenes/<roomId>/current` | scene canvas | E2E client-side với room key (`storage.ts`) | ❌ ciphertext (nhưng xem ghi chú room_key) |
| `files/<roomId>/<fileId>` | ảnh/PDF/DXF/GLB/thumb | encrypt + compress client-side | ❌ |
| `chats/<roomId>/current` | log chat | E2E room key (storage.ts:265-292) | ❌ |
| `library/<roomId>/current` | manifest DXF/IFC/PDF + bytes nguồn | E2E room key | ❌ |

⚠️ "E2E" hiện là **managed-key**: `meeting.room_key` nằm ngay trong D1 (0001, ghi chú TEST PHASE) → server/ops về lý thuyết giải mã được mọi blob; admin console chỉ là *cố tình không trả* `room_key`/`scene_r2_key` (index.ts:1551). Đây là trade-off đã ghi ở dev-phase-notes ("`room_key` lưu D1 — chưa E2E thật").

Ngoài 4 prefix trên R2 **không có gì khác** (chưa có `avatars/` — vẫn là TODO trong userProfile.ts).

### 1.3 Supabase Auth

Identity + profile HR (`user_metadata`: name/title/division/company/emp_no/avatar-ref; `app_metadata.role`) — chi tiết & lộ trình UUID-hoá ở [user-data-model.md](../specs/user-data-model.md). Worker chỉ verify JWT qua JWKS và proxy Admin REST bằng `SUPABASE_SERVICE_API_KEY`.

### 1.4 Trình duyệt (localStorage / sessionStorage / IndexedDB) — đây là chỗ "để ở local" nhiều nhất

| Key | Nội dung | Có bản DB không? |
|---|---|---|
| `excalidraw`, `excalidraw-state`, `excalidraw-collab` | scene cache + appState + username (LocalData) | Có (R2 scene) khi ở trong meeting; canvas solo ngoài meeting = **chỉ local** |
| IDB `files-db` / `excalidraw-library` / `excalidraw-ttd-chats` | file bytes cache, library cá nhân, TTD chats | library cá nhân = chỉ local |
| IDB `mcm:meetingLibrary:<roomId>` (+ deleted list) (meetingLibrary.ts:107) | cache thư viện DXF/IFC/PDF của phòng | Có (R2 `library/`) — IDB là cache |
| `mcm:userProfile:v1`, `mcm:hostClaim:v1` | hồ sơ + claim host per-room | một phần (Supabase) — xem user-data-model.md |
| `mcm:lastMeeting:v1` (lastMeeting.ts) | **roomId + roomKey** cho nút Resume | room_key cũng có trong D1; ⚠️ secret nằm plaintext trong localStorage |
| `mcm:reviewRoom:v1` (sessionStorage, reviewMode.ts) | đánh dấu tab đang review read-only | per-tab, đúng chỗ |
| `mcm:transcript:<roomId>` (transcription.ts:138) | **TOÀN BỘ transcript STT của meeting** | ❌ **KHÔNG có bản DB** |
| `mcm:summary:<roomId>` (transcription.ts:161) | AI summary của meeting | ❌ **KHÔNG có bản DB** |
| `mcm:chatTranslations`, `mcm.holidays.v2.*`, `mcm:canvasNav:v1`, `mcm:sttPanelPos/Size`, `mcm:cadViewState`, `mcm:ifcViewState`, `mcm:sttEnabled`, theme, ngôn ngữ | cache/preference UI | OK để local (preference) |
| `sb-*-auth-token` | session Supabase (SDK, `persistSession:true`) | OK (chuẩn SDK) |
| File ghi âm `.webm` (MeetingRecorder.ts:171) | recording cuộc họp | ❌ chỉ download về máy host, **không bao giờ upload** |

### 1.5 Room server (`room/`)

Hoàn toàn **in-memory / stateless** (socket relay + proxy TURN/Gemini/Deepgram) — không persist gì. Secrets nằm ở `room/.env.development`: `CLOUDFLARE_TURN_TOKEN_ID/API_TOKEN`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY` (server-only, không vào browser). Đúng thiết kế, nhưng nhớ: khi dời lên Cloudflare các key này thành `wrangler secret`.

### 1.6 Dịch vụ ngoài

Daily.co giữ state riêng: room `<roomId>` + `<roomId>-audio` được tạo on-demand (index.ts:1293-1325) và **không bao giờ bị xoá** — kể cả khi admin xoá meeting.

---

## 2. Vi phạm single-source-of-truth

| # | Datum | Các bản sao | Bản authoritative | Mức độ |
|---|---|---|---|---|
| 1 | **Transcript + AI summary** | localStorage duy nhất | — KHÔNG CÓ | 🔴 dữ liệu nghiệp vụ chỉ sống trong 1 trình duyệt; đổi máy/clear cache = mất; admin & người khác trong meeting không xem được; mâu thuẫn với "finished meeting = review đầy đủ" |
| 2 | **Recording .webm** | máy host duy nhất | — KHÔNG CÓ | 🔴 như trên (Phase 5 đã định làm, ghi nhận để khỏi quên) |
| 3 | **Internal domain** | hardcode `@mapgroup.co.kr` ở worker (index.ts:142) + `session.ts` + `AdminConsole.tsx` defaults **và** `system_settings.internal_domains` | hiện tại = HARDCODE (D1 setting bị bỏ qua) | 🔴 admin sửa setting tưởng có hiệu lực nhưng không — sai lệch nguy hiểm vì nó quyết định authz |
| 4 | **Scene** | localStorage cache ↔ R2 blob | R2 (reconcile khi join) | 🟡 chấp nhận được; rủi ro là canvas solo (không room) chỉ có local |
| 5 | **Hồ sơ user / avatar** | localStorage ↔ Supabase `user_metadata` | Supabase (đã fix 06-10) | 🟡 avatar upload (data URL) vẫn local-only — xem user-data-model.md |
| 6 | **Host** | `mcm:hostClaim:v1` (client) ↔ `meeting.host_email` (D1) ↔ acting-host election runtime | D1 là thiết kế đích; runtime đang soft | 🟡 ba khái niệm, server chưa enforce (dev-phase-notes 🟠) |
| 7 | **room_key** | D1 `meeting.room_key` ↔ URL hash ↔ `mcm:lastMeeting:v1` | D1 (managed key) | 🟡 nhiều bản sao của một SECRET; localStorage plaintext |
| 8 | **participant_count** (cột meeting) ↔ `meeting_participant` rows | hai cách đếm cùng một thứ | nên là `COUNT(meeting_participant)` | 🟢 lệch chỉ ảnh hưởng hiển thị |
| 9 | **`file.project_id`** ↔ `meeting.project_id` | file nhận projectId từ query param lúc upload | `meeting.project_id` | 🟢 có thể lệch khi meeting được file vào folder SAU khi upload |
| 10 | **`client` table** ↔ Supabase guest account | guest có cả contact card lẫn (tương lai) account, không link nhau | mỗi bên một mục đích, nhưng thiếu liên kết `client.email → user_id` | 🟢 |
| 11 | **invitee ↔ project_member** | internal được mời có thể có cả 2 row; `canSeeMeeting` internal-allow (index.ts:184) khiến CẢ HAI bị bypass với nội bộ | thiết kế 2-grant là ĐÚNG (host-and-scheduling.md); vấn đề là dev-rule internal-allow làm 2 bảng chưa phải nguồn quyền thật | 🟡 siết trước prod (đã ghi dev-phase-notes) |
| 12 | **Daily room** | state ở Daily.co keyed by roomId | D1 meeting là gốc | 🟢 rò rỉ room mồ côi phía Daily sau khi xoá meeting |

**Dữ liệu CHỈ ở client mà production cần đưa vào DB:** transcript (#1), summary (#1), recording (#2), avatar upload (→ R2 `avatars/<user_id>`), canvas solo nếu muốn "mọi thứ đều trên server".

---

## 3. Lỗ hổng toàn vẹn dữ liệu (cite file:line)

1. **Admin xoá meeting KHÔNG dọn 3 bảng** — `DELETE /v1/admin/meetings/:roomId` (worker/src/index.ts:1584-1618) xoá 4 prefix R2 + `file` + `meeting`, nhưng **bỏ lại orphan rows**: `meeting_invitee`, `meeting_participant`, `note (scope='meeting', ref=roomId)`. Hệ quả: `/v1/me/invitations` và `/v1/me/meetings` vẫn JOIN ra (JOIN meeting nên rows mồ côi bị ẩn — nhưng rác tích tụ và đếm analytics `meeting_participant` (index.ts:1769) bị phồng). (`audit_log` giữ lại là ĐÚNG.)
2. **Meeting "hồi sinh" sau khi xoá** — `PUT /v1/scenes/:roomId` upsert lại row meeting (index.ts:282-293). Client nào còn mở phòng và auto-save sau khi admin xoá sẽ TÁI TẠO meeting (không title/owner) + blob scene mới trong R2; các orphan invitee/participant ở mục 1 lập tức "gắn lại" vào meeting zombie này.
3. **Không có FK/cascade thật** — chỉ 0001 khai báo `REFERENCES`; các bảng 0005-0012 không có FK nào; không `ON DELETE`. Toàn vẹn 100% phụ thuộc code.
4. **`PATCH /v1/projects/:id` không có authz** (index.ts:467-509) — bất kỳ JWT hợp lệ nào (kể cả GUEST ngoài công ty có tài khoản) sửa được tên/cover/metadata của MỌI project nếu đoán/biết id. `POST /v1/projects` (index.ts:401) cũng không giới hạn internal.
5. **`project_member` chỉ ghi-thêm** — insert tại index.ts:890 (INSERT OR IGNORE) + backfill 0008; **không tồn tại endpoint list/remove** → không thu hồi được quyền browse cả folder của một người; admin cũng không nhìn thấy bảng này.
6. **Không xoá được project** — không có `DELETE /v1/projects` ở bất kỳ tầng nào → folder rác tồn tại mãi; nếu sau này thêm xoá mà quên cascade thì meeting/file/member mồ côi (bài học mục 1).
7. **Email là khoá định danh** toàn bộ D1 — đổi email = mất quyền + lịch sử. Chi tiết & lộ trình UUID: [user-data-model.md](../specs/user-data-model.md) §2.3, §3.
8. **R2 mồ côi vô hình** — `scenes/chats/library` không có row D1 (by design, index.ts:312, 337), nên: (a) admin storage stats (index.ts:1646-1661) **đếm thiếu** (chỉ SUM từ bảng `file`); (b) không có job/endpoint nào liệt kê-đối chiếu R2 ↔ D1 để phát hiện blob mồ côi (vd blob sinh lại bởi mục 2).
9. **Chưa có D1 backup / R2 versioning** (dev-phase-notes 🟡) — một lệnh xoá nhầm là mất thật.

---

## 4. Admin coverage matrix (Console `components/mcm/AdminConsole.tsx` + `/v1/admin/*`)

| Dữ liệu | Xem được | Quản lý được | Thiếu |
|---|---|---|---|
| Supabase users | ✅ list (proxy index.ts:1416) | ✅ create / role / password / disable / delete | sửa user_metadata (title/division) chưa có UI |
| `meeting` | ✅ list + detail (1529, 1552; ẩn room_key đúng) | ✅ delete (kèm cascade R2 — nhưng thiếu, §3.1); PATCH admin-bypass có ở API nhưng **console không có UI sửa** | restore/repair meeting; xoá kèm invitee/participant/note |
| `project` | ⚠️ chỉ thấy `project_name` dính trên row meeting | ❌ không list, không sửa, **không xoá** | tab Projects: list/rename/transfer-owner/delete-cascade |
| `project_member` | ❌ | ❌ (không có endpoint) | xem roster + thu hồi membership |
| `meeting_invitee` | ❌ trong console (endpoint `/v1/meetings/:id/invitees` tồn tại, admin pass, nhưng admin meeting detail (1552-1581) không trả invitees và UI không gọi) | ❌ | thêm invitees vào admin meeting detail |
| `meeting_participant` | ✅ trong meeting detail + analytics | — (log, không cần sửa) | |
| `note` | ❌ (per-user by design) | ❌ | GDPR export/delete theo user (đã ghi dev-phase-notes) |
| `client` | ✅ tab Clients | ✅ create/delete | edit row; link sang account nếu guest có login |
| `audit_log` | ✅ (200 dòng cuối, index.ts:1637) | — | pagination/filter/export |
| `system_settings` | ✅ tab Settings | ✅ PUT | **Worker chưa đọc** các setting này (§2.3) → đang là quản lý "giả" |
| R2 blobs | ⚠️ stats từ bảng `file` (đếm thiếu §3.8) | ⚠️ chỉ xoá theo meeting | nội dung không đọc được (mã hoá — chấp nhận); cần job đối chiếu/quét mồ côi + tổng dung lượng THẬT (R2 list) |
| Stats/analytics/cost | ✅ aggregates | — | cost là ước tính (ghi rõ ở dev-phase-notes) |
| Recordings | placeholder | — | chờ Phase 5 |
| Transcript/summary | ❌ (chỉ trong browser người dự) | ❌ | phải đưa vào DB trước (mục §2.1) |

---

## 5. Checklist đi production (local → remote)

Hiện trạng: `wrangler.jsonc` `database_id: "local-dev-placeholder"` → toàn bộ D1 + R2 đang là **miniflare local**: `worker/.wrangler/state/v3/d1/...sqlite` và `worker/.wrangler/state/v3/r2/...` trên đúng 1 máy dev. **Không gì tự migrate cả.**

1. **Tạo hạ tầng remote** (1 lần, cần `wrangler login`):
   - `npx wrangler r2 bucket create mcm-storage`
   - `npx wrangler d1 create mcm-db` → dán `database_id` thật vào `worker/wrangler.jsonc:38`.
2. **Chạy migrations theo thứ tự** trên remote: `npx wrangler d1 execute mcm-db --remote --file=./schema/0001_init.sql` … lần lượt tới `0013_status_canonical.sql` (dev-phase-notes 🟡 đã nhắc).
3. **Secrets** (đang ở `worker/.dev.vars` local): `wrangler secret put DAILY_API_KEY`, `wrangler secret put SUPABASE_SERVICE_API_KEY`; `SUPABASE_URL`/`DAILY_DOMAIN` đặt làm `vars`. Room server (host riêng) cần env riêng: `CLOUDFLARE_TURN_TOKEN_ID/API_TOKEN`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`.
4. **Deploy**: `npx wrangler deploy`; client build với `VITE_APP_STORAGE_URL` = URL worker thật.
5. **Migrate dữ liệu local nếu muốn giữ** (mặc định là MẤT):
   - D1: `npx wrangler d1 export mcm-db --local --output=dump.sql` → `npx wrangler d1 execute mcm-db --remote --file=dump.sql` (lọc bỏ CREATE trùng).
   - R2: viết script đọc blob local (qua worker local GET) → PUT lên remote; không có lệnh copy sẵn.
   - **Không thể migrate**: mọi thứ ở §1.4 nằm trong trình duyệt từng user (transcript, summary, avatar upload, recording đã download).
6. **Khoá lại trước khi mở**: CORS `origin:"*"` → origin thật (index.ts:70); bỏ default password/auto-login; rate-limit; siết internal-allow → project_member; bật D1 backup (Time Travel) + R2 versioning; sửa lỗ §3.4 (PATCH project authz).

---

## 6. Khuyến nghị ưu tiên

1. 🔴 **Fix cascade xoá meeting** (worker/src/index.ts:1584): thêm DELETE `meeting_invitee` / `meeting_participant` / `note(scope='meeting')`; đồng thời chặn upsert-hồi-sinh ở `PUT /v1/scenes` (chỉ upsert khi meeting tồn tại, hoặc 404 khi đã xoá).
2. 🔴 **Authz cho `PATCH /v1/projects/:id` + `POST /v1/projects`** (owner/member + internal-only) — đang mở cho mọi JWT.
3. 🔴 **Persist transcript + summary vào R2** (blob mã hoá per-room như `chats/`) — dữ liệu họp quan trọng nhất đang chỉ nằm trong localStorage 1 máy.
4. 🔴 **Worker đọc `system_settings.internal_domains`** thay cho hardcode — để bảng setting admin sửa là setting THẬT.
5. 🟠 **Tạo D1/R2 remote + chạy 0001-0013 + secrets + deploy** (checklist §5) — chừng nào còn placeholder thì "database" = 1 file sqlite trên máy dev.
6. 🟠 **Admin tab Projects + Membership**: list/delete project (cascade đủ), xem & thu hồi `project_member`, hiện invitees trong meeting detail.
7. 🟠 **Endpoint remove `project_member`** (thu hồi quyền folder) — hiện grant là vĩnh viễn.
8. 🟡 **Job đối chiếu R2 ↔ D1** (list prefix, báo blob mồ côi + dung lượng thật cho tab Storage).
9. 🟡 **UUID-hoá identity** theo lộ trình user-data-model.md §3 (thêm cột `user_id`, ghi song song, chuyển authz).
10. 🟡 **D1 backup + R2 versioning** bật ngay khi có remote; xoá Daily room khi xoá meeting (dọn state ngoài).
