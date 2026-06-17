# Runbook — Incident playbooks

Mỗi mục: dấu hiệu → việc làm ngay → kiểm tra lại. Ngắn, làm theo từ trên xuống.

---

## (a) Room server chết giữa buổi họp

**Dấu hiệu:** con trỏ người khác đứng im, không sync; chat dịch / STT báo lỗi;
người mới không vào được phòng live.

1. Probe room server:
   ```bash
   curl http://<host>/health
   ```
   Mong đợi `{ "ok": true, "uptime": <giây> }` (HTTP 200). Không trả lời = server down.
   (Route gốc `GET /` cũng trả `Excalidraw collaboration server is up :)` nếu muốn kiểm nhanh.)
2. Restart:
   ```bash
   pm2 restart excalidraw-collab     # hoặc: docker restart mcm-room
   pm2 logs excalidraw-collab        # xem vì sao chết (OOM? crash?)
   ```
3. Báo người trong phòng **refresh trình duyệt** để reconnect socket — canvas đã lưu trên
   Worker (R2/D1) nên không mất nội dung, chỉ mất kết nối realtime.
4. Nếu chết lặp lại do hết RAM: `pm2.production.json` đã có `max_memory_restart: 4G` +
   autorestart; cân nhắc VM RAM lớn hơn.

---

## (b) Mất dữ liệu / lệnh DELETE sai

**Dấu hiệu:** meeting/project/scene biến mất hoặc bị xoá nhầm.

1. **D1 Time Travel** (DB `mcm-db`) — khôi phục về thời điểm trước sự cố:
   ```bash
   cd worker
   npx wrangler d1 time-travel info mcm-db                  # xem timestamp/bookmark còn giữ
   npx wrangler d1 time-travel restore mcm-db --timestamp=<ISO-time-trước-sự-cố>
   ```
2. **Backup export (B9)** — nếu cần dữ liệu cũ hơn cửa sổ Time Travel, phục hồi từ file
   `wrangler d1 export` đã sao lưu:
   ```bash
   npx wrangler d1 execute mcm-db --remote --file=<duong-dan-ban-export.sql>
   ```
3. **R2 object (blob scene/file)** đã xoá/đè — khôi phục từ versioning của bucket `mcm-storage`
   (R2 → bucket `mcm-storage` → bật/ dùng Object versioning để rollback về version trước).
4. Xác nhận lại: mở meeting bị ảnh hưởng, kiểm tra canvas + library tải đúng.

> Lưu ý nguồn gốc: meeting xong là **bất biến** và khách bị **revoke ≠ delete** — nếu data
> "mất" thực ra là do revoke/ẩn theo thiết kế thì KHÔNG restore, kiểm tra access trước.

---

## (c) Chi phí tăng đột biến / nghi key bị lộ

**Dấu hiệu:** hóa đơn provider nhảy bất thường, traffic API lạ.

1. Mở dashboard spend từng provider: Resend, Daily, Google AI (Gemini), Deepgram, Cloudflare.
   Xem cái nào tăng.
2. **Chặn máu ngay:** đặt spend cap / hạ quota API ở provider đang tăng (giới hạn request/ngày).
3. **Xoay key** ngay theo [`key-rotation.md`](./key-rotation.md) — coi key cũ là đã lộ:
   tạo mới → set vào Worker/host → revoke key cũ.
4. Kiểm tra `ALLOWED_ORIGINS` (var Worker) còn đúng — origin lạ gọi `/v1` là dấu hiệu lạm dụng
   bằng bearer token lộ.
5. Theo dõi 24h: spend về bình thường chưa.

---

## (d) Feature 500 ngay sau khi deploy

**Dấu hiệu:** vừa `wrangler deploy` xong, một route/feature trả 500 (thường là feature mới
cần cột/bảng mới).

1. Nguyên nhân hay gặp nhất: **migration chưa áp lên remote** → schema D1 thật thiếu bảng/cột.
   ```bash
   cd worker
   node migrate.mjs --status --remote     # còn migration PENDING không?
   node migrate.mjs --remote              # áp các migration còn thiếu
   ```
2. Thử lại feature. Nếu hết 500 → xong.
3. Nếu vẫn lỗi: xem log Worker (Cloudflare dashboard → Worker `mcm-storage` → Logs, hoặc
   `npx wrangler tail mcm-storage`) để tìm lỗi thật.
4. Cần lùi gấp: redeploy lại commit trước đó (`git checkout <commit cũ> -- worker/ && npx wrangler deploy`)
   — nhưng đừng rollback DB nếu migration đã chạy đúng (chỉ thiếu deploy code).
