# MCM Roadmap — các Phase đang follow

> **🎯 HAI MỐC GO-LIVE (chốt 06-17):** **Tháng 7 = TEST NỘI BỘ** (chỉ @mapgroup) · **Tháng 8 = MỞ KHÁCH NGOÀI**. Tháng 7 gồm Recording (P5) + full Admin Console (P-A) + Phase 6 hardening (B1–B11), **trừ 1b** (canvas-relay-auth = chấp nhận tạm cho nội bộ). Tháng 8 thêm **1b auth room server + email-verify + cohost server-validation** trước khi mở external. Chi tiết blocker: memory `mcm-july-v1-scope` + audit task `wztvf5jk8`.

> Nguồn tham chiếu **chuẩn duy nhất** cho các phase. Chi tiết kỹ thuật từng phase nằm ở daily log (`docs/logs/YYYY-MM-DD.md`) + memory. Cập nhật lần cuối: **2026-06-23** — **Meeting Package full feature** (curate → recap board-PNG+chat+file+attachment → audience+member-picker → publish → distribution Shared-with-me + Client-portal + badge "Recap" → management unpublish/soft-delete/recipient-revoke → export zip in-worker; migration **0032**+**0034**) + **Event-Log P1 MVP + consent gate** (bảng `meeting_event`+`meeting_consent`, migration **0033**, consolidate-on-end, `MeetingConsentGate` lúc join có language switcher) + **REFRAME chủ sản phẩm**: event-log/Chairman = **tầng thông tin/kiến thức dự án**, KHÔNG phải giám sát — **BỎ** stealth + chấm điểm hành vi per-person (kèm phân tích pháp lý `event-log-privacy-analysis.md`) + dashboard sidebar IA + nhiều fix. **Migration 0031–0034 đã apply remote.** Trước đó (06-19): STT thực sự chạy, caption per-view, audio optimize. Hạ tầng chốt ở **`specs/infrastructure.md`**. app LIVE trên Cloudflare Pages (https://map-canvasm.pages.dev) + realtime 100% Durable Objects (06-17). **CÒN NỢ chặn tháng 7: B1 spend-cap (Luân) + B3 rotate (Luân) + B5 daily-token-room cap + Recording MVP.** **B8 STT-default-OFF = ✅ (verified) + consent gate ship 06-23 ⇒ B8 GIỜ ĐÃ CƠ BẢN ĐÓNG** (xem delta). Chairman = spec REFRAME, CHƯA code (cố ý). Chi tiết: `logs/2026-06-17.md` → `2026-06-23.md`.

> **📊 ĐÁNH GIÁ NHANH (06-23) — đứng đâu:** **Hạ tầng + tiền + bảo mật phần lớn đã khoá; tuần 06-20→23 đẩy mạnh lớp SẢN PHẨM (post-meeting deliverable + knowledge layer).** Blocker B1–B11: B2,B4,B6,B7,B9,B10 ✅; B11 huỷ; **B8 giờ cơ bản đóng** (STT default-OFF ✅ verified + consent gate đã ship). Còn nợ tháng 7: **B1** (trần chi GCP/Deepgram/Daily — việc Luân, làm TRƯỚC) · **B3** (rotate secrets — việc Luân) · **B5** (chặn auto-tạo Daily room — code M) · **Recording MVP** (feature lớn còn lại). **Tháng 7 (test nội bộ) gần sẵn sàng**; rủi ro còn lại là *soft host-control* (chấp nhận cho nội bộ). **Tháng 8 (khách ngoài)** cần thêm: cohost server-validation (kick/mute qua DO — ⏳ verified CHƯA làm, DO vẫn relay byte), email-verify out-of-band, ~~guest data-lifecycle~~ (**revoke≠delete giờ đã SHIP** — verify code, xem cuối doc) — xem cuối doc.

## 🔼 Delta 06-18 → 06-19 (cập nhật trạng thái)

> Hai ngày này KHÔNG tiến roadmap-đã-định (Daily caps / Chairman / Recording) — test live PC↔iPad lộ một cụm bug nền tảng (nghe tiếng, phiên âm, khách vào họp) nên ưu tiên dập. Kết quả: **STT giờ ra chữ thật trên thiết bị thực.** Hạ tầng đã chốt gom vào **`specs/infrastructure.md`** (mới).

**✅ DONE thêm (06-18/06-19):**
- **STT THỰC SỰ CHẠY** — root-cause `[object Blob]` (Cloudflare WS giao Blob ≠ Node ArrayBuffer → `send(blob)` thành text `"[object Blob]"` → Deepgram `SchemaError` mọi frame, mọi provider). Fix 1 dòng `server.binaryType="arraybuffer"` (`worker/src/stt.ts`, `61bc0b00`). Trước đó 06-18 đã loại trừ ngôn ngữ (nova-3 có ko/vi/en, `keyterm` chỉ khi `ko`, bỏ `numerals`), clone track iOS, worklet flow.
- **Caption system per-view** — `captionSurfaceAtom` (`captionState.ts`) định tuyến **đúng 1 surface/view** (giết double-mount / rò canvas trần); **Caption Dock** per-viewer (font S/M/L) cho present/share; Full/Compact toggle; auto-scroll stick-to-bottom; toggle CC ở header (`e0ea5c42`, `e54cf608`, `deccbef2`, `cd124eaf`).
- **Audio optimize** — chống ồn (box-filter anti-alias downsample trong worklet) + giảm latency (chunk 250→100ms + endpointing Deepgram) (`33f78d48`). Audio iPad→PC FIX (publish mic sau join, autoplay capture-phase) (06-18).
- **Share-window resilience** — người share re-announce qua `broadcastScreenShareSnapshot()` ở new-user handler → viewer refresh/vào-muộn lại thấy share (`9f96ec05`). _(Giới hạn: chính người share reload thì browser xé `getDisplayMedia` — phải chọn lại.)_
- **Đồng bộ UI transcription** — indicator "đang thu" lái bằng **PCM thật**; panel/caption đồng bộ Glass-Desk; sửa dropdown provider thiếu style; host thấy guest knock (`viewerAuthority` thay `iAmHost`, `e8a39e10`).
- **Guest deadlock FIX (06-18)** — khách qua portal-tile bị 403/"Couldn't open" do `room_key=null` trước khi kịp vào lobby knock → client cho park ở phòng chờ với key rỗng, fetch lại key thật sau admit. _(Server strip giữ nguyên.)_

**⏳ CÒN NỢ / PHASE SAU (cập nhật 06-19):**
- **Option Gemini Live cho STT** — provider `gemini-live` (`gemini-3.5-live-translate-preview`) skeleton qua REGISTRY; **đang wire API**, chưa xong; cần secret `GEMINI_LIVE_API_KEY`.
- **Thực thi chiến lược design-system** theo `plans/design-system-unification.md` (06-19, mới có plan): hợp nhất token dashboard(Glass-Desk)↔canvas, P0→P3. 2 quyết định P3 còn treo: **accent hue** + **typography**.
- **Recording MVP** (Phase 5, tháng 7) — chưa build.
- **Chairman MVP** — spec xong, chưa code.
- **Admin Daily-caps** — chuyển 2 cap hardcode (exp 6h / max 50) sang `system_settings` + ô Settings (spec `daily-usage-admin.md`), chưa làm.
- **B1 spend-cap** (Luân) + **B3 rotate secrets** (Luân) — vẫn CÒN.
- **B8 STT default-OFF + consent banner** — default-OFF có, banner còn thiếu (cần khi đi đa quốc gia).
- **Cohost server-validation** (kick/mute live qua DO) — tháng 8, track I-2.
- _(Merge branch `fix/live-bugs-video-audio-stt-translate` về master — 06-19 đã làm thẳng trên master, dải `d75e7588…7dd1f407`.)_

## 🔼 Delta 06-20 → 06-23 (cập nhật trạng thái)

> Tuần này đẩy lớp **SẢN PHẨM** (post-meeting deliverable + knowledge/info layer) thay vì hạ-tầng. Hai cột mốc lớn (**Meeting Package** đủ vòng đời + **Event-Log P1 + consent**) + một **quyết-định-sản-phẩm gốc rễ** (REFRAME "giám sát" → "thông tin dự án"). Làm thẳng trên `master`, dải `dd073366…8ab8b063`. Migration **0031–0034 đã apply remote**. Log chi tiết: `logs/2026-06-23.md`. Spec sống đã cập nhật (KHÔNG lặp lại ở đây): [meeting-package.md](meeting-package.md) (SHIPPED), [meeting-event-log.md](meeting-event-log.md) (P1 LIVE), [event-log-privacy-analysis.md](event-log-privacy-analysis.md), [../specs/chairman-account.md](../specs/chairman-account.md) (REFRAME/SUPERSEDED).

**✅ DONE thêm (06-20 → 06-23):**
- **Meeting Package — full feature** _(`dd073366` → `8ab8b063`)_. Vòng đời: **curate** (chọn file deliverable, loại file canvas nội bộ) → **recap** (`recap.html` self-contained: **board PNG dark** + summary + **chat đã giải mã** + file list; trước chỉ là danh sách file) + **local attachment** (kéo file máy vào, materialise thành `file` row) + **tên mặc định** → **audience** `meeting`/`project`/`list` + **member picker** → **publish/draft** → **distribution** (`SharedWithMe.tsx` nội bộ nhóm theo project/meeting + unread badge; `ClientPortal.tsx` khách ngoài; **badge "Recap"** trên meeting card; email-notify audience `list`) → **management** (unpublish, **soft-delete + restore**, recipient **revoke + restore**) → **export STORE-zip in-worker** (`GET /v1/packages/:id/export`, tự thêm đuôi file đúng + cache R2). _Verify schema: `worker/schema/0032_meeting_package.sql` (3 bảng) + `0034_meeting_package_manage.sql` (`ADD COLUMN deleted_at`). Verify routes: `index.ts` `/v1/meetings/:roomId/packages`, `/v1/packages/:id` (+`/files/:fileId`,`/recap`,`/publish`,`/unpublish`,`/export`,`/restore`,`/recipients…`), `/v1/me/packages`; gate `canEditMeeting`(write)/`canSeePackage`(read); tạo 409 nếu cuộc chưa `finished`. Mọi read filter `deleted_at IS NULL`; recipient revoke = flip `status`, KHÔNG hard-delete._
- **Meeting Event-Log P1 MVP + consent gate** _(`07ed97a4`, `fe0baf72`)_. Bảng `meeting_event` (timeline server-đọc-được, id ổn định `<meetingId>:<kind>:<seq>` idempotent upsert) + `meeting_consent` (bảng RIÊNG, compliance fact). **Consolidate-on-end**: lúc End-for-all client (giữ room-key) đọc blob chat+transcript đã flush → parse `transcript.segment`+`chat.message` plaintext → POST cả lô (0 đổi luồng live, chạy 1 lần; `data/meetingEventLog.ts`). `POST/GET /v1/meetings/:roomId/events` (gate `canSeeMeeting`) + `POST .../consent`. **`MeetingConsentGate.tsx`** hiện lúc join (có **language switcher** vi/en/ko, version hoá `CONSENT_VERSION`). _Verify: `worker/schema/0033_meeting_event.sql` (2 bảng, comment ghi thẳng "NO per-person behavioral scoring/sentiment/profiling/covert monitoring"); `index.ts:2688/2785/2806`; component `excalidraw-app/components/mcm/MeetingConsentGate.tsx`._
- **REFRAME chủ sản phẩm** _(`64bb449f`, `ff27cda3`, `ac56e74c`)_ — event-log + tài khoản "Chairman" cũ **KHÔNG phải giám sát nhân viên** → đóng khung lại thành **tầng thông tin/kiến thức dự án** (AI hiểu dòng chảy + lãnh đạo đọc thông tin dự án **CÓ CÔNG BỐ** qua gate). **BỎ**: stealth/tàng hình → đọc-có-công-bố (consent gate đã ship); chấm điểm hành vi per-person (`chairman_insight`) → BỎ; "quyền tối thượng kể cả 1:1/HR" → disclosure+consent+retention. Kèm **phân tích pháp lý** (KR PIPA/CSA hình sự với 1:1, PH NPC, VN PDPL 2025, EU GDPR Đ.22) ở `plans/event-log-privacy-analysis.md`. `specs/chairman-account.md` đã dán banner SUPERSEDED.
- **Dashboard sidebar IA redesign** _(`056b8466`)_ — `ProjectBrowser.tsx` chia lại sidebar trái (Internal / Workspace / Projects-by-status) + fix scroll/overlap Shared-with-me.
- **Fix gói nhỏ:** avatar phục vụ public không cần JWT (`e1f6ab84`); meeting-card redesign action-luôn-hiện state-aware + icon Review≠Details (`1c33764e`,`a65975e3`); package modal portal+background (`283552b5`,`90e3a0fb`); **AI summary tổng hợp cả cuộc** (transcript+chat+canvas) + UX 429 cooldown (`377fb213`); khách hết họp graceful tức thì (`b4b7254a`); scrollbar portal sections (`fe0baf72`).

**⏳ CÒN NỢ / PHASE SAU (cập nhật 06-23):**
- **B8 STT default-OFF + consent** — **GIỜ CƠ BẢN ĐÓNG.** STT default-OFF ✅ _verified `excalidraw-app/data/transcription.ts:72` `atom<boolean>(readBool(..., false))` + comment "Default OFF — … privacy decision each user should opt into per device"_; **consent gate** lúc join đã ship 06-23 (notice ghi-âm + AI-xử-lý, version hoá, language switcher) ⇒ disclosure cần cho đa quốc gia đã có. _(Còn tinh chỉnh: alert phút/ngày Deepgram là nice-to-have.)_
- **Guest data-lifecycle (revoke ≠ delete)** — **GIỜ ĐÃ SHIP** (verify code, không còn hard-delete guest): `DELETE /v1/projects/:projectId/guests/:id` (`index.ts:4332`) làm **soft-revoke** (`UPDATE project_guest SET status='revoked', revoked_at` + Supabase **BAN** không DELETE + cascade `meeting_invitee` → revoke=kick) + `POST .../guests/clean` retire-không-delete (`index.ts:4387`, comment "NEVER deletes"). Plan `guest-data-lifecycle.md` banner "cần sửa/hard-delete" nay STALE — đã cập nhật.
- **Recording MVP** (Phase 5, tháng 7) — vẫn CHƯA build.
- **Chairman MVP** — spec đã REFRAME (disclosed + leadership-read), CHƯA code (cố ý: chờ exec quyết có build trước tháng 8 không).
- **B1 spend-cap** (Luân) + **B3 rotate secrets** (Luân) + **B5 chặn auto-tạo Daily room** — vẫn CÒN.
- **Cohost server-validation** (kick/mute live qua DO) — ⏳ verify CHƯA làm: `roomDO.ts` chỉ relay byte, host election vẫn **client-side** (`roomDO.ts:124` "host-election dedup key, client-side"); DO không validate `HOST_COMMAND`. Tháng 8, track I-2.
- **Gemini Live STT** skeleton — vẫn chưa wire xong; **design-system unification** (`plans/design-system-unification.md`) chưa thực thi.

---

## 🎯 Ưu tiên 1–2 tuần tới (chốt 06-17 cuối ngày)

> _(Cập nhật 06-23: **B8 đã cơ bản đóng** (STT default-OFF ✅ + consent gate ship) — gỡ khỏi MUST. **Guest data-lifecycle đã ship** (soft-revoke, verify code) — gỡ khỏi CAN-WAIT.)_

**MUST cho THÁNG 7 (test nội bộ) — theo thứ tự:**
1. **B1 spend-cap** (Luân, 30') — đặt budget/quota GCP-Gemini + Deepgram + Daily. *Hàng rào tiền cứng, làm TRƯỚC tất cả.*
2. **B3 rotate secrets** (Luân) — xoay toàn bộ key đã từng commit.
3. **B5 chặn auto-tạo Daily room** + rate-limit `/daily/token` (code M) — chống loop đốt phí.
4. **Phase 5 Recording → R2** (feature lớn còn lại của tháng 7) — Daily cloud recording → webhook → R2 auth-gated → xem trong review-mode.
5. **Smoke-test DO 2-client thật** + test 2-account (invite→magic-link→auto-join, revoke=kick ≤60s) trên prod.
6. **R2 lifecycle rule trên `trash/`** (Luân) + dọn Daily-room orphan trong cascade.

**CAN-WAIT cho THÁNG 8 (khách ngoài):**
7. **Cohost server-validation (kick/mute live qua DO)** — đóng nốt host-control client-soft (track I-2). _(⏳ verify CHƯA làm.)_
8. **Email-verify out-of-band** cho khách thật.
9. **(tuỳ exec) Chairman account MVP** — spec đã REFRAME (disclosed + leadership-read, bỏ stealth/scoring); nếu lãnh đạo muốn oversight thì build.
10. **Regenerate architecture.md** (bản hiện tại 06-19 — stale so với 06-20→23: thiếu Meeting Package / Event-Log / consent).

---

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

- [x] **Phòng chờ (waiting room)** — khách ngoài vào link → login → **gõ cửa + chờ host duyệt**; nội bộ @mapgroup **auto-admit**. _(06-16, commit `37e5953c` + fix `3e13f1c2`/`95942b6c`; **verified live 06-17** — anh Luân test tay OK.)_ Cổng duyệt **ép server ở Daily token** (decision **1a**, migration `0025_meeting_knock`): external chưa admitted → không token → không audio. `WaitingRoom.tsx` (clone WaitingForStart, poll 5s, vào muted) + mục "Waiting (knocking)" + Admit/Deny + badge "N waiting" trong ParticipantsBar. **Còn 1b:** canvas relay vẫn trust-the-key → auth room server TRƯỚC khi mở cho khách ngoài thật.
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

### Phase 5 — Recording → R2 (auth-gated) — _scope tháng 7, CHƯA build (06-17)_

> Backup/DR foundation cho recording đã có (soft-delete `trash/`, archive, IA-tier plan ở `runbooks/backup.md`) nhưng **luồng recording chính chưa làm**. Đây là feature lớn còn lại của tháng 7.

- [ ] **Daily cloud recording** (audio+screen đều trên Daily) → webhook `recording.ready` → **Worker copy về R2 private** (Daily không ghi thẳng R2 — chỉ AWS S3).
- [ ] **Tải qua Worker có auth** (verify JWT + membership) — không link công khai. R2 vì **egress free** (S3 ~$0.09/GB).
- [ ] Xem lại trong **review-mode** của cuộc họp đã xong.
- _(Ghi server-side vì host có thể là máy bất kỳ/yếu.)_

---

### Phase A — Admin Console (track riêng)

Lớp back-office quản trị toàn hệ thống (KHÁC host). **Admin = account RIÊNG** (`admin@mapgroup.co.kr`, role qua Supabase `app_metadata`); **không meeting host nào là admin**. Module: Dashboard · Users&Roles · Meetings · Recordings · Cost&Usage · API/Integrations · Storage · Audit log · Security · Settings · Analytics · Compliance/GDPR · Announcements. → spec đầy đủ: **[admin-console.md](../specs/admin-console.md)**. Build: A1 (role+gate+/admin+Dashboard+Users+Meetings) → A2 (Cost+API+Recordings+Storage+Audit) → A3 (Security+Settings+Analytics+Compliance).

**Tiến độ 06-17:** ✅ role+gate+console + Users + Meetings + **AI&Cost tab** (đo `usage_events`, metering FIXED bằng `waitUntil`) + **System-status tab** + **Realtime monitor tab** (DO connections + reject audit) + **Backup DB / Archive&Delete project / weekly Cron** + **client backdrops/branding upload** (per-country). ⏳ Còn: Recordings tab (chờ Phase 5), Security/Settings/Analytics/Compliance (A3), Audit-log viewer UI.

---

## 🏗️ Track HẠ TẦNG PRODUCTION (song song feature phase — audit 3-team 2026-06-05)

> Feature phase 1-5 ở trên là **tính năng**. Để **chạy production thật** còn cả track hạ tầng — trước đây rải rác / thiếu khỏi roadmap. Bảo mật: secrets **KHÔNG lộ trên git** (đã verify history sạch); rotate = phòng ngừa trước prod.

> _(Các mục SÓT đã được đưa vào **Phase 6** & **Phase 7** ngày 06-17 — không còn orphan. Giữ nhãn I-x trong ngoặc để truy vết.)_

### 🟠 Phase 6 — Production hardening = **CỔNG GO-LIVE tháng 7** (audit 3-team 06-17)

> 11 blocker; phần lớn là **việc S của Luân (ops/secrets/cost)**, không phải code dev. Effort: S <1 ngày · M 1-3 ngày. Thứ tự = "chặn máu" trước.

**Tuần 1 — chặn tiền + bảo mật + dữ liệu (gần như toàn Luân):**
- **B1 · Spend-cap** GCP/Gemini + Deepgram + Daily quota (30', hàng rào tiền *duy nhất app-bug không vượt được* — làm TRƯỚC mọi rate-limit). **S** ⏳ _**CÒN — việc anh Luân (ưu tiên #1 cho tháng 7).** Rate-limit per-isolate ở Worker đã có (B7 ✅) nhưng đó KHÔNG phải trần tiền cứng — vẫn cần đặt budget/quota ở dashboard GCP + Deepgram + Daily._
- **B2 · Migration remote** ✅ _06-17: áp **0017–0027** lên remote D1, **27/27** schema_version khớp (knock `0025` + usage `0026` + `realtime_backend` `0027`). **Cập nhật 06-23: 0028–0034 cũng đã apply remote** (usage `0028`, client-branding `0029`, owner-audit `0030`, file-thumb `0031`, **meeting_package `0032`**, **meeting_event/consent `0033`**, **package-manage `0034`**)._
- **B3 · Rotate toàn bộ secrets** (Gemini/Deepgram/Supabase/Daily/Resend) — key đã commit = coi như lộ; thay `*.example` + pre-commit hook chặn `.env.development`/`.dev.vars`. Rotate = cách thật duy nhất (hook chỉ chặn commit mới). **S** ⏳ _CÒN — việc anh Luân; key 06-17 đã set sạch BOM nhưng VẪN phải xoay trước external._
- **B4 · Bỏ password khỏi email mời** (`/v1/guests/send-invite` nhúng `password` → magic-link). **S** ✅ _verified lỗ có thật → đã fix._
- **B6 · Khoá CORS** Worker `origin:"*"` → allowlist (bearer-not-cookie; **đừng** thêm CSRF token). **S** ✅ _06-17: allowlist + cho private-LAN (RFC1918) để dev qua LAN gọi Worker online y hệt prod._
- **B9 · DR** ✅ _06-17: export D1 thủ công + **restore-test PASS**. R2 **KHÔNG có S3 versioning** → soft-delete blob sang prefix `trash/` (`8f637542`) thay vì xoá vĩnh viễn; **còn**: gắn R2 lifecycle rule trên `trash/` (việc anh Luân)._ **(I-4)**

**Tuần 2 — hosting + ổn định:**
- **B10 · Deploy app Cloudflare Pages** ✅ _06-17: **app LIVE tại https://map-canvasm.pages.dev** — toàn stack online trên Cloudflare, không còn máy dev/room server/Fly. PWA manifest rebrand Excalidraw→Canvas M._ **(I-3)**
- ~~**B11 · Room server → container bền**~~ ❌ **HUỶ** _06-17: room server socket.io bị **khai tử** (realtime → 100% Durable Objects, xem Phase 7/I-2). Không còn server Node để giữ sống._
- Phụ: **Daily room orphan** — `deleteDailyRoom()` vào `deleteMeetingCascade`; **scrub hardcoded pw** `MapMeet@2026`/`MapAdmin@2026` (14 file → seed script). **S**

**Tuần 3 — cost guard:**
- **B5 · Chặn `/v1/daily/token` auto-tạo room** → chỉ host/owner `POST .../daily-room` + rate-limit (~1 req/s/user). **M** ⏳ _CÒN — cost-guard tháng 7 (token đã gate `canSeeMeeting`+knock; chưa chặn auto-create room loop)._
- **B7 · Auth + rate-limit AI/STT routes** ✅ _06-17: AI/STT dời lên Worker (I-1, `8e734411`) + **JWT-gate** (`9c72569b`, đóng lỗ cost-abuse public) + rate-limit **per-isolate** (đủ cho internal). Nâng DO/KV-limiter chỉ khi external lạm dụng thật._
- **B8 · STT default OFF** + banner consent + alert phút/ngày (Deepgram tính phút×người); log usage vào `usage_events` (migration `0028` ✅ applied remote 06-17). **S** ✅ _CƠ BẢN ĐÓNG 06-23: **STT default-OFF** ✅ verified (`excalidraw-app/data/transcription.ts:72`, atom mặc định `false` + comment "privacy decision … opt into per device"); **consent gate** lúc join đã ship (`MeetingConsentGate.tsx`, notice ghi-âm+AI-xử-lý, version hoá, language switcher vi/en/ko) → disclosure cho đa quốc gia ĐÃ CÓ; usage đo + hiện trên admin Cost/Status tab. Còn nice-to-have: alert phút/ngày Deepgram._

**Tuần 4 — runbook + verify:**
- **(I-6) Runbooks** `docs/runbooks/`: deploy · key-rotation · incident (room crash→restart; data-loss→restore). Ngắn, cho PM tự làm.
- **(I-5) Observability** — tạo Sentry project + DSN prod (*nice-to-have, không khối launch*); server-side log = `wrangler tail` + `docker logs` (KHÔNG pino/Datadog). CI **chỉ** dùng cho cron `wrangler d1 export` → R2.
- **Test 2-account thật:** invite → magic-link → auto-join; confidential (member B 403); revoke = kick ≤60s.
- ~~**Daily-token check membership**~~ ✅ 06-16: token gate `canSeeMeeting` + (external) **admitted-knock**, base meeting id (strip `-audio`).
- Token refresh họp >4h (Daily token hết hạn 4h) · scene size limit — *để sau nếu chưa đụng.*

**→ Tháng 8 (mở khách ngoài) — GAP CÒN MỞ (verify code 06-17):**
- ~~**1b auth room server**~~ ✅ **đã đóng bởi DO handshake 06-17** — verify code: `handleRealtimeUpgrade` (`index.ts:5515`) verify **JWT + canSeeMeeting + isFinishedLocked + knock-admitted + WS-cap** TRƯỚC khi trả `101`. Lỗ relay-không-verify (socket.io không bao giờ vá) đã đóng.
- ⏳ **Cohost server-validation (kick/mute live)** — DO chỉ relay byte, **KHÔNG** validate `HOST_COMMAND`; host election + kick/mute vẫn **client-soft** (`roomDO.ts:109` "client-side"). Khách ngoài có thể spoof host-claim → phải để DO đọc role cohost/host từ D1 + ép kick/mute server-side. **(blocker tháng 8, track I-2.)**
- ⏳ **Email-verify out-of-band** (xác thực email khách thật trước khi cấp quyền).
- ✅ **Guest data-lifecycle (revoke ≠ delete)** — **ĐÃ SHIP (verify code 06-23, không còn hard-delete):** `DELETE /v1/projects/:projectId/guests/:id` (`index.ts:4332`) = soft-revoke (`UPDATE project_guest SET status='revoked', revoked_at` + Supabase **BAN** không DELETE + cascade `meeting_invitee` revoke=kick); `POST .../guests/clean` (`index.ts:4387`) retire-không-delete (comment "NEVER deletes — … AI moat are preserved"). Plan `guest-data-lifecycle.md` banner "cần sửa" nay STALE → đã cập nhật. _(Còn để sau: route anonymize-on-erasure cho GDPR, nice-to-have.)_
- ⏳ **(tuỳ chọn exec) Chairman account** — spec đã **REFRAME** (`specs/chairman-account.md`: disclosed + consent + leadership-read, BỎ stealth + per-person scoring), CHƯA code. Nếu lãnh đạo muốn đọc thông tin dự án xuyên-org (có công bố + audit) thì build trước tháng 8; nếu không, để sau. _(Event-log P1 + consent gate đã đặt nền cho hướng này.)_
- _KHÔNG over-engineer: bỏ multi-region/k8s/E2E-crypto/SSO/CI-CD-deploy — xem audit mục 5._

### 🟣 Phase 7 — Serverless infra migration (June) — **BUILT + DEPLOYED LIVE 06-17**

> Dời lớp compute + realtime khỏi room server (Node đơn) sang **Cloudflare serverless** theo [kế hoạch hạ tầng tháng 6](2026-06-01-plan-ha-tang-cloudflare.md) (Worker/Durable Objects, D1+R2, `wrangler secret`). P1 remote (D1+R2+secrets) LIVE 06-11; **06-17 cắt nốt transport + AI → toàn stack serverless trên Cloudflare**.

- [x] **(I-1) AI/STT dời lên Worker** ✅ _06-17 (`8e734411`)_ — Gemini (`/translate`,`/translate-batch`,`/summarize`,`/chatbot`) → `ai.ts`; Deepgram `/stt` → `stt.ts` WS proxy **route riêng** (switch theo `pathname` trước `.get()` DO). Cache/rate-limit per-isolate; **JWT-gated** (`9c72569b`). TURN đã BỎ.
- [x] **(I-2) Realtime → Durable Objects** ✅ **BUILT + DEPLOYED LIVE 06-17** _(không còn post-launch — đã online)_. socket.io 1-instance (SPOF) → **1 DO/phòng** trên Worker `mcm-storage`, raw WebSocket + **Hibernation API** (idle → $0). Build qua 10 slice + audit parity 100% + consolidation (bắt 2 bug tích hợp). **Meeting mới default `realtime_backend='do'`** (`f3631fb1`). **Admin "Realtime" monitor tab** (`36831dce`).
  - **→ Kế hoạch chi tiết:** [durable-objects-migration.md](durable-objects-migration.md) (`68fde99e`). **CHỐT 100% DO** (`c25a929e`): **bỏ Fly.io bridge, khai tử room server socket.io** — dự án đi đa quốc gia (Phi/Africa). Cờ `realtime_backend` chỉ là công tắc TẠM trong build/test; đích = pure DO + bỏ hẳn `room/`.
  - **Đóng 1b/B12:** handshake WS verify **Supabase JWT + canSeeMeeting + knock** Ở WORKER trước khi trả `101` — lỗ relay-không-verify mà socket.io không bao giờ vá. _(Cũng mở khoá election live đọc role cohost cho kick/mute — track I-2 ở Phase 4.)_
  - **Hard-break đã fix:** LIBRARY_FILE → **R2-by-reference** (`a85b1f64`, Workers WS cap 1 MiB).
  - **Còn lại:** smoke-test 2-client live + slice-9 E2E/load (fanout 20s, eviction, hibernation 0-wake) trên DO đã deploy — xem `logs/2026-06-17.md`.

### ✅ Đã có chỗ trong phase (audit xác nhận thêm chi tiết)

- **P4** cần D1: bảng **membership** (ai vào meeting nào) + **waiting_room** (duyệt khách) + **meeting.status** ('finished') + **DELETE meeting cascade** (xoá D1 + R2) + middleware **per-meeting authz**.
- **P5** cần: **Daily webhook** (`recording.ready-to-download`) + route `/v1/recordings/:id` (auth+membership) + copy→R2 + lifecycle (xoá bản Daily sau copy) + **dọn Daily room** + quota.

### 🧹 Dọn dẹp / nợ nhỏ

- ✅ Xoá **mesh dead code** (`AudioRoom`/`AudioPeer`/`turnConfig`) — dropped 06-17 (`746eb8ca`).
- ✅ **R2 orphan/soft-delete** — blob meeting bị xoá → `trash/` (B9, `8f637542`). Còn: gắn lifecycle rule trên `trash/` (việc Luân) + dọn Daily room orphan trong cascade.
- **E2E key hardening** — `room_key` lưu D1 (server đọc được, không E2E thật). **Chủ ý giữ** (managed key = nền cho admin compliance + Chairman); chỉ ghi rõ là ranh giới *chính sách* không phải mật mã thuần — KHÔNG nâng lên client-only-key vì sẽ phá compliance/Chairman (xem `specs/chairman-account.md §4`).
- **Gộp audio+screen 1 Daily room** (giờ 2 room `<id>` + `<id>-audio`) cho unified recording + giảm cost — làm chung với Phase 5.
- **Data residency** (R2/Daily region) cho client xuyên quốc gia; **mời theo email cụ thể** + invite UI.
- **Regenerate `docs/generated/architecture.md`** — bản hiện tại **2026-06-19** (đã regen 1 lần ở `49f52375`), nhưng nay **STALE so với 06-20→23**: KHÔNG có Meeting Package (0032/0034), Event-Log + consent (0033), reframe Chairman, dashboard sidebar IA. Tạo lại bản 06-23 (file SINH TỰ ĐỘNG — **đừng hand-edit**, regenerate).

---

## Lịch sử đánh số (để khỏi lẫn)

Số phase từng đổi trong ngày 2026-06-05: ban đầu Recording=Phase 2/3, Auth=Phase 4; sau **đảo lại** vì tải recording cần auth trước. **Số HIỆN TẠI (doc này) là chuẩn**: 1 screen-share, 2 audio, 3 auth, 4 host-control, 5 recording.
