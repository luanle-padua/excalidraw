# Scope/Plan — Per-source / per-speaker audio recording (#23)

> Status: **PROPOSED — chờ anh Luân chốt hướng (xem "Quyết định cần anh chốt")**. Ngày: 2026-06-24.
> Nguồn: feedback của anh — (A) thu kênh **mic tách riêng** khỏi **screen-share audio**; (B) **mic mỗi user = 1 file riêng** → lợi cho xử lý sau (STT/diarization/dịch/summary).

## 1. Hiện trạng (đã map từ code)
- **Chỉ HOST ghi.** Người tham gia khác KHÔNG chạy MediaRecorder — chỉ thấy đèn REC broadcast qua collab. (`CloudRecordingControls.tsx`, `clientRecording.ts`)
- Host trộn **mic host + tiếng tất cả peer + screen-audio** vào **1 Web Audio `destination` → 1 track** → 1 file WebM. (`clientRecording.ts`: mic `addLocalStream`, peer `addStream(socketId,…)`, screen `setScreenAudioStream` — tất cả vào cùng `this.destination`)
- Mỗi lần Record→Stop = **1 clip** ("Clip 1/Clip 2"); không cắt theo share/join/leave.
- Upload: `PUT /v1/recordings/:roomId/upload?duration=…` → R2 `recordings/{meetingId}/{id}.webm`; D1 bảng `recording` (cột: id, meeting_id, project_id, r2_key, duration, bytes, status, started_by, …). **KHÔNG có cột `kind` / `user_id`.**
- UI: `RecordingsSection.tsx` list theo `created_at DESC`.

→ Vì mic + peer + screen nằm chung 1 Web Audio graph, **không de-mix được sau khi ghi**. Phải tách **tại lúc ghi**.

## 2. Hai mục tiêu
- **(A)** Tách **giọng nói (mic)** khỏi **screen-share audio** → 2 file riêng.
- **(B)** **Mic từng user = 1 file riêng** (per-speaker).

(A) dễ (làm host-side). (B) là phần kiến trúc — có 2 hướng:

## 3. Hai hướng cho (B) — per-user files

### Hướng 1 — Mỗi client tự ghi mic của mình *(khuyến nghị)*
Mỗi người tham gia chạy 1 MediaRecorder **audio-only cho mic của chính họ**, upload kèm `speakerId = mình`.
- ✅ **Chất lượng cao nhất**: mic local, **trước khi qua mạng** (không mất gói/jitter) → tốt nhất cho STT/diarization.
- ✅ **Khớp kiến trúc sẵn có**: mỗi client vốn đã tự transcribe mic mình (STT per-speaker) — đây là cùng mô hình.
- ✅ Tải phân tán: mỗi máy ghi+upload phần của mình, host không gánh.
- ⚠️ Phức tạp hơn: mọi client phải chạy recorder + quản lý vòng đời (bật khi host Record, tắt khi rời/stop) + nhiều upload.

### Hướng 2 — Host ghi tách từng stream peer
Host (đang giữ stream mỗi peer theo `socketId`) tạo 1 recorder/peer + 1 cho mic host + 1 cho screen-audio.
- ✅ Đơn giản hơn (chỉ host ghi, dùng path upload sẵn có).
- ❌ **Chất lượng kém hơn**: là bản host **nhận qua mạng** (đã nén/mất gói).
- ❌ Host gánh **N MediaRecorder** cùng lúc → nặng CPU máy host khi đông người.

**Khuyến nghị: Hướng 1** — vì lợi ích anh nêu ("xử lý sau") phụ thuộc *chất lượng audio sạch theo từng người*, mà chỉ mic-local mới sạch. Hướng 2 chỉ nên dùng nếu sau này không muốn mọi client ghi.

