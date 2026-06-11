# Khảo sát tính năng người dùng MAP CanvasMeet — 2026-06-11

> Đường dẫn `docs/...` trong file là vị trí CŨ trước reorg docs 06-11 (xem `docs/README.md`).
> Tổng hợp từ 6 báo cáo khảo sát theo hành trình (login-home, meeting-mgmt, in-room-collab, in-room-media-ai, documents, guest-xp), đọc code thật tại commit 2026-06-11. Bối cảnh: **polish "chuẩn chỉnh" trước, cutover lên remote sau** (P1 worker remote đã live, DB trống, dev vẫn local).
>
> Chú giải độ chín: 🟢 chín (dùng được, tin được) · 🟡 chạy nhưng thô (thiếu i18n / lỗi im lặng / cạnh sắc) · 🔴 placebo hoặc hỏng làm mất niềm tin / mất dữ liệu · ⚪ dead code / không có UI (người dùng không chạm tới).
>
> Điểm đã verify lại code khi 2 báo cáo lệch nhau: `MCMAssistant` + `AIToolsPanel` **không được mount ở đâu cả** (chỉ export, comment `MeetingShell.tsx:84` xác nhận; toggle dịch chat thật nằm trong `ChatPanel`) → hạ từ 🔴 xuống ⚪ dead code. Review-mode finished: 2 báo cáo cùng kết luận (gate chạy trên mọi đường vào, còn 2 gap fail-open + blob PUT) → ghi 🟡.

---

## (a) Bảng inventory tính năng người dùng

### Hành trình 1 — Vào app & màn hình chính

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| Login email + password | login-home | 🟢 | 1 message lỗi chung cho sai pass / mất mạng |
| Quick-login demo (chọn user, pass chung) | login-home | 🔴 | Password (kể cả admin) hardcode trong bundle client — ai đọc bundle cũng login được thành nhân viên thật (`LoginScreen.tsx:21`, `demoUsers.ts:31`) |
| Magic-link cho khách | login-home, guest-xp | 🟡 | Lỗi Supabase hiện raw tiếng Anh; sau "đã gửi" không có nút quay lại; **rủi ro va chạm `#room` vs `#access_token` chưa test** |
| authReady gate (không flash login) | login-home | 🟢 | — |
| ProjectBrowser 3 cột | login-home | 🟡 | Lỗi mạng → hiện "Chưa có cuộc họp" (nói dối); mở meeting/đổi màu/tạo project fail đều im lặng; loading "…" trơ |
| Badge "Được mời" | login-home | 🟢 | — |
| Project trống (hint + nút tạo) | login-home | 🟢 | — |
| CalendarX (Schedule-X, holiday KR+VN) | login-home | 🟢 | — |
| Day notes dưới lịch | login-home | 🟡 | `saveNote` fail bị nuốt → mất ghi chú lặng lẽ khi offline; aria nút "+" hardcode EN |
| Resume banner (họp dở) | login-home | 🟢 | — |
| Join bằng link dán | login-home | 🟡 | Key sai / meeting bị xoá → fail sâu, không báo gì tại lobby |
| MeetingDueNotice (chuông sắp họp) | login-home | 🟢 | Join fail khi worker chết thì im lặng |
| UserMenu (avatar, fallback chữ cái) | login-home | 🟢 | — |
| UserProfileModal | login-home | 🟢 | Avatar chỉ lưu local (TODO R2 P2, đã biết) |
| LangThemeSwitcher | login-home | 🟢 | Theme "system" + OS dark → icon gây hiểu lầm 1 click đầu |
| Đăng xuất / đổi tài khoản | login-home | 🟡 | `mcm:userProfile:v1` là 1 key chung → đổi account cùng máy mang tên/avatar người trước vào meeting |
| CalendarView / CalendarSplit / InvitedMeetings | login-home | ⚪ | Dead code ~800 dòng, không ai import — nên xoá trước khi đóng băng |

