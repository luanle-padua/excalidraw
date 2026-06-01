# 2026-06-01 — Kế hoạch hạ tầng tháng 6: migrate sang Cloudflare serverless

> Mục tiêu: tháng 6/2026 hoàn thiện **phần hạ tầng** của MAP CanvasMeet để demo.
> Phần tính năng (collab, audio, STT/dịch, viewer DXF/PDF/IFC, AI bot) coi như xong —
> đây là kế hoạch chuyển từ mô hình *"máy dev + quick tunnel"* sang **Cloudflare serverless**.

## 1. Phạm vi (đã chốt với chủ dự án 01/06)

4 ưu tiên, theo thứ tự:

1. **URL ổn định + always-on** — không phụ thuộc máy dev bật.
2. **Persist scene** — reload / đóng phòng không mất canvas.
3. **Auth + room management** — SSO email công ty, danh sách phòng, lịch, host.
4. *(Trượt được)* **Video conferencing** — giữ audio-only nếu thiếu thời gian.

**Nơi chạy:** Cloudflare serverless. **Realtime:** Durable Objects (raw WebSocket) — KHÔNG dùng
Containers/VPS. Đường thuần serverless, scale-to-zero, rẻ nhất; đánh đổi là refactor transport lớn nhất.

## 2. Kiến trúc đích

```
        Cloudflare Access (SSO email công ty, free ≤50 user)        ← Auth (Tuần 4)
                              │ Access JWT
   app.<domain>.com ─────────┤
                              ▼
   Cloudflare Pages ──► static build excalidraw-app                 ← URL ổn định (Tuần 1)
                              │
   Worker (router) ──────────┼─────────────────────────────────────┐
                              │                                     │
   ┌── /ws (Upgrade) ─► Durable Object  MeetingRoom (1/phòng)       │  ← Realtime (Tuần 2)
   │      • relay 7 event transport + presence + follow            │
   │      • WebSocket Hibernation API                              │
   │                                                                │
   ├── /chatbot /translate /translate-batch /summarize /turn ─► Gemini  ← AI/TURN (Tuần 1)
   │                                                                │
   └── persist ──► R2 (scene blob + asset, đã mã hoá E2E)          │  ← Persist (Tuần 3)
                   D1 (danh sách phòng / lịch / host / metadata)    │  ← Room mgmt (Tuần 3)
```

**Nguyên tắc giữ nguyên:** E2E encryption client-side không đổi. Hash `#room=<roomId>,<roomKey>`
giữ nguyên; `roomKey` là AES-GCM key, server (DO + R2) chỉ thấy ciphertext.

## 3. Insight then chốt khiến DO khả thi

Relay hiện tại ([room/src/index.ts](../room/src/index.ts), socket.io) **chỉ xử lý ~7 event transport** —
toàn bộ message phong phú (`WS_SUBTYPES` UPDATE / MOUSE_LOCATION / CHAT / STT / LIBRARY / …) nằm
**bên trong blob mã hoá E2E**, relay không decode. Vậy DO **không** phải reimplement 20+ subtype, chỉ relay lại blob.

Event transport cần port (xem [app_constants.ts](../excalidraw-app/app_constants.ts) + [room/src/index.ts](../room/src/index.ts):904–1038):

| Event (server) | Hành vi | Phía DO |
| --- | --- | --- |
| `init-room` (server→1) | Bắn ngay khi connect | DO gửi khi WS mở |
| `join-room` (client→server) | join + tính presence | Thêm WS vào set của DO; tính `first-in-room` / `new-user` |
| `first-in-room` (server→1) | Người đầu phòng | `connectedCount <= 1` |
| `new-user` (server→broadcast) | Báo có người mới | broadcast trừ sender |
| `room-user-change` (server→all) | Danh sách socketId | broadcast set id hiện tại |
| `server-broadcast` → `client-broadcast` | Relay blob `[encryptedData, iv]` | broadcast tới peer khác, giữ binary |
| `server-volatile-broadcast` → `client-broadcast` | Như trên, drop được | broadcast (không cần reliability) |
| `request-room-clients` | Xin lại presence | trả `room-user-change` cho riêng socket |
| `rtc-signal` (to/from) | Signaling audio/video mesh | route tới WS theo `to` |
| `user-follow` (FOLLOW/UNFOLLOW) | Follow-view rooms `follow@<id>` | sub-set trong DO; bắn `user-follow-room-change` |
| `broadcast-unfollow` | Khi follow-room rỗng | như cũ |
| `disconnecting` | Cập nhật presence + dọn follow | hook `webSocketClose` của DO |

**`socket.id` là load-bearing** (presence, `follow@<id>`, `rtc-signal.to/from` đều key theo nó) →
DO phải tự **mint connection-id ổn định** mỗi WS và gắn vào `ws.serializeAttachment()` (sống qua hibernation).

## 4. Chiến lược giảm sửa client: adapter `RoomSocket`

