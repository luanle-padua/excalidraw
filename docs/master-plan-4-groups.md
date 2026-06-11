# Master plan — 4 nhóm việc (chốt với anh Luân 2026-06-11)

> **Chiến lược: chuẩn chỉnh mọi thứ TRƯỚC, dọn lên remote SAU CÙNG** ("chuyển nhà một lần, sạch sẽ"). Thay thế bảng thứ tự cũ trong phase-review-2026-06-11.md §d. Nguồn: 3 đội rà soát 06-11 — [phase-review](phase-review-2026-06-11.md) · [admin-feature-proposals](admin-feature-proposals-2026-06-11.md) · [user-feature-audit](user-feature-audit-2026-06-11.md).
>
> Thứ tự tổng: **G4 (chặn lỗ hổng) + G1 chạy trước → G2 xen kẽ → G3 chốt hạ.** Mục ⚡ trong G3 (backup) là ngoại lệ làm sớm được ngay.

## GROUP 1 — APP + TÍNH NĂNG USER (chuẩn chỉnh)

> Audit 06-11 ([user-feature-audit-2026-06-11.md](user-feature-audit-2026-06-11.md)): **96 tính năng — 41 🟢 / 43 🟡 / 8 🔴 / 4 ⚪** (≈87% dùng được). Nợ tụ ở 2 pattern: lỗi bị nuốt im lặng (`data/*.ts` trả `[]/null/false`) và ~40 chuỗi hardcode né hệ i18n.

**🔴 Phải xử (mất niềm tin / mất dữ liệu):**
- [ ] **Tạo meeting fail im lặng** — `registerMeeting` không check kết quả (`ScheduleMeetingForm.tsx:174`) → form đóng "thành công" mà meeting không tồn tại.
- [ ] **Upload tài liệu trong review mode = MẤT DỮ LIỆU placebo** — UI nhận file nhưng `persistLibrary` skip viewOnly (`MeetingLibrary.tsx:1443`) → chặn/ẩn upload khi review.
- [ ] **Sửa project "lưu giả"** — nút Edit không gate owner, worker 403 nhưng modal vẫn đóng như đã lưu (`ProjectBrowser.tsx:516-523, 339-351`).
- [ ] Switch **Phòng chờ** + **Ghi hình** placebo (0 consumer; `ScheduleMeetingForm.tsx:441-470`) — làm thật hoặc ẩn; docs còn hứa "host duyệt".
- [ ] **Quick-login password (cả admin) hardcode trong bundle** + revoke vô tác dụng với phòng live — gỡ/vá TRƯỚC khi URL remote public (giao với G3).
- [ ] **Co-host election**: form chỉ định đã ship nhưng election không đọc role `cohost` → live không có quyền gì.

**🟡 Polish đáng giá nhất (⏱ = 1 buổi):**
- [ ] ⏱ Toast lỗi chung cho ~6 thao tác đang câm (mở meeting, tạo project, invite, đổi màu…) — ROI cao nhất.
- [ ] Empty-state nói dối khi mất mạng → "Không tải được — thử lại" (ProjectBrowser/Calendar/MyFiles).
- [ ] Quét i18n ~40 chuỗi hardcode: ưu tiên lỗi mic/audio + RecordingControls (khách Hàn/Anh nhận lỗi tiếng Việt đúng chỗ dễ hỏng).
- [ ] ⏱ Present fail câm — render `errorMessage` (lỗi token chắc chắn gặp khi lên remote).
- [ ] ⏱ Bug chèn trùng IFC/PDF lần bấm 2 — fix 1 dòng (check `customData.mcmType` thay vì `type==="rectangle"`).

**Khác:**
- [ ] **Test mic thật 2 máy** → verify remote-mute icon → dọn mesh WebRTC dead code (`AudioRoom`/`AudioPeer`/`turnConfig`) + dọn ⚪ dead code mới phát hiện: `MCMAssistant` + `AIToolsPanel` không được mount ở đâu.
- [ ] **Waiting room per-guest** (Phase 4 leftover) — đi cùng việc làm thật switch phòng chờ.
- [ ] (sau demo) P5 recording: Daily cloud recording → webhook → R2 auth-gated.

**Bổ sung 06-11 chiều (yêu cầu anh Luân khi test):**
- [ ] **Chuông mời vào họp LIVE** — mở rộng MeetingDueNotice (poll 60s sẵn): meeting live mình được mời nhưng chưa join → toast + "Vào ngay". (Invite hiện chỉ cấp quyền + copy link, không ai được báo.)
- [ ] **Bug: invite trong meeting không thêm invitee** — phòng test có 0 row trong D1; đang truy (POST đi đâu / fail chỗ nào).
- [ ] **Bug review mode: đóng chat là mất** — icon chat bị ẩn ở review nên panel đóng rồi không mở lại được; giữ icon (chat read-only).
- [ ] **Modal "Dự án" trong meeting**: resize được + mặc định to hơn (đang cắt nội dung).
- [ ] **My Files nâng cấp**: nhóm theo loại + sort + tag + cờ **Bảo mật/Chia sẻ được** per-file (badge + cảnh báo khi copy file bảo mật vào meeting; cần migration 0017 thêm cột `tags`,`visibility` — giao G4).

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

- [ ] **Chặn blob PUT vào meeting `finished`** ở Worker — "immutable" thành enforce thật (mồ côi nguy hiểm nhất phase-review tìm ra).
- [ ] **Revoke invitee khi LIVE → huỷ Daily token** (hiện token sống 4h sau revoke).
- [ ] **Doc hygiene:** sửa ~17 chỗ stale (nặng nhất `data-architecture-audit.md` — cần banner "snapshot 06-10, nhiều finding đã fix trong P0") + nhận chủ 10 item mồ côi.
- [ ] **Index D1 cho blob** chats/library/transcripts (PUT hiện ghi R2 không tạo row D1) — tiền đề G2 gói 3.
- [ ] (sau demo) P2: identity email→UUID, avatar data-URL→R2.

## Nguyên tắc (nhắc lại các chốt)

- Anh Luân non-CS → mọi lựa chọn ưu tiên **managed/đơn giản/ít maintain**; nêu chi phí $ khi đề xuất.
- Migrations là SSOT (`migrate.mjs`, không execute tay); local = prod parity, khác duy nhất binding.
- 4 quyết định data 06-10 (compliance/My Files/visibility=data-scope/AI summary-first) giữ nguyên hiệu lực.
