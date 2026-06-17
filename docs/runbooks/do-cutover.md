# Runbook — Cutover realtime sang Durable Objects (DO)

Chuyển lớp realtime của Canvas M từ **socket.io (Fly)** sang **Durable Objects**
chạy trên Worker `mcm-storage`. Cờ chọn backend là **`realtime_backend` per-meeting
trong D1** (`do` | `socketio`), client đọc lúc `initializeRoom`. Cutover = lật cờ
này, KHÔNG migrate dữ liệu (R2 vẫn authoritative).

Plan gốc: `docs/plans/durable-objects-migration.md`. Rollback: [`do-rollback.md`](./do-rollback.md).

Tên thật (đừng đoán):
- Worker: `mcm-storage` → `https://mcm-storage.<account>.workers.dev`
- D1: `mcm-db` (id `70c15c3f-6dc5-4dbf-bc9e-e011728c7c18`, region APAC, account `rnd_ai`)
- R2 bucket: `mcm-storage`
- DO class: `RoomDO` (binding `ROOM` trong `wrangler.jsonc`)
- Migration cờ backend: `worker/schema/0027_realtime_backend.sql`

> **Quy tắc placement (đã verify trên docs Cloudflare 06-17, xem cuối file):** DO sinh ra
> ở data center **gần lần `.get()` đầu tiên**, và **KHÔNG đổi region sau khi tạo**. Vì vậy
> cutover phải để **host nội bộ APAC mở phòng trước** (host làm `.get()` đầu) → DO neo ở
> APAC. KHÔNG có schema `home_region` cho August.

---

## 0. Đặt vấn đề placement (đa quốc gia: Hàn + VN + Phi)

Verify trên docs Cloudflare (URL ở cuối) — chốt thực tế:

