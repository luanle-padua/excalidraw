# Master plan — 4 nhóm việc (chốt với anh Luân 2026-06-11)

> **Chiến lược: chuẩn chỉnh mọi thứ TRƯỚC, dọn lên remote SAU CÙNG** ("chuyển nhà một lần, sạch sẽ"). Thay thế bảng thứ tự cũ trong phase-review-2026-06-11.md §d. Nguồn: 3 đội rà soát 06-11 — [phase-review](../audits/2026-06-11-phase-review.md) · [admin-feature-proposals](../audits/2026-06-11-admin-feature-proposals.md) · [user-feature-audit](../audits/2026-06-11-user-feature-audit.md).
>
> Thứ tự tổng: **G4 (chặn lỗ hổng) + G1 chạy trước → G2 xen kẽ → G3 chốt hạ.** Mục ⚡ trong G3 (backup) là ngoại lệ làm sớm được ngay.

> **CẬP NHẬT TRẠNG THÁI 2026-06-15** (rà toàn bộ — xem `logs/2026-06-15.md`): **G1 ~90% xong** (8/9 🔴 + 🟡 polish đã vá trong đợt 06-11), **G4 gần trọn** (còn index-blob, revoke→Daily-token, doc hygiene). **G2 admin chưa làm. G3 remote chưa cutover** (Worker remote đã LIVE từ 06-11). Chèn thêm workstream **Glass-Desk redesign + rebrand Canvas M** (06-12/06-15, ngoài plan gốc) — đã xong + push. Kế tiếp đề xuất: đóng nốt G1/G4 → G2 gói 1+2 → G3 + Phase 6 ngay trước demo.

## GROUP 1 — APP + TÍNH NĂNG USER (chuẩn chỉnh)

> Audit 06-11 ([user-feature-audit-2026-06-11.md](../audits/2026-06-11-user-feature-audit.md)): **96 tính năng — 41 🟢 / 43 🟡 / 8 🔴 / 4 ⚪** (≈87% dùng được). Nợ tụ ở 2 pattern: lỗi bị nuốt im lặng (`data/*.ts` trả `[]/null/false`) và ~40 chuỗi hardcode né hệ i18n.

