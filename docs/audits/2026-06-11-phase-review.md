# Phase Review — Tổng hợp rà soát toàn bộ kế hoạch (2026-06-11)

> Đường dẫn `docs/...` trong file là vị trí CŨ trước reorg docs 06-11 (xem `docs/README.md`). Tổng hợp từ 5 báo cáo audit cùng ngày: **roadmap-tracks**, **production-data**, **dev-phase-notes**, **feature-phases**, **admin-ops**. Bối cảnh: P1 (hạ tầng remote Cloudflare) vừa xong sáng nay → unlock cutover client + Pages + backup thật. File này KHÔNG sửa doc nào khác — chỉ liệt kê chỗ cần sửa để người/phiên sau quyết.

Ký hiệu: ✅ xong · 🟡 một phần · ⬜ chưa · 💀 stale (doc lệch code) · ❓ không verify được bằng code.

---

## A. BẢNG TỔNG trạng thái (đã khử trùng lặp)

### A1. Tính năng (Phase 1–5, 4.5, A)

| # | Hạng mục | Trạng thái | Ghi chú | Nguồn báo cáo |
| --- | --- | --- | --- | --- |
| 1 | P1 Screen share (Daily.co) | ✅ | lazy-join 2nd call object, verified live | roadmap |
| 2 | P2 Audio → Daily SFU | ✅ | caveat: **chưa test mic 2 máy thật** (AU1+H6 ❓); mesh dead code chưa dọn | roadmap, dev-phase-notes |
| 3 | P3 Supabase Auth | ✅ | Worker JWKS gate `/v1/*`, remote smoke 06-11 no-token→401 | roadmap |
| 4 | P4 — Mời theo link + login giữ `#room` | ✅ |  | roadmap, feature-phases |
| 5 | P4 — End-for-all → finished (state machine 409) | ✅ |  | roadmap, feature-phases |
| 6 | P4 — Membership D1 + authz per-meeting + Daily-token gate | ✅ | `canSeeMeeting`, 0008, roomGate | roadmap, feature-phases |
| 7 | P4 — Acting-host election (email → internal → HOSTLESS) | ✅ | server-side validate chưa có (chỉ client validate END/KICK) | feature-phases, dev-phase-notes |
| 8 | P4 — Kick / Mute | ✅ (soft) | client-side, spoofable — đúng như doc ghi nhận | roadmap, feature-phases |
| 9 | P4 — Co-host **chỉ định** (create + edit form) | ✅ | ship 06-10/06-11; **chưa test live 2 account** | feature-phases (roadmap stale) |
| 10 | P4 — Co-host **quyền LIVE** + transfer host thủ công | ⬜ | election KHÔNG đọc role `cohost` → co-host hiện chỉ là nhãn | feature-phases |
| 11 | P4 — Waiting room per-guest | ⬜ | flag `waiting_room` lưu D1 nhưng **0 consumer** — switch trong form là placebo | roadmap, feature-phases |
| 12 | P4 — Revoke-khi-LIVE → kick realtime + huỷ Daily token | 🟡 | revoke soft ✅; kick + huỷ token (4h vẫn sống) ⬜ — **MỒ CÔI, không doc nào track** | feature-phases |
| 13 | P4.5 Scheduling (form/invite/calendar/state-machine/WaitingForStart/reschedule/B+ folder) | ✅ | xác nhận xong thật từng dòng; sót nhỏ: admin filter theo `status` ⬜ mồ côi; email/.ics "để sau" đúng | roadmap, feature-phases |
| 14 | P5 Recording → R2 (Daily cloud + webhook) | ⬜ | 100% trên giấy; hiện = download local máy host (cố ý); **≡ P0.4 production-data-plan** (trùng 2 doc); phụ thuộc "gộp 2 Daily room" chưa được kéo vào checklist P5 | roadmap, production-data, feature-phases |
| 15 | Phase A Admin Console A1–A3 | ✅ | không claim khống; caveat: Cost = ước tính, Recordings placeholder, bảng `usage_events` doc nói "cần" nhưng KHÔNG có migration, module-table over-promise CSV-import/force-logout | admin-ops (roadmap thiếu dòng) |

### A2. Data plan (QĐ + P0–P3)