- `env.ROOM.idFromName(roomId)` cho ID **deterministic**; nó KHÔNG tự quyết region.
  Region được quyết bởi **nơi gọi `.get()` lần đầu** ("a data center close to where the
  initial `get()` request is made").
- DO **KHÔNG đổi region sau khi tạo** ("Durable Objects do not currently change locations
  after they are created").
- `locationHint` **CÓ** hiệu lực với ID từ `idFromName` (placement độc lập với cách tạo ID;
  chỉ **lần `.get()` đầu** mới tôn trọng hint; best-effort, không đảm bảo). → Khẳng định
  cũ "`locationHint` chỉ honored với `newUniqueId`" **SAI** — nhưng August vẫn KHÔNG cần
  set hint.
- `jurisdiction` chỉ có **`eu`** / **`fedramp`** — **KHÔNG có Africa / APAC jurisdiction**.
  Nó dùng cho data-residency pháp lý (EU/FedRAMP), KHÔNG phải để giảm latency cho Phi.
  → August KHÔNG dùng `jurisdiction`.

**Hệ quả thực thi:** phần kiểm soát placement August = **thứ tự ai mở phòng**, không phải
schema. GO/NO-GO chỉ cần xác nhận host APAC mở phòng đầu; KHÔNG cần "verify locationHint
honored" như một blocker (đã verify — không dùng nó).

---

## 1. GO/NO-GO — cổng bắt buộc TRƯỚC cutover

Tick hết. **Bất kỳ mục auth / file / reconnect / first-in-room / cờ-runtime / rollback
nào fail = NO-GO, không cắt.**

**Auth (đóng 1b/B12)**
- [ ] External `denied`/chưa `admitted` → handshake **403, KHÔNG mở WS** (thủ công + auto).
- [ ] Revoke giữa buổi → client poll-60s `kickedAtom` văng đúng; reconnect bị 403.
- [ ] JWT hết hạn / sai audience → **401**; `canSeeMeeting` fail → **403**; WS-count cap → **403**.
- [ ] Phòng `finished` → handshake **409** (read-only, reviewer không relay được).

**Payload / file**
- [ ] `LIBRARY_FILE` đi **R2-by-reference**; file **30MB+** OK; KHÔNG còn inline >1MiB.
- [ ] R2-ref đã deploy ĐỒNG BỘ cho cả hai backend (không nửa-migrated corrupt).

**Reconnect / presence**
- [ ] Deploy Worker (đứt mọi WS) → **100% client tự nối lại**; không desync im lặng.
- [ ] `room-user-change` **debounce ~250ms** — N×close khi deploy KHÔNG nhấp nháy.
- [ ] `first-in-room` dùng cờ `roomEverInitialized` trong `ctx.storage` (KHÔNG length);
      wake-from-hibernate KHÔNG clear scene người reconnect.
- [ ] Reconnect KHÔNG gọi `Portal.close()` → giữ `broadcastedElementVersions` → KHÔNG
      full-scene re-broadcast bão.

**Cờ runtime**
- [ ] `realtime_backend` đọc **runtime per-meeting từ D1** (KHÔNG `import.meta.env`);
      absent/null → mặc định `socketio` (non-breaking).
- [ ] Mọi client trong 1 phòng CÙNG backend (A/B theo cả phòng, không split-brain cross-build).

**Parity**
- [ ] Canvas / presence / chat / follow / rtc / lock / knock PASS so socket.io
      (checklist `docs/plans/durable-objects-migration.md` §7.3 + "Parity acceptance").

**AI / STT**
- [ ] `/translate`, `/chatbot`, `/summarize` trên Worker, rate-limit per-isolate OK.
- [ ] `/stt` WS proxy route riêng, KHÔNG chạm `RoomDO`; STT OFF mặc định (B8).

**Vận hành / chi phí**
- [ ] Secrets đã set trên Worker (xem §4): `GEMINI_API_KEY`, `DEEPGRAM_API_KEY` (+ Daily/Resend cũ).
- [ ] CORS allowlist (B6) đúng; WS-count cap (B1 spend-cap) bật.
- [ ] **Hibernation thật:** phòng idle 10 phút → **0 wake event** trong DO log → $0 compute.
- [ ] **Rollback diễn tập** (xem [`do-rollback.md`](./do-rollback.md)): đổi D1 + reconnect
      **< 5 phút**, không mất data; socket.io-client còn trong bundle; Fly socket.io còn chạy.
- [ ] **Placement:** host nội bộ APAC là người mở phòng đầu (DO neo APAC) — đã hiểu, không cần schema.

---

## 2. Deploy DO lên remote (làm 1 lần, trước khi lật cờ)

Thứ tự BẮT BUỘC: **migration D1 trước → rồi deploy Worker** (giống `deploy.md`).

### 2a. Áp migration `0027` (cờ backend) lên D1 thật

```bash
cd worker
node migrate.mjs --status --remote      # xác nhận 0027_realtime_backend còn PENDING
node migrate.mjs --remote               # áp các migration còn thiếu (gồm 0027)
```

`0027` thêm cột `realtime_backend` (default `socketio`) vào bảng meeting trong `mcm-db`.
Đừng `wrangler d1 execute --file` bằng tay — sẽ lệch tracking `schema_version`.

### 2b. Deploy Worker (gồm class `RoomDO` + binding + DO migration class)

```bash
cd worker
npx wrangler deploy
```

`wrangler deploy` đọc `wrangler.jsonc`: binding `ROOM` (DurableObjectNamespace → class
`RoomDO`) + block `migrations` khai báo class mới (`new_sqlite_classes`/`new_classes`).
Lần đầu deploy class DO mới, **phải** có entry migration trong `wrangler.jsonc`, nếu không
deploy báo lỗi "class not found in migrations".

Smoke sau deploy:
- [ ] `https://mcm-storage.<account>.workers.dev/` không 500.
- [ ] `wrangler tail mcm-storage` chạy, không lỗi boot.
- [ ] Một phòng test (cờ `do`, xem §3) mở được WS `/rooms/:id/ws`, nhận `init-room`.

> Nếu route DO 500 ngay sau deploy → thường do migration `0027` chưa áp remote
> (`node migrate.mjs --remote`) — xem `incident.md` (d).

---

## 3. Lật cờ — rollout dần (vài phòng nội bộ trước)

Cờ ở **D1 per-meeting**. Lật = `UPDATE` cột `realtime_backend`. Lệnh chạy trong `worker/`,
target remote `mcm-db`.

### 3a. Một phòng test nội bộ (an toàn nhất, làm đầu tiên)

```bash
cd worker
# bật DO cho 1 phòng cụ thể
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meeting SET realtime_backend='do' WHERE id='<ROOM_ID>';"

# kiểm tra lại đã set đúng
npx wrangler d1 execute mcm-db --remote \
  --command "SELECT id, realtime_backend FROM meeting WHERE id='<ROOM_ID>';"
```

> Tên bảng/cột thật theo schema `mcm-db` (`meeting`, khoá `id`) — kiểm trong
> `worker/schema/` nếu khác. **Để host nội bộ APAC mở phòng này trước** (DO neo APAC).

Người trong phòng **refresh** để client đọc lại `realtime_backend` lúc `initializeRoom`
→ chuyển sang `RawWsTransport` (DO). Chạy 1-2 buổi nội bộ thật, soi parity + log.

### 3b. Mở rộng theo nhóm (vài phòng → toàn nội bộ)

```bash
cd worker
# ví dụ bật DO cho các meeting tạo bởi nội bộ trong tuần test
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meeting SET realtime_backend='do' WHERE <điều-kiện-nhóm-nội-bộ>;"
```

Tăng dần: 1 phòng → vài phòng nội bộ → toàn bộ nội bộ. **Chỉ mở external + global (Phi)
SAU khi nội bộ ổn định** (theo timeline plan Aug W2).

### 3c. Bật toàn bộ (cutover cuối)

```bash
cd worker
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meeting SET realtime_backend='do';"
# meeting mới: default cột nên đổi sang 'do' ở migration sau, hoặc set ở code tạo meeting
```

> Meeting đang `finished` là read-only (handshake 409) — đổi cờ không ảnh hưởng. Meeting
> mới tạo sẽ lấy default cột; nếu muốn mặc định `do` cho meeting mới, đổi default ở
> migration tiếp theo (KHÔNG sửa 0027 đã áp).

---

## 4. Secrets bắt buộc trên Worker (AI/STT dời lên Worker — I-1)

AI + STT chuyển từ Fly room-server lên Worker → secret phải set trên `mcm-storage`
(KHÔNG để trong `wrangler.jsonc`). Set 1 lần, deploy sau giữ nguyên.

```bash
cd worker
npx wrangler secret put GEMINI_API_KEY       # dịch chat + chatbot + summarize
npx wrangler secret put DEEPGRAM_API_KEY     # STT proxy /stt

# đã có từ trước (giữ nguyên nếu đã set): DAILY_API_KEY, RESEND_API_KEY, SUPABASE_SERVICE_API_KEY
npx wrangler secret list                     # xác nhận đủ (không lộ giá trị)
```

Local dev: thêm `GEMINI_API_KEY` / `DEEPGRAM_API_KEY` vào `worker/.dev.vars` (gitignored).
Chi tiết xoay key: `key-rotation.md` (cập nhật khi key chuyển host → Worker).

---

## 5. Monitor trong lúc cutover

Theo dõi song song hai chỗ:

1. **Admin → tab Realtime** (mới): trạng thái mỗi phòng đang dùng backend nào, số WS,
   phòng nào lỗi handshake (401/403/409). Đây là cửa nhìn nhanh "ai đang trên DO".
2. **Cloudflare observability** cho `mcm-storage`:
   - `npx wrangler tail mcm-storage` — log handshake (verify JWT/knock), 401/403/409, lỗi relay.
   - Dashboard → Worker `mcm-storage` → **Durable Objects metrics**: số DO active, request,
     duration, **wake event** (idle phải về 0), error rate.
   - Theo dõi **eviction + latency** khi mở global (đo latency thật từ Phi — plan §8).

Dấu hiệu phải dừng/rollback ngay (xem `do-rollback.md`):
- Client desync im lặng sau deploy (reconnect fail).
- `first-in-room` clear scene người reconnect (wake-from-hibernate bug).
- Handshake từ chối nhầm người hợp lệ (401/403 sai).
- Wake event liên tục khi idle (rò keep-alive → mất $0 + nghi churn reconnect).

---

## Tham chiếu docs Cloudflare (verify 06-17)

- Placement + data location (first-access region, không đổi sau tạo, `locationHint` honored
  với mọi cách tạo ID, danh sách hint): https://developers.cloudflare.com/durable-objects/reference/data-location/
- Namespace API (`idFromName`, `newUniqueId`, `getByName`, `get` + `locationHint`):
  https://developers.cloudflare.com/durable-objects/api/namespace/
- `DurableObjectId` + `jurisdiction` (`eu` / `fedramp`): https://developers.cloudflare.com/durable-objects/api/id/
