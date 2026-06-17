# MCM Roadmap — các Phase đang follow

> **🎯 HAI MỐC GO-LIVE (chốt 06-17):** **Tháng 7 = TEST NỘI BỘ** (chỉ @mapgroup) · **Tháng 8 = MỞ KHÁCH NGOÀI**. Tháng 7 gồm Recording (P5) + full Admin Console (P-A) + Phase 6 hardening (B1–B11), **trừ 1b** (canvas-relay-auth = chấp nhận tạm cho nội bộ). Tháng 8 thêm **1b auth room server + email-verify + cohost server-validation** trước khi mở external. Chi tiết blocker: memory `mcm-july-v1-scope` + audit task `wztvf5jk8`.

> Nguồn tham chiếu **chuẩn duy nhất** cho các phase. Chi tiết kỹ thuật từng phase nằm ở daily log (`docs/logs/YYYY-MM-DD.md`) + memory. Cập nhật lần cuối: **2026-06-17 (cuối ngày, sau lượt ship lớn)** — **app LIVE trên Cloudflare Pages (https://map-canvasm.pages.dev) + realtime 100% Durable Objects** (DO migration BUILT + DEPLOYED + **client ép DO theo build**, nuốt 1b/B12; room server socket.io/Fly bị khai tử). I-1 (AI/STT → Worker) DONE, B10 (Pages) DONE, **B9 DR (backup/archive/cron/trash) DONE**, **B7 AI rate-limit DONE**, **AI cost-metering FIXED (`waitUntil`)**, **D1 migration 0029**. Phase 6 go-live blocker phần lớn ✅ (chi tiết dưới). **CÒN LẠI chặn tháng 7: B1 spend-cap (Luân) + B3 rotate (Luân) + B5 daily-token-room cap + B8 STT-OFF/consent.** Chairman = đã viết spec (`specs/chairman-account.md`), CHƯA code. Chi tiết hôm nay: `logs/2026-06-17.md`.

> **📊 ĐÁNH GIÁ NHANH (06-17 cuối ngày) — đứng đâu:** **Hạ tầng + tiền-mặt-tích-cực phần lớn đã khoá.** 8/11 blocker B1–B11 đã đóng (B2,B4,B6,B7,B9,B10 ✅; B11 huỷ). 3 việc còn lại đều **ngắn**: **B1** (đặt trần chi GCP/Deepgram/Daily — 30', việc Luân, làm TRƯỚC) · **B3** (rotate secrets — việc Luân) · **B5+B8** (chặn auto-tạo Daily room + STT-default-OFF — code S). **Tháng 7 (test nội bộ) gần sẵn sàng**; rủi ro còn lại là *soft host-control* (chấp nhận cho nội bộ). **Tháng 8 (khách ngoài)** cần thêm: cohost server-validation (kick/mute) qua DO, email-verify out-of-band, guest data-lifecycle (revoke≠delete) — xem cuối doc.

## 🎯 Ưu tiên 1–2 tuần tới (chốt 06-17 cuối ngày)

**MUST cho THÁNG 7 (test nội bộ) — theo thứ tự:**
1. **B1 spend-cap** (Luân, 30') — đặt budget/quota GCP-Gemini + Deepgram + Daily. *Hàng rào tiền cứng, làm TRƯỚC tất cả.*
2. **B3 rotate secrets** (Luân) — xoay toàn bộ key đã từng commit.
3. **B8 STT default-OFF + banner consent** (code S) — đặc biệt cho đa quốc gia/Phi.
4. **B5 chặn auto-tạo Daily room** + rate-limit `/daily/token` (code M) — chống loop đốt phí.
5. **Phase 5 Recording → R2** (feature lớn còn lại của tháng 7) — Daily cloud recording → webhook → R2 auth-gated → xem trong review-mode.
6. **Smoke-test DO 2-client thật** + test 2-account (invite→magic-link→auto-join, revoke=kick ≤60s) trên prod.
7. **R2 lifecycle rule trên `trash/`** (Luân) + dọn Daily-room orphan trong cascade.

**CAN-WAIT cho THÁNG 8 (khách ngoài):**
8. **Cohost server-validation (kick/mute live qua DO)** — đóng nốt host-control client-soft (track I-2).
9. **Email-verify out-of-band** cho khách thật.
10. **Guest data-lifecycle (revoke ≠ delete)** — sửa chỗ hard-delete → soft-revoke.
11. **(tuỳ exec) Chairman account MVP** — nếu lãnh đạo muốn oversight; spec đã sẵn.
12. **Regenerate architecture.md** (đang stale 06-11).

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
- **B2 · Migration remote** ✅ _06-17: áp **0017–0027** lên remote D1, **27/27** schema_version khớp (knock `0025` + usage `0026` + `realtime_backend` `0027`)._
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
- **B8 · STT default OFF** + banner consent + alert phút/ngày (Deepgram tính phút×người); log usage vào `usage_events` (migration `0028` ✅ applied remote 06-17). **S** ⏳ _CÒN: usage đã đo + hiện trên admin Cost/Status tab (06-17); **chưa** set STT default-OFF + banner consent. Nhẹ — làm cho tháng 7 (consent đặc biệt cần khi đi đa quốc gia/Phi)._

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
- ⏳ **Guest data-lifecycle (revoke ≠ delete)** — code hiện hard-delete guest ở vài đường; cần đổi sang soft-revoke giữ history (memory `mcm-guest-data-lifecycle`, plan `guest-data-lifecycle.md`). Quan trọng khi có khách thật + đa quốc gia.
- ⏳ **(tuỳ chọn exec) Chairman account** — spec xong (`specs/chairman-account.md`), CHƯA code. Nếu lãnh đạo muốn giám sát/oversight xuyên dự án thì build trước tháng 8; nếu không, để sau.
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
- **Regenerate `docs/generated/architecture.md`** — đang STALE (06-11, banner đã cảnh báo): mô tả room-server socket.io đã khai tử, §5 known-gaps liệt kê nhiều thứ nay đã đóng (CORS, rate-limit, backup/DR, finished blob-PUT). Tạo lại bản 06-17 (đừng sửa tay).

---

## Lịch sử đánh số (để khỏi lẫn)

Số phase từng đổi trong ngày 2026-06-05: ban đầu Recording=Phase 2/3, Auth=Phase 4; sau **đảo lại** vì tải recording cần auth trước. **Số HIỆN TẠI (doc này) là chuẩn**: 1 screen-share, 2 audio, 3 auth, 4 host-control, 5 recording.
