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

## 🔮 Sau nữa (chưa lên lịch)

- **Realtime → Durable Objects** — thay socket.io :3002 đơn lẻ (scale + HA). *(June infra plan.)*
- **Production hardening**: rotate keys + `wrangler secret put`; khoá **CORS** Worker về origin thật; **SMTP** cho magic-link (built-in rate-limit); xử lý token hết hạn (họp >4h); rate-limiting/chống abuse.
- **R2 lifecycle/cleanup** (orphan bytes) + dọn Daily room.
- **Observability** server-side (room + worker).
- **Data residency / compliance** (R2 region, Daily region) cho client xuyên quốc gia.
- **E2E key hardening** — room key đang lưu D1 (server đọc được) → không phải E2E thật.
- **Gộp audio+screen 1 Daily room** (giờ là 2 room `<id>` + `<id>-audio`) cho unified recording.
- **Mời theo email cụ thể** + invite UI cho host.

---

## Lịch sử đánh số (để khỏi lẫn)
Số phase từng đổi trong ngày 2026-06-05: ban đầu Recording=Phase 2/3, Auth=Phase 4; sau **đảo lại** vì tải recording cần auth trước. **Số HIỆN TẠI (doc này) là chuẩn**: 1 screen-share, 2 audio, 3 auth, 4 host-control, 5 recording.
