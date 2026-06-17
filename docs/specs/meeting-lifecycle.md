# Vòng đời một cuộc họp — Canvas M (full lifecycle)

> Truy vết **trọn vòng đời** của một meeting: `tạo → lên lịch → vào → đang họp → kết thúc → xoá`, ở cả 3 lớp **D1** (metadata), **R2** (bytes E2E) và **code** (worker + client). Đối chiếu [host-and-scheduling.md](host-and-scheduling.md) (state machine + role) và [user-data-model.md](user-data-model.md). Mọi trích dẫn `file:line` lấy từ code thật `worker/src/index.ts`, `worker/schema/*.sql`, `excalidraw-app/collab/Collab.tsx`, `components/mcm/*`.

**Nguyên tắc xuyên suốt:** D1 chỉ giữ **con trỏ + metadata**; R2 giữ **bytes mã hoá E2E** bằng room key (key nằm trong `#room=roomId,roomKey` của URL, **không bao giờ gửi server**); realtime edits đi qua **Durable Object (RoomDO)** relay — server relay bytes đã mã hoá, không đọc được nội dung. `meeting.id == roomId` (`schema/0001_init.sql:26`).

---

## ASCII timeline — phase → D1 ghi gì → R2 ghi gì

```
 PHASE         ACTION                       D1 (metadata)                         R2 (E2E bytes)
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 TẠO           POST /v1/meetings            INSERT meeting{status,realtime_       (chưa có)
 (scheduled/   (form tạo = form edit)        backend='do', room_key, organizer_
  live)                                      email=JWT, host_email}
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 TẠO ad-hoc    PUT /v1/scenes/:room   ──┐    UPSERT meeting (gap-fill) +          scenes/<room>/current  (ghi luôn)
 (side path)   registerMeeting status=live  realtime_backend='do'
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 MỜI + LỊCH    POST .../invitees            INSERT meeting_invitee{kind:          (không)
               PATCH status/scheduled_at     internal|guest, role, status}
                                            UPDATE meeting.scheduled_at
                                            scheduled ─Start→ live ─End→ finished
                                                  └─cancel→ cancelled ─restore→ scheduled
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 VÀO HỌP       knock / admit                INSERT meeting_knock{status:          (không)
 (join)        WS upgrade (DO)               invited→admitted}
               POST .../participant         INSERT meeting_participant{joined_at}
               GET /v1/daily/token          (đọc gates)                           (không)
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 ĐANG HỌP      mọi người vẽ/chat/upload     (chỉ metadata: scene_updated_at,      scenes/<room>/current
 (live)        realtime edits qua RoomDO     participant_count, last_seen_at)      files/<room>/<fileId>
                                                                                  chats/<room>/current
                                                                                  library/<room>/current
                                                                                  transcripts/<room>/current
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 KẾT THÚC      Host End-for-all             UPDATE meeting.status='finished'      (R2 đóng băng — blob PUT bị
 (finished)    (1) status='finished' FIRST  (rồi) HOST_COMMAND broadcast          409 sau grace window)
               (2) broadcast END_MEETING    POST .../summary → meeting.ai_summary
               → mọi người → review (RO)    revoke = UPDATE invitee.status=revoked
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 XOÁ           DELETE /v1/meetings/:room    DELETE file/invitee/participant/      scenes|files|chats|library|
 (delete)      (chỉ khi cancelled)          knock/note/meeting                    transcripts → COPY sang
               deleteMeetingCascade()       INSERT deleted_meeting (TOMBSTONE)    trash/<ts>/...  rồi delete gốc
                                                                                  (SOFT-delete, khôi phục được)
                                            + xoá 2 Daily rooms (<id>, <id>-audio)
```

---

## Bảng tổng: ở mỗi phase — D1 ghi gì / R2 ghi gì / ai làm được

