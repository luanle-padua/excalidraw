# MCM Roadmap — các Phase đang follow

> Nguồn tham chiếu **chuẩn duy nhất** cho các phase. Chi tiết kỹ thuật từng phase nằm ở daily log (`docs/logs/YYYY-MM-DD.md`) + memory. Cập nhật lần cuối: **2026-06-16** (Phase 4 **waiting room knock-to-join DONE** + revise mô hình phân quyền "chức vụ ≠ vai trò, division admin = head-only" + workstream **trang khách Glass-Desk đa quốc gia** — xem `logs/2026-06-16.md`; kế tiếp: G2 admin → G3 remote + Phase 6, và **1b auth room server** trước khi mở cho khách ngoài thật).

## ✅ Đã xong

### Phase 1 — Screen share (Daily.co) ✅

1 người Present → cả phòng xem; cửa sổ nổi + **Pop-out ra màn hình 2** (Document-PiP); **khoá 1-người-share** (qua socket); **share kèm âm thanh tab** (screenAudio). Media qua Daily SFU, presence/lock qua socket. _(Verified live.)_

### Phase 2 — Audio → Daily SFU ✅

Bỏ audio mesh P2P (không scale) → audio chạy **Daily SFU** (scale N người). `DailyAudio` drop-in cho `AudioRoom` → STT/recorder/UI **không đổi**. _(Code + screen-audio verified; còn test nghe mic khi có máy có micro.)_

### Phase 3 — Supabase Auth ✅

Đóng lỗ **Worker no-auth**: Worker verify Supabase JWT (jose/JWKS) chặn mọi `/v1` trừ health. Login bắt buộc cho tất cả (nội bộ email/pw 1-click, **khách magic-link**). 5 user nội bộ seed sẵn. _(Verified live: token thật→200, không/sai→401.)_ → setup ở [supabase-setup.md](../specs/supabase-setup.md).

**Kèm theo:** timer họp **khách quan** (đếm từ host start, ai vào sau cùng số); nút **Invite** copy link.

---

## ⏳ Tiếp theo

### Phase 4 — Host control + per-meeting membership (gần xong)

Vai trò host (chốt 2026-06-05) — **gắn với recording bảo mật** (chỉ host + người được duyệt mới tải được). Thiết kế đầy đủ (organizer vs host, acting-host, lifecycle, **lên lịch họp**): **[host-and-scheduling.md](../specs/host-and-scheduling.md)** (bàn 2026-06-08).

- [x] **Phòng chờ (waiting room)** — khách ngoài vào link → login → **gõ cửa + chờ host duyệt**; nội bộ @mapgroup **auto-admit**. _(06-16, commit `37e5953c` + fix `3e13f1c2`/`95942b6c`.)_ Cổng duyệt **ép server ở Daily token** (decision **1a**, migration `0025_meeting_knock`): external chưa admitted → không token → không audio. `WaitingRoom.tsx` (clone WaitingForStart, poll 5s, vào muted) + mục "Waiting (knocking)" + Admit/Deny + badge "N waiting" trong ParticipantsBar. **Còn 1b:** canvas relay vẫn trust-the-key → auth room server TRƯỚC khi mở cho khách ngoài thật.
- [x] **Mời theo LINK** (mở link + login) _(06-09)_. _(Mời theo email cụ thể = sau.)_ **+ Login bằng link** ngay tại màn đăng nhập _(06-15: dán `ID,KEY` → login → auto-join)_.
- [x] **End meeting for all** — host kết thúc → meeting thành _finished_ cho cả phòng _(06-08; ghi `status='finished'` chuẩn từ 06-10; lan tới member qua verify-registry từ 06-11)_.
- [~] **Co-host** + chuyển host khi host rời. _(✅ Chỉ định co-host trước trong form Create/Edit + **End đã đọc role** (06-11). ❌ Còn: **election live chưa đọc role cohost cho kick/mute** — cần room server validate, xem track I-2.)_
- [x] **Kick / mute** participant _(06-08 — soft enforcement, xem dev-phase-notes)_. **+ Revoke = kick** _(06-11: bỏ khỏi invitee → văng khỏi phòng live, poll 60s)_.
- [x] **Membership** (D1): `project_member` + `meeting_invitee` (0008) → Worker authz per-meeting/project + Daily-token check _(06-09)_.

### Phase 4.5 — Scheduling (lên lịch họp) ✅ (06-09 → 06-10)

Chốt 2026-06-08, ship xong 2026-06-10:

