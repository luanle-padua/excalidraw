# Runbook — Rollback realtime DO → socket.io

Lưới an toàn cho **cửa sổ cutover**: nếu DO lỗi sau khi bật, lật `realtime_backend` về
`socketio` để phòng họp về Fly/socket.io. **Mục tiêu < 5 phút**, không mất dữ liệu.

> **Lưu ý vòng đời:** lưới rollback này **CHỈ cho cửa sổ cutover**. Đích dài hạn là **bỏ
> hẳn socket.io + `room/`** (plan §1, chốt 06-17). Khi DO ổn định ≥ vài tuần sau August →
> retire socket.io, gỡ runbook này.

Cutover: [`do-cutover.md`](./do-cutover.md). Plan: `docs/plans/durable-objects-migration.md` §7.4.

---

## Vì sao rollback an toàn (không mất data)

- **R2 authoritative** cho scene / chat / library. DO **KHÔNG giữ canvas state bền vững** —
  nó chỉ relay + presence + auth gate. Tắt DO không mất gì.
- Rollback = **đổi 1 giá trị D1 + client reconnect**, KHÔNG migrate dữ liệu, KHÔNG redeploy.
- `socket.io-client` vẫn **nằm trong bundle** suốt cửa sổ rollback (~30KB gz) → lật cờ là
  client tự chuyển transport, không cần build/deploy frontend lại.

## Prerequisite (phải đúng TRƯỚC khi cần rollback)

- [ ] **Fly socket.io room-server còn chạy + reachable** suốt cửa sổ rollback. Probe:
      `curl http://<host>/health` → `{ "ok": true, ... }` (xem `incident.md` (a)).
      Nếu đã tắt Fly thì rollback bằng cờ **vô tác dụng** — client sẽ không có server để nối.
- [ ] `VITE_APP_WS_SERVER_URL` (Pages) vẫn trỏ đúng room-server socket.io.
- [ ] `socket.io-client` còn trong bundle production (chưa tree-shake bỏ).

> Vì vậy: trong cửa sổ cutover **KHÔNG tắt Fly, KHÔNG gỡ socket.io-client**. Chỉ gỡ khi
> retire socket.io hẳn (sau August, DO ổn định).

---

## Drill rollback (chạy được, < 5 phút)

### 1. Lật cờ về socketio trong D1 (`worker/`, remote `mcm-db`)

**Một phòng** (rollback cục bộ khi chỉ 1 phòng lỗi):

```bash
cd worker
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meeting SET realtime_backend='socketio' WHERE id='<ROOM_ID>';"
```

**Toàn bộ** (rollback diện rộng khi DO lỗi hệ thống):

```bash
cd worker
npx wrangler d1 execute mcm-db --remote \
  --command "UPDATE meeting SET realtime_backend='socketio';"
```

Kiểm tra đã đổi:

```bash
npx wrangler d1 execute mcm-db --remote \
  --command "SELECT realtime_backend, COUNT(*) FROM meeting GROUP BY realtime_backend;"
```

### 2. Client reconnect

- Báo người trong phòng **refresh trình duyệt** → client đọc lại `realtime_backend` lúc
  `initializeRoom` → thấy `socketio` → dùng socket.io-client nối về Fly.
- Reconnect loop client tự nối lại khi WS DO đứt; nhưng refresh là cách chắc + nhanh nhất
  để đọc cờ mới.
- Canvas KHÔNG mất (R2/D1 authoritative) — chỉ đổi đường realtime.

### 3. Xác nhận đã về socket.io

- [ ] Admin → tab Realtime: phòng hiển thị backend `socketio`.
- [ ] 2 client cùng phòng thấy con trỏ + sync nhau qua room-server (Fly).
- [ ] `curl http://<host>/health` OK (room-server đang phục vụ).
- [ ] `wrangler tail mcm-storage`: không còn handshake `/rooms/:id/ws` cho phòng đã rollback.

---

## Sau rollback

1. Giữ phòng trên socket.io, **điều tra root cause DO** (log `wrangler tail`, DO metrics:
   wake event, error, handshake fail).
2. Vá DO, deploy lại Worker (xem `do-cutover.md` §2), verify trên **1 phòng test** trước.
3. Chỉ bật `do` lại theo rollout dần (`do-cutover.md` §3) sau khi GO/NO-GO pass lại.

> Đo thật thời gian drill (lật D1 → refresh → sync lại) phải **< 5 phút**. Nếu lâu hơn,
> kiểm: Fly có reachable không, client có đọc cờ runtime đúng không, bundle còn
> socket.io-client không.
