# Unified Meeting Replay — Design + Plan (#28)

> Status: **DEPLOYED 2026-06-25** — full P0–P3 built (owner-approved: trọn P0→P3, audio trộn+solo, zoom hoãn). Pages `ce3f75d8` · Worker `466b11a6` · D1 0038; commits `999dd6f8` (P0–P2) + `1dd2993e` (P3+#22). Còn lại = P4 polish (zoom/keyboard) khi cần.
> Tổng hợp từ 3 bản design (timeline-centric / player-centric / minimal) qua team. Mục tiêu owner: *hiểu cả cuộc họp — ai nói gì, lúc nào* — bằng 1 replay hợp nhất canvas + audio per-speaker + screen, **gọn, đừng lố quá, không phá tính năng cũ**.

## 1. Ý tưởng cốt lõi — "1 đồng hồ, 1 playhead"
Mở rộng **dock "Tua lại" sẵn có** (canvas replay bottom-dock) thành replay hợp nhất, chạy trên **1 trục thời gian tuyệt đối (epoch ms)**:
- **Canvas** đã ở clock này (`canvasHistory` frame có `ts = Date.now()`).
- **Transcript** đã ở clock này (`transcriptionLogAtom` segment có `ts` + tên) → nguồn "ai nói lúc nào".
- **Recording** per-speaker gắn vào clock này qua `started_at_ms` (mốc nhỏ thêm vào).

Một scrubber, một playhead chạy ngang **dùng chung trục X** với dải lane per-speaker. Canvas evolve phía sau; lane cho thấy ai nói khi nào; chooser chọn nghe/xem gì **kèm canvas**.

```
┌─ REVIEW CANVAS (driven in place via excalidrawAPI.updateScene — như hiện tại) ────────────┐
│            (whiteboard tái dựng tại thời điểm playhead)                                    │
│     ┌───────────────┐  ← pane video NỔI chỉ hiện ở chế độ "Screen-along" (kéo được)        │
│     │ screen-video  │                                                                      │
│     └───────────────┘                                                                      │
├─ mcm-replay dock (bar sẵn có, + lane strip) ──────────────────────────────────────────────┤
│ ▶ ↺  00:04:12 / 00:41:18   ├──────●────────────────────┤   0.5× 1× 2× 4×  [Along ▾]   ✕   │ ← transport + chooser
│ Linh  ▓▓▓░░░░▓▓▓▓▓░░░░░░░░▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ← lane per-speaker (transcript)│
│ Minh  ░░░░░░░▓▓▓▓░░░░░░░░░░░░▓▓▓▓▓▓▓░░░░░░░░░░░▓▓▓░░░░░░░░░░░░     filled = đang nói          │
│ 유훈   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░     tint = personColor          │
│ ⧉Screen ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱     span screen-video           │
└────────────────────────────────●───────────────────────────────────────────────────────────┘
```
**Mặc định collapse** = đúng 1 hàng transport như hiện tại; bấm chevron mới xổ lane → giữ "đừng lố quá".

## 2. Lane "ai nói lúc nào" (giá trị chính)
- **Nguồn = transcript** (`transcriptionLogAtom`): group theo người (modal đã có `groupBySpeaker`), mỗi segment → interval `[ts, ts+~width]`, merge khoảng cách < ~4s thành 1 block. **Không cần record** vẫn có lane (STT chạy độc lập). Độ rộng block là *thẩm mỹ*, không phải dữ liệu tải-nặng.
- **Gọn, không thành DAW:** 1 hàng mỏng ~18px/người, **không waveform**, block bo tròn phẳng; cap **top-N (~6) + "+k nữa"**; tint `personColor(email)` (khớp avatar/transcript). Lane chia sẻ **đúng trục X với scrubber** → 1 playhead dọc cắt hết.
- **Tương tác:** click block/lane → playhead nhảy tới → canvas + audio seek theo. Click *tên* người → solo nghe người đó (chế độ audio). Hover → tooltip snippet transcript (tùy chọn).

## 2.1 NHIỀU NGƯỜI — hiển thị cho khéo (owner nhấn mạnh)
KHÔNG đổ ra 20 lane thành bức tường. Quy tắc:
- **Mặc định khi đông = 1 "dải hội thoại" DUY NHẤT (1 hàng):** mỗi block tô **màu `personColor` của người đang nói** → nhìn 1 phát thấy turn-taking (ai nói, nối ai) bất kể bao nhiêu người. 2 người nói chồng → block sọc/chia đôi. Tên hiện khi block đủ rộng / hover. Cực gọn, luôn 1 hàng.
- **Xổ ra (chevron) = lane per-người**, sắp theo **thời lượng nói giảm dần**: hiện **top-N (~6) + 1 lane gộp "Người khác (k)"** (heatmap khi bất-kỳ-ai-trong-nhóm nói — không mất thông tin). Bấm lane gộp → mở full list **cuộn được, tên dính trái (sticky)**.
- Avatar + màu/người, tên cắt gọn. Solo = bấm tên (trong nhóm gộp thì mở rộng trước). Lane strip cao tối đa ~40vh, cuộn trong; canvas vẫn thao tác phía sau.
- **Ngưỡng tự chuyển:** ≤ ~5 người → lanes thẳng; > ngưỡng → mặc định thu về "dải hội thoại 1 hàng", per-người là opt-in. Giữ đúng "đừng lố quá" dù 3 hay 30 người.

## 3. Chooser "Play along" (3 chế độ)
Segmented `[Along ▾]` trong transport — đổi **cái gì play KÈM canvas**, KHÔNG đụng playhead/trục (đổi giữa chừng giữ nguyên `T`):
| Chế độ | Play kèm canvas | Hành vi |
|---|---|---|
| **Canvas** (mặc định = hiện tại) | — | Replay vector thuần. Luôn có kể cả không có recording. |
| **Audio-along** | **mic mọi người, trộn** | Mỗi `mic` track 1 thẻ `<audio>`, seek theo playhead, play khi `T` trong cửa sổ track, im ngoài cửa sổ. **Trình duyệt tự trộn** (không server-mix). Solo/mute per-người tùy chọn. |
| **Screen-along** | **screen-video** (pane nổi) | Thẻ `<video>` nhỏ nổi/kéo được, seek theo playhead; audio màn-share theo nó. Chỉ bật nếu có track `screen-video`. |
Chế độ chỉ **enable khi có dữ liệu** (Audio nếu có mic; Screen nếu có screen-video); meeting chỉ-canvas thì chooser thu về 1 nút "Canvas".

## 4. Đồng bộ — clock & playback (chốt sau khi cân 3 bản)
- **Khi PLAY:** `playheadT` tiến liên tục bằng **rAF** (× speed). Media (`<audio>`/`<video>`) **play native cho mượt**; mỗi ~500ms so `currentTime` với mục tiêu `(playheadT − started_at_ms)/1000`, lệch **> ~250ms mới nudge** (không seek mỗi frame). Canvas là **hàm bậc thang** — chỉ `updateScene` khi đổi keyframe (`ts ≤ playheadT`). → audio mượt, canvas rẻ.
- **Khi SCRUB:** set `playheadT` → canvas `reconstructSceneAt` + mọi media `currentTime` seek theo.
- **Canvas-only:** giữ nguyên vòng keyframe `STEP_MS_AT_1X` hiện tại (không media).
- **Cố ý KHÔNG:** server mixdown, Web Audio graph, drift-correction nặng, transport thứ 2. Nudge-on-drift là đủ "hiểu cuộc họp".

## 5. Dữ liệu / timing
- **t=0 anchor** `T0 = min(canvasHistory[0].ts, min(track.started_at_ms))`; `T1 = max(last frame ts, max(started_at_ms + duration*1000))`. Mọi thứ đã epoch ms → **0 quy đổi**.
- **Thêm 1 field `started_at_ms`** (epoch ms) / recording row — **chỉ cho sync audio chính xác**. Stamp `Date.now()` đúng lúc `MicRecorder.start()` thật sự nổ (người unmute trễ thì track bắt đầu trễ — đó là sự thật cần). Thread qua `uploadRecording` → cột D1 nullable (migration) → `listRecordings` trả về.
- **Legacy/null an toàn:** row cũ `started_at_ms=null` → fallback đặt ở `session.startedAt` (hoặc giữ như clip lẻ hiện tại). Không crash, không chặn.
- Lane (transcript) **không cần** field này → ship trước được.

## 6. Kế hoạch theo phase (mỗi phase ship được, KHÔNG phá gì)
- **P0 — stamp `started_at_ms` (vô hình):** capture ở `MicRecorder`/screen recorders → `uploadRecording` param → cột D1 nullable (migration mới) → trả ở `listRecordings`. Không đổi UI. *Chỉ THÊM 1 field; live-capture/lock/upload không đổi hành vi.*
- **P1 — canvas player chạy theo ms (refactor, không surface mới):** đổi `CanvasReplayPlayer` từ index→`playheadT` (rAF). Canvas-only nhìn y hệt. De-risk mọi thứ sau.
- **P2 — lane "ai nói lúc nào" (giá trị chính, read-only):** thêm `SpeakerLanes` từ transcript, chung trục scrubber, tint `personColor`, click-to-seek. **Ship ngay giá trị headline** trên canvas replay. Chưa cần audio.
- **P3 — chooser + audio/screen-along:** 3 chế độ; hook `useReplayMedia` (nâng từ `fetchRecordingObjectUrl`/buffer của `RecordingsSection` → 1 bộ load gated chung); audio = N `<audio>` seek theo playhead + nudge; screen = pane video. Dùng `started_at_ms` (fallback xấp xỉ nếu null).
- **P4 — polish:** zoom (nếu cần), phím tắt (space/←/→), solo/mute, density/collapse lane, fallback legacy, sửa luôn **ô "Pick a track" tràn boundary** (#22) khi gộp player vào deck.

**Tái dùng:** `reconstructSceneAt`/`historyTimeline`, drive `updateScene`+snapshot/restore, gated blob loader, dock shell/scss, `personColor`, `transcriptionLogAtom`, `roomRecording.startedAt/sessionId`. **Không đổi:** `canvasHistory.ts`, `MeetingLogModal` tabs (Recordings tab giữ làm fallback "play 1 clip").

## 7. KHÔNG được phá (invariants)
Live capture + DO lock + per-speaker upload (P0 chỉ THÊM field); canvas review mọi entry-path; finished-meeting immutable (replay = `updateScene(NEVER)` + restore-on-exit); recording authority gate (deck dùng cùng gated fetch — viewer không quyền → `listRecordings`=[] → chỉ thấy lane canvas/transcript); MeetingLogModal tabs.

## 8. Rủi ro & guardrail "đừng lố quá"
- KHÔNG: canvas thứ 2 (sẹo phantom-guest), waveform/VAD, server-mix, transport riêng, drift-correction nặng. Quá vạch này = over-design.
- Lane đông người → top-N + collapse. Nhiều session/1 họp → lane hiện gap (không track = không fill), không stitch.
- Blob buffer mất Range-seek với file lớn → mic 32k nhỏ vô hại; screen-video dài có thể chậm seek (chấp nhận cho review nội bộ; sau đổi signed-URL sau cùng helper).
- Skew clock giữa máy (mỗi `started_at_ms` là `Date.now()` máy đó) → lệch giây ở review chấp nhận được; nếu cần, chuẩn hoá theo DO `startedAt` (1 clock server) sau.

## 9. Quyết định cần anh chốt
1. **Phạm vi v1:** làm **P0→P2** trước (lane "ai nói lúc nào" + canvas, **chưa audio**) cho anh thấy giá trị sớm — rồi P3 (play-along) ngay sau? Hay làm **trọn P0→P3** rồi mới cho test 1 lần (như anh từng dặn "đừng test sớm muộn")?
2. **Audio-along mặc định:** **trộn tất cả** (đúng "nghe lại cuộc họp") + cho solo 1 người — OK chứ?
3. Có cần **zoom timeline** (P4) không, hay họp nội bộ ngắn thì "Fit" là đủ?