| # | Hạng mục | Trạng thái | Ghi chú | Nguồn |
| --- | --- | --- | --- | --- |
| 16 | QĐ1 compliance open · QĐ2 My Files · QĐ3 confidential enforce | ✅ | verified code đầy đủ | production-data |
| 17 | QĐ4 AI summary-first | 🟡 | cột D1 + route + auto-recap ✅; đích "/chatbot lên Worker enforce scope" ⬜ — **mồ côi** (chỉ nằm trong QĐ4/I-1, không có dòng phase) | production-data |
| 18 | P0.1–P0.6 (schema_version, internal_domains, transcript R2, tombstone 410, project delete/member) | ✅ | P0.4 recording chủ động "để sau" = P5 | production-data |
| 19 | P1 hạ tầng remote (D1 APAC 16/16 + R2 + 4 secrets + Worker live) | ✅ 06-11 | URL `mcm-storage.rnd-ai.workers.dev`; secrets/migrate-remote tin theo log, không kiểm trực tiếp được | production-data, roadmap |
| 20 | P2 email→UUID + avatar R2 | ⬜ | chưa bắt đầu; **thời điểm backfill rẻ nhất là bây giờ khi remote còn trống** | production-data |
| 21 | P3 Backup/DR + đối chiếu R2↔D1 + xoá Daily room | ⬜ | **VỪA UNLOCK bởi P1**: Time Travel, `d1 export --remote`, R2 versioning đều khả dụng từ hôm nay | production-data, admin-ops |

### A3. Hạ tầng / hardening / dọn dẹp (I, P6, Dọn)

| # | Hạng mục | Trạng thái | Ghi chú | Nguồn |
| --- | --- | --- | --- | --- |
| 22 | I-1 AI/STT/TURN → Worker | ⬜ | đường `wrangler secret` đã chứng minh → chi phí giảm; **TURN nên XOÁ cùng mesh thay vì port** | roadmap, dev-phase-notes |
| 23 | I-2 socket.io → Durable Objects | ⬜ | room/ vẫn 1 instance Node, **socket.io không auth** (gap mồ côi nếu DO trễ) | roadmap, dev-phase-notes |
| 24 | I-3 Deploy production | 🟡 | Worker remote LIVE ✅; còn: **Pages hosting client, cutover `VITE_APP_STORAGE_URL`, CI/CD, domain, staging** | roadmap, dev-phase-notes |
| 25 | I-4 DR: backup D1 + R2 versioning | ⬜ (unlock) | vế "migration chạy tay" trong doc đã chết (migrate.mjs từ 06-10) | roadmap, admin-ops |
| 26 | I-5 Observability | 🟡 | **Workers Logs ĐÃ bật** (`observability.enabled=true`, hiệu lực từ deploy hôm nay — chưa doc nào ghi); Sentry wired nhưng DSN upstream → hiệu lực MCM = 0 | roadmap, dev-phase-notes, admin-ops |
| 27 | I-6 Runbooks | ⬜ | mầm sẵn: log 06-11 §6 (gotcha deploy-trước-secrets) + production-data-plan | roadmap |
| 28 | P6 — Khoá CORS (`origin:"*"` worker L70) | ⬜ |  | roadmap, dev-phase-notes |
| 29 | P6 — Rate-limiting (Worker + room) | ⬜ | 0 hit toàn repo | roadmap, dev-phase-notes |
| 30 | P6 — Rotate keys + password hardcode | 🟡 | `wrangler secret` xong 4 secret; rotate chưa; room keys vẫn `.env`; `DEMO_PASSWORD`/`MapAdmin@2026` + quick-login còn nguyên | roadmap, dev-phase-notes |
| 31 | P6 — SMTP / token refresh 4h / scene size limit | ⬜ |  | roadmap |
| 32 | P6 — Daily-token check membership | ✅ | **xong 06-09 — roadmap quên gạch** (💀) | roadmap vs dev-phase-notes |
| 33 | Dọn — Mesh dead code (AudioRoom/AudioPeer/turnConfig) | ⬜ | ràng buộc: `DailyAudio.ts`/`audioState.ts` import **type** từ AudioRoom — phải tách type trước; chờ test mic | dev-phase-notes |
| 34 | Dọn — Gộp 2 Daily room (`<id>` / `<id>-audio`) | ⬜ | tiền đề bắt buộc của P5 cloud recording | dev-phase-notes, feature-phases |
| 35 | Dọn — E2E thật (bỏ `room_key` khỏi D1 + `mcm:lastMeeting` plaintext) | ⬜ | post-demo | roadmap, dev-phase-notes |
| 36 | Dọn — R2 orphan / meeting rác | 🟡 | phần lớn ✅ (cascade dọn R2, wipe 06-04); còn lại: **Daily room mồ côi không bị xoá** — mồ côi, chưa mục nào track | roadmap, production-data |