### Hành trình 2 — Tạo & quản lý meeting

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| ScheduleMeetingForm (UI 4 zone, double-submit guard) | meeting-mgmt | 🟢 | — |
| **Tạo meeting — kết quả bị bỏ qua** | meeting-mgmt | 🔴 | `registerMeeting` trả false khi lỗi nhưng form đóng như thành công → meeting "đã tạo" không tồn tại |
| Validate lịch (ngày trống / quá khứ / duration âm) | meeting-mgmt | 🟡 | Schedule không bắt buộc ngày; không chặn quá khứ; duration gõ tay được số âm |
| **Toggle Waiting room / Recording khi tạo** | meeting-mgmt, guest-xp | 🔴 | Placebo: flag lưu D1 nhưng 0 consumer; docs host-and-scheduling.md còn hứa "host duyệt" — doc nói dối so với code |
| Chọn co-host khi tạo | meeting-mgmt | 🟡 | Đổi host rồi tự làm co-host → role rơi im lặng (organizer không nằm trong selected) |
| EditMeetingForm (load, diff invitee, khoá lịch khi live) | meeting-mgmt | 🟢 | — |
| EditMeetingForm — báo lỗi PATCH | meeting-mgmt | 🟡 | Có alert nhưng thô, không phân biệt 403/409; giờ lệch phút bị ép về :00/:30 khi load |
| Invite/revoke sau khi lưu edit | meeting-mgmt | 🟡 | Không check kết quả → danh sách mời có thể nửa vời mà báo "đã lưu" |
| Host/Co-host PATCH phía worker | meeting-mgmt | 🟡 | PATCH không validate `host_email` internal (POST thì có) — lệch nhau |
| MeetingDetailPreview (hero, AI summary, people) | meeting-mgmt | 🟢 | — |
| Dời lịch / Huỷ / Khôi phục / Xoá meeting | meeting-mgmt | 🟢 | Server enforce organizer-only + state machine + race 409, confirm i18n |
| Gán màu meeting | meeting-mgmt | 🟡 | Fail không báo (assignColor không check kết quả) |
| InvitePanel (mời trong canvas) | meeting-mgmt, in-room, guest-xp | 🟡 | `send()` fail (403/409 meeting finished) → im lặng, nút chỉ nhả ra |
| Tạo project | meeting-mgmt | 🟡 | Fail → input bị xoá trắng, không báo lỗi |
| **Sửa project (MetadataEditor)** | meeting-mgmt | 🔴 | Nút Edit hiện cho mọi người nhưng worker 403 owner-only + kết quả bị bỏ qua → member thường "lưu giả", thay đổi biến mất im lặng |
| Xoá project (owner) | meeting-mgmt | ⚪ | Worker có DELETE owner-only nhưng không có UI nào ngoài AdminConsole |
| MetadataEditor (khung form) | meeting-mgmt | 🟢 | — |
| Label metadata project/meeting | meeting-mgmt | 🟡 | `metadataFields.ts` hardcode tiếng Anh 100% — user vi/ko mở form Sửa project thấy toàn EN |
| Mở lại meeting từ card | meeting-mgmt | 🟡 | Thiếu room_key (mạng/403) → click không có gì xảy ra |
| MemberPicker / PeopleGrid | meeting-mgmt | 🟢 | — |
| Timezone | meeting-mgmt | 🟢 | Đúng cho 1 múi giờ; HQ↔VN dùng chéo sẽ lệch (ghi nhận, chưa phải bug demo) |