## 4. Kế hoạch theo phase (nếu chọn Hướng 1)
- **P0 — Schema + route (nền, tương thích ngược).** Thêm cột `kind TEXT DEFAULT 'mixed'` (`mic`|`screen-audio`|`mixed`) + `speaker_id TEXT NULL` vào bảng `recording`; route upload nhận `?kind=&speakerId=`; R2 key `…/{id}_{kind}.webm`. File cũ vẫn `mixed`. *(worker `index.ts`, migration mới, `recordings.ts`)*
- **P1 — (A) tách screen-audio ở host.** Host tách 2 recorder: 1 = giọng nói (mic host + peer), 1 = screen-audio. Quick win, không đụng client khác. *(`clientRecording.ts`, `CloudRecordingControls.tsx`)*
- **P2 — (B) per-user mic.** Mỗi client chạy recorder mic-only, bật/tắt theo `RECORDING_STATE` host broadcast, upload `kind=mic&speakerId=self`. Đồng bộ thời gian: lưu `started_at` mỗi file để căn chỉnh sau. *(client recorder mới + collab signal)*
- **P3 — UI.** `RecordingsSection` gom theo người/loại (player xử lý audio-only); Meeting log hiển thị "Audio theo người".
- **P4 (sau) — Payoff.** Per-speaker audio chảy vào STT/diarization/dịch/summary chính xác hơn (gắn với AI strategy).

## 5. Rủi ro & lưu ý
- **Consent/riêng tư:** KHÔNG ghi nhiều hơn hiện tại (host Record là đã thu mọi giọng) — chỉ *tách ra*. Câu consent vừa viết đã disclose "recording + AI". Per-speaker dễ tách giọng hơn → nhạy hơn chút; nội bộ thì OK, nhưng nên ghi rõ trong consent nếu đi khách ngoài.
- **Storage:** audio-only nhỏ; tổng tăng tuyến tính theo số người nói. Giữ cap `MAX_RECORDING_BYTES`. Cân nhắc còn giữ file `mixed` để xem nhanh không.
- **Tham gia một phần:** ai tắt mic / no-mic → không có file (đúng).
- **Đồng bộ:** mỗi file start lệch nhau → cần lưu mốc thời gian để ghép timeline.

## 7. Khoá độc quyền recording (#24) — NỀN TẢNG, làm trước
**Bug owner:** "1 người đang record thì không ai được record" — hiện vẫn record chồng được.

**Root cause:** control record chỉ host thấy (`CloudRecordingControls.tsx` `if (!isHost) return null`), nhưng host là **soft** (dev-phase nhiều người có thể là host), và chặn chỉ dựa trên state `isRecording` broadcast qua DO → có **đua/late-sync**: host B chưa nhận RECORDING_STATE của A là vẫn thấy nút Record. **Client không thể tự enforce một khoá phân tán.**

**Fix đúng = khoá phía server (DO room):**
- DO giữ **1 `recordingOwner` duy nhất/phòng**. `acquireRecordingLock(socketId)` — nếu đã có chủ khác → **từ chối** (client hiện "đang được ghi bởi X", không cho start). `releaseRecordingLock` khi stop **và tự release khi chủ disconnect** (ghost reaper sẵn có).
- Client: nút Record disable + nhãn "đang được ghi" cho người không phải chủ; chỉ **chủ** thấy Stop (sửa luôn lỗi phụ: host khác đang bấm Stop được recording của người ta).

**Khớp với #23:** "mỗi user 1 file" (Hướng 1) KHÔNG mâu thuẫn độc quyền — vẫn là **1 phiên record (1 chủ)**; các recorder mic per-client chỉ là *nô lệ* của phiên đó (bật/tắt theo lock), không phải nhiều phiên độc lập. → Làm khoá này **P0**, trước khi tách track.

## 8. BUILD CONTRACT (chốt — mọi agent bám theo)
**Owner chốt:** Hướng 1, full P0–P3, không file `mixed` dư, tối ưu dung lượng. Build thẳng production.

### Schema (migration `0037_recording_per_speaker.sql` — ĐÃ viết)
`recording` thêm: `kind TEXT NOT NULL DEFAULT 'mixed'` (`mic`|`screen-audio`|`screen-video`|`mixed`), `speaker_id TEXT`, `speaker_name TEXT`, `session_id TEXT`. Index `ix_recording_session(meeting_id, session_id)`.