**Đếm nhanh:** ✅ **17** · 🟡 **6** · ⬜ **13** (36 hạng mục sau khử trùng lặp).

---

## B. 💀 DANH SÁCH STALE — chỗ cần sửa trong doc

### B1. Doc nói CÒN MỞ nhưng code ĐÃ XONG

| # | File doc | Chỗ cần sửa | Sự thật |
| --- | --- | --- | --- |
| 1 | `docs/roadmap.md` | P6.g "Daily-token check membership" ⬜ | Xong 06-09 (`canSeeMeeting` trong `/v1/daily/token`); dev-phase-notes đã tick — gạch ✅ |
| 2 | `docs/roadmap.md` | P4.d "Co-host + chuyển host" ⬜ toàn phần | Designation ĐÃ ship (create 06-10 + `EditMeetingForm.tsx` 06-11) — tách 2 dòng: designation ✅ / quyền live + transfer ⬜ |
| 3 | `docs/roadmap.md` | I-3 "chưa có gì" | Worker ĐÃ deploy thật `mcm-storage.rnd-ai.workers.dev` — sửa thành: còn Pages + cutover + CI/CD + domain + staging |
| 4 | `docs/roadmap.md` | I-4 vế "migration chạy tay wrangler d1 execute" | `worker/migrate.mjs` + `schema_version` từ 06-10, chạy `--remote` 16/16 hôm nay |
| 5 | `docs/roadmap.md` | Mục "Đã có chỗ trong phase" (P4 cần membership/status/cascade/authz) | 4/5 đã xong (0008 + 0013 + cascade + roomGate); chỉ còn bảng `waiting_room` |
| 6 | `docs/roadmap.md` | Dọn.b "R2 orphan + 3 meeting rác" | `deleteMeetingCascade` dọn R2; meeting cũ wipe 06-04 — còn lại chỉ Daily room mồ côi |
| 7 | `docs/roadmap.md` | Header "Cập nhật 2026-06-10" + thiếu dòng trạng thái Phase A | Cập nhật ngày; thêm dòng ✅ Phase A (kèm caveat Cost/Recordings) |
| 8 | `docs/roadmap.md` | I-5 "chưa wire @sentry" | Sai nhẹ: ĐÃ wire (`excalidraw-app/sentry.ts`) nhưng DSN/hostname upstream → sửa thành "MCM chưa có project Sentry riêng"; bổ sung: Workers Logs đã bật |
| 9 | `docs/production-data-plan.md` | Dòng ~14 "Còn mở: scene-PUT hồi sinh; INTERNAL_DOMAIN hardcode; transcript/summary chỉ localStorage" | Cả 3 đã XONG (P0.2/P0.3/P0.5) — mâu thuẫn với chính bảng P0 cùng file; chỉ còn đúng: recording, avatar |
| 10 | `docs/data-architecture-audit.md` | ~8 finding: §2.1+KN3, §2.3+KN4, §3.1+KN1, §3.2, §3.4+KN2, §3.5+KN7, §3.6, §4, §5+KN5 | Tất cả đã fix trong P0+P1 — đề xuất thêm banner "snapshot 06-10 sáng, trạng thái sống xem production-data-plan §5" để khỏi fix lại lần hai |
| 11 | `docs/dev-phase-notes.md` | H4 "`mutedByHost` chỉ local ở host" | ĐÃ FIX: `ParticipantsBar.tsx` L784-813 đọc AUDIO_STATE thật — tick [x] |
| 12 | `docs/dev-phase-notes.md` | H1 "HOST_COMMAND tin thẳng, không validate" | Sai một nửa: client validate election cho END/KICK đã có (`Collab.tsx` L1339); phần còn mở thật = server-side enforce — sửa câu chữ |
| 13 | `docs/dev-phase-notes.md` | I3 deploy ⬜ | Tách: ✅ Worker remote / ⬜ Pages + CI/CD + domain + staging + cutover |
| 14 | `docs/dev-phase-notes.md` | L30 (backup) + L47 (observability) | Đúng về trạng thái nhưng thiếu note "**đã unlock 06-11, làm được ngay**" + ghi nhận `observability.enabled=true` |
| 15 | `docs/host-and-scheduling.md` | §"⚠️ Phụ thuộc sống còn" ("API mở toang, GET /v1/projects trả MỌI project") | LỖI THỜI từ 06-10: canSeeMeeting + projectAccess + Daily-token gate đã server-enforced — đánh ✅ |
| 16 | `docs/host-and-scheduling.md` | §Data model ("DB dùng Completed/Cancelled cần thống nhất" + các cột "Thêm:") | Đã xong (0013); các cột organizer/host/duration/waiting_room/recording_enabled đều tồn tại |
| 17 | `docs/dev-phase-notes.md` L34 | Lý do hoãn GDPR "cần log-drains" | Chỉ đúng cho failed-login; export/delete chỉ cần D1+R2 — tách 2 dòng |