- [x] **Form lên lịch + mời** (ngày/giờ/thời lượng, picker nội bộ + client list) + **mục "Sắp tới/Được mời"** _(06-09)_.
- [x] **Home 3 cột Notion + calendar Schedule-X** (màu sync, holidays, day panel) _(06-09)_.
- [x] **State machine `scheduled→live→finished/cancelled`** + **chuẩn hoá `meeting.status`** (migration `0013`, client đọc tolerant qua `meetingStatus.ts`) _(06-10)_.
- [x] **Màn "chờ host Start"** (`WaitingForStart` + gate trong `startCollaboration`): mở link khi chưa Start → nội bộ thấy nút **Bắt đầu** (luật acting-host), khách **poll 5s** tới khi live thì tự vào; meeting huỷ → thông báo _(06-10)_.
- [x] **Dời lịch / Huỷ** (organizer, trong detail panel; legacy meeting không có organizer → nội bộ được phép) _(06-10)_.
- Để sau: email mời tự động · calendar sync (.ics) · recurring · waiting room per-guest (Phase 4).

### Phân quyền — REVISE 06-16 (đảo vài điểm 06-15) ✅

Mô hình authz được rà lại với anh Luân (chi tiết: `plans/project-permissions.md` + memory `project_mcm-permission-model`):

- [x] **Division admin = CHỈ HEAD** (bỏ deputy khỏi mọi authz worker — đảo "deputy ngang head" 06-15; cột `deputy_email` để dormant).
- [x] **Chức vụ (직급) ≠ vai trò dự án** — title chỉ hiển thị (chip xám), không khoá nút assign; roster gộp 1 list (`8cf63c79`).
- [x] **Tạo dự án = mọi nội bộ** (creator auto leader+owner); **auto-join họp = chỉ leadership** (member thường phải được mời); **START (scheduled→live) = chỉ phòng sở hữu** (`isOwningDeptMember`, `2ed69a67`) — không còn "nội bộ nào cũng start".
- [x] Fix gốc **form lịch gắn nhầm dự án** (`2f30666d`) — đóng cùng lúc: guest mất khỏi list + admin phòng khác start/join.

### Workstream UI — Glass-Desk redesign + rebrand "Canvas M" ✅ (06-12 → 06-15)

Ngoài plan gốc — yêu cầu anh Luân "redesign UI/UX như app Apple, trend 2026". Design-system **Glass Desk** (`plans/glass-desk-dashboard-2026.md`): content giấy đặc, khung điều hướng kính Liquid Glass.

- [x] **Dashboard** (06-12, commit `997000cf`): token Glass-Desk, **wallpaper** (preset/gradient/upload, per-browser), **CalendarX + ghi chú** (`GET/PUT /v1/notes` day|meeting), **color/icon** project+meeting (migration `0018`, cosmetic miễn guard), ColorMenu/EmojiMenu.
- [x] **Login + Admin Console** Glass-Desk + **rebrand "MAP CanvasMeet" → "Canvas M"** (logo `public/canvas-m.png`; acronym MCM / prefix `mcm-` giữ) + **luồng login bằng link** (06-15, merge từ `feature/canvas-m-login-admin-ui`, đã push). _(Verify: typecheck/eslint/build pass + team review 6 agent, không regression.)_
- [x] **Trang khách (ClientPortal) Glass-Desk đa quốc gia** (06-16): card kính mờ + **nền xoay 7 theme** (`PortalBackdrop` data-driven, lazy-load, opaque base chống lộ panel khi crossfade) đã **nén WebP 15.3MB→741KB**; **calendar trong suốt** bên phải; greeting ra ngoài nền, **Cormorant Garamond**, "Hi {name}" hero; **phòng chờ đồng bộ** cùng nền/kính. _(Theme-theo-từng-client/insight = làm sau khi cần.)_
- Còn: **quét i18n lại** (đang **tạm dừng** tới khi UI chốt — chuỗi mới hardcode tiếng Việt) · **test tay login-link** 2 account.

### Phase 5 — Recording → R2 (auth-gated)

- [ ] **Daily cloud recording** (audio+screen đều trên Daily) → webhook `recording.ready` → **Worker copy về R2 private** (Daily không ghi thẳng R2 — chỉ AWS S3).
- [ ] **Tải qua Worker có auth** (verify JWT + membership) — không link công khai. R2 vì **egress free** (S3 ~$0.09/GB).
- [ ] Xem lại trong **review-mode** của cuộc họp đã xong.
- _(Ghi server-side vì host có thể là máy bất kỳ/yếu.)_

---

### Phase A — Admin Console (track riêng)