### R2 key
Giữ nguyên `recordings/{meetingId}/{recordingId}.webm` (recordingId unique; kind ở D1).

### Worker — upload `PUT /v1/recordings/:roomId/upload?duration=<sec>&kind=<…>&sessionId=<uuid>`
- Body = WebM bytes; `Content-Type` header → contentType lưu (`audio/webm` cho mic/screen-audio, `video/webm` cho screen-video).
- `speaker_id`/`speaker_name` **server tự lấy từ JWT** khi `kind='mic'` (KHÔNG tin client).
- Gate: `kind∈{screen-audio,screen-video,mixed}` → `canManageRecording` (chỉ owner). `kind='mic'` → **authenticated + có quyền vào meeting + meeting chưa finished** (mọi participant). Reuse helper access meeting hiện có; nếu chưa có thì check participant/membership.
- INSERT thêm kind/speaker_id/speaker_name/session_id. Trả `{ok,id}`.

### Worker — list `GET /v1/recordings/:roomId`
SELECT trả thêm `kind, speaker_id, speaker_name, session_id`. Gate giữ nguyên (review = host/leadership).

### DO recording lock (roomDO.ts) — **giữ owner trong socket-attachment** (sống qua hibernation, tự nhả khi socket đóng)
Control frame mới (DO chặn xử lý, KHÔNG relay):
- C→DO `recording-acquire` `[{sessionId, startedAt}]` → nếu 1 socket KHÁC đang giữ lock → reply `recording-lock` `[{ok:false, owner:{email,name,startedAt,sessionId}}]`. Ngược lại set `attachment.recording={sessionId,startedAt,email,name}` trên socket này → reply `recording-lock` `[{ok:true, owner:{…}}]` + broadcast `recording-state`.
- C→DO `recording-release` `[]` → nếu sender đang giữ → clear attachment.recording → broadcast `recording-state` `[{recording:false}]`.
- DO→C `recording-state` `[{recording, owner?:{email,name}, startedAt?, sessionId?}]` — broadcast khi acquire/release/close, **và unicast cho socket vừa join** (late-join thấy phiên đang chạy). Thay cho hack re-broadcast 5s.
- Auto-release: trong `webSocketClose` + ghost reaper, nếu socket bị gỡ có `attachment.recording` → broadcast `recording-state` false.

### Client recorder (clientRecording.ts) + upload (data/recordings.ts)
- **MIC-only recorder**: `audio/webm;codecs=opus`, **mono, ~32 kbps**, CHỈ mic local (không trộn peer/screen). Mọi participant chạy khi phiên active.
- **SCREEN-AUDIO recorder** (owner): `audio/webm` opus mono ~48 kbps từ screenAudio stream (khi có share audio).
- **SCREEN-VIDEO recorder** (owner, opt-in): canvas-compositor VP8 ~1.5 Mbps (như hiện tại).
- **Skip-silent**: mic không có tiếng đáng kể (mute/im cả buổi) → KHÔNG upload (không tạo row rỗng).
- `uploadRecording(roomId, blob, { durationSec, kind, sessionId })`.

### Integration (Lead) — KHÔNG agent đụng
`CloudRecordingControls.tsx` (acquire/release lock + UI non-owner disabled), `Collab.tsx`/portal (gửi/nhận control frame lock → cập nhật `roomRecordingAtom{recording,owner,startedAt,sessionId}`), vòng đời mic per-client (phiên active + có mic → ghi mic local → stop+upload khi hết phiên/rời), i18n.

## 6. Quyết định cần anh chốt
1. **Hướng 1 (mỗi client tự ghi — khuyến nghị) hay Hướng 2 (host ghi tách)?**
2. **Có giữ thêm 1 file `mixed`** để xem lại nhanh, hay chỉ giữ per-source?
3. **Phạm vi đợt này:** làm cả P0–P3, hay chỉ P0–P1 (tách screen-audio trước) rồi P2 sau?