| Phase | D1 ghi | R2 ghi | Ai làm được |
| --- | --- | --- | --- |
| **Tạo** (scheduled/live) | `meeting` row: `status`, `realtime_backend='do'`, `room_key`, `organizer_email`(=JWT), `host_email`(=organizer), `scheduled_at`, `duration_min`, `waiting_room`, `recording_enabled` | — | Nội bộ (`@mapgroup`) hoặc admin; nếu gắn project → phải là **manager** của project (`canManageProject`) |
| **Tạo ad-hoc** | `meeting` UPSERT (gap-fill) qua scene-PUT hoặc `registerMeeting(status='live')` | `scenes/<room>/current` | Bất kỳ user đã đăng nhập (autosave); organizer stamp từ JWT |
| **Mời + lịch** | `meeting_invitee` (internal/guest); `meeting.scheduled_at`; transition `status` | — | **Meeting-manager** (organizer/host/co-host/project-authority/admin) mới mời; **nội bộ** mới drive state machine |
| **Vào họp** | `meeting_knock` (chỉ khách); `meeting_participant{joined_at}` | — | Internal **auto-admit**; khách **knock → host duyệt**; cả hai phải qua `canSeeMeeting` |
| **Đang họp** | chỉ metadata: `scene_updated_at`, `participant_count`, `last_seen_at` | scene · files · chats · library · transcripts (tất cả E2E) | Mọi người trong phòng (không phải review/viewOnly) |
| **Kết thúc** | `status='finished'`; `ai_summary`; revoke → `invitee.status='revoked'` | đóng băng (PUT 409 sau grace) | **Host/co-host/organizer/project-lead** mới End; finished = **immutable** |
| **Xoá** | DELETE file/invitee/participant/knock/note/meeting + INSERT `deleted_meeting` | COPY → `trash/<ts>/`, delete gốc (soft) | **Organizer** (chỉ khi `cancelled`) hoặc **admin** (mọi state) |

---

## Phase 1 — Tạo (create)

Hai đường sinh meeting, đều stamp `realtime_backend='do'` và `organizer_email` từ **JWT đã verify** (client không tự khai được).

### 1a. `POST /v1/meetings` — đường chính (form tạo = form edit)
`worker/src/index.ts:1646`.

- **Gate ai tạo:** chỉ nội bộ hoặc admin (`index.ts:1649`) — khách không bao giờ tạo. Nếu payload có `projectId` → phải qua `canManageProject` (admin · head · leader · co-operator), không phải mọi member (`index.ts:1685`); đóng audit H2 "tiêm card vào folder phòng khác".
- **Status lúc sinh:** chỉ được `scheduled` hoặc `live` (`index.ts:1700-1705`) — terminal state (`finished`/`cancelled`) chỉ tới được qua PATCH state machine, không bao giờ ở lúc tạo.
- **Owner stamp:** `organizer = JWT email` (`index.ts:1706`); `host_email` = `hostEmail` nếu là nội bộ, ngược lại fallback về organizer (`index.ts:1709-1712`).
- **D1 ghi** — `INSERT INTO meeting (... realtime_backend) VALUES (... 'do')` (`index.ts:1719-1727`). Các cột: `id(=roomId)`, `project_id`, `title`, `created_by`, `room_key`, `thumbnail`, `organizer_email`, `host_email`, `status`, `scheduled_at`, `duration_min`, `topic/description/type/discipline/priority/confidentiality`, `waiting_room`, `recording_enabled`.
- **ON CONFLICT = re-register** (`index.ts:1728-1746`): chỉ COALESCE lấp NULL, **không bao giờ ghi đè** — lifecycle/ownership trên row đã tồn tại chỉ di chuyển qua PATCH có guard. Chặn một POST trùng id viết đè meeting finished hoặc cướp `room_key`.
- Chặn hồi sinh: nếu `isDeletedMeeting` → `410` (`index.ts:1697`).

Schema cột lifecycle: `schema/0009_meeting_schedule.sql` (`organizer_email`, `host_email`, `duration_min`, `waiting_room` DEFAULT 1, `recording_enabled` DEFAULT 0); `schema/0027_realtime_backend.sql` (`realtime_backend` chọn transport **runtime, per-meeting** — không phải build-flag, tránh split-brain hai client khác build vào cùng phòng).