### Hành trình 3 — Trong phòng (collab cơ bản)

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| Join → start-gate route (scheduled/live/finished/cancelled) | in-room, guest-xp | 🟢 | Nhưng **fail-open**: worker chết → `getMeeting` null → meeting finished mở qua raw link vào EDITABLE |
| WaitingForStart (Start nội bộ / khách poll 5s) | in-room, guest-xp | 🟢 | Start fail vì mạng → nút im lặng |
| MeetingHeader (title/edit, đồng hồ, đếm người) | in-room | 🟢 | — |
| **Nút Share / Layout / More trên header** | in-room, guest-xp | 🔴 | Không có onClick — 3 nút placebo bấm im lặng với mọi người dùng |
| End-for-all + confirm | in-room | 🟡 | Không check kết quả PATCH → offline tạo trạng thái lệch host-thấy-finished / registry-live |
| Leave (flush save, clear hash) | in-room | 🟢 | — |
| ParticipantsBar (roster, speaking, follow, panel Zoom-style) | in-room | 🟢 | — |
| Host badge | in-room | 🟡 | aria/title "Host của cuộc họp" hardcode VN |
| Kick / Mute (host) | in-room | 🟡 | Client-soft: bị kick vào lại được bằng link; thông báo = window.alert thô |
| Raise hand + reaction nổi | in-room, media-ai | 🟢 | — |
| ChatPanel (gửi/nhóm/reply/@mention/@bot, persist) | in-room | 🟢 | 2 chuỗi vặt hardcode EN |
| Chat dịch (pre-translate 3 thứ tiếng) | in-room | 🟢 | — |
| Sticker / StickerPicker | in-room | 🟡 | Hint/empty hardcode VN, label EN; asset fail chỉ console |
| CanvasNavWidget (zoom + minimap) | in-room | 🟡 | Logic chín nhưng 0% i18n — trộn EN/VN hardcode |
| AuthorBadgeOverlay | in-room | 🟢 | — |
| RevisionCloud (cloud + note) | in-room | 🟡 | Note mặc định + toast hardcode VN — người Hàn thấy tiếng Việt |
| TextTranslateOverlay (dịch text trên canvas) | in-room | 🟡 | Toàn bộ UI hardcode VN; dịch fail → bail im lặng, không báo |
| MeetingLogModal | in-room | 🟡 | Clear xoá storage nhưng không xoá atom → UI trơ đến khi reload; header export hardcode VN |
| Review mode read-only (mọi đường vào) | in-room, guest-xp | 🟡 | Gate đã phủ raw link + reload; còn 2 lỗ: fail-open khi mất mạng, Worker chưa chặn blob PUT vào finished |
| 2 người cùng thao tác / reconnect | in-room | 🟢 | — |

### Hành trình 4 — Trong phòng (media + AI)

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| Present (screen share, lazy-join, lock 1 người) | media-ai | 🟡 | **Lỗi phía người present câm hoàn toàn** — status "error" + errorMessage không component nào render |
| Xem màn hình share (ScreenSharePane, PiP) | media-ai | 🟢 | — |
| Audio call (Join/Mute/Leave, listener-only khi không mic) | media-ai | 🟡 | State machine + Retry tốt nhưng **mọi message lỗi hardcode tiếng Việt** — khách Hàn/Anh gặp lỗi mic đọc tiếng Việt |
| STT bật/tắt + interim/final (panel drag/resize) | media-ai | 🟡 | Badge "LIVE" nói dối (chỉ phản ánh toggle); **mặc định BẬT** → mic tự stream lên Deepgram không hỏi; lỗi WS chỉ console.warn; nút test-file lộ cho mọi user |
| TranscriptionController (load/clear log theo phòng) | media-ai | 🟢 | — |
| Dịch transcript per-viewer | media-ai | 🟡 | Lỗi → âm thầm hiện nguyên bản (chấp nhận được); chưa batch, tốn call |
| Recording (download local) | media-ai | 🟡 | Logic tốt nhưng 100% chuỗi UI hardcode VN né hệ i18n; lỗi chỉ là dấu "!" bé phải hover |
| AI summary (generate khi End, hiện ở preview) | media-ai, meeting-mgmt | 🟢 | Fire-and-forget: Gemini lỗi thì summary không bao giờ xuất hiện, không retry |
| CanvasBotTool (@bot trên canvas) | media-ai | 🟢 | Lỗi ghi frame i18n lên canvas — chuẩn; thiếu timeout request treo |
| AIToolsPanel | media-ai | ⚪ | **Không được mount ở đâu** (đã verify) — dead code, dọn cùng đợt |
| MCMAssistant | media-ai | ⚪ | **Không được mount ở đâu** (đã verify) — dead code; nếu sau này mount thì hiện chỉ là `alert("coming soon")` |

