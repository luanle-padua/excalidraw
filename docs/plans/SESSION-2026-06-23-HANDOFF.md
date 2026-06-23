# Session handoff — 2026-06-23 (resume từ bất kỳ tài khoản nào)

Đọc file này trước để biết ngay: đã ship gì, đang lỗi gì, làm tiếp thế nào. Mọi lệnh deploy chạy từ repo `D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw`.

## ▶▶ RESUME SÁNG MAI
- **Mở lại ĐÚNG cuộc hội thoại này** (máy này — `MAP1756`): trong terminal, cd vào repo `excalidraw` rồi chạy:
  ```
  claude --resume 505fba12-3899-4c30-a07d-aa829d290490
  ```
  (ID phiên = `505fba12-3899-4c30-a07d-aa829d290490`. Nếu quên, chạy `claude --resume` không tham số rồi chọn từ danh sách — phiên này thư mục `D--LUAN-0-WIP-20-MEETING-CANVAS`.)
- **Từ máy/account khác** (mất lịch sử chat nhưng đủ resume CÔNG VIỆC): clone/pull repo, đọc file này (đã trên `origin/master`), rồi bám 2 việc lớn ở mục ⏳ (Canvas-Replay rebuild + Recording no-audio fix).

## ✅ ĐÃ SHIP + LIVE HÔM NAY (đều trên `origin/master` + prod Pages `map-canvasm` + worker `mcm-storage`)
> Verify SHA: `git log --oneline -40`. Migration prod D1 đã APPLY: **0031, 0032, 0033, 0034, 0035, 0036**.

| Khu vực | Nội dung |
|---|---|
| **Meeting Package — full feature** | Recap = board canvas PNG (dark) + chat (notepad) + files + file đính kèm local + đặt tên mặc định + member picker. Audience meeting/project/list. Publish/draft. Export zip. Quản lý (unpublish/soft-delete/revoke). Phân phối (SharedWithMe + list/grid view + ClientPortal + badge "Recap" trên card + nhóm theo project/meeting). Migration **0032, 0034**. |
| **Event-Log P1 + Consent gate** | Migration **0033**. Consent lúc join + language switcher; consolidate-on-end. **REFRAME**: đây là lớp THÔNG TIN dự án, KHÔNG phải giám sát (Chairman per-person scoring/stealth ĐÃ BỎ — xem docs/specs/chairman-account.md + docs/plans/event-log-privacy-analysis.md). |
| **Dashboard** | Sidebar IA (Internal/Workspace/Projects-by-status); **Project Files** (thư viện tài liệu chia sẻ theo project, migration **0036**); **Project status enum** (prepare/ongoing/on-hold/finished, division-admin/leader đặt được). |
| **Recording — CLIENT-SIDE (free, KHÔNG Daily cloud)** | Pivot khỏi Daily. Host Record → MediaRecorder trong browser capture audio mix + screen-share qua **CANVAS COMPOSITOR** → WebM → upload R2 (`recording` table migration **0035**) → review-mode tab "Recordings" (player + download). Báo REC cho mọi người. stop() được làm chặt để không bao giờ treo. WebM seekable nhờ ts-ebml (lazy-load chunk riêng). Nút log đổi tên **"Hồ sơ họp"** (gộp Transcript/Summary/Recordings). Backend Daily cloud-recording (start/stop/webhook/R2-copy, routes migration 0035) giữ **NGỦ ĐÔNG/không dùng** làm phương án tương lai. |
| **Nhiều fix** | avatar serve public, redesign meeting-card, package modal portal/bg, AI summary canvas+chat, guest end-meeting tức thì, scrollbars, recap dark capture. |

**Prod hiện tại:** Pages `map-canvasm` + Worker `mcm-storage` = HEAD `origin/master`; migration remote D1 tới **0036**. (PWA cache cứng → hard-refresh / unregister service worker để thấy bản mới — hôm nay 1 bundle SW cũ làm rối khâu test.)

## ⏳ PENDING / BUGS cho ngày mai (PHẦN QUAN TRỌNG NHẤT)
1. **Canvas-Replay — ĐÃ REVERT hôm nay** (revert commit trên master; bản gốc là feature replay: capture canvas evolution + scrub player). **LÝ DO revert: gây REGRESSION** —
   - (a) **phantom guests**: hàng chục entry "guest" cứ hiện cho NGƯỜI KHÁC khi review (nghi do player mount Excalidraw THỨ HAI + vòng lặp reload → re-join phòng lặp → presence ma);
   - (b) **reload loop**: replay "load đi load lại" khi vào lại, chỉ lần mở đầu chạy;
   - (c) không scrub được.
   - **Phía CAPTURE đã review SẠCH** (`data/canvasHistory.ts`: snapshot-delta mỗi 3s, E2E, hook thụ động trong `Collab.syncElements` SAU broadcast; worker `/v1/canvas-history/:roomId` blob E2E). Thủ phạm là **PLAYER** (`CanvasReplaySection.tsx`, một `<Excalidraw>` thứ 2 standalone).
   - **REBUILD theo hướng**: play trên CHÍNH canvas review-mode (lái Excalidraw review hiện có qua `updateScene` theo timeline — **KHÔNG mount Excalidraw thứ 2**), KHÔNG presence ma, KHÔNG reload loop, scrub chạy được. (UX owner: "chỉ cần player ở canvas, cho nó play mọi hoạt động".)
2. **Recording bug — quay screen-share KHÔNG có audio.** Khi record TRONG LÚC screen-share, WebM ra thiếu audio (record audio-only THÌ CÓ audio, theo owner). Soi `excalidraw-app/audio/clientRecording.ts` — output stream phải LUÔN mang track audio-mix kèm track video-canvas; tìm vì sao audio rớt khi có track video compositor (nghi MediaRecorder codec/thứ tự track, hoặc mix audio rỗng khi screen capture).
3. **Recording — KHÔNG phải bug (đã xác nhận)**: screen recording quay đúng người đang share (1 người share bất kỳ), KHÔNG phải ghép tất cả mọi người — owner OK.
4. **Dọn worktree**: ~25+ worktree agent cũ tồn trong `.claude/worktrees/` (bẫy junction Windows — `rm -rf` và cả `git worktree remove` đi theo junction node_modules rồi XOÁ repo CHÍNH; xem memory feedback_windows-worktree-junction-footgun). Chúng làm bẩn `yarn test:app` (file test trùng). Dọn TAY: tắt process node/vite vương vãi, rồi xoá `.claude/worktrees/` bằng tay. KHÔNG rm chúng từ trong 1 session đang chạy.

## 📌 LƯU Ý
- **Deploy** = Cloudflare Pages `map-canvasm` (MANUAL `wrangler pages deploy build`, KHÔNG git-CI) + worker `mcm-storage` (`wrangler deploy`) + D1 `mcm-db`. PWA cache cứng — hard-refresh / unregister service worker để thấy build mới.
- **Recording giờ client-side (free)** — KHÔNG cần plan/ops Daily cloud-recording. Daily vẫn dùng cho live A/V (room-merge ĐÃ REVERT về setup 2-room đã ổn định).
- **Specs liên quan:** docs/plans/meeting-package.md, docs/specs/chairman-account.md, docs/plans/event-log-privacy-analysis.md.
