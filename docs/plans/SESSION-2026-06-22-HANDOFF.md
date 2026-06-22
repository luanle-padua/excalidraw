# Session handoff — 2026-06-22 (resume từ bất kỳ tài khoản nào)

Đọc file này trước để biết ngay: đã ship gì, đang chạy gì, làm tiếp thế nào. Mọi lệnh deploy chạy từ repo `D:/LUAN/0.WIP/20.MEETING-CANVAS/excalidraw`.

## ▶▶ RESUME SÁNG MAI
- **Mở lại ĐÚNG cuộc hội thoại này** (máy này — `MAP1756`): trong terminal, cd vào repo rồi chạy:
  ```
  claude --resume 505fba12-3899-4c30-a07d-aa829d290490
  ```
  (ID phiên = `505fba12-3899-4c30-a07d-aa829d290490`. Nếu quên, chạy `claude --resume` không tham số để chọn từ danh sách phiên gần đây — phiên này là cái mới nhất, thư mục `D--LUAN-0-WIP-20-MEETING-CANVAS`.)
- **Từ máy/account khác** (mất lịch sử chat nhưng đủ resume CÔNG VIỆC): clone/pull repo, đọc file này (đã trên `origin/master`), rồi resume workflow Package:
  `Workflow({ scriptPath: "C:/Users/MAP1756/.claude/projects/D--LUAN-0-WIP-20-MEETING-CANVAS-excalidraw/505fba12-3899-4c30-a07d-aa829d290490/workflows/scripts/meeting-package-build-wf_a5728dcd-70d.js", resumeFromRunId: "wf_a5728dcd-70d" })`
  (script này nằm trên máy MAP1756; nếu máy khác không có, đọc spec docs/plans/meeting-package.md để chạy lại từ đầu.)

## ✅ ĐÃ SHIP HÔM NAY (đều trên `origin/master` + LIVE prod)
| Commit | Nội dung |
|---|---|
| `8d2ffec0` | My Files thumbnail **tối ưu băng thông** (thumb WebP server, không tải ảnh gốc; migration **0031** `user_file.thumb_r2_key`) + **dọn Fly.io/socket.io** (xoá `room/`, sửa doc; giữ type load-bearing + flag `realtime_backend`) |
| `3f81e4c1` | **Bỏ pre-join "Ready to join?" modal** — vào thẳng canvas, bấm "Call" để vào A/V |
| `59bc6e17` | **Header clarity redesign** — label nút chính; **Call = toggle** join/leave Daily; exit chỉ Leave meeting + End meeting; Layout icon rõ+chữ; nút Files tách Projects; panel phải mở mặc định; xoá PreJoinModal |
| `bfc49ca8` | **Screen-share sharer-awareness** — self-preview cái đang share + banner "Bạn đang chia sẻ [loại]" + nút Dừng rõ |
| `68bc6d82` | Handbook (web + print) cập nhật |

**Prod hiện tại:** Pages `map-canvasm.pages.dev` = `bfc49ca8`; Worker `mcm-storage` Version sau `229c5a38`; migration remote D1 tới **0031**. (PWA cache → hard-refresh để thấy bản mới.)

## ⏸ ĐÃ DỪNG (tối 06-22) — Meeting Package build, resume sáng mai
> Workflow đã được **TaskStop tối 06-22** để không chạy qua đêm. Có thể đã có **edit Package dở dang trên working tree** (chưa commit) — chạy `git status` để xem; resume sẽ chạy lại các agent chưa cache (agent đã xong lấy cache, gần như tức thì).
- Workflow `meeting-package-build` · Run **`wf_a5728dcd-70d`** · Task `walx2tzc0`.
- Script: `…/505fba12-…/workflows/scripts/meeting-package-build-wf_a5728dcd-70d.js`
- Journal: `…/505fba12-…/subagents/workflows/wf_a5728dcd-70d/journal.jsonl`
- Làm gì: build **P1+P2** Meeting Package (curate summary+file+transcript → publish recap server-readable, audience cả họp/project + export zip offline). Tạo **migration 0032** + worker routes `/v1/packages/*` + `MeetingPackageBuilder.tsx` trong `MeetingDetailPreview`.
- RESUME nếu treo/tắt: `Workflow({ scriptPath: <trên>, resumeFromRunId: "wf_a5728dcd-70d" })` (agent xong lấy cache).
- Spec gốc: **docs/plans/meeting-package.md**.

## ▶ LÀM TIẾP KHI PACKAGE BUILD XONG
1. Đọc verify + review verdict (file output của task `walx2tzc0`, hoặc journal). Nếu review có `blocking[]` → fix rồi `yarn test:typecheck` (root) + `cd worker && npx tsc --noEmit` phải sạch.
2. **Commit** (loại handbook đã push + loại `package.json`/`yarn.lock` playwright stray):
   `git add -A; git reset -q -- package.json yarn.lock docs/handbook docs/handbook-web`
3. **SHIP theo thứ tự (migration TRƯỚC vì worker query cột/bảng mới):**
   - `cd worker && echo y | npx wrangler d1 execute mcm-db --remote --file=./schema/0032_meeting_package.sql`
   - `cd worker && npx wrangler deploy`
   - `cd excalidraw-app && VERCEL_GIT_COMMIT_SHA=$(git rev-parse --short HEAD) yarn build`
   - `cd excalidraw-app && npx wrangler pages deploy build --project-name=map-canvasm --branch=main --commit-dirty=true`
   - Verify: `curl -s "https://map-canvasm.pages.dev/version.json?t=$(date +%s)"` (cache-bust) khớp SHA mới.
   - ⚠️ **Migration lên prod D1 = hỏi Luân trước** (production schema change).

## 📌 LƯU Ý / CÒN LẠI
- **Stray chưa commit:** `package.json` + `yarn.lock` chỉ thêm `playwright` devDep (1 agent test thêm, không source nào import). Quyết: bỏ (`git checkout -- package.json yarn.lock`) hoặc commit riêng.
- **Deploy reference:** frontend = Cloudflare **Pages `map-canvasm`** (branch `main`, MANUAL — KHÔNG git-CI, KHÔNG Vercel dù build script nhắc VERCEL_GIT_COMMIT_SHA); worker = `mcm-storage` (`wrangler deploy`); D1 = `mcm-db`. Realtime = **100% Durable Objects** (Fly đã khai tử 06-17).
- **Specs chưa build / để sau:** Package **P3** (audience "vài người cụ thể" + email notify); xoá flag `realtime_backend` (quyết định của Luân); ảnh "office" png/jpg thật cho preset blur (mỹ thuật).
- **Specs đã ghi:** docs/plans/meeting-package.md, docs/plans/screenshare-sharer-awareness.md.
- Quan trọng đã verify hôm nay: meeting(canvas/DO) vs call(Daily) **tách bạch** — Daily opt-in; xem transcript không bật mic = **$0 Daily** (transcript đi qua WS/DO). Daily ~$0.004/người/phút video, $0.00099 audio, 10k phút free/tháng.