### Hành trình 5 — Tài liệu kỹ thuật

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| Upload thư viện phòng (picker + kéo thả) | documents | 🟡 | Lỗi đọc ảnh chỉ console; không giới hạn size client; alert format lạ hardcode VN |
| Bake IFC → GLB + thumbnail | documents | 🟡 | Bake nhiều giây **không spinner** → user bấm lại tạo bản trùng |
| UI thư viện (search/filter/sort/group) | documents | 🟡 | i18n lẩu 2 thứ tiếng: empty/search hardcode VN, section/chip hardcode EN |
| Click/kéo file vào canvas + chống trùng | documents | 🟡 | **Bug dedup**: IFC/PDF check `type==="rectangle"` nhưng anchor nay là image → bấm lần 2 chèn trùng |
| PDF trên canvas (lật trang, snapshot sync) | documents | 🟡 | Cơ chế vững nhưng toolbar/placeholder hardcode VN, không dùng useT |
| IFC focus 3D (orbit/storey/pick/section) | documents | 🟢 | Renderer lỗi chỉ console.warn → pane trắng câm |
| DXF overlay + layer panel | documents | 🟢 | Chín nhất nhóm overlay |
| Khoá / xoá file thư viện | documents | 🟡 | Confirm/alert hardcode VN; lock client-soft (dev-phase, đã ghi nhận) |
| Sync file lớn + peer hydrate | documents | 🟡 | Retry tổng ~5,4s — GLB lớn trượt → peer kẹt thumbnail-only im lặng |
| Rời phòng khi upload đang dở | documents | 🟡 | PUT GLB bị bỏ rơi → entry metadata-only vĩnh viễn, không cảnh báo "đừng thoát" |
| **Upload trong review mode (meeting finished)** | documents | 🔴 | Nút không gate viewOnly → upload "thành công" trên màn hình rồi biến mất khi reload = placebo mất dữ liệu |
| MyFilesPanel (tủ cá nhân) | documents | 🟢 | Lỗi mạng → "tủ trống" giả (cạnh nhỏ) |
| "Từ tủ của tôi" trong meeting | documents | 🟢 | — |
| Gate tủ với khách ngoài | documents | 🟢 | Internal-only đúng 3 tầng (nav, shelf, Worker) |
| Restore library khi reopen | documents | 🟢 | — |
| Tombstone (chống file xoá hồi sinh) | documents | 🟢 | — |

### Hành trình 6 — Khách ngoài

| Tính năng | Hành trình | Độ chín | Vấn đề chính |
|---|---|---|---|
| **"Gửi lời mời" cho khách** | guest-xp | 🔴 | Worker chỉ ghi D1, **không gửi email nào** — nhãn "Gửi lời mời ✓" đánh lừa organizer rằng khách đã được báo |
| Login bắt buộc giữ `#room` (password path) | guest-xp | 🟢 | — |
| Chờ start (poll 5s, tự join khi live) | guest-xp | 🟢 | — |
| Phòng toàn khách (hostless) | guest-xp | 🟡 | Không ai Start/End được, khách chờ vô hạn không một dòng giải thích |
| Dashboard của khách | guest-xp | 🟡 | Đúng spec, nhưng ô "Tạo project" vẫn hiện → bấm bị 403 im lặng |
| Nút trong canvas khách thấy | guest-xp | 🟡 | Invite hiện cho khách → gửi bị 403 im lặng; (Share/Layout/More đã tính ở HT3) |
| Bị kick giữa chừng | guest-xp | 🟡 | Alert i18n nhưng thô; client-soft — vào lại ngay bằng link cũ |
| **Bị revoke với phòng live** | guest-xp | 🔴 | Socket không auth: đang ở phòng vẫn vẽ/chat/nghe; vào lại bằng raw link vẫn join như phòng ad-hoc — "thu hồi" chỉ là cảm giác |
| Meeting cancelled — khách mở link | guest-xp | 🟢 | Thẻ "đã huỷ" 3 thứ tiếng + nút quay lại |
| i18n mặc định khách Hàn/Anh | guest-xp | 🟡 | Map browser-lang đúng, nhưng lỗi mic/audio + vài hint hardcode VN — đúng chỗ khách dễ gặp nhất |