Thay vì sửa khắp [Collab.tsx](../excalidraw-app/collab/Collab.tsx) + [Portal.tsx](../excalidraw-app/collab/Portal.tsx),
viết **một adapter** `RoomSocket` phơi đúng subset API của `socket.io-client` mà code đang dùng:

```
.on(event, cb)  .off(event, cb)  .once(event, cb)
.emit(event, ...args)            // args có thể gồm ArrayBuffer + Uint8Array
.id                              // = connection-id do DO cấp
.close()  .connect()
sự kiện nội bộ: "connect", "connect_error"
```

Backing bằng raw `WebSocket` tới DO. Điểm chạm tối thiểu:
- [Collab.tsx](../excalidraw-app/collab/Collab.tsx):690–715 — thay `import socketIOClient` + `socketIOClient(...)` bằng `new RoomSocket(wsUrl, roomId)`.
- [Portal.tsx](../excalidraw-app/collab/Portal.tsx):27 `socket: Socket` → `socket: RoomSocket`. Phần còn lại của Portal/Collab gần như giữ nguyên vì API trùng.

### Wire format (envelope qua raw WS)

socket.io tự đóng khung event+args (kể cả binary). Raw WS không có → tự định nghĩa envelope nhị phân:

```
[4 byte big-endian headerLen][header JSON utf8][payload nhị phân (tuỳ chọn)]
header = { "ev": "<event>", "args": [<json-serializable args>], "bin": <true nếu có payload> }
payload (khi bin=true) = [iv 12 byte][ciphertext...]   // chính là encryptedData của broadcastScene
```

- Event không binary (`join-room`, `room-user-change`, `rtc-signal`…) → chỉ header, `bin=false`.
- `server-broadcast` / `client-broadcast` → `bin=true`, tách `iv` + `encryptedData` ở header/payload.
- (Tuỳ chọn) cân nhắc msgpack nếu muốn gọn hơn — nhưng JSON-header đủ cho demo, dễ debug.

### Reconnect & hibernation

- Dùng **WebSocket Hibernation API** của DO (`state.acceptWebSocket(ws)`, handler `webSocketMessage/Close/Error`)
  → DO ngủ khi không có message, không tính tiền wall-clock khi idle.
- `RoomSocket` tự reconnect (backoff) khi WS rớt; re-`join-room`. Lưu ý `socketInitialized`
  ([Portal.tsx](../excalidraw-app/collab/Portal.tsx):28) reset đúng như flow `first-in-room` cũ.

## 5. Persist scene — thay lớp Firebase

Interface persist gói gọn **6 hàm** trong [data/firebase.ts](../excalidraw-app/data/firebase.ts), gọi tại
[Collab.tsx](../excalidraw-app/collab/Collab.tsx):279/287/474/495/1044, [App.tsx](../excalidraw-app/App.tsx):470, [data/index.ts](../excalidraw-app/data/index.ts):425:

| Hàm | Vai trò | Map sang Cloudflare |
| --- | --- | --- |
| `loadFirebaseStorage` | Lazy init client | Bỏ (không cần) |
| `saveToFirebase(portal, elements, files)` | Lưu scene mã hoá | `PUT /rooms/:roomId/scene` → R2 object `rooms/<roomId>/scene` (ciphertext) |
| `loadFromFirebase(roomId, roomKey, socket)` | Tải scene | `GET /rooms/:roomId/scene` → R2 → giải mã client-side |
| `isSavedToFirebase(portal, elements)` | Check version đã lưu | So `broadcastedElementVersions` (local) hoặc ETag R2 |
| `saveFilesToFirebase({prefix, files})` | Lưu asset (ảnh/IFC/PDF) | `PUT /files/...` → R2 `files/rooms/<roomId>/<fileId>` |
| `loadFilesFromFirebase(prefix, key, ids)` | Tải asset | `GET /files/...` → R2 |

→ Tạo `excalidraw-app/data/storage.ts` cùng **chữ ký y hệt**, sửa import ở 3 file trên (hoặc re-export
từ `firebase.ts` để zero-churn). Backend: Worker route đọc/ghi R2; metadata (version, updatedAt) vào D1.

**Giữ E2E:** client vẫn `encryptData(roomKey, ...)` trước khi gửi; R2 chỉ chứa ciphertext — đúng mô hình hiện tại.

## 6. D1 schema (room management)

```sql
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,          -- roomId (KHÔNG chứa roomKey — key chỉ ở client/hash)
  title       TEXT,
  host_email  TEXT,                      -- từ Access JWT
  created_at  INTEGER,
  updated_at  INTEGER,
  scene_etag  TEXT                        -- version scene mới nhất trong R2
);
CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  room_id     TEXT REFERENCES rooms(id),
  start_at    INTEGER,
  end_at      INTEGER,
  created_by  TEXT
);
CREATE TABLE memberships (                 -- ai được vào phòng nào (nếu cần private)
  room_id     TEXT,
  user_email  TEXT,
  role        TEXT,                        -- 'host' | 'member'
  PRIMARY KEY (room_id, user_email)
);
```