### 1b. Ad-hoc scene-upsert — side path (share dialog / lobby)
`worker/src/index.ts:844` (`PUT /v1/scenes/:roomId`) và client `registerMeeting(status:'live')` (`Collab.tsx:1105`).

- Phòng tạo từ share-dialog không có row registry trước; client gọi `registerMeeting` với `status='live'` (organizer stamp server-side) — **không còn meeting "vô chủ"**.
- Khi autosave scene đầu tiên, PUT scene **UPSERT** luôn `meeting` row để folder UI thấy (`index.ts:881-892`), set `realtime_backend='do'`. Nếu PUT mang `projectId` mà caller không reach được project → **strip** (không 403) để autosave vẫn thành công (audit H2, `index.ts:866-880`).
- Chặn hồi sinh: `isDeletedMeeting` → `410` (`index.ts:848`); finished + quá grace → `409` (`index.ts:852`).

---

## Phase 2 — Mời (invite) + Lịch (schedule)

### Mời — `meeting_invitee`
`POST /v1/meetings/:roomId/invitees` (`index.ts:2142`). Gate: **meeting-manager** mới mời (`isMeetingManager` — organizer/host/co-host/project-authority/admin, `index.ts:2150`), không phải bất kỳ ai chỉ thấy meeting.

- **Nội bộ vs khách** tự phân loại: `kind = isInternalEmail(ie) ? 'internal' : 'guest'` (`index.ts:2178`).
- D1 ghi `meeting_invitee{meeting_id, email(lower), kind, role:'cohost'|'attendee', status:'invited', invited_by, invited_at}` (`schema/0008_membership.sql:20`, `index.ts:2179-2186`). Email luôn lower-case để khớp JWT.
- Khách = **synthetic login**: email khách gõ tay biến thành `client` card cho **người mời** (re-pick sau, `index.ts:2194-2214`); tài khoản đăng nhập khách provision riêng qua `POST /v1/guests` (`index.ts:2282`) — host chia sẻ email + temp password + link thủ công (không gửi email tự động).
- `addToProject` chỉ nâng quyền **nội bộ** lên `project_member` — khách **không bao giờ** auto thành member (`index.ts:2217-2231`), bảo mật "by construction".
- Không mời vào meeting terminal: `finished`/`cancelled` → `409` (`index.ts:2169`).

### Lịch + state machine — `meeting.status`
State machine (`index.ts:377-381`, đối chiếu `components/mcm/meetingStatus.ts`):

```
 scheduled ──Start──> live ──End for all──> finished   (terminal, IMMUTABLE)
     └──cancel──> cancelled ──restore──> scheduled
```

PATCH `/v1/meetings/:roomId` (`index.ts:1831`) là cổng duy nhất chuyển status (status đã bỏ khỏi metadata editor). `normalizeStatus` gom mọi giá trị lịch sử (`Completed/done/in progress…`) về bộ canon (`index.ts:384`).

Các gate PATCH (role ≠ admin):
- `finished` = **IMMUTABLE**: mọi field → `409` (`index.ts:1917`).
- Sửa content (title/topic/schedule/host…) thuộc **organizer** (hoặc project-authority); `cancelled` phải restore trước (`index.ts:1920-1926`).
- Chuyển status là **đặc quyền nội bộ** (guest invitee qua roomGate nhưng **không** drive state machine, `index.ts:1932`).
- Transition hợp lệ kiểm cứng (`index.ts:1935-1942`): `null→*`, `scheduled→{live,cancelled}`, `live→finished`, `cancelled→scheduled`.
  - **Start (`→live`)**: chỉ **phòng sở hữu** (`isOwningDeptMember`) + organizer/host/co-host/authority — phòng khác không nhảy vô start (`index.ts:1943-1974`).
  - **End (`→finished`)**: chỉ host/co-host/organizer/project-lead — KHÔNG phải acting-host rule, không phải participant ngẫu nhiên (`index.ts:1976-1998`).
  - **cancel/restore**: chỉ organizer/authority (`index.ts:2000-2003`).