---

## (b) 🔴 PHẢI XỬ TRƯỚC REMOTE

Những thứ placebo / hỏng làm người dùng **mất niềm tin hoặc mất dữ liệu** — phải xong trước khi mời người thật vào URL remote:

1. ✅ đã xử 2026-06-11 (chi tiết: `ScheduleMeetingForm.create()` check kết quả `registerMeeting`, fail → alert `folder.saveFailed` + giữ form mở, cùng pattern EditMeetingForm) — ~~**Tạo meeting im lặng thất bại**~~ `await registerMeeting(...)` không check kết quả (`excalidraw-app/components/mcm/ScheduleMeetingForm.tsx:174`; `registerMeeting` trả false khi lỗi tại `excalidraw-app/data/projects.ts:216-229`). Mạng rớt → form đóng "thành công", meeting không tồn tại, invite sau đó 404.
2. ✅ đã xử 2026-06-11 (chi tiết: 2 switch giữ hiển thị nhưng `disabled` + nhãn `folder.comingSoon` "(sắp có)", bỏ hẳn state/payload `waitingRoom`/`recordingEnabled`; `docs/host-and-scheduling.md` ghi rõ "chưa triển khai — Phase 4") — ~~**Toggle Waiting room / Recording = placebo**~~ flag lưu D1 (`worker/src/index.ts:989-990`) nhưng 0 consumer; UI switch tại `ScheduleMeetingForm.tsx:441-470`. Ẩn hoặc dán nhãn "(sắp có)" + sửa `docs/host-and-scheduling.md:14` đang hứa "host duyệt".
3. ✅ đã xử 2026-06-11 (chi tiết: `inviteToMeeting` trả `{ok, status}`; InvitePanel hiện lỗi i18n riêng cho 403 / 409 / mạng, thành công thì auto-copy link phòng vào clipboard — "cấp quyền ≠ đã báo khách") — ~~**"Gửi lời mời ✓" không gửi email**~~ worker chỉ ghi row (`worker/src/index.ts:1254-1311`), nhãn thành công tại `InvitePanel.tsx:303-307`. Đổi nhãn thành "Đã cấp quyền — nhớ gửi link cho khách" + auto-copy link.
4. ✅ đã xử 2026-06-11 (chi tiết: nút Edit project chỉ hiện cho owner — `host_email` khớp email session — hoặc admin (legacy project `host_email` null → chỉ admin); `saveProject` check kết quả, fail → alert `folder.saveFailed` + giữ modal mở) — ~~**Sửa project "lưu giả"**~~ nút Edit không gate owner (`excalidraw-app/components/mcm/ProjectBrowser.tsx:516-523`) trong khi worker 403 owner-only (`worker/src/index.ts:644-658`); `saveProject` bỏ qua kết quả, đóng modal luôn (`ProjectBrowser.tsx:339-351`).
5. ✅ đã xử 2026-06-11 (chi tiết: MeetingLibrary gate `meetingViewOnlyAtom` — nút upload disabled + early-return ở picker/drop/copy-from-shelf, insert/xem vẫn được; Worker 409 mọi blob PUT scene/chat/transcript/library/files vào meeting finished sau grace window) — ~~**Upload tài liệu trong review mode = placebo mất dữ liệu**~~ nút upload không check `meetingViewOnlyAtom` (`excalidraw-app/components/mcm/MeetingLibrary.tsx:1443-1453`) trong khi `persistLibrary` skip viewOnly (`excalidraw-app/collab/Collab.tsx:2013`) → file "lên" rồi biến mất khi reload. Kèm việc Worker chặn blob PUT vào meeting finished (gap đã biết).
6. ✅ đã xử 2026-06-11 (chi tiết: Share wired — copy `activeRoomLink` + toast `header.shareCopied`, disabled khi chưa có link; Layout + More gỡ hẳn khỏi JSX và import) — ~~**3 nút chết Share / Layout / More trên MeetingHeader**~~ không có onClick (`excalidraw-app/components/mcm/MeetingHeader.tsx:433-447, 470-476`). Gỡ hoặc disable — demo bấm vào im lặng rất xấu mặt.
7. ✅ đã xử 2026-06-11 (chi tiết: quick-login tách ra `DevQuickLogin.tsx` — importer duy nhất của `demoUsers.ts` — sau guard tĩnh `import.meta.env.DEV` + `lazy()` nên Vite drop cả chunk khỏi bundle prod; grep build prod verify: **0 hit** `MapAdmin@2026` / email demo / `DEMO_USERS` trong JS; `mapgroup.co.kr` chỉ còn ở allowlist internal-domain + default AdminConsole — chủ đích) — ~~**Quick-login + password hardcode trong bundle**~~ password chung và cả `MapAdmin@2026` nằm trong JS client (`LoginScreen.tsx:21`, `demoUsers.ts:31`), email nhân viên thật phơi cho khách ngoài. Gỡ trước khi URL remote public.
8. ⏭ SKIP có chủ đích — cần auth socket room server (track I-2), quyết định anh Luân 06-11. **Revoke vô tác dụng với phòng live** — khách bị thu hồi vẫn vẽ/chat/nghe (socket không auth), vào lại raw link vẫn join (`Collab.tsx:924-936`, `excalidraw-app/data/meetingStatus.ts:24-44`). Tối thiểu: client re-check `canSeeMeeting` định kỳ; căn cơ: auth socket room-server (track I-2).
9. ✅ đã xử 2026-06-11 (chi tiết: `getMeetingChecked` mới trong `data/projects.ts` phân biệt found / not-found(404) / error; start-gate trong Collab fail-closed — lỗi mạng retry 1 lần rồi CHẶN join + toast `errors.joinUnverified`, room ad-hoc 404 vẫn pass-through như cũ) — ~~**Review-gate fail-open khi mất mạng**~~ `getMeeting` lỗi mạng trả null (`excalidraw-app/data/projects.ts:276-278`) → meeting finished mở qua raw link khi worker chết vào EDITABLE (`Collab.tsx:918-948`). Phân biệt 404 vs lỗi mạng; lỗi mạng thì chặn join hoặc ép viewOnly.

