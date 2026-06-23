# Meeting Event Log — dòng thời gian thống nhất, server-đọc-được cho AI suy luận

**Trạng thái:** SPEC (2026-06-23) · **chưa build** · xếp sau Meeting Package + AI strategy Phase 0. KHÔNG có code trong doc này.

> Mục tiêu gốc của anh Luân: một con AI sau này phải hiểu **"trong cuộc họp đã xảy ra GÌ và VÌ SAO kết quả lại như thế."** Hôm nay dữ liệu cuộc họp nằm rải rác (snapshot canvas mã hoá, chat/transcript blob mã hoá không có index, presence chỉ là số tổng) → **không có một dòng thời gian thống nhất** để model đọc và suy ra nhân-quả. Doc này thiết kế **một bảng sự kiện cuộc họp** (`meeting_event`) làm "nguồn sự thật theo thời gian", server-đọc-được, theo đúng pattern client-giải-mã-rồi-upload của [[meeting-package]] và đúng chiến lược retrieval-grounded của [[ai-project-knowledge-strategy]].

Liên quan: `docs/plans/ai-project-knowledge-strategy.md` · `docs/plans/meeting-package.md` · `docs/specs/chairman-account.md` · `docs/plans/dev-phase-notes.md` · `docs/specs/meeting-lifecycle.md`.

---

## 0. TL;DR cho anh Luân (1 phút)

- **Vấn đề:** AI hiện chỉ thấy `meeting.ai_summary` (D1, server-đọc-được) + lúc summarize thì đọc transcript+chat. Nó **không thấy chuỗi sự kiện**: ai vào/ra lúc nào, canvas tiến hoá ra sao, file nào được đưa vào lúc nào, host bấm record/end lúc nào, screenshare bật khi nào. Vì vậy nó tóm tắt được "kết quả" nhưng **mỏng về "vì sao"** (bước ngoặt, ai chốt, quyết định nào lật quyết định cũ).
- **Giải pháp:** một bảng D1 **`meeting_event`** = mọi sự kiện đáng kể của 1 cuộc họp, mỗi dòng `{ts, actor_email, kind, payload_json, r2_ref?}`. Server-đọc-được. Nội dung E2E (transcript/chat) đi vào đây đúng cách Package làm: **client giải mã bằng room_key rồi POST plaintext**.
- **Canvas:** KHÔNG lưu operation-log đầy đủ (đắt + E2E + nhiễu). Lưu **checkpoint có caption** — vài ảnh chụp mốc + 1 câu mô tả "đã thêm/đổi gì". Đủ cho "canvas tiến hoá thế nào", rẻ hơn nhiều.
- **MVP:** lúc End-for-all, gộp chat+transcript đang-có-sẵn thành các dòng `meeting_event` server-đọc-được (consolidate-on-end). Sau đó mới thêm canvas checkpoint, presence, sự kiện host.
- **Đánh đổi phải nói thẳng:** bảng này làm **nội dung cuộc họp trở nên server-đọc-được** — y như Package và Chairman đã vượt E2E. Đây là **quyết định chính sách**, gắn vào mô hình giám sát Chairman/Owner (`docs/specs/chairman-account.md` §4).

---

## 1. Hiện trạng (đã đọc code — verify + cite)

Mọi tín hiệu giàu của cuộc họp hôm nay đều **không phải một dòng thời gian server-đọc-được**:

| Tín hiệu | Lưu ở đâu | Server đọc được? | Có index/timeline? |
|---|---|---|---|
| **Canvas** | R2 `scenes/<roomId>/current`, ghi đè (`worker/src/index.ts:451`, PUT `:1289-1290`) | KHÔNG — E2E room-key | KHÔNG — chỉ **snapshot cuối**, không op-log |
| **Chat** | R2 `chats/<roomId>/current`, ghi đè (`worker/src/index.ts:453`, PUT `:1358`) | KHÔNG — E2E room-key | KHÔNG — append-only blob, không D1 index |
| **Transcript** | R2 `transcripts/<roomId>/current`, ghi đè (`worker/src/index.ts:455`, PUT `:1381`) | KHÔNG — E2E room-key | KHÔNG — append-only blob, không D1 index |
| **Presence** | D1 `meeting_participant(joined_at, last_seen_at)` — 1 dòng/(meeting,user) (`worker/schema/0006_participants.sql:4-11`) | CÓ | **Chỉ tổng hợp** — first-join + last-seen, KHÔNG có từng lần join/leave |
| **AI summary** | D1 `meeting.ai_summary` (plaintext, ghi 1 lần lúc End-for-all, `worker/src/index.ts:2530-2557`) | CÓ | KHÔNG — 1 text bất biến, không có timeline bên dưới |