- Commit transition **có điều kiện** trên status cũ (`UPDATE ... WHERE status IS ?2`, `index.ts:2008`): hai transition đua nhau (Start vs Cancel) không cùng thắng — kẻ thua thấy 0 row đổi → `409`.

`scheduled_at`/`duration_min` cập nhật qua cùng PATCH (`index.ts:2033-2034`). Meeting hiện ở mục "Sắp tới" của người được mời qua `GET /v1/me/meetings` (`index.ts:3275`): union của (organizer/host) ∪ (invitee active) ∪ (project_member, trừ confidential). `color`/`icon` cố tình **exempt** khỏi guard finished (chỉ cosmetic, `index.ts:1876-1880`).

---

## Phase 3 — Vào họp (join)

Client gate ở `Collab.tsx startCollaboration` (`Collab.tsx:881`). Đọc `getMeetingChecked(roomId)` để biết status, rồi rẽ nhánh (`Collab.tsx:991-1087`):

- `scheduled`/`cancelled` → park vào `startGateAtom` → overlay **WaitingForStart** (nội bộ thấy nút Start = acting-host; khách poll tới khi live). KHÔNG connect (`Collab.tsx:1027-1035`).
- `finished` → khách bị chặn (review internal-only, `Collab.tsx:1037-1052`); nội bộ → `meetingViewOnlyAtom=true` + `markReviewRoom` (read-only mọi entry path).
- `live` + **khách** chưa admitted → `knockToMeeting` + park `waitingRoomAtom` → overlay **WaitingRoom** poll (`Collab.tsx:1062-1085`). Nội bộ auto-admit → connect thẳng.
- `forbidden` (revoked/never invited) → `kickedAtom=true`, clear room hash (`Collab.tsx:1013-1018`).

### Phòng chờ (knock-to-join) — `meeting_knock`
Schema `schema/0025_meeting_knock.sql`: `(room_id, email, name, status, created_at, last_seen)`, PK `(room_id,email)`, status `invited → admitted | denied`.

- `POST .../knock` (`index.ts:2864`): **chỉ khách** (internal được trả "do not knock", auto-admit `index.ts:2871-2876`); denied trong cooldown `REKNOCK_COOLDOWN_MS=30s` bị từ chối re-knock (`index.ts:2916-2932`).
- `GET .../knock` self-poll status (`index.ts:2950`); `GET .../knocks` host xem hàng chờ (`index.ts:2966`).
- `PATCH .../knock/:email` manager **admit/deny** (`index.ts:2985`): deny = **soft** (chỉ knock-only, không bao giờ thành meeting_invitee, re-knockable sau cooldown, schema comment `0025`).

### DO realtime handshake — gate server-side (4 lớp, NEVER 101 nếu rớt)
`handleRealtimeUpgrade` (`index.ts:5080`), comment `roomDO.ts:20`. Worker verify **TRƯỚC** `env.ROOM.get()` và **TRƯỚC** khi trả `101`:

1. **JWT** `verifyRealtimeJwt` (token qua WS subprotocol `mcm.v1, <jwt>`, không phải query param) → rớt `401` (`index.ts:5097`).
2. **canSeeMeeting** — cùng authz như REST: admin ∪ organizer/host ∪ invitee active ∪ project member(owner/manager) ∪ authority(leader/head); confidential = invitee-only (`index.ts:411-477`, gate `5112`). Ad-hoc không có row → mở (`index.ts:456`).
3. **isFinishedLocked** → `409` (reviewer không relay bytes vào phòng đóng băng, `index.ts:5130`).
4. **Knock** — khách phải có `meeting_knock.status='admitted'`, ngược lại `403`; `revoked` được phân biệt = kick trong audit (`index.ts:5140-5154`).
5. **WS-count cap** `ROOM_WS_CAP` (default 500) chống spam-open WS (`index.ts:5157-5174`).

Roomkey (`#room`) **không bao giờ** lên server — DO chỉ relay bytes đã mã hoá.

