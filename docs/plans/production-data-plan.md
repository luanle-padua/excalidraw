# Kế hoạch dữ liệu production — "local GIỐNG HỆT production"

_Lập 2026-06-10. Nền tảng: [data-architecture-audit.md](../audits/2026-06-10-data-architecture-audit.md) (bản đồ dữ liệu + lỗ hổng — KHÔNG lặp lại ở đây) và [user-data-model.md](../specs/user-data-model.md) (định danh user). Mục tiêu: dù đang chạy local, CẤU TRÚC dữ liệu (schema, key-scheme, secret names, ranh giới D1/R2/Supabase) phải y hệt khi lên production — đổi môi trường chỉ là đổi binding target._

## ✅ QUYẾT ĐỊNH CHỐT (buổi bàn 2026-06-10 chiều — anh Luân duyệt)

1. **Admin compliance access**: admin được mở NỘI DUNG mọi meeting (canvas/chat/transcript, read-only review qua `room_key` managed) phục vụ quản trị rủi ro. User không được thông báo, nhưng **mọi lần mở đều ghi `audit_log`** (bất biến) — dấu vết bảo vệ chính admin.
2. **My Files ("Tài liệu của tôi")**: tủ tài liệu cá nhân — R2 `userfiles/<user>/<fileId>` (server-readable) + bảng `user_file`; bake DXF/IFC/PDF MỘT lần lúc upload; kéo vào meeting bằng **COPY** (client fetch blob → đi đúng pipeline ingest/encrypt sẵn có) — meeting giữ tính snapshot, xoá file trong tủ không đục lỗ meeting cũ. Mở rộng sau: tủ dự án.
3. **Visibility dữ liệu meeting**: nguyên tắc duy nhất **"thấy meeting = thấy toàn bộ dữ liệu meeting đó"** (`canSeeMeeting` là ranh giới). 2 ngoại lệ: recording (P5 — host + người duyệt), `confidentiality='Confidential'` → invitee-only kể cả project member (ENFORCE, hết trang trí).
4. **AI summary-first**: meeting End → auto-summary → lưu **D1** (cột `meeting.ai_summary`, server-readable, QUERY được) làm nền hỏi-xuyên-meeting; transcript chi tiết vẫn E2E blob (`transcripts/`). **Luật sắt: scope AI = scope người hỏi** (`canSeeMeeting`/`projectAccess`). Đích: dời `/chatbot` lên Worker (I-1) để enforce scope + đọc D1.

   ⚠️ Điều chỉnh so với bản đầu của plan này: `summaries/` KHÔNG còn là blob E2E — summary chuyển thành **cột D1** vì AI và admin cần query; transcript giữ E2E (admin/AI đọc qua client review với managed key khi cần đào sâu).

**Trạng thái code đã verify hôm nay** (audit viết buổi sáng, chiều đã fix một phần): ✅ cascade xoá meeting dọn đủ invitee/participant/note (index.ts:1794-1806); ✅ `PATCH /v1/projects` owner-only, `POST /v1/projects` internal-only + insert owner membership (441-468, 547-562; 0014 backfill); ✅ `canSeeMeeting` invited-only, bỏ internal-allow (180-220). **Còn mở:** scene-PUT hồi sinh meeting đã xoá (304-331 upsert vô điều kiện); `INTERNAL_DOMAIN` hardcode (142) — `system_settings` admin sửa vẫn vô hiệu; transcript/summary chỉ localStorage (transcription.ts:44-45); recording chỉ download; avatar chưa lên R2; migrations chạy tay không track.

---

## 1. Nguyên tắc "local = production"

Parity được định nghĩa bằng 4 bất biến — vi phạm cái nào là lệch cấu trúc:

1. **Cùng schema**: `worker/schema/000N_*.sql` là NGUỒN DUY NHẤT; cùng dãy migration chạy trên local lẫn remote, track bằng bảng `schema_version` (§4). Không bao giờ sửa DB tay.
2. **Cùng key-scheme R2**: mọi blob theo bảng prefix chuẩn (§2) — local miniflare và bucket thật dùng đúng một bộ key builder trong `worker/src/index.ts:135-138`.
3. **Cùng secret names**: tên trong `worker/.dev.vars` ↔ `wrangler secret put <TÊN>` phải 1-1. Bộ hiện tại: `DAILY_API_KEY`, `DAILY_DOMAIN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_API_KEY` (+ `SUPABASE_DATABASE_PASSWORD` chỉ dùng seed script — không cần lên Worker). Room server thêm bộ riêng: `CLOUDFLARE_TURN_TOKEN_ID/API_TOKEN`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`.
4. **Khác DUY NHẤT binding target**: `wrangler.jsonc` `database_id` (đang `"local-dev-placeholder"`) + bucket thật + `VITE_APP_STORAGE_URL`. Code không được biết mình đang ở env nào.

**Chỗ HIỆN ĐANG lệch parity** (dữ liệu nghiệp vụ nằm sai tầng — phân loại từ audit §1.4):

| Datum (key) | Loại | Phán quyết |
| --- | --- | --- |
| `mcm:transcript:<roomId>`, `mcm:summary:<roomId>` | **DATA** | 🔴 phải lên server (R2 + D1 index) — P0.3 |
| Recording `.webm` (MeetingRecorder.ts:171) | **DATA** | 🔴 upload R2 `recordings/` thay vì download — P0.4 |
| Avatar upload (data URL local) | **DATA** | 🟠 R2 `avatars/<user_id>` — P2 |
| Canvas solo (ngoài meeting) | DATA cá nhân | 🟡 chấp nhận local ở dev-phase; ghi nhận |
| `mcm:lastMeeting:v1` (chứa roomKey plaintext) | cache + SECRET | hợp lệ là cache, nhưng secret cần dọn khi E2E thật |
| `mcm:hostClaim:v1`, `mcm:reviewRoom:v1`, IDB meetingLibrary, scene cache, preference UI (`mcm:cadViewState`…), `sb-*-auth-token` | **cache/pref** | ✅ đúng chỗ, giữ nguyên |

## 2. Ranh giới D1 (database) vs R2 (storage)

**Quy tắc:** D1 = metadata/registry/quan hệ/audit — mọi thứ cần QUERY, JOIN, liệt kê, authz. R2 = bytes — mọi thứ chỉ cần GET/PUT theo key. **Mỗi blob "có đời sống riêng" phải có row D1 trỏ vào** (bài học audit §3.8: scenes/chats/library không có row → admin đếm thiếu, mồ côi vô hình — chấp nhận cho 3 prefix per-room hiện có vì key suy ra từ `meeting.id`, nhưng prefix MỚI bắt buộc có bảng index).

D1 hiện có 10 bảng (audit §1.1). **Bảng cần thêm:** `recording(id, meeting_id, r2_key, duration_ms, size, created_by, created_at)`; `transcript`/`summary` KHÔNG cần bảng riêng — dùng blob per-room như `chats/` (key suy từ roomId); `user_profile` (P2, theo user-data-model.md §3); `schema_version` (§4).

**Bảng prefix R2 chuẩn (naming convention chốt):**

| Prefix | Nội dung | Mã hoá | D1 index | Admin đọc? |
| --- | --- | --- | --- | --- |
| `scenes/<roomId>/current` | canvas | E2E room_key | `meeting.scene_r2_key` | ❌ ciphertext |
| `files/<roomId>/<fileId>` | ảnh/PDF/DXF/GLB | E2E room_key | bảng `file` | ❌ |
| `chats/<roomId>/current` | chat log | E2E room_key | — (key suy ra) | ❌ |
| `library/<roomId>/current` | manifest vật liệu | E2E room_key | — | ❌ |
| **`transcripts/<roomId>/current`** (✅ 06-10) | transcript STT | E2E room_key (như chats) | — | ❌ (đọc qua compliance review client-side) |
| ~~`summaries/`~~ → **cột D1 `meeting.ai_summary`** (✅ 06-10) | AI summary | server-readable | chính nó là D1 | ✅ — nền AI hỏi-xuyên-meeting |
| **`userfiles/<email>/<fileId>`** (✅ 06-10, quyết định #2) | tủ tài liệu cá nhân | server-readable (chưa thuộc meeting nào) | bảng `user_file` (0016) | ✅ |
| **`recordings/<roomId>/<recordingId>.webm`** (mới) | ghi âm/hình | **server-readable** (file lớn, cần stream/range; mã hoá client là không thực tế) | bảng `recording` | ✅ |
| **`avatars/<user_id>`** (mới, P2) | ảnh đại diện | server-readable (public-ish) | `user_profile.avatar_key` | ✅ |

Hệ quả cho admin: nhóm E2E admin chỉ quản vòng đời (xoá/đếm), không đọc nội dung — đúng chủ trương; nhớ rằng "E2E" hiện là managed-key (`meeting.room_key` trong D1 — audit §1.2) nên đây là ranh giới CHÍNH SÁCH chứ chưa phải mật mã. `recordings/`/`avatars/` server-readable → admin xem/phát được, cần ghi rõ trong admin-console.md khi làm.

## 3. User data — chốt thực thi (chi tiết model ở user-data-model.md, đây là trình tự)

1. **Supabase = identity SoR.** `user_metadata` chỉ giữ: HR seed (name/title/division/company/emp_no) + `avatar` ref nhỏ (`lib:NN.png`). KHÔNG nhét data URL, không nhét quyền (quyền = `app_metadata.role`, chỉ service key sửa được).
2. **D1 giữ quan hệ & profile mirror**: bảng `user_profile(user_id PK, email, display_name, company, division, avatar_key, updated_at)` — Worker upsert lúc verify JWT (đã có sẵn claims trong middleware).
3. **Lộ trình email→UUID** (migration tactic, mỗi bước một migration đánh số):
   - `00NN_user_id_columns.sql`: `ALTER TABLE project_member ADD COLUMN user_id TEXT;` — tương tự `meeting_invitee`, `meeting_participant`, `client` (cột `created_by_user_id`), `meeting` (organizer/host), `project` (host). Nullable, không phá gì.
   - Backfill script (`scripts/backfill-user-ids.mjs`): Supabase Admin API `listUsers` → map email→UUID → UPDATE qua `wrangler d1 execute`.
   - Worker ghi SONG SONG email + user_id ở mọi INSERT (invite, participant, membership).
   - Chuyển authz check (`canSeeMeeting`, `projectAccess`, PATCH owner) sang `user_id` khi JWT `sub` có sẵn; **email giữ làm display + grant cho người CHƯA có tài khoản** (invitee email-only được "claim" về user_id ở lần login đầu — UPDATE WHERE email match AND user_id IS NULL).
4. **Avatar → R2**: `PUT /v1/me/avatar` (JWT) → `avatars/<user_id>` → `user_profile.avatar_key`; broadcast socket chỉ gửi ref/URL, bỏ data URL.

## 4. Migrations discipline

Hiện trạng: 0001–0014 chạy tay, `package.json` chỉ có script cho 0001, wrangler `d1 execute --file` KHÔNG track gì → local và remote có thể lệch dãy mà không ai biết. Quy trình chốt:

1. **Migration mới = file đánh số tiếp theo**, idempotent khi có thể (`IF NOT EXISTS`, `INSERT OR IGNORE` — như 0014 đã làm). Không sửa file đã apply.
2. **Bảng track** — `schema/0015_schema_version.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
   );
   ```
3. **Script chạy tuần tự** `worker/scripts/migrate.mjs` (npm: `db:migrate:local` / `db:migrate:remote`): liệt kê `schema/*.sql` theo số → `wrangler d1 execute mcm-db --local|--remote --command "SELECT version FROM schema_version"` lấy max → chạy lần lượt file lớn hơn bằng `--file` → INSERT row track sau mỗi file. Cùng MỘT script cho cả hai env (chỉ khác flag) = parity tự nhiên.
4. CI/checklist deploy: `db:migrate:remote` chạy TRƯỚC `wrangler deploy`.

## 5. Kế hoạch theo phase

### P0 — Parity cấu trúc NGAY trên local (không cần tài khoản Cloudflare, rủi ro thấp)

| # | Việc | File/lệnh | Trạng thái |
| --- | --- | --- | --- |
| P0.1 | ✅ (06-10) `0015_p0_parity.sql` (schema_version + tombstone + ai_summary + seed internal_domains) + **`worker/migrate.mjs`** (`node migrate.mjs` / `--remote` / `--status`); local đã track 16/16 | `worker/schema/`, `worker/migrate.mjs` | XONG |
| P0.2 | ✅ (06-10) Worker đọc `system_settings.internal_domains` (cache per-isolate 60s, refresh trong JWT middleware, fallback hardcode khi bảng trống) | `worker/src/index.ts` | XONG (client session.ts còn hardcode — display only) |
| P0.3 | ✅ (06-10) `PUT/GET /v1/transcripts/:roomId` (E2E như chats, sau roomGate); **summary đổi thành cột D1 `meeting.ai_summary`** (POST `/v1/meetings/:id/summary`) — phục vụ AI summary-first; client persist + auto-summary on End | worker + client transcription | XONG |
| P0.4 | Recording → R2: bảng `recording`, `PUT /v1/recordings/:roomId`, MeetingRecorder upload (giữ download fallback) | worker + `MeetingRecorder.ts` | ĐỂ SAU (gắn Phase 5) |
| P0.5 | ✅ (06-10) Tombstone `deleted_meeting` (ghi trong cascade) → mọi PUT scene/file/chat/library/transcript + POST register trả **410 Gone** | index.ts | XONG |
| P0.6 | ✅ (06-10) `DELETE /v1/projects/:id` (owner = chỉ khi project trống; admin = force cascade) + GET/POST/DELETE `project_member` (chặn xoá owner cuối) + admin Projects tab | worker + AdminConsole | XONG |

**Thêm ngoài kế hoạch (quyết định 06-10):** Confidential enforce trong `canSeeMeeting` + mọi query list · compliance open `POST /v1/admin/meetings/:id/open` (audit BẮT BUỘC trước khi trả key) · My Files `user_file`/`userfiles/` (0016) + UI · wrangler 3→4.99.

(P0 structure parity coi như XONG trừ P0.4 recording: local đã vận hành đúng mô hình đích, lên remote không đổi gì ngoài binding.)

### P1 — Tạo hạ tầng remote — ✅ XONG 2026-06-11 (account `rnd_ai@mapgroup.co.kr`)

1. ✅ R2 bucket `mcm-storage` + D1 `mcm-db` (region APAC, `database_id: 70c15c3f-6dc5-4dbf-bc9e-e011728c7c18` đã dán vào wrangler.jsonc). Local dev KHÔNG đổi — `wrangler dev` vẫn dùng SQLite local theo binding name, chỉ `--remote`/`deploy` đụng remote.
2. ✅ `node migrate.mjs --remote` — 16/16 applied, verify `--status` sạch.
3. ✅ Secrets: cả 4 (`DAILY_API_KEY`, `DAILY_DOMAIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_API_KEY`) đẩy bằng `wrangler secret put` — chọn secret cho TẤT CẢ thay vì vars để không commit giá trị account-specific vào git (đổi nhỏ so với plan; `SUPABASE_ANON_KEY` worker không đọc nên bỏ).
4. ✅ `npx wrangler deploy` → **`https://mcm-storage.rnd-ai.workers.dev`** — smoke test: `/v1/health` 200, route cần JWT trả 401 đúng. Remote DB đang TRỐNG (fresh) — migrate dữ liệu local nếu cần giữ: audit §5.5.
5. **Cutover client (khi muốn):** build với `VITE_APP_STORAGE_URL=https://mcm-storage.rnd-ai.workers.dev`; Pages cho app = bước riêng (I-tracks roadmap). CHƯA làm (chủ động): CORS vẫn `*` (tiện dev — khoá khi có origin thật), default password, rate-limit (audit §5.6).

### P2 — Identity UUID + avatar (theo §3, sau khi remote ổn định; mỗi bước một migration, rollback = bỏ qua cột mới)

### P3 — Backup/DR + observability

- D1: Time Travel có sẵn 30 ngày; thêm export định kỳ `npx wrangler d1 export mcm-db --remote --output=backup-$(date).sql` (scheduled task / GitHub Action tuần).
- R2: bật versioning trên bucket; job đối chiếu R2↔D1 (admin endpoint list prefix, báo mồ côi + dung lượng THẬT — audit §3.8).
- Xoá Daily room khi xoá meeting (audit §1.6); audit_log pagination/export.

## 6. Bảng đích "datum → nơi lưu" (một dòng một loại)

| Datum | Đích | Ghi chú |
| --- | --- | --- |
| Identity, password, role, HR metadata, avatar-ref | **Supabase** | SoR; `app_metadata.role` chỉ service-key |
| Profile mirror (`user_profile`), project, meeting, file-index, recording-index, invitee, member, participant, client, note, settings, audit_log, schema_version | **D1** | mọi quan hệ key bằng `user_id` (email = display/claim) |
| Scene, files, chat, library, transcript, summary | **R2** (E2E room_key) | prefix §2; admin quản vòng đời, không đọc |
| Recording, avatar | **R2** (server-readable) | `recordings/`, `avatars/` |
| room_key | **D1** `meeting.room_key` (managed) | E2E thật = post-demo; không trả qua admin API |
| Scene cache, meetingLibrary IDB, hostClaim, lastMeeting, reviewRoom, preference UI, session token | **localStorage/IDB — cache-only** | mất là dựng lại được từ server |
| Canvas solo ngoài meeting, library cá nhân Excalidraw | localStorage (chấp nhận dev-phase) | nếu cần roam → tạo meeting/room cá nhân |
| TURN/Gemini/Deepgram/Daily keys | env room-server + `wrangler secret` | không bao giờ vào browser |