Xác nhận các điểm đề bài nêu:
1. **Canvas chỉ là snapshot cuối, E2E, không op-log** — đúng. PUT ghi đè nguyên blob (`index.ts:1289-1290`); GET trả nguyên blob (`:1329`). Không có bảng nào lưu từng thao tác.
2. **Chat + transcript là log append-only nhưng là blob R2 E2E, KHÔNG có D1 index** — đúng. Comment ngay trong code: transcript *"E2E-encrypted with the room key exactly like the chat log (server relays bytes, never reads them)"* và *"The QUERYABLE artifact is the AI summary (D1 meeting.ai_summary)"* (`index.ts:1362-1367`). Tức artifact truy vấn được DUY NHẤT là summary; bản thân chat/transcript server không đọc.
3. **Presence chỉ tổng hợp** — đúng. `meeting_participant` là *"one row per (meeting, user); joined_at = first join, last_seen_at = most recent"* (`0006_participants.sql:1-11`). Không lưu chuỗi join/leave.
4. **Không có bảng timeline thống nhất** — đúng. Lướt toàn bộ `worker/schema/*.sql`: có `audit_log` (chỉ admin mutation, `0005`), `usage_events` (chỉ billing AI/STT, `0028`), `meeting_participant` (`0006`) — **không bảng nào** là dòng thời gian nội dung cuộc họp.

**Ràng buộc E2E (then chốt):** nội dung thô mã hoá bằng `room_key`; server **không cầm** key trong luồng thường. Nhưng `room_key` hiện **managed trong D1** (xem `chairman-account.md` §4 điểm 2) — nên "E2E hiện là ranh giới **chính sách**, chưa phải mật mã thuần". [[meeting-package]] đã lách bằng cách **client giải mã rồi upload PLAINTEXT** (`0032_meeting_package.sql:6-13`: *"the chosen files are decrypted client-side and re-uploaded as plaintext"*). **Event log phải tôn trọng / lách E2E theo đúng cách đó** — không tự ý cho server giải mã ngầm.

**Chiến lược AI đã chốt:** retrieval-grounded, **KHÔNG fine-tune** (`ai-project-knowledge-strategy.md` §"1 model của admin"). Summary D1 là "nguyên tử" hiện tại; doc đó nói thẳng *"chất lượng bộ nhớ bị chặn bởi chất lượng summary"* (§Căng thẳng cốt lõi). Event log **chính là tầng dưới summary** — cho AI nguyên liệu giàu hơn 1 đoạn text.

---

## 2. Mục tiêu & KHÔNG-mục-tiêu

### 2.1 "Hiểu vì sao kết quả như thế" cần gì
Để model trả lời "đã xảy ra gì + vì sao", nó cần **dòng thời gian có cấu trúc** gồm:
- **Quyết định** (cái gì được chốt, lúc nào, ai chốt) + **quyết định bị lật** (cuộc này/đoạn này lật cái trước — tín hiệu nhân-quả giàu nhất, đúng `decisionsReversed` của `chairman-account.md` §3.3).
- **Action item** (việc + chủ trì + trạng thái) — thứ user thật sự muốn dạng danh sách.
- **Ai-nói-gì** (transcript segment + chat) có speaker, có timestamp → attribution (đã khả thi: *"mỗi tab transcribe chính mình → attribution chính xác"*, architecture §2.6 dẫn trong `chairman-account.md` §3.3).
- **Mốc tiến hoá canvas** (checkpoint có caption: "đã chốt layout mặt bằng", "vẽ thêm trục lưới") — KHÔNG phải từng nét.
- **Tham chiếu file then chốt** (DXF/IFC/PDF nào được đưa vào, lúc nào, ai đưa) → AI nối quyết định với bản vẽ.
- **Bước ngoặt** (turning point) suy ra từ chuỗi trên — đoạn nào chuyển hướng cuộc họp.