**🔴 Phải xử (mất niềm tin / mất dữ liệu):** — *8/9 xong trong đợt 06-11*
- [x] **Tạo meeting fail im lặng** — `registerMeeting` giờ check `ok` (`ScheduleMeetingForm.tsx:173`) → báo lỗi thật.
- [x] **Upload tài liệu trong review mode = MẤT DỮ LIỆU placebo** — chốt **review = chỉ Chat** (06-11): tab library biến khỏi sidebar, mọi đường chèn file gỡ; worker chặn blob PUT vào finished (grace 10').
- [x] **Sửa project "lưu giả"** — gate owner + báo lỗi khi 403 (06-11 "Quản lý dự án" rework).
- [x] Switch **Phòng chờ** + **Ghi hình** placebo → để **disabled + nhãn "sắp có"** (06-11), không còn hứa hão; làm thật = Phase 4 (waiting room) / Phase 5 (recording).
- [x] **Quick-login password hardcode trong bundle** — tách `DevQuickLogin` lazy sau `import.meta.env.DEV`; **build prod grep 0 hit password** (verify 06-11). Revoke-live = kick (06-11).
- [~] **Co-host election**: ✅ form chỉ định + **End đã đọc role** (06-11); ❌ **election live vẫn chưa đọc role `cohost` cho kick/mute** → cần room server validate (track I-2). **CÒN MỞ.**

**🟡 Polish đáng giá nhất (⏱ = 1 buổi):** — *đã xong cả 5 trong đợt 06-11*
- [x] ⏱ Toast lỗi chung — **AppToast** mới cho mọi thao tác từng câm (mở meeting, tạo project, invite, đổi màu…).
- [x] Empty-state nói dối khi mất mạng → "Không tải được — thử lại" (commit `84c913d9`).
- [x] Quét i18n ~70 chuỗi hardcode (commit `195c25f7`). **LƯU Ý: i18n nay TẠM DỪNG** cho redesign — chuỗi UI mới (wallpaper/calendar/login-link) đang hardcode tiếng Việt, gom 1 đợt cuối khi UI chốt.
- [x] ⏱ Present fail — `errorMessage` đã render (audioState + screenShareMedia, MeetingCallControls/MeetingShell).
- [x] ⏱ Bug chèn trùng IFC/PDF — guard bằng `customData.mcmType` (Collab.tsx).

**Khác:**
- [ ] **Test mic thật 2 máy** → verify remote-mute icon → dọn mesh WebRTC dead code (`AudioRoom`/`AudioPeer`/`turnConfig`). *(⚠️ `MCMAssistant`/`AIToolsPanel` giờ có tham chiếu trong MeetingShell.tsx — cần xác nhận đã mount hay vẫn dead.)*
- [ ] **Waiting room per-guest** (Phase 4 leftover) — đi cùng việc làm thật switch phòng chờ.
- [ ] (sau demo) P5 recording: Daily cloud recording → webhook → R2 auth-gated.

**Bổ sung 06-11 chiều (yêu cầu anh Luân khi test):** — *đã xong toàn bộ (06-11 §9)*
- [x] **Chuông mời vào họp LIVE** — MeetingDueNotice ưu tiên meeting live mình được mời trực tiếp chưa join.
- [x] **Notification center ở dashboard** — **NotificationBell** (toolbar lobby): badge pending + panel Accept/Decline từng lời mời; route `POST /v1/me/invitations/:id/respond`.
- [x] **Bug: invite trong meeting không thêm invitee** — root cause: 2 nút InvitePanel vô hình (portal thoát scope token) → stamp token lên portal root.
- [x] **Bug review mode: đóng chat là mất** — giữ icon chat (read-only) qua fab.
- [x] **Modal "Dự án" trong meeting**: resize được + to hơn (1180×780).
- [x] **My Files nâng cấp**: nhóm theo loại + sort + tag + cờ Bảo mật/Chia sẻ (migration `0017_user_file_meta`); copy file bảo mật vào meeting phải confirm.

**Đã chín, giữ làm chuẩn mực:** hệ i18n typed 3 thứ tiếng (parity ép bằng TS) · registry state machine + review-gate mọi đường vào · pipeline tài liệu DXF/IFC/MyFiles (restore/hydrate/tombstone chống race).

## GROUP 2 — ADMIN MANAGEMENT

- [ ] **Gói 1 (1 buổi):** dropdown gán admin (API có sẵn) + quét meeting/project TRỐNG (preview→tick→xoá, dùng cascade sẵn) + export CSV (BOM UTF-8) + banner cảnh báo Dashboard.
- [ ] **Gói 2 (1 buổi):** tab **Statistics** (trend 12 tuần, cắt division/discipline, % meeting có summary/transcript, storage theo project — SQL thuần trên bảng có sẵn, 0 migration) + nút **Reset dữ liệu demo** (wipe meetings, giữ project/user).
- [ ] **Gói 3 (M):** quét **R2 thật** + dọn blob mồ côi (route mới R2 list + anti-join D1) — sửa luôn gốc rễ Storage/Cost đếm thiếu. Đôi với G4 index-blob.
- [ ] (sau, khi đã quen tay dọn tay) retention cron (`scheduled()` handler — hiện setting là đồ trang trí), GDPR export, cost nối billing thật.

## GROUP 3 — REMOTE (làm CUỐI, khi G1+G2+G4 xong)

- [ ] ⚡ **Làm sớm được ngay (độc lập cutover):** bật R2 versioning + xác nhận D1 Time Travel + `wrangler d1 export` định kỳ — DB remote đang trống là lúc đẹp nhất.
- [ ] Cloudflare **Pages** hosting app + trỏ client `VITE_APP_STORAGE_URL=https://mcm-storage.rnd-ai.workers.dev`.
- [ ] Khoá trước khi mở cửa: **CORS origin thật** (worker index.ts), **bỏ password hardcode** + bắt đổi lần đầu, **rate-limit** cơ bản.
- [ ] Room server realtime: host tạm + auth tối thiểu cho demo (Durable Objects = hẳn sau demo).
- [ ] Migrate dữ liệu local→remote nếu cần giữ (audit §5.5) — hoặc đi tay không cho sạch, dùng Reset demo của G2.

## GROUP 4 — DATA (nền móng, xen kẽ với G1/G2)

- [x] **Chặn blob PUT vào meeting `finished`** ở Worker — enforce thật, **grace window 10'** từ `updated_at` để không gãy flush-on-leave (06-11).
- [ ] **Revoke invitee khi LIVE → huỷ Daily token** (token còn sống 4h sau revoke). *(App-layer đã kick qua poll 60s từ 06-11, nhưng Daily token CHƯA bị thu hồi → vẫn còn mở.)* **CÒN MỞ.**
- [~] **Doc hygiene:** một phần đã sửa (06-11 + bản rà 06-15 này); `data-architecture-audit.md` vẫn cần banner "snapshot 06-10". **Còn vài chỗ stale.**
- [ ] **Index D1 cho blob** chats/library/transcripts (PUT hiện ghi R2 KHÔNG tạo row D1 — verify 06-15 vẫn thiếu) — tiền đề G2 gói 3. **CÒN MỞ.**
- [x] **Migration mới đã land:** `0016_user_files` + `0017_user_file_meta` (My Files tags/visibility) + `0018_color_icon` (project/meeting cosmetic). Route `GET/PUT /v1/notes` (ghi chú lịch).
- [ ] (sau demo) P2: identity email→UUID, avatar data-URL→R2.

## Nguyên tắc (nhắc lại các chốt)

- Anh Luân non-CS → mọi lựa chọn ưu tiên **managed/đơn giản/ít maintain**; nêu chi phí $ khi đề xuất.
- Migrations là SSOT (`migrate.mjs`, không execute tay); local = prod parity, khác duy nhất binding.
- 4 quyết định data 06-10 (compliance/My Files/visibility=data-scope/AI summary-first) giữ nguyên hiệu lực.