### Nợ mới ghi nhận trong đợt xử 2026-06-11

- **`my_role` cho project list** — client đang đoán owner qua `host_email` khớp email session; project legacy `host_email` null → chỉ admin sửa được. Worker nên trả `my_role` per-project để nút Edit chính xác và mở đường transfer owner.
- **R2 transcript không xoá khi Clear log** — Clear trong MeetingLogModal xoá UI/local nhưng blob transcript trên R2 vẫn còn → reopen meeting là transcript "hồi sinh".
- **Key i18n chết `header.layout` / `header.more`** — 2 nút đã gỡ khỏi MeetingHeader nhưng key còn ở cả 3 locale (en/ko/vi); dọn cùng đợt vét dead code.

---

## (c) 🟡 POLISH ĐÁNG GIÁ (xếp theo tác động/effort)

⏱ = ước làm xong trong 1 buổi.

1. **Toast lỗi chung cho mọi thao tác im lặng** ⏱ — 1 component toast + gắn vào ~6 chỗ đang nuốt lỗi: mở meeting, tạo project, gán màu, join DueNotice, reopen card, InvitePanel send. Tác động lớn nhất trên mỗi giờ bỏ ra.
2. **Empty-state nói dối khi mất mạng** — tầng `data/*.ts` trả `[]`/`null` khi lỗi → ProjectBrowser/Calendar/MyFiles hiện "trống" giả. Đổi sang trả null-khi-lỗi + UI "Không tải được — thử lại". (nửa ngày–1 ngày, chạm nhiều file)
3. **Quét i18n hardcode (~40 chuỗi)** — cơ chế useT + typed parity đã sẵn, chỉ là chưa gọi. Cụm ưu tiên: (a) lỗi mic/audio `AudioRoomController.tsx:137-143` + `DailyAudio.ts` ⏱ — khách ngoài gặp đầu tiên; (b) `RecordingControls.tsx` ⏱; (c) `TextTranslateOverlay` 4 chuỗi ⏱; (d) `MeetingLibrary` + `PDFCanvasOverlay` ~15 chuỗi; (e) `CanvasNavWidget`, StickerPicker, RevisionCloud, `metadataFields.ts`, các chuỗi vặt.
4. **Present fail đang câm** ⏱ — render `screenShareMedia.errorMessage` thành pill/toast cạnh nút Present; lỗi token là lỗi chắc chắn gặp khi dọn lên remote (`DailyScreenShare.ts:127,161,366`).
5. **End-for-all check kết quả PATCH** ⏱ — fail thì báo và giữ nguyên, tránh lệch host-finished/registry-live (`MeetingHeader.tsx:326`).
6. **Magic-link**: test + vá va chạm `#room` vs `#access_token` ⏱ (cất #room vào localStorage trước signInWithOtp, redirect URL sạch); dịch lỗi Supabase + nút quay lại sau "đã gửi" ⏱.
7. **STT**: badge LIVE phản ánh kết nối thật + default OFF / consent 1 lần (mic đang tự stream lên Deepgram khi join audio — privacy/cost); giấu nút test-file sau dev-flag.
8. **Bug dedup IFC/PDF chèn trùng** ⏱ — đổi check `type==="rectangle"` thành match `customData.mcmType` (`MeetingLibrary.tsx:914-927, 1021-1034`); 1 dòng, fix bug thật.
9. **Busy state khi bake IFC / upload lớn** ⏱ — spinner "Đang xử lý {name}…" + `beforeunload` khi upload in-flight (chống mất bytes khi rời phòng).
10. **Gate UI theo vai với khách** ⏱ — ẩn ô "Tạo project" (`ProjectBrowser.tsx:490-507`) và nút Invite với guest (như đã gate My Files); thêm 1 dòng giải thích hostless ở start-gate.
11. **MeetingLogModal Clear xoá luôn atom** ⏱ — hiện bấm Clear xong transcript vẫn trơ → user tưởng hỏng (`MeetingLogModal.tsx:298-302`).
12. **Identity bleed khi đổi tài khoản** ⏱ — key profile theo email hoặc xoá `mcm:userProfile:v1` khi signOut (`data/userProfile.ts:17`).
13. **AI summary fail có cờ + nút thử lại** — hiện fire-and-forget, Gemini lỗi thì summary biến mất vĩnh viễn không dấu vết.
14. **Peer hydrate file lớn** — kéo dài backoff quá 5,4s + placeholder "File lớn đang tải… thử lại" có nút retry (`Collab.tsx:2791`).
15. **Validate form lịch** ⏱ — bắt buộc ngày ở mode schedule, chặn quá khứ, chặn duration ≤ 0; giữ nguyên phút gốc thay vì ép :00/:30 khi edit.
16. **Dọn dead code** ⏱ — `CalendarView/CalendarSplit/InvitedMeetings` (~800 dòng) + `MCMAssistant` + `AIToolsPanel` (đã verify không mount) — tránh sửa nhầm file không chạy trước khi đóng băng.
17. Worker: validate `host_email` internal trong PATCH (đồng bộ với POST, `worker/src/index.ts:1187` vs `:955-957`) ⏱; cân nhắc UI xoá project cho owner (worker đã sẵn).

---

## (d) CHECKLIST CHUẨN CHỈNH TRƯỚC CUTOVER

### Tin được (hết placebo, lỗi có tiếng nói)
- [ ] Tạo meeting fail → giữ form + báo lỗi (không đóng giả thành công)
- [ ] Ẩn / dán nhãn "(sắp có)" 2 toggle Waiting room & Recording; sửa docs đang hứa "host duyệt"
- [ ] Gỡ hoặc disable 3 nút Share / Layout / More
- [ ] "Gửi lời mời" → đổi nhãn "Đã cấp quyền — nhớ gửi link"; báo lỗi khi 403/409
- [ ] Nút Sửa project chỉ hiện cho owner; lưu fail phải báo
- [ ] Disable upload tài liệu khi meeting đã kết thúc (review mode) + Worker chặn blob PUT vào finished
- [ ] Gỡ quick-login + password hardcode khỏi bundle
- [ ] Revoke có răng: ít nhất re-check quyền định kỳ trong phòng live
- [ ] Review-gate không fail-open khi mất mạng
- [ ] End-for-all / Present / dịch canvas: fail phải hiện thông báo, không câm

### Mượt (loading / empty state thật thà)
- [ ] Phân biệt "trống thật" vs "mất kết nối" ở ProjectBrowser, Calendar, My Files (+ nút thử lại)
- [ ] Toast lỗi chung cho thao tác im lặng (mở meeting, tạo project, đổi màu, join)
- [ ] Spinner khi bake IFC / ingest file lớn + cảnh báo trước khi rời phòng lúc đang upload
- [ ] Fix bug chèn trùng IFC/PDF khi bấm tile lần 2
- [ ] Clear log transcript phản hồi ngay (xoá atom)
- [ ] Badge STT "LIVE" phản ánh kết nối thật; STT default OFF hoặc hỏi 1 lần
- [ ] Day note lưu fail phải báo; loading "…" → skeleton

### Đủ tiếng (i18n — khách Hàn/Anh không thấy tiếng Việt trần)
- [ ] Lỗi mic/audio (`AudioRoomController`, `DailyAudio`) — ưu tiên số 1
- [ ] `RecordingControls` toàn bộ
- [ ] `TextTranslateOverlay`, `CanvasNavWidget`, StickerPicker, RevisionCloud
- [ ] `MeetingLibrary` + `PDFCanvasOverlay` (~15 chuỗi lẩu vi+en)
- [ ] `metadataFields.ts` label form Sửa project
- [ ] Lỗi magic-link qua key i18n thay vì `err.message` thô
- [ ] Vét chuỗi vặt: "Admin", "Resize", "Host của cuộc họp", `title="Recording"`, aria các nút

### Khách ngoài OK
- [ ] Test thật magic-link với link `#room` (va chạm 2 hash) trước khi mời khách
- [ ] Ẩn ô "Tạo project" + nút Invite với guest
- [ ] Dòng giải thích hostless: "Chờ nhân viên MAP vào để bắt đầu/điều khiển cuộc họp"
- [ ] Kick: thay window.alert bằng modal/toast tử tế
- [ ] Nút quay lại / gửi lại sau màn "đã gửi magic link"

---

## (e) Thống kê độ chín

| Độ chín | Số tính năng |
|---|---|
| 🟢 chín | **41** |
| 🟡 thô | **43** |
| 🔴 placebo/hỏng | **8** |
| ⚪ dead code / không UI | **4** |
| **Tổng** | **96** |

Tỷ lệ 🟢+🟡 (dùng được) ≈ 87%. Nền tảng (i18n typed 3 thứ tiếng, registry state machine, sync/restore tài liệu, review-gate) đã vững; nợ tập trung ở **lỗi bị nuốt im lặng** (pattern `data/*.ts` trả `[]`/`null`/`false`) và **~40 chuỗi hardcode né hệ i18n**. Xử xong 9 mục 🔴 + cụm toast/i18n là đủ "chuẩn chỉnh" để cutover.