### 2.2 KHÔNG làm (tránh ôm đồm + tránh đốt tiền/đụng E2E vô ích)
- **KHÔNG** ghi từng mouse-move / từng pointer update / từng thao tác canvas thô. Đó là nhiễu, đắt, và phá ngân sách R2/D1 cho 0 giá trị reasoning.
- **KHÔNG** thay/đụng blob E2E gốc (`scenes|chats|transcripts/.../current`). Event log là **bản dẫn xuất riêng**, đúng tinh thần Package: *"KHÔNG đụng E2E của raw meeting"* (`meeting-package.md:12`).
- **KHÔNG** dựng vector DB / RAG / embeddings ở đây. Theo AI strategy: nối thẳng vào prompt là đủ tới ~50 cuộc; Vectorize là Phase 2 và **vượt lằn ranh E2E — báo trước**.
- **KHÔNG** làm real-time analytics live. Event log là để **đọc lại + AI suy luận**, không phải dashboard live.
- **KHÔNG** thay thế `ai_summary`, `meeting_participant`, hay Package — event log **bổ sung tầng dưới** cho chúng.

---

## 3. Taxonomy sự kiện (cái gì ghi, granularity nào)

Một `kind` enum gọn, mở rộng dần. Mỗi sự kiện có `actor_email` (ai gây ra, NULL nếu hệ thống), `ts`, `payload_json`, tuỳ chọn `r2_ref`.

| `kind` | Khi nào | `payload_json` (gợi ý) | Nguồn | E2E? | Phase |
|---|---|---|---|---|---|
| `transcript.segment` | 1 đoạn STT hoàn chỉnh | `{speaker, text, lang, segIdx}` | client (đã giải mã) | có (plaintext-hoá) | P1 |
| `chat.message` | 1 tin chat | `{text, lang}` | client (đã giải mã) | có | P1 |
| `canvas.checkpoint` | mốc canvas (xem §4) | `{caption, elementCount, addedKinds[], thumbR2}` | client | một phần | P2 |
| `file.added` | thêm DXF/IFC/PDF/img vào họp | `{fileId, kind, name, size}` | server-derived (từ `file` row) | KHÔNG | P2 |
| `presence.join` / `presence.leave` | join/leave thật | `{name}` | server (RoomDO/route) | KHÔNG | P2 |
| `host.start` / `host.end` | Start / End-for-all | `{by}` | server (lifecycle) | KHÔNG | P2 |
| `host.record_start` / `host.record_stop` | bật/tắt record | `{by}` | server | KHÔNG | P3 |
| `screenshare.start` / `screenshare.stop` | present bật/tắt (Daily) | `{by}` | server/client | KHÔNG | P3 |
| `ai.summary_generated` | summary ghi xong | `{summaryLen, model}` | server | KHÔNG (derived) | P2 |
| `decision` / `action_item` | (tuỳ chọn) trích từ summary | `{text, owner?, status?, evidenceSegIdx[]}` | AI-derived (Phase 1.5) | KHÔNG | P3 |

**Granularity nguyên tắc:** ghi cái **thay đổi trạng thái hoặc nội dung có ý nghĩa**, không ghi cái liên tục. Transcript segment + chat message vốn đã rời rạc → ghi từng cái. Canvas/presence → ghi **mốc + chuyển trạng thái**, không ghi liên tục.

### 3.1 Canvas: checkpoint-có-caption vs op-log đầy đủ — chọn checkpoint
**Op-log đầy đủ (mọi `addElement/update/delete`):**
- (+) tái dựng từng bước, "phim tua lại" hoàn hảo.
- (−) **Đụng E2E nặng nhất:** mỗi op chứa nội dung canvas → muốn server-đọc-được phải giải mã + plaintext-hoá MỌI op (hàng nghìn/cuộc). Khối lượng D1 lớn.
- (−) **Nhiễu cho reasoning:** model không cần biết user kéo hình chữ nhật 3px sang phải. Nó cần "đã chốt layout X".
- (−) Excalidraw đã có version trên element nhưng **không phát op-log bền** ra ngoài (collab broadcast là ephemeral; bền chỉ có snapshot — đúng hiện trạng §1). Dựng op-log = hạ tầng mới đáng kể.