### B2. Doc claim DONE / ngầm-done nhưng CHƯA verify được

| # | Mục | Vấn đề |
| --- | --- | --- |
| 1 | P1 secrets + migrate-remote | Tin theo log 06-11, auditor không kiểm trực tiếp được từ máy local — smoke lại khi cutover |
| 2 | Test mic 2 máy (AU1) + remote mute icon (H6) | ❓ test thủ công, chưa có dấu vết đã chạy — gộp 1 buổi test |
| 3 | Co-host designation (EditMeetingForm) | Code có, **chưa test live 2 account** |
| 4 | R2 versioning / Time Travel retention | "30 ngày" trong plan có thể sai trên **free tier** — check docs Cloudflare trước khi hứa |
| 5 | `docs/admin-console.md` bảng module L19 | Hứa "import CSV + force logout" trong scope A1 ✅ — console KHÔNG có (chỉ script seed) — chú thích lại |

### B3. Item MỒ CÔI (không doc nào track — cần nhận chủ)

1. **Revoke-khi-LIVE → kick realtime + huỷ Daily token** (chốt 06-08 #3) — token 4h vẫn sống sau revoke.
2. **Chatbot lên Worker enforce scope** (đích QĐ4) — chỉ nằm trong QĐ4/I-1, dễ rơi.
3. **Bảng `usage_events`** — admin-console.md nói "cần cài sớm", không migration nào tạo → gộp vào dòng Cost hoặc bỏ hẳn (estimate-only cho demo).
4. **Daily room mồ côi khi xoá meeting** — cascade không gọi Daily API.
5. **Blob PUT scenes/chats/library vào meeting `finished` chưa bị Worker chặn** (chỉ chặn deleted 410) — mâu thuẫn trực tiếp quyết định "finished = immutable" → đáng 🔴.
6. **Room server socket.io không auth** — ai có roomId join relay được; cần gate riêng nếu DO (I-2) trễ.
7. Admin filter theo `status` (build-order spec) — gộp backlog track A hoặc bỏ.
8. Audit §2.8/2.9 (participant_count, file.project_id lệch) 🟢 — không ai nhận.
9. **Announcements (v3)** trong bảng module admin — đánh "out-of-scope June demo" hoặc xoá.
10. Cụm "dọn rác client": `mcm:lastMeeting` roomKey plaintext, legacy components (CalendarView/CalendarSplit/InvitedMeetings), PWA branding excalidraw — gom 1 checkbox.

---

## C. MÂU THUẪN giữa các doc

| # | Mâu thuẫn | Phân xử |
| --- | --- | --- |
| 1 | roadmap P6.g ⬜ vs dev-phase-notes [x] 06-09 | Notes đúng — roadmap sửa |
| 2 | roadmap P4.d "co-host chưa" vs log 06-10/11 (designation ship) | Log đúng — roadmap tách 2 dòng |
| 3 | roadmap I-5 "chưa wire Sentry" vs code (wired nhưng vô hiệu cho MCM) | Cả hai nửa-đúng — sửa wording "MCM chưa có Sentry project riêng" |
| 4 | architecture §6 ✅ Phase A vs roadmap không có dòng Phase A | Thêm dòng Phase A vào roadmap |
| 5 | production-data-plan: dòng "Còn mở" đầu file vs bảng P0 cùng file | Bảng P0 đúng — sửa 1 dòng đầu file |
| 6 | dev-phase-notes H1 vs architecture §2.2 | Architecture (doc generated) mô tả ĐÚNG hơn doc tay — ngược kỳ vọng; sửa notes |
| 7 | Spec co-host "như host trừ End-for-all" vs election không đọc `cohost` | Gap spec-vs-code thật — thêm item "election ưu tiên cohost" (xem D#5) |
| 8 | P0.4 (plan) ≡ Phase 5 (roadmap) track song song 2 doc + lặp trong "CÒN LẠI" 06-10/06-11 | Gộp về roadmap P5, plan chỉ trỏ link |
| 9 | Bảng §4 admin-coverage (audit) trùng phạm vi admin-console.md | Hợp nhất về admin-console.md |
| 10 | P0.2 note "client còn hardcode INTERNAL_DOMAIN" vs session.ts:66-67 refresh từ `/v1/config` | Hardcode chỉ là fallback khởi động — hạ mức ghi chú |

---

## D. ĐỀ XUẤT THỨ TỰ VIỆC KẾ TIẾP (demo tháng 6 trước, hardening sau)

| TT | Việc | Lý do | Effort | Phụ thuộc | Đơn giản-để-maintain? |
| --- | --- | --- | --- | --- | --- |
| 1 | **"P1.5 Cutover & hardening tối thiểu"**: deploy client lên **Pages**, trỏ `VITE_APP_STORAGE_URL` sang Worker remote, **khoá CORS** về origin Pages, đổi 2 password hardcode (`MapMeet@2026`/`MapAdmin@2026`) | Demo tháng 6 CẦN chạy trên URL thật; P1 vừa unlock; CORS `*` + password hardcode không thể mang đi demo. Đặt tên phase rõ — hiện đang mồ côi không chủ | 1–2 ngày | P1 ✅ | ✅ Pages = managed, zero server |
| 2 | **Realtime cho demo**: quyết DO (I-2) vs host tạm room server (Node trên 1 máy/tunnel/VPS). Đề xuất: **host tạm cho demo, DO làm sau** | room/ hiện local-only → demo ngoài LAN sẽ chết; DO 3-5 ngày là rủi ro sát demo. Nếu chọn host tạm: thêm gate auth tối thiểu cho socket.io (mồ côi B3#6) | tạm: 1 buổi · DO: 3–5 ngày | #1 (cùng đợt cutover) | Host tạm = nợ ngắn hạn chấp nhận được; DO mới là đích managed — sau demo |
| 3 | **Backup quick-win**: bật R2 versioning + xác nhận Time Travel retention (free tier!) + script `wrangler d1 export --remote` định kỳ | VỪA UNLOCK hôm nay; rẻ nhất khi DB còn trống; audit dặn sẵn "bật ngay khi có remote"; có backup TRƯỚC khi demo đổ dữ liệu thật | 1 buổi | P1 ✅ | ✅ thuần managed features, gần như zero maintain |
| 4 | **Test 2 máy mic thật (AU1+H6 gộp)** → nếu OK thì dọn mesh dead code (tách type `PeerState`/`AudioRoomEvents` ra trước) | Demo sống chết ở audio; là blocker duy nhất của việc dọn mesh + xoá TURN khỏi scope I-1 | 1 buổi test + 1 buổi dọn | máy thứ 2 có mic | ✅ giảm code chết = dễ maintain hơn |
| 5 | **Co-host quyền LIVE**: election đọc role `cohost` (ưu tiên trước acting-host) + **quyết định ẩn switch waiting-room/recording** nếu không kịp (đang là placebo) | Designation đã ship nhưng vô nghĩa khi LIVE — demo dễ bị hỏi; switch placebo = UX hứa sai. Waiting room ĐẦY ĐỦ thì lớn → để sau demo, chỉ cần ẩn switch (30 phút) | 1–2 buổi | #4 không bắt buộc; cần test 2 account | ✅ chỉ sửa election client, không thêm hạ tầng |
| 6 | **Doc hygiene 1 buổi**: sửa toàn bộ mục B1 (17 chỗ) + nhận chủ cho 10 item mồ côi B3 | 5 doc đang lệch code ở ~17 chỗ; rủi ro thật là người sau **fix lại việc đã xong** (audit findings còn ghi 🔴 mở) | 1 buổi | danh sách này | ✅ chi phí gần 0, tránh lãng phí lớn |
| 7 | **Hardening sau demo** (bucket, không làm trước demo): P5 cloud recording (sau khi gộp 2 Daily room), rate-limit, P2 UUID (làm sớm sau demo khi data còn ít), GDPR export, chặn blob PUT vào meeting `finished`, revoke-live kick+token, DO (I-2), CI/CD + domain + staging | Không cái nào chặn demo; P5 là đường managed đúng khẩu vị nhưng có dependency chuỗi; P2 đụng authz nên cần remote ổn định trước | nhiều đợt | #1–#2 xong | P5/DO = managed đúng hướng; còn lại là nợ kỹ thuật xếp hàng |

**Nguyên tắc xếp:** #1–#5 là những gì demo tháng 6 CẦN (URL thật + realtime + audio tin cậy + không hứa sai trên UI); #3 và #6 là 2 quick-win rẻ nhất hôm nay; mọi thứ còn lại dồn #7.