### `meeting_participant` — ai thực sự vào
`POST .../participant` (`index.ts:2102`): UPSERT `meeting_participant{meeting_id, user_email, name, joined_at, last_seen_at}` (`schema/0006_participants.sql`). Review meeting finished **không** ghi participant (không phải "attended") → `isFinishedLocked` → skip 200 (`index.ts:2114`).

### Daily token cho media (screen-share + audio)
`GET /v1/daily/token` (`index.ts:3582`). Strip `-audio` suffix về base meeting id để gate (`index.ts:3598`); **canSeeMeeting** (`3603`) + **isFinishedLocked** → 409 (no media trong finished, `3610`) + **knock admitted** cho khách (`3617-3628`). `DAILY_API_KEY` ở server, client chỉ nhận `{url, token}` (token 4h, screen+audio). Ensure Daily room theo roomId (`3640-3674`).

---

## Phase 4 — Đang họp (live)

Trong khi mọi người làm việc, **R2 nhận bytes E2E** (mã hoá bằng room key trước khi rời browser), **D1 chỉ giữ metadata** (`scene_updated_at`, `participant_count`, `last_seen_at`). Realtime edits (cursor, element delta) chạy qua **RoomDO relay** — server relay byte mã hoá, không giải mã được.

R2 key helpers (`index.ts:304-308`):

| Loại | R2 key | Route PUT/GET | Nội dung |
| --- | --- | --- | --- |
| Canvas | `scenes/<roomId>/current` | `index.ts:844` / `897` | scene E2E (snapshot tự lưu) |
| File | `files/<roomId>/<fileId>` | `index.ts:1021` | image/pdf/dxf/ifc/glb E2E; index ở D1 `file` (`schema/0001:44`) |
| Chat | `chats/<roomId>/current` | `index.ts:928` | chat log E2E (reopen/review) |
| Library | `library/<roomId>/current` | `index.ts:992` | manifest DXF/IFC/PDF source E2E |
| Transcript | `transcripts/<roomId>/current` | `index.ts:951` | STT transcript E2E (≠ `ai_summary` là plaintext D1) |

Mọi route blob qua **roomGate** (`index.ts:826-832`): `canSeeMeeting` + finished-review-internal-only cho khách. Mọi PUT có check `isFinishedLocked` → 409 (`index.ts:852,921,944,985,1014`).

---

## Phase 5 — Kết thúc (finished)

Host **End-for-all** — `MeetingHeader.tsx:375`. Thứ tự **bắt buộc**:

1. **`status='finished'` ghi TRƯỚC** (`updateMeeting(roomId, {status:'finished'})`, `MeetingHeader.tsx:384`) — để reopen = read-only review ngay cả khi broadcast lỗi. Ghi fail → abort, không side-effect.
2. Kick AI recap nền (non-blocking, `MeetingHeader.tsx:390`).
3. `clearLastMeeting()` (`MeetingHeader.tsx:396`) — finished không bao giờ offer "Resume".
4. **Broadcast `HOST_COMMAND{action:'END_MEETING'}`** (`MeetingHeader.tsx:398`).
5. Tự `markReviewRoom` + `setViewOnly(true)` (`MeetingHeader.tsx:400-401`).

Phía nhận (`Collab.tsx:1503` `HOST_COMMAND`): broadcast chỉ là **HINT** — registry là authority. Verify `status===finished` (retry ~5 lần × 1s vì D1 read-replica eventual consistency) rồi mới flip `meetingViewOnlyAtom=true` + `markReviewRoom` (`Collab.tsx:1520-1550`). Broadcast giả verify ra not-finished → không làm gì.

**Finished = IMMUTABLE** (review/extract-only, no edit), gác nhiều lớp:
- PATCH mọi field → `409` (`index.ts:1917`).
- `isFinishedLocked` (`index.ts:365`, có `FINISHED_WRITE_GRACE_MS=10min` cho peer còn trong phòng) chặn **blob PUT** scene/chat/library/transcript/files → `409`.
- DO upgrade finished → `409` (`index.ts:5130`); Daily token finished → `409` (`index.ts:3610`); participant finished → skip (`index.ts:2114`).
- `viewOnly` client chặn mọi mutate handler trong Collab (`Collab.tsx:639,2099,2156,2250…`).