Lớp back-office quản trị toàn hệ thống (KHÁC host). **Admin = account RIÊNG** (`admin@mapgroup.co.kr`, role qua Supabase `app_metadata`); **không meeting host nào là admin**. Module: Dashboard · Users&Roles · Meetings · Recordings · Cost&Usage · API/Integrations · Storage · Audit log · Security · Settings · Analytics · Compliance/GDPR · Announcements. → spec đầy đủ: **[admin-console.md](../specs/admin-console.md)**. Build: A1 (role+gate+/admin+Dashboard+Users+Meetings) → A2 (Cost+API+Recordings+Storage+Audit) → A3 (Security+Settings+Analytics+Compliance).

---

## 🏗️ Track HẠ TẦNG PRODUCTION (song song feature phase — audit 3-team 2026-06-05)

> Feature phase 1-5 ở trên là **tính năng**. Để **chạy production thật** còn cả track hạ tầng — trước đây rải rác / thiếu khỏi roadmap. Bảo mật: secrets **KHÔNG lộ trên git** (đã verify history sạch); rotate = phòng ngừa trước prod.

### 🔴 SÓT — chưa nằm trong phase nào (cần đưa vào)

- **I-1. Backend AI/STT/TURN đang trên room server** — Gemini (`/translate`,`/summarize`,`/chatbot`), Deepgram (`/stt`), Cloudflare TURN (`/turn-credentials`) chạy trên `room/` (Node đơn), key trong `room/.env.development`. → **dời lên Cloudflare Worker/DO** + `wrangler secret`. _(Cả lớp compute + secrets này chưa có phase.)_
- **I-2. Realtime = socket.io 1 instance** (`room/` — SPOF, không scale ngang, HTTP) → **Durable Objects** (June plan, chưa vào roadmap).
- **I-3. Deploy production** — chưa có **CI/CD** (Pages + `wrangler deploy`), **domain thật**, **staging env**. Đang dev-machine + cloudflared quick-tunnel (URL đổi mỗi lần).
- **I-4. Disaster recovery** — **D1 backup** + **R2 versioning** chưa có; D1 migration chạy tay (`wrangler d1 execute`).
- **I-5. Observability** — client `@sentry/browser` THỰC RA **đã wire sẵn** (`excalidraw-app/sentry.ts` + `TopErrorBoundary.tsx`, kế thừa Excalidraw — chỉ init khi có DSN env); **CHƯA xác nhận DSN/env prod**. Server-side logging/alerting (Worker + room server) **chưa có**.
- **I-6. Runbooks** — deploy / key-rotation / incident-response chưa có.

### 🟠 Phase 6 — Production hardening (gom các việc trước go-live)

- Khoá **CORS** Worker (`origin:"*"` → origin thật).
- **Rate-limiting** Worker + room server (chống abuse/cost AI).
- **Rotate keys** + `wrangler secret put` (Daily/Supabase/Gemini/Deepgram/TURN).
- **SMTP** cho magic-link (built-in rate-limit + dễ spam).
- **Token refresh** họp >4h (Daily token hết hạn 4h).
- **Scene size limit** + input validation Worker.
- ~~**Daily-token check membership**~~ ✅ 06-16: token gate `canSeeMeeting` + (external) **admitted-knock**, dùng **base meeting id** (strip `-audio` — vá luôn lỗ canSeeMeeting bị bypass bởi hậu tố room).

### ✅ Đã có chỗ trong phase (audit xác nhận thêm chi tiết)

- **P4** cần D1: bảng **membership** (ai vào meeting nào) + **waiting_room** (duyệt khách) + **meeting.status** ('finished') + **DELETE meeting cascade** (xoá D1 + R2) + middleware **per-meeting authz**.
- **P5** cần: **Daily webhook** (`recording.ready-to-download`) + route `/v1/recordings/:id` (auth+membership) + copy→R2 + lifecycle (xoá bản Daily sau copy) + **dọn Daily room** + quota.

### 🧹 Dọn dẹp / nợ nhỏ

- Xoá **mesh dead code** (`AudioRoom`/`AudioPeer`/`turnConfig`) sau khi verify mic.
- **R2 orphan cleanup** (xoá blob khi meeting bị xoá) + dọn 3 meeting rác cũ.
- **E2E key hardening** — `room_key` lưu D1 (server đọc được, không E2E thật).
- **Gộp audio+screen 1 Daily room** (giờ 2 room `<id>` + `<id>-audio`) cho unified recording + giảm cost.
- **Data residency** (R2/Daily region) cho client xuyên quốc gia; **mời theo email cụ thể** + invite UI.

---

## Lịch sử đánh số (để khỏi lẫn)

Số phase từng đổi trong ngày 2026-06-05: ban đầu Recording=Phase 2/3, Auth=Phase 4; sau **đảo lại** vì tải recording cần auth trước. **Số HIỆN TẠI (doc này) là chuẩn**: 1 screen-share, 2 audio, 3 auth, 4 host-control, 5 recording.