**Checkpoint-có-caption (KHUYẾN NGHỊ):**
- 1 checkpoint = `{ts, caption, thumbR2, elementCount, addedKinds}`. Sinh ra ở **mốc tự nhiên**: lúc End-for-all (bắt buộc 1 cái cuối), khi 1 file lớn (IFC/DXF) được anchor lên canvas, hoặc throttle thưa (vd mỗi N phút nếu canvas đổi đáng kể), hoặc khi host bấm "đánh dấu mốc".
- `caption` có thể (a) do người gõ, hoặc (b) AI sinh 1 câu từ diff text-elements giữa 2 checkpoint (rẻ, Haiku).
- `thumbR2` = ảnh PNG render client-side (đã có pipeline thumbnail trong app) → **server-đọc-được ảnh**, không phải scene mã hoá. Cho phép Chairman/AI "thấy" canvas mà không cần giải mã scene blob.
- (+) Rẻ: vài chục checkpoint/cuộc thay vì vài nghìn op. (+) Đúng tầm reasoning: "canvas tiến hoá qua các mốc này". (+) Ít đụng E2E: chỉ text-elements + thumbnail vào event, không phải toàn scene.

→ **Chốt đề xuất: checkpoint-có-caption.** Op-log đầy đủ chỉ cân nhắc nếu sau này có nhu cầu "tua lại từng bước" thật sự (defer, gần như chắc không cần cho mục tiêu reasoning).

---

## 4. Nơi ở: schema D1 + nội dung E2E vào thế nào

### 4.1 Bảng `meeting_event` (migration cộng dồn, next ~0033+)
```sql
-- Dòng thời gian thống nhất, SERVER-ĐỌC-ĐƯỢC của 1 cuộc họp. Mỗi dòng = 1 sự
-- kiện đáng kể. Nội dung E2E (transcript/chat/canvas text) đi vào đây dạng
-- PLAINTEXT do client giải mã rồi POST — đúng pattern meeting_package (0032).
-- Đây là bản DẪN XUẤT; blob E2E gốc (scenes|chats|transcripts/.../current) GIỮ NGUYÊN.
CREATE TABLE IF NOT EXISTS meeting_event (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL,              -- REFERENCES meeting(id)
  project_id   TEXT,                        -- denormalised lúc ghi → filter tường phòng ban
  ts           INTEGER NOT NULL,            -- thời điểm sự kiện (ms epoch) — nguồn sự thật timeline
  seq          INTEGER,                     -- thứ tự ổn định khi cùng ts (segIdx / counter)
  actor_email  TEXT,                        -- ai gây ra (NULL = hệ thống)
  kind         TEXT NOT NULL,               -- taxonomy §3
  payload_json TEXT,                        -- JSON nhỏ; nội dung text plaintext nằm đây
  r2_ref       TEXT,                        -- tuỳ chọn: thumbnail/blob lớn (vd canvas thumb PNG)
  source       TEXT,                        -- 'client' | 'server' (provenance + tin cậy)
  created_at   INTEGER NOT NULL             -- thời điểm insert (≠ ts khi consolidate-on-end)
);
CREATE INDEX IF NOT EXISTS ix_event_meeting_ts ON meeting_event(meeting_id, ts, seq);
CREATE INDEX IF NOT EXISTS ix_event_project    ON meeting_event(project_id, ts);
CREATE INDEX IF NOT EXISTS ix_event_kind       ON meeting_event(meeting_id, kind);
```