UI tối thiểu cho demo: trang "Phòng của tôi" (list từ `rooms`), nút *Tạo phòng* (sinh roomId+roomKey, ghi D1),
nút *Vào*. Lịch họp có thể chỉ hiển thị, chưa cần nhắc.

## 7. Auth — Cloudflare Access

- Bật **Access** trên `app.<domain>.com`: policy = email thuộc domain công ty (hoặc allowlist). Free ≤50 user.
- Worker verify **`Cf-Access-Jwt-Assertion`** (JWKS của team) → lấy `email` → dùng cho `host_email`/`memberships`.
- Access đứng trước cả Pages lẫn Worker → mọi request đã auth; không tự build login.

## 8. Task breakdown theo tuần

**Tuần 1 (02–08/06) · Deploy nền tảng + URL ổn định**
- [ ] `wrangler` project; build `excalidraw-app` → Cloudflare Pages; gắn custom domain.
- [ ] Worker router khung; port `/chatbot` `/translate` `/translate-batch` `/summarize` `/turn-credentials`
      từ [room/src/index.ts](../room/src/index.ts) sang Worker `fetch` (Gemini key = Worker secret).
- [ ] *Mốc:* mở app qua domain thật, AI/dịch chạy; collab tạm vẫn dùng relay cũ.

**Tuần 2 (09–15/06) · Realtime → Durable Objects** ⭐ lõi
- [ ] DO `MeetingRoom`: Hibernation API, mint connection-id, relay 7 event + presence + follow + rtc-signal.
- [ ] `RoomSocket` adapter (client) + envelope wire format; thay socketIOClient ở [Collab.tsx](../excalidraw-app/collab/Collab.tsx):690–715.
- [ ] Reconnect/backoff; verify cursor + follow-view + audio signaling.
- [ ] *Mốc:* 2–3 máy collab realtime qua DO, gỡ hẳn room server Node.

**Tuần 3 (16–22/06) · Persist + Room management**
- [ ] `data/storage.ts` (6 hàm) + Worker R2 routes; verify reload không mất canvas + asset.
- [ ] D1 schema + Worker CRUD phòng; UI "Phòng của tôi" + tạo/vào phòng.

**Tuần 4 (23–29/06) · Auth + hoàn thiện**
- [ ] Bật Cloudflare Access; Worker verify Access JWT → email; gắn host/permission.
- [ ] Dọn debug (Eruda, `console.log` [App.tsx](../excalidraw-app/App.tsx):328 & [Collab.tsx](../excalidraw-app/collab/Collab.tsx):524, `DEBUG=*` ở room cũ).
- [ ] Test end-to-end + kịch bản demo.

## 9. Rủi ro & giảm thiểu

- **DO refactor là phần nặng nhất** → làm Tuần 2, giữ relay cũ làm fallback tới khi DO chạy ổn (feature-flag `VITE_REALTIME=do|socketio`).
- **Binary qua raw WS**: socket.io xử lý binary tự động; raw WS phải tự đóng khung → đã định nghĩa envelope ở §4; test sớm với `broadcastScene`.
- **Hibernation + presence**: id phải sống qua ngủ → `serializeAttachment`. Test reconnect kỹ.
- **Pages build lớn (IFC/three, web-ifc wasm)**: kiểm tra giới hạn asset Pages; web-ifc wasm phải serve đúng MIME.
- **Access chặn WebSocket**: xác nhận Access cho phép Upgrade tới Worker/DO (có thể cần service token cho `/ws`).

## 10. Cần verify trên Cloudflare (kiến thức chốt ở 01/2026)

- DO **WebSocket Hibernation API** signature hiện tại (`acceptWebSocket`, `webSocketMessage/Close/Error`).
- Pages + Functions vs Workers-only (binding R2/D1/DO từ Pages Functions hay tách Worker riêng).
- Giá/giới hạn **R2, D1, DO**; **Access** free tier ≤50 user còn đúng không.
- Access có chặn WS Upgrade không; cách verify Access JWT (JWKS endpoint của team).

## 11. Definition of Done (demo cuối tháng 6)

- [ ] URL cố định `app.<domain>.com`, mở được không cần máy dev bật.
- [ ] 2–3 người vào cùng phòng, collab realtime (cursor/scene/follow) + audio qua DO.
- [ ] Reload trang → canvas còn nguyên (persist R2).
- [ ] Đăng nhập bằng email công ty (Access); thấy danh sách phòng; tạo/vào phòng.
- [ ] AI bot + dịch + STT vẫn chạy (qua Worker).

## Tham khảo nhanh

- Quyết định & lý do: memory `project_mcm-june-infra` (tóm tắt kiến trúc), `mcm-overview` (feature layer).
- Protocol transport: [room/src/index.ts](../room/src/index.ts):904–1038; constants [app_constants.ts](../excalidraw-app/app_constants.ts):16–58.
- Client transport: [Collab.tsx](../excalidraw-app/collab/Collab.tsx):690–715, [Portal.tsx](../excalidraw-app/collab/Portal.tsx).
- Persist interface: [data/firebase.ts](../excalidraw-app/data/firebase.ts) (6 hàm), callers ở §5.
