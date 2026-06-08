# MCM Roadmap — các Phase đang follow

> Nguồn tham chiếu **chuẩn duy nhất** cho các phase. Chi tiết kỹ thuật từng phase nằm ở daily log (`docs/YYYY-MM-DD.md`) + memory. Cập nhật lần cuối: 2026-06-05.

## ✅ Đã xong

### Phase 1 — Screen share (Daily.co) ✅
1 người Present → cả phòng xem; cửa sổ nổi + **Pop-out ra màn hình 2** (Document-PiP); **khoá 1-người-share** (qua socket); **share kèm âm thanh tab** (screenAudio). Media qua Daily SFU, presence/lock qua socket. *(Verified live.)*

### Phase 2 — Audio → Daily SFU ✅
Bỏ audio mesh P2P (không scale) → audio chạy **Daily SFU** (scale N người). `DailyAudio` drop-in cho `AudioRoom` → STT/recorder/UI **không đổi**. *(Code + screen-audio verified; còn test nghe mic khi có máy có micro.)*

### Phase 3 — Supabase Auth ✅
Đóng lỗ **Worker no-auth**: Worker verify Supabase JWT (jose/JWKS) chặn mọi `/v1` trừ health. Login bắt buộc cho tất cả (nội bộ email/pw 1-click, **khách magic-link**). 5 user nội bộ seed sẵn. *(Verified live: token thật→200, không/sai→401.)* → setup ở [supabase-setup.md](supabase-setup.md).

**Kèm theo:** timer họp **khách quan** (đếm từ host start, ai vào sau cùng số); nút **Invite** copy link.

---

## ⏳ Tiếp theo

### Phase 4 — Host control + per-meeting membership ⭐ NEXT
Vai trò host (chốt 2026-06-05) — **gắn với recording bảo mật** (chỉ host + người được duyệt mới tải được):
- [ ] **Phòng chờ (waiting room)** — khách (ngoài tổ chức) vào link → login → **chờ host duyệt**; nội bộ (domain @mapgroup.co.kr) vào thẳng.
- [ ] **Mời theo LINK** (mở link + login). *(Mời theo email cụ thể = sau.)*
- [ ] **End meeting for all** — host kết thúc → meeting thành *finished* cho cả phòng.
- [ ] **Co-host** + chuyển host khi host rời.
- [ ] **Kick / mute** participant (host + co-host).
- [ ] **Membership** (D1): ai được vào meeting nào → Worker check `userId`/email → nền cho tải recording bảo mật.

### Phase 5 — Recording → R2 (auth-gated)
- [ ] **Daily cloud recording** (audio+screen đều trên Daily) → webhook `recording.ready` → **Worker copy về R2 private** (Daily không ghi thẳng R2 — chỉ AWS S3).
- [ ] **Tải qua Worker có auth** (verify JWT + membership) — không link công khai. R2 vì **egress free** (S3 ~$0.09/GB).
- [ ] Xem lại trong **review-mode** của cuộc họp đã xong.
- *(Ghi server-side vì host có thể là máy bất kỳ/yếu.)*

---

## 🏗️ Track HẠ TẦNG PRODUCTION (song song feature phase — audit 3-team 2026-06-05)

> Feature phase 1-5 ở trên là **tính năng**. Để **chạy production thật** còn cả track hạ tầng — trước đây rải rác / thiếu khỏi roadmap. Bảo mật: secrets **KHÔNG lộ trên git** (đã verify history sạch); rotate = phòng ngừa trước prod.

### 🔴 SÓT — chưa nằm trong phase nào (cần đưa vào)
- **I-1. Backend AI/STT/TURN đang trên room server** — Gemini (`/translate`,`/summarize`,`/chatbot`), Deepgram (`/stt`), Cloudflare TURN (`/turn-credentials`) chạy trên `room/` (Node đơn), key trong `room/.env.development`. → **dời lên Cloudflare Worker/DO** + `wrangler secret`. *(Cả lớp compute + secrets này chưa có phase.)*
- **I-2. Realtime = socket.io 1 instance** (`room/` — SPOF, không scale ngang, HTTP) → **Durable Objects** (June plan, chưa vào roadmap).
- **I-3. Deploy production** — chưa có **CI/CD** (Pages + `wrangler deploy`), **domain thật**, **staging env**. Đang dev-machine + cloudflared quick-tunnel (URL đổi mỗi lần).
- **I-4. Disaster recovery** — **D1 backup** + **R2 versioning** chưa có; D1 migration chạy tay (`wrangler d1 execute`).
- **I-5. Observability** — Sentry có **config** (`sentry-production.yml`) nhưng **CHƯA wire `@sentry/browser` vào app**; server-side logging/alerting chưa có.
- **I-6. Runbooks** — deploy / key-rotation / incident-response chưa có.

### 🟠 Phase 6 — Production hardening (gom các việc trước go-live)
- Khoá **CORS** Worker (`origin:"*"` → origin thật).
- **Rate-limiting** Worker + room server (chống abuse/cost AI).
- **Rotate keys** + `wrangler secret put` (Daily/Supabase/Gemini/Deepgram/TURN).
- **SMTP** cho magic-link (built-in rate-limit + dễ spam).
- **Token refresh** họp >4h (Daily token hết hạn 4h).
- **Scene size limit** + input validation Worker.
- **Daily-token check membership** (giờ JWT hợp lệ bất kỳ mint được token mọi room).

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