Ghi chú thiết kế (bám pattern hiện có):
- **Shape copy từ `audit_log`/`usage_events`** (`{id, actor, kind, meta-json, ts}`) — đúng gợi ý của `ai-project-knowledge-strategy.md` addendum (bảng `ai_signal` "copy shape audit_log").
- **`project_id` denormalised** — thừa kế **tường phòng ban** y như `meeting_package.project_id` (`0032:19`) và `chairman_insight.project_id` (`chairman-account.md` §3.5). Filter ở query-side, KHÔNG tin client gửi (risk #2 của AI strategy).
- **`payload_json` nhỏ**, blob lớn (thumbnail) đẩy ra R2 qua `r2_ref` (vd `events/<meetingId>/<eventId>.png`) — **server-readable**, không room-key, đúng layout `packages/<id>/…` của Package.
- **`source`** phân biệt client-decrypted vs server-derived → audit + tin cậy.

### 4.2 Nội dung E2E vào bằng cách nào — client giải mã rồi POST (như Package)
Server **không** giải mã trong luồng thường. Client (đang giữ `room_key` từ `#room=<id>,<key>`) là nơi DUY NHẤT đọc được transcript/chat/canvas. Vì vậy:
- Các `kind` E2E (`transcript.segment`, `chat.message`, `canvas.checkpoint` text) **chỉ client gửi** được, dạng plaintext, qua route `POST /v1/meetings/:roomId/events`.
- Đây **chính xác** là cơ chế Package: *"decrypted client-side and re-uploaded as plaintext"* (`0032:6-8`). Không phát minh đường mới.
- Các `kind` non-E2E (`file.added`, `presence.*`, `host.*`, `screenshare.*`, `ai.summary_generated`) **server tự ghi được** vì metadata vốn server-readable (`file` row, lifecycle route, `meeting_participant`).

### 4.3 Đánh đổi riêng tư — phải nói thẳng
Ghi nội dung cuộc họp dạng plaintext vào D1 nghĩa là **nội dung họp trở nên server-đọc-được** (khác blob E2E hiện tại). Đây **không** phải lỗ hổng kỹ thuật, mà là **quyết định chính sách có chủ đích**, đúng cùng đánh đổi mà Package và Chairman đã chọn:
- Gắn vào **mô hình giám sát Chairman/Owner** (`docs/specs/chairman-account.md` §4): nội dung họp *có thể* được lãnh đạo/AI đọc lại; tổ chức phải **công bố chính sách** (consent/onboarding), nhất là khi "đi đa quốc gia — Phi" (chairman-account §4.3).
- **Tôn trọng cờ `confidential`** của meeting (`meeting.confidentiality`, `0015_p0_parity`): event log của cuộc `confidential` phải kế thừa cùng gate `canSeeMeeting` (`index.ts:411-477`) — chỉ owner/invitee/admin/chairman đọc. **Lưu ý:** Chairman có quyền tối thượng vượt cả `confidential` (chairman-account §4.5 CHỐT 06-17) → event log cũng nằm trong tầm Chairman, **có chủ đích**.
- **Retention:** nội dung plaintext nhạy hơn blob E2E. Đề xuất gắn TTL/retention theo `docs/specs/d1-retention.md` — đặc biệt với event hành vi. Đừng để timeline plaintext tích luỹ vô thời hạn không kiểm soát.
- **`revoke ≠ delete`** (theo guest-data-lifecycle): khi cần thu hồi, ưu tiên đánh dấu trạng thái giữ provenance cho AI knowledge graph, không hard-delete — trừ khi retention policy yêu cầu purge.

---

## 5. Cách GHI: client-emit vs server-derived, batching, finalize

### 5.1 Hai nguồn ghi
- **Server-derived (ưu tiên, rẻ, đáng tin):** mọi sự kiện metadata server vốn đã thấy → ghi tại chính chỗ code đã chạy:
  - `file.added` — chỗ tạo `file` row (per-meeting material).
  - `presence.join/leave` — tại `POST /v1/meetings/:roomId/participant` (`index.ts:2562`) + RoomDO teardown.
  - `host.start/end` — tại lifecycle transition (`docs/specs/meeting-lifecycle.md`, status `scheduled→live→finished`, `index.ts:661-663`).
  - `ai.summary_generated` — ngay sau `POST /v1/meetings/:roomId/summary` (`index.ts:2530`).
- **Client-emit (bắt buộc cho E2E):** `transcript.segment`, `chat.message`, `canvas.checkpoint` — client giải mã rồi gửi. KHÔNG có đường nào khác vì server không cầm key.

### 5.2 Batching
- Client KHÔNG gửi từng segment 1 request (đốt request + đua với throttle save hiện có: scene 20s, transcript 5s, chat 800ms — architecture §2.2). Thay vào đó **gom theo lô**: `POST /v1/meetings/:roomId/events` nhận **mảng** events, gửi định kỳ (vd mỗi 10–15s, hoặc piggyback lúc transcript/chat blob flush).
- **Idempotent:** mỗi event mang id ổn định (vd `meetingId:kind:segIdx`) → retry/replay không nhân đôi (upsert theo PK).

### 5.3 Live-append vs consolidate-on-end — và lựa chọn theo phase
- **Consolidate-on-end (MVP — ÍT RỦI RO NHẤT):** lúc End-for-all, client đang giữ key + toàn bộ transcript/chat blob đã flush. Một lần, client **đọc blob đã có, parse thành events, POST cả lô**. Lợi: 0 thay đổi luồng live; tái dùng đúng blob đã tồn tại; chạy 1 lần. **Đây là MVP** — đúng tinh thần Package (curate sau khi finished).
- **Live-append (sau):** emit event ngay khi xảy ra → cho phép Chairman/AI đọc cuộc **đang diễn ra** gần real-time. Đắt hơn (request liên tục), đụng luồng live. Defer tới khi có nhu cầu "AI theo dõi cuộc đang họp".
- **Reconcile bằng Cron (bền hoá):** theo risk #5 của AI strategy (*"Cron reconcile chạy lại cuộc nào thiếu"*) — cuộc nào `finished` mà chưa có event row thì có job dò + nhắc/tự lành. Vì consolidate-on-end là client-driven (client có thể đóng tab trước khi gửi), cần fallback: ít nhất các event **server-derived** (presence/host/file/summary) luôn có; chỉ phần E2E (transcript/chat) phụ thuộc client.

### 5.4 Finished = bất biến
Cuộc `finished` là read-only (`isFinishedLocked`, `index.ts:649-659`; các PUT scene/chat/transcript đều 409 sau grace window). Event log **append một lần lúc consolidate** rồi khoá — không cho sửa event của cuộc đã finished (trừ đường admin/chairman regenerate có chủ đích, đúng risk #4 AI strategy "admin-only regenerate dù gốc khoá").

---

## 6. Cách TIÊU THỤ cho AI suy luận

### 6.1 Nâng cấp summary hiện tại
`/summarize` hôm nay chỉ nhận `{segments[], chat[], canvasText[]}` (`worker/src/ai.ts:11`, `SUMMARY_SYSTEM_PROMPT` `ai.ts:309-330`) — tức **chỉ transcript + chat + text canvas**, KHÔNG thấy presence/host/file/checkpoint/turning-point. Event log cho phép summary đọc **cả timeline**: "file IFC được đưa vào ngay trước khi chốt quyết định X" là tín hiệu nhân-quả mà transcript thuần không nói. → Summary chất lượng cao hơn = **nguyên tử KB tốt hơn** (đúng "chất lượng summary là TRẦN", AI strategy risk #1).

### 6.2 Retrieval-grounded querying (KHÔNG fine-tune)
- **Trong 1 cuộc:** "vì sao chốt phương án A?" → server lấy các `meeting_event` của cuộc đó (decision/transcript quanh mốc đó/file liên quan), nối vào prompt Claude/Gemini, trả lời **kèm trích dẫn event** (`ts` + `kind` + `actor`). Đúng pattern grounding bắt-buộc-evidence của Chairman (`chairman-account.md` §3.3).
- **Xuyên chuỗi họp / dự án:** event log gắn `project_id` → retrieval xuyên cuộc cùng dự án (decision-reversed: quyết định cuộc N lật cuộc N-k). Nối thẳng vào prompt; **không vector DB** tới khi kho quá lớn (AI strategy Phase 1: "30 tóm tắt × 1k token thừa sức").
- **Chairman reasoning:** `POST /v1/chairman/meetings/:id/reason` (chairman-account §3.2) hiện gather transcript/chat/canvas/summary; thêm `meeting_event` vào context → per-person behavioral + turning-point có **evidence trỏ thẳng vào event** (click → nhảy tới segment). Event log là **nguồn evidence sạch** cho mode đó.
- **Bức tường phòng ban:** mọi query filter `project_id` server-side từ session đã verify (risk #2). Chairman/admin xuyên-dự-án = code path riêng, audit (`chairman_audit`).

### 6.3 Quan hệ với rolling brief + ai_signal
- Event log nuôi **rolling brief** (AI strategy §asset 2): brief-merge có thể đọc decision/action events thay vì chỉ summary prose → action-item có cấu trúc (chủ trì/trạng thái) chính xác hơn.
- `decision_reversed`, `action-item lifecycle` (AI strategy addendum, 4 luồng tín hiệu) **tự nhiên rơi ra** từ event log → đỡ phải log riêng.

---

## 7. Migration / rollout theo phase

- **P1 — MVP (consolidate chat+transcript on-end).** Bảng `meeting_event` + route `POST /v1/meetings/:roomId/events` (gate `canSeeMeeting`, gom lô, idempotent). Client lúc End-for-all parse blob chat+transcript đã-có thành `transcript.segment` + `chat.message` plaintext rồi POST. **Giá trị ngay:** lần đầu có dòng thời gian server-đọc-được của ai-nói-gì. Rủi ro thấp (chỉ đọc cái đã có, chạy 1 lần khi finished).
- **P1.5 — server-derived events.** Ghi `file.added`, `presence.join/leave`, `host.start/end`, `ai.summary_generated` tại chính chỗ code đã chạy. Rẻ, không đụng E2E, không phụ thuộc client. Thêm Cron reconcile.
- **P2 — canvas checkpoints.** Client emit `canvas.checkpoint` (caption + thumbnail R2) tại mốc tự nhiên + lúc End-for-all. Caption AI-sinh (Haiku) tuỳ chọn.
- **P2.5 — nâng `/summarize` đọc event log** → summary giàu hơn. Nâng Chairman reasoning đọc event log làm evidence.
- **P3 — sự kiện giàu + decision/action trích.** `screenshare.*`, `record.*`, `decision`/`action_item` AI-derived. Live-append (nếu cần AI theo cuộc đang họp).
- **P4 (chỉ khi cần) — Vectorize.** Khi kho quá lớn. **Vượt lằn ranh E2E — báo anh Luân trước** (AI strategy Phase 2).

---

## 8. Open questions cho anh Luân quyết

1. **Plaintext nội dung vào D1 — chốt chính sách E2E.** Event log làm transcript/chat server-đọc-được (như Package, như Chairman). Anh đồng ý đây là đánh đổi đã chọn (E2E = ranh giới chính sách, không phải mật mã thuần)? Có cần consent banner/ToS nội bộ TRƯỚC khi bật (đa quốc gia — Phi)? → §4.3.
2. **Granularity transcript.** Ghi **từng segment** (giàu, nhiều dòng/cuộc) hay **gộp theo người-theo-lượt** (gọn hơn, dễ đọc, mất chút độ phân giải)? Đề xuất: từng segment ở P1, gộp khi render.
3. **Canvas — checkpoint đủ chưa?** Đề xuất checkpoint-có-caption (không op-log). Anh có viễn cảnh nào cần "tua lại từng bước" canvas không? Nếu không → khoá hướng checkpoint cho gọn/rẻ.
4. **Retention nội dung plaintext.** TTL bao lâu cho event log (nhất là content + behavioral)? Gắn vào `d1-retention.md`. `revoke ≠ delete` hay có lúc phải hard-purge theo luật?
5. **Live-append có cần không?** MVP là consolidate-on-end. Anh có cần Chairman/AI đọc cuộc **đang diễn ra** không? Nếu không gấp → defer, tiết kiệm nhiều.
6. **Caption checkpoint:** người gõ tay hay AI tự sinh (thêm chi phí Haiku + 1 call/checkpoint)? Đề xuất AI-sinh, người sửa được.
7. **Quan hệ với Package + Chairman:** event log và Package cùng tạo "bản plaintext dẫn xuất". Có nên Package **đọc lại event log** (thay vì re-parse blob) cho recap? Đề xuất: có, ở P2 — 1 nguồn sự thật timeline.