**Revoke = kick (≠ delete):** `DELETE .../invitees/:email` (`index.ts:2243`) UPDATE `meeting_invitee.status='revoked'` (soft, giữ row audit). Revoke guest cấp project cascade vào invitee để `canSeeMeeting` deny **request kế tiếp**, không đợi JWT hết hạn (audit H3, `index.ts:2666-2683`). Lần WS upgrade kế tiếp → `403` reason `revoked` = văng khỏi phòng (`index.ts:5147`).

**AI recap:** `generateAiSummary` gọi `/summarize` (transcript + chat) → `POST .../summary` lưu `meeting.ai_summary` (TEXT) + `ai_summary_at` (`schema/0015_p0_parity.sql:21`, route `index.ts:2070`). Đây là plaintext **server-readable, query được** cho hỏi-xuyên-meeting — KHÁC transcript E2E. Route tách khỏi PATCH vì meeting đã immutable lúc summary land.

---

## Phase 6 — Xoá (delete)

Hai cổng: organizer `DELETE /v1/meetings/:roomId` — **chỉ khi `cancelled`** (đường disposal duy nhất: cancel trước, rồi xoá; finished bất tử, `index.ts:2795,2807-2816`); admin `DELETE /v1/admin/meetings/:roomId` — mọi state (`index.ts:4165`). Cả hai gọi `deleteMeetingCascade` (`index.ts:4095`).

**D1 — hard-delete các row meeting-scope** (`index.ts:4134-4150`):
`file` · `meeting_invitee` · `meeting_participant` · `meeting_knock` · `note (scope='meeting')` · `meeting`.

**Tombstone chống hồi sinh:** `INSERT OR REPLACE INTO deleted_meeting (id, deleted_by, deleted_at)` (`index.ts:4156`, schema `0015_p0_parity.sql:15`). Route scene-PUT/POST check `isDeletedMeeting` → `410` (`index.ts:848,1697`) — client còn giữ phòng mở không tái tạo registry được.

**R2 — SOFT-delete (KHÔNG hard-delete, khôi phục được):** R2 không có versioning kiểu S3, hard-delete là vĩnh viễn. Thay vào đó **COPY mỗi blob sang `trash/<deletedAt>/<key>`** (kèm `customMetadata.trashedFrom/trashedAt`) rồi delete bản gốc (`index.ts:4106-4133`). Quét 5 prefix: `scenes/<room>`, `files/<room>`, `chats/<room>`, `library/<room>`, `transcripts/<room>`. Đặt lifecycle rule trên prefix `trash/` để expire sau N ngày (cost control). Aligned với quy tắc dự án "revoke ≠ delete, đừng hard-delete, giữ history/moat".

**Daily rooms:** xoá best-effort cả hai (`<id>` screen-share + `<id>-audio` audio) để dọn billing (`index.ts:4151-4153`, `deleteDailyRoom` swallow lỗi).

---

## Ghi chú data-retention (moat)

- **Finished giữ vĩnh viễn = moat AI.** Meeting xong là **immutable review**, không bao giờ tự xoá; `ai_summary` (D1 plaintext) là nền hỏi-xuyên-meeting. Muốn xoá phải `cancel` trước (mà finished không cancel được) — tức finished thực tế **không có đường xoá** ngoài admin.
- **Trash 30 ngày (cấu hình):** xoá meeting = blob sang `trash/<ts>/` recoverable; lifecycle rule trên prefix `trash/` mới là thứ expire thật. Không có byte nào biến mất ngay.
- **Revoke ≠ delete:** thu hồi invite/guest = soft (`status='revoked'`, giữ row + full history/attribution), chặn truy cập tương lai (kick), **không** lấy lại dữ liệu họ đã tải. Phù hợp [[mcm-guest-data-lifecycle]].
