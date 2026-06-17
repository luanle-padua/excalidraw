# Migration realtime: socket.io → Cloudflare Durable Objects (DO)

> **Chốt 06-17.** Chuyển lớp realtime của MAP CanvasMeet (Canvas M) từ **Node + Express + socket.io (1 instance Fly.io)** sang **1 Durable Object / 1 phòng họp** — raw WebSocket + Hibernation API — host **chung trên Worker `mcm-storage`** (Hono, D1 `mcm-db`, R2 `mcm-storage`).
>
> **CHỐT 06-17 (REVISED): chuyển TOÀN BỘ realtime sang DO — 100%, KHÔNG Fly, KHÔNG giữ socket.io lâu dài.** DO chạy ngay trên Worker `mcm-storage` (không host riêng, không tốn host). Cờ `realtime_backend` chỉ là công tắc TẠM trong lúc build/test; đích = pure DO + **bỏ hẳn `room/` socket.io**. _(Mọi nhắc tới "Fly.io" / "giữ socket.io làm rollback lâu dài" ở các mục dưới = framing CŨ đã huỷ — bỏ qua.)_
>
> Migration này **nuốt luôn 1b/B12** (room-server auth gap): handshake WS của DO **verify Supabase JWT + canSeeMeeting + knock** — điều mà socket.io relay hiện tại KHÔNG làm (roadmap track I-2, blocker 1b).
>
> **Ràng buộc PM (anh Luân — simplicity-first, tự maintain, all-in Cloudflare):** giữ vận hành đơn giản, không over-engineer; **mọi tính năng liên quan phải chạy ổn định xuyên suốt** (incremental, parity-verified, rollback-able).

---

## 1. Mục tiêu & nguyên tắc

**Mục tiêu**

- **M1** — Bỏ SPOF socket.io 1-instance (track I-2), về serverless all-in Cloudflare.
- **M2** — **Đóng 1b/B12:** hiện `room/src/index.ts:863-867` mở `cors origin:'*'`, **không verify gì** — ai biết roomId là relay được scene bytes (`server-broadcast` `:905-911`). DO phải verify **JWT + canSeeMeeting + knock TRƯỚC khi trả `101 Switching Protocols`**.
- **M3** — Sẵn sàng đa quốc gia (Hàn + VN + Phi) trước August, latency chấp nhận được cho payload delta nhỏ.
- **M4** — Giảm chi phí: phòng idle → hibernate → $0 compute (GB-s ngừng tính), client vẫn nối ở edge.

**Nguyên tắc (ràng buộc anh Luân)**

- **P1 — Parity tuyệt đối.** Giữ NGUYÊN wire contract `(event, roomId, encryptedBuffer, iv)` (`Portal.tsx:107-112`) và `client-broadcast` (`Collab.tsx:1246`). DO là **relay E2E ngu** — không decrypt, không hiểu 18 WS_SUBTYPES. **Đổi _transport_, không đổi _semantics_.**
- **P2 — Incremental + dual-run.** socket.io chạy song song suốt July; chọn backend là **runtime per-meeting từ server** (KHÔNG `import.meta.env` build-time — xem §7.1), swap đúng block connect (`Collab.tsx:1100-1126`) + transport trong Portal.
- **P3 — Rollback-able tức thì.** R2 vẫn authoritative cho scene/chat/library; DO **không giữ canvas state bền vững** → rollback = đổi giá trị backend per-meeting, không migrate dữ liệu.
- **P4 — Không over-engineer.** KHÔNG dựng CRDT/snapshot/last-write-wins server-side ở DO cho bản August. DO = relay + presence + auth gate. Mọi thứ "thông minh" hơn để Phase sau.

---

## 2. Kiến trúc đích

```
                       ┌──────────────────────────────────────────────┐
   Browser (client)    │            Cloudflare (mcm-storage Worker)    │
                       │                                              │
  raw WebSocket  ──────┼──► Worker.fetch() switch theo url.pathname:  │
  (Sec-WebSocket-      │      /stt          → Deepgram WS proxy        │
   Protocol = token)   │      /rooms/:id/ws → [AUTH GATE] → RoomDO     │
   #room=ID,KEY  ──────┼──►  /v1/*          → REST (JWT gate :148-183) │
   (roomKey E2E)       │                                              │
                       │   AUTH GATE (trước .get(), tái dùng :146-183):│
                       │     1. verify Supabase JWT (jose/JWKS)        │
                       │     2. canSeeMeeting(DB,email,role,roomId)    │
                       │     3. knock.status='admitted'? (external)    │
                       │     4. WS-count cap (RPC tới DO) < N          │
                       │     ─ FAIL → 401/403, KHÔNG trả 101 ─         │
                       │     ─ OK → env.ROOM.idFromName(roomId).get()─ │
                       │                      │                       │
                       │                      ▼                       │
                       │        ┌───────────────────────────────┐    │
                       │        │  RoomDO  (1 instance = 1 phòng)│    │
                       │        │  acceptWebSocket(server,[tags])│    │
                       │        │  send init-room NGAY sau accept│    │
                       │        │  webSocketMessage/Close/Error  │    │
                       │        │  getWebSockets() = presence    │    │
                       │        │  serializeAttachment = identity│    │
                       │        │  ctx.storage: roomEverInited   │    │
                       │        │  Hibernation khi idle → $0     │    │
                       │        └───────────────────────────────┘    │
                       │                                              │
   HTTP  ──────────────┼──►  AI routes (Gemini): /translate          │
   /translate /chatbot │       /translate-batch /chatbot /summarize  │
   /summarize          │       (I-1 dời từ Fly lên Worker)            │
                       └──────────────────────────────────────────────┘

  Daily.co (audio/video media)  ── tách riêng, token gate ở Worker, KHÔNG qua DO
  TURN  ── ĐÃ BỎ
```

**Khẳng định cốt lõi: 1 DO = 1 phòng họp.** `env.ROOM.idFromName(roomId)` deterministic → mọi participant cùng meeting đáp xuống đúng 1 DO instance. Đó là toàn bộ "coordination primitive" — không cần room registry, không cross-room (pattern tldraw-sync / PartyKit "một WS server / phòng").

**Phân tách rõ:**

- **DO** — chỉ realtime collab relay (7 nhóm event + presence + follow + rtc-signal).
- **Worker REST/D1/R2** — GIỮ NGUYÊN: roomGate (`worker/src/index.ts:693-728`), canSeeMeeting (`:306-372`), Daily token (`:3467-3589`), knock routes.
- **AI (I-1)** — dời từ Fly lên Worker (HTTP routes); **KHÔNG nằm trong DO**. STT `/stt` = WS proxy riêng trên Worker, **route tách khỏi `/rooms/:id/ws`**.

---

## 3. Ánh xạ chi tiết: socket.io hiện tại → DO mới

| socket.io hiện tại (file:line) | Cơ chế cũ | Tương đương DO | Độ khó |
|---|---|---|---|
| `connection` → `init-room` (`index.ts:887`) | emit `init-room` ngay khi socket mới nối, TRƯỚC mọi message | **Phải gửi NGAY khi accept**, trong cùng lượt `fetch()`: sau `acceptWebSocket(server,...)` gọi `server.send({ev:'init-room'})` đồng bộ TRƯỚC khi return Response 101. KHÔNG đợi `join-room`. (client `Portal.tsx:46-51` chỉ emit `join-room` sau khi nhận `init-room`) | TB |
| `join-room` (`index.ts:888-903`) | join room; `first-in-room` nếu ≤1; else `new-user`; rồi `room-user-change` full list | `webSocketMessage` nhận join: quyết định `first-in-room` dựa **cờ `roomEverInitialized` trong `ctx.storage`** (KHÔNG `getWebSockets().length` — xem §3.1 dưới); else `new-user` cho peer khác; rồi broadcast `room-user-change` = list socketId từ attachments | **Cao** |
| `server-broadcast` (`index.ts:905-911`) | `socket.broadcast.to(room).emit('client-broadcast', data, iv)` | Loop `getWebSockets()`, skip sender, chỉ WS `readyState===OPEN`, `ws.send(frame)` — relay opaque `(encryptedData, iv)` y nguyên | Dễ |
| `server-volatile-broadcast` (`index.ts:913-921`) | volatile = **drop nếu socket buffer đầy (backpressure)**, KHÔNG phải drop khi peer disconnect | Raw WS không có "volatile". Path này: chỉ gửi tới WS `OPEN` **và** `bufferedAmount` dưới ngưỡng (vài trăm KB), vượt → bỏ qua. Khớp ngữ nghĩa backpressure-drop của cursor/idle (MOUSE_LOCATION `:1287`) | TB |
| `request-room-clients` (`index.ts:934-945`) | re-emit peer list (audio mesh catch-up) | nhận control msg → gửi lại `room-user-change`, list **chỉ từ WS `OPEN`** (loại CLOSING) map qua `deserializeAttachment().socketId`. **D1: hiện KHÔNG client nào emit (WebRTC mesh → Daily.co); GIỮ làm forward-compat rẻ, có comment trong `roomDO.ts`. KHÔNG xoá.** | TB |
| `rtc-signal` (`index.ts:947-957`) | TARGETED: `io.to(payload.to).emit('rtc-signal',{from,...})` | tra WS theo `deserializeAttachment().socketId === payload.to`, gửi `{from, type, data}`. Không thấy → `rtc-error{reason:'peer-offline'}` cho sender (tránh treo WebRTC). **D1: hiện KHÔNG client nào emit (WebRTC mesh → Daily.co); GIỮ làm forward-compat rẻ, có comment trong `roomDO.ts`. KHÔNG xoá.** | TB |
| `user-follow` FOLLOW/UNFOLLOW (`index.ts:959-990`) | sub-room `follow@<socketId>`; emit `user-follow-room-change` | Follow-map giữ **trong instance memory** (rebuild lazy 1 lần on-wake từ attachments — KHÔNG scan mọi WS mỗi close); emit `user-follow-room-change` tới followed. Mất khi evict → follower tự re-FOLLOW (không critical) | Dễ |
| `disconnecting` (`index.ts:992-1013`) | mỗi socket tự recompute `room-user-change`; `broadcast-unfollow` nếu follow room rỗng | `webSocketClose`: xóa khỏi follow map; **debounce `room-user-change` ~250ms** gộp nhiều close (bắt buộc — deploy = N×close đồng thời); nếu followed mất hết follower → `broadcast-unfollow` | **Cao** |
| `disconnect` (`index.ts:1015-1018`) | remove listeners | DO không cần — runtime tự dọn WS đã đóng | — |
| Heartbeat 25s/20s (`index.ts:871-882`) | socket.io ping để sống qua IFC/DXF stall | **Bỏ app-heartbeat.** `RawWsTransport` KHÔNG gửi heartbeat nào (dựa WS keepalive của edge). `ctx.setWebSocketAutoResponse(ping/pong)` đáp ping mà KHÔNG wake DO. Xóa luôn class bug reconnect-churn | Dễ |
| `maxHttpBufferSize 50MB` (`index.ts:882`) — LIBRARY_FILE inline | file binary nhồi inline qua broadcast | **HARD BREAK:** Workers WS cap **1 MiB/msg**. Đổi library-file sang **R2-by-reference** (đã có path R2 `Collab.tsx:2803-2875`): broadcast chỉ `{fileId, r2Key, meta}`, peer fetch R2 | **Bắt buộc fix trước cutover** |
| presence list (`room-user-change`) | server liệt kê socket.id trong room | **Derive, đừng store:** list = `getWebSockets()` (chỉ OPEN) map qua `deserializeAttachment().socketId` | Dễ |
| socket.id (server-gen) | ổn định trong 1 session/instance | DO mint `socketId` (UUID) lúc accept, lưu `serializeAttachment({socketId,userId,email,role,joinedAt})` (≤2KB) để sống qua hibernation; client đọc từ `init-room` | TB |
| Translation cache + rate-limit (`index.ts:46-137,315-848`) | in-memory Map + express-rate-limit (per-IP, 1 instance) | HTTP routes trên Worker, **không qua DO**. cache/rate-limit thành per-isolate (Gemini rẻ). Chi tiết §6 | TB |
| STT `/stt` (`stt.ts:244-383`) | raw WS proxy ↔ Deepgram, mount cạnh socket.io (`index.ts:855` đã tách non-/stt) | WS proxy riêng trên Worker; Worker route theo `pathname` TRƯỚC `.get()` DO; **không vào RoomDO** | TB |
| Screen-share LOCK | client-side: `applyScreenShare` dedup/early-return (`Collab.tsx:2405-2421`, guard `:2407-2413`) + `setScreenShare` broadcast (`:2426-2433`); prune-on-leave (`:1862-1883`, inside room-user-change) | DO chỉ relay SCREEN_SHARE; lock + prune giữ client-side. KHÔNG đổi DO. **(D5 — anchors re-verified 06-17)** | — |
| Knock (waiting room) | client poll `getMyKnock` ~5s tới Worker | GIỮ HTTP poll. **Thêm:** DO handshake check `meeting_knock.status='admitted'` cho external (§4) | TB |
| Host election | `joinedAt` nhỏ nhất thắng, qua USER_PROFILE | DO chỉ relay; logic client giữ nguyên (`restoreHostClaimForRoom`, sentinel localStorage) | — |
| Revoke/kick (06-11) | client poll `getMeetingChecked` 60s → `kickedAtom` (`Collab.tsx:1574-1604`) | **GIỮ poll-60s** (đủ cho August). DO alarm re-check = DEFER (phá hibernation, §10/§D) | — |

### 3.1 Ba invariant presence dễ vỡ thầm lặng (từ critique — bắt buộc đúng)

1. **`first-in-room` KHÔNG được suy từ `getWebSockets().length<=1`.** Khi DO vừa wake từ hibernation và nhận lại WS đầu tiên sau evict, `length===1` → một client đang reconnect sẽ bị đếm là "first-in-room" → trigger `initializeRoom` clear scene. **Đúng:** lưu cờ `roomEverInitialized` trong `ctx.storage` (bền qua hibernate); chỉ gửi `first-in-room` khi cờ false, sau đó set true; mọi reconnect khác = `new-user`. Khớp invariant `Collab.tsx:1131` (reload KHÔNG fire `first-in-room`, host restore từ localStorage).

2. **Reconnect KHÔNG được gọi `Portal.close()`.** `broadcastedElementVersions: Map` (`Portal.tsx:34`) là CLIENT-side. Nếu reconnect reset Map (qua `Portal.close()` `:76`), client re-broadcast TOÀN BỘ scene như INIT → **bão UPDATE trên DO single-thread**. Reconnect chỉ swap transport, GIỮ Map. Test: "reconnect không gây full-scene re-broadcast".

3. **STT_SEGMENT đi đường `client-broadcast` (E2E qua roomKey), KHÔNG vòng qua Worker.** Giữ thứ tự per-sender (DO single-thread bảo toàn) + giữ mã hóa. STT proxy `/stt` chỉ làm PCM↔Deepgram, không bơm segment vào DO.

---

## 4. Auth handshake = fix 1b/B12

**Vấn đề:** `room/src/index.ts:863-867` socket.io `cors origin:'*'`, không verify. `server-broadcast` (`:905-911`) relay scene bytes cho bất kỳ ai biết roomId. Hôm nay chỉ Daily token endpoint (`worker/src/index.ts:3502-3514`) chặn external → guest có roomKey nhưng knock **denied** vẫn edit canvas được. **Đây là B12/1b.**

**Lời giải — verify TRƯỚC khi trả `101`, Ở WORKER (trước `.get()`), tái dùng y hệt middleware `worker/src/index.ts:146-183`:**

```
GET /rooms/:roomId/ws
├─ token = req.headers['sec-websocket-protocol']  (ưu tiên; echo lại subprotocol đã chọn)
│           fallback ?token=  — token lấy từ supabase.auth.getSession().access_token
│           (KHÔNG ưu tiên query param: rò vào log/referrer)
├─ jwtVerify(token, JWKS)   // createRemoteJWKSet(${SUPABASE_URL}/auth/v1/.well-known/jwks.json)
│     issuer=${SUPABASE_URL}/auth/v1 ; audience='authenticated' → {sub,email,role}
│     FAIL → 401  (KHÔNG 101)
├─ canSeeMeeting(env.DB, email, role, roomId)   // copy logic :306-372; index (room_id,email)
│     FAIL → 403  (KHÔNG 101)
├─ external (role≠admin && !isInternalEmail(email)):
│     SELECT status FROM meeting_knock WHERE room_id=? AND email=lower(?)
│     status≠'admitted' → 403  (khớp :3502-3514)
├─ WS-count cap: RPC tới DO lấy getWebSockets().length; > N (vd 500) → 403  (chống DDoS spam-mở WS)
└─ OK → id=env.ROOM.idFromName(roomId); stub=env.ROOM.get(id); return stub.fetch(req)
        DO accept WS, serializeAttachment({sub,email,role,socketId,joinedAt})
```

Verify ở Worker **trước `.get()`** → user bị từ chối **không spin up DO** (fail-fast, đỡ tiền + đỡ tấn công). **DO re-trust attachment, KHÔNG re-verify JWKS trong hot path.**

**Token hết hạn / revoke giữa chừng:**

- **Reconnect → verify lại** (token mới). Tuyến chính.
- **Revoke mid-meeting (kick 06-11):** GIỮ **poll-60s client** (`Collab.tsx:1574-1604`, `kickedAtom`) — đã là lưới kick 06-11, đủ cho August. **DO alarm re-check = DEFER:** alarm wake DO định kỳ + D1 query mỗi phòng = đốt compute + phá hibernation, trái simplicity-first. Chỉ thêm khi external lạm dụng thật.

**JWKS stale:** jose cache JWKS per-isolate. Supabase xoay key + isolate mới → 401. Mitigation: `Cache-Control: max-age=60s`; trên 401 refetch JWKS bypass cache; client retry. (rủi ro thấp).

---

## 5. Đổi phía client: socket.io-client → WebSocket thuần

**Điểm swap DUY NHẤT:** `Collab.tsx:1100-1126` (dynamic import socket.io-client, `VITE_APP_WS_SERVER_URL`) + transport trong `Portal`. Mọi thứ khác giữ nguyên.

**`RawWsTransport` mimic bề mặt socket.io** để app chạy trên cả hai backend không sửa logic:

- Cài `.on(ev,cb)`, `.off`, `.emit(ev,...args)`, `.id`, `.close()`, `.connect()` — y hệt API socket.io mà `Portal.open` (`Portal.tsx:40-64`) + Collab đang dùng (`init-room`, `new-user`, `room-user-change`, `client-broadcast`, `first-in-room`, `user-follow-room-change`).
- **Wire frame — đơn giản hóa, KHÔNG tự chế length-prefix parser** (giảm bug cho 1-người maintain): chỉ có 2 loại frame → phân biệt bằng `typeof event.data`:
  - **control** = `ws.send(JSON string)` — `{ev, args}`.
  - **scene/binary** = `ws.send(ArrayBuffer)` — body `[iv:12B][ciphertext]` (cộng 1 header byte/route tối thiểu để gắn event name nếu cần).
  - Nhận: `typeof data==='string'` → control; `instanceof ArrayBuffer` → binary. Ít code, ít bug, dễ maintain hơn `[4B len][JSON][bin]` tự chế.
- **Encrypt/decrypt KHÔNG đổi:** `_broadcastSocketData` (`Portal.tsx:88-114`) vẫn `encryptData(roomKey,...)`; switch WS_SUBTYPES (`Collab.tsx:1303-1567`) vẫn decrypt y nguyên. DO không thấy plaintext.
- **D7 — enum `WS_SUBTYPES` có 19 thành viên** (`app_constants.ts:23-70`): `INVALID_RESPONSE, INIT, UPDATE, MOUSE_LOCATION, IDLE_STATUS, USER_VISIBLE_SCENE_BOUNDS, CHAT, CHAT_REACTION, LIBRARY_FILE, LIBRARY_FILE_DELETE, LIBRARY_FILE_LOCK, RAISE_HAND, SCREEN_SHARE, MEETING_REACTION, STT_SEGMENT, USER_PROFILE, RECORDING_STATE, HOST_COMMAND, AUDIO_STATE`. `INVALID_RESPONSE` được `case`-handle riêng (early `return`) và mọi nhánh còn lại exhaustive → `default: assertNever(decryptedData, null)` (`Collab.tsx:1564-1566`) **PHẢI giữ** làm lưới biên dịch: thêm subtype mới mà quên handle = TypeScript báo lỗi ngay ở `assertNever`. KHÔNG xoá default. (Con số "18" cũ ở P1/§5 = đếm thiếu `INVALID_RESPONSE`.)
- **`#room=roomId,roomKey` GIỮ NGUYÊN:** roomKey vẫn ở hash fragment (E2E); token Supabase đi riêng qua subprotocol.

**Reconnect/resync (socket.io cho free, raw WS phải tự viết):**

- Backoff (0.5s→1s→2s→max 10s + jitter). **Deploy Worker = restart DO = đứt mọi WS** → bắt buộc auto-reconnect, nếu không user desync im lặng sau mỗi deploy (R4).
- Sau reconnect: gửi lại `join-room`; trên `new-user`/`first-in-room` re-broadcast USER_PROFILE + INIT (`Portal.tsx:52-58`). `socketInitialized` chống INIT trùng (`Portal.tsx:75`).
- `connect`-equiv → `setMySocketId(connectionId)` đọc từ `init-room`, thay cho `socket.on('connect', ...)` (`Collab.tsx:1144`).
- **Fallback 5s GIỮ NGUYÊN:** `INITIAL_SCENE_UPDATE_TIMEOUT` (`Collab.tsx:59,1239-1242`) + eager R2 prefetch (`:1162-1217`) vẫn trả scene nếu `first-in-room` chậm khi DO wake. Lưới an toàn này khiến hibernation-wake latency không thành sự cố.
- **`new-user` vs reconnect:** DO mint socketId mới mỗi accept → mỗi reconnect = "người mới" về presence (chấp nhận được). Client dedup host bằng `joinedAt`, không bằng socketId.

---

## 6. Dời AI/STT (I-1) lên Worker + wrangler secret

| Route hiện tại (file:line) | Đích | Ghi chú |
|---|---|---|
| `POST /translate` (`index.ts:384-432`) | Worker route | Gemini; rate-limit per-isolate |
| `POST /translate-batch` (`index.ts:315-382`) | Worker route | cache → per-isolate Map (mất khi isolate xoay, Gemini ~$0.075/1M token, chấp nhận) |
| `POST /chatbot` (`index.ts:490-615`) | Worker route | transcript context; rate-limit 5/min |
| `POST /summarize` (`index.ts:653-848`) | Worker route | recap JSON; rate-limit 1/min |
| `/stt` WS (`stt.ts:244-383`) | Worker WS proxy (route riêng) | proxy PCM↔Deepgram; stateless; route tách khỏi `/rooms/:id/ws` |

- **Route phân tách trên Worker:** `Worker.fetch` switch theo `url.pathname` TRƯỚC `.get()`: `/stt`→Deepgram proxy, `/rooms/:id/ws`→RoomDO, còn lại→REST. Test: "1 upgrade `/stt` không bao giờ chạm RoomDO".
- **Rate-limit:** express-rate-limit (per-IP, 1 instance) không port thẳng. **Đề xuất August:** per-isolate counter đơn giản (đủ cho internal, đúng P4). Nâng DO/KV-limiter **chỉ khi external lạm dụng thật**. B7 (AI rate-limit) vẫn phải đóng trước external.
- **Secrets (wrangler):** `DAILY_API_KEY`, `GEMINI/GOOGLE key`, `DEEPGRAM key`, `RESEND_API_KEY` → `wrangler secret put` trên `mcm-storage` (B3). Không hardcode, không để trong `wrangler.jsonc`. Binding DB/R2 đã có (`wrangler.jsonc:17`).
- **STT mặc định OFF (B8)** giữ nguyên khi dời.

---

## 7. Chiến lược migration parity-safe + dual-run + rollback

### 7.1 Dual-run qua cờ — **RUNTIME per-meeting, KHÔNG build-time**

> **Lỗ hổng nghiêm trọng (critique B):** `VITE_APP_REALTIME` là **build-time env của Vite** (`import.meta.env` inline lúc build). Nếu client A (build cũ/cache) = socketio và B (build mới) = DO vào **cùng phòng** → hai backend, không thấy nhau, **scene split-brain im lặng**. → Cờ chọn backend phải đến **từ server**.

- Worker trả `realtime_backend` (`do|socketio`) trong **room metadata D1 per-meeting**; client đọc lúc `initializeRoom`, **KHÔNG** từ `import.meta.env`.
- Cờ chỉ chọn `RawWsTransport` (DO) hay socket.io-client. Phần encrypt/switch/18 `broadcast*` byte-identical.
- **Mọi client trong 1 meeting CÙNG backend** (A/B theo cả phòng). Mismatch giữa 2 client cùng phòng = bug chặn-merge.
- **July:** mặc định `socketio` trên Fly (test nội bộ thật). DO build song song, bật cho **vài phòng nội bộ** verify, thu log parity.
- **Bỏ bridge socket.io↔DO:** A/B theo cả phòng là đủ cho parity test; bridge thật phức tạp 2× maintain → TRÁNH.

### 7.2 Thứ tự cắt từng tính năng (rủi ro tăng dần)

1. **Hạ tầng** — DO class + Worker route + frame + auth handshake. Test wrangler/vitest (DO unit test).
2. **R2-by-reference cho LIBRARY_FILE** (BẮT BUỘC trước cutover — fix hard-break 1 MiB). **Deploy cho CẢ HAI backend cùng lúc**, gate theo **build** không theo realtime flag (nếu không: client socketio inline 50MB vs client DO nhận `{fileId,r2Key}` → corrupt nửa-migrated). An toàn nhất: làm R2-ref trước, chạy ổn trên socketio Fly vài ngày, RỒI mới bật DO. Verify file 30MB+.
3. **Scene sync** (server-broadcast INIT/UPDATE, volatile cursor/idle) — 90% traffic.
4. **Presence** (room-user-change, first-in-room, new-user) — host election, prune. Chú ý 3 invariant §3.1.
5. **rtc-signal + user-follow** (targeted) — voice mesh + follow-view; dễ partial-fail → test kỹ.
6. **Chat / reactions / STT_SEGMENT / library lock / raise-hand / screen-share / recording / host-command** — đều ride broadcast, parity = byte-identical.
7. **Auth enforcement (1b)** bật cứng: từ chối non-admitted/revoked.

### 7.3 Verify PARITY (room-by-room checklist)

- **Canvas sync:** 2 client vẽ/move/delete, so version + thứ tự + nội dung khớp socket.io (deletion cần version bump để broadcast — ref memory collab-gotchas).
- **Presence:** join/leave list đúng; `first-in-room` chỉ 1 lần/đời phòng (cờ storage, KHÔNG length); `new-user` không double khi reconnect; reconnect KHÔNG full-scene re-broadcast.
- **Lock share:** 1 người share → người khác early-return (`Collab.tsx:2405-2421`); sharer rớt ngột → prune (`:1862-1883`) không kẹt lock.
- **Knock:** external denied KHÔNG mở được WS (DO 403); admitted mở được; internal auto.
- **Reconnect:** kill network 2s → tự reconnect, re-INIT, không desync; deploy Worker → mọi client tự nối lại; debounce `room-user-change` không nhấp nháy.
- **AI:** /translate, /chatbot, /summarize trả kết quả + rate-limit hoạt động.
- **STT:** `/stt` proxy ↔ Deepgram, subtitle hiện đúng thứ tự; không đụng route DO.
- **Follow:** A follow B → viewport B đẩy tới A; B rời → `broadcast-unfollow`.
- **Tải payload:** file 30MB qua R2-ref OK; >1MiB inline KHÔNG còn.

### 7.4 Rollback nhanh

- Đổi `realtime_backend='socketio'` (D1 per-meeting) → client reconnect về Fly/socket.io. R2 authoritative → **không mất dữ liệu, không migrate**.
- **GIỮ `socket.io-client` trong bundle suốt cửa sổ rollback** (~30KB gz) — nếu xóa khỏi bundle, rollback = redeploy frontend, không phải lật cờ. Rollback diễn tập = "đổi giá trị D1 + client reconnect", đo thật < 5 phút.
- Giữ Fly socket.io chạy (không tắt) tới khi DO ổn định ≥ vài tuần sau August.
- DO không giữ canvas state bền vững → tắt DO không mất gì.

---

## 8. Placement đa quốc gia (Hàn + VN + Phi)

> **Cảnh báo kỹ thuật (critique C — phải kiểm chứng trên docs Cloudflare TRƯỚC khi hứa):** `env.ROOM.idFromName(roomId)` cho ID **deterministic** và **placement theo region của first-access**; `locationHint` chủ yếu honored với `newUniqueId()`. → Chiến lược `home_region` trên `idFromName` **có thể vô tác dụng**.

- **August scope: KHÔNG dựng schema `home_region`/`locationHint` D1** (OVER-ENGINEER + có thể sai kỹ thuật). DO sống ở **đúng 1 region**, không replica, không relocation sau tạo.
- **Thực tế chấp nhận được:** payload là **delta mã hóa nhỏ** (media đã ở Daily.co); client terminate WS ở **edge Cloudflare gần nhất** → chỉ thêm 1 chặng edge→DO. Intra-APAC vài chục ms; Phi→APAC ~200-300ms cho cursor/scene — chấp nhận.
- **Kiểm soát mềm:** đảm bảo **người tạo phòng (host nội bộ APAC) là người `.get()` đầu** → DO sinh ở APAC. Một guest Phi mở phòng sớm có thể ghim phòng sang region xa — theo dõi, chỉ optimize nếu user phàn nàn.
- **Việc cần làm August:** _đo latency thật từ Phi_ trước; nếu traffic Phi lớn mới cân nhắc (a) ghim placement bằng cơ chế đã-verify trên docs, hoặc (b) `jurisdiction` cho data-residency. **KHÔNG re-architect.**

---

## 9. Test + checklist GO/NO-GO

**9.1 Unit (vitest + wrangler DO test)**

- Frame pack/unpack: phân biệt string vs ArrayBuffer; input méo (iv lệch biên) không treo parser, log lỗi trước relay.
- DO handler: join/broadcast/rtc-route/follow/close; socketId sống qua `serializeAttachment` sau mô phỏng hibernation; `roomEverInitialized` đúng sau wake (first-in-room KHÔNG re-fire).
- Auth: JWT hợp lệ/hết hạn/sai audience; canSeeMeeting pass/fail; knock admitted/denied; WS-count cap.

**9.2 E2E (Playwright, 2-4 client)** — toàn bộ checklist §7.3 trên DO path, so log với socket.io path.

**9.3 Tải**

- 1 phòng 100 user: memory DO (~2KB/socket → ~200KB OK < 128MB); fanout 200KB scene × 100 `ws.send` — **đo thật**, nếu chậm thì chunk fanout (`queueMicrotask`) hoặc giới hạn; **đừng hứa 10ms khi chưa đo**.
- **D6 — 20s full-sync fanout PHẢI nằm trong kịch bản tải:** mỗi client tự `queueBroadcastAllElements` (`Collab.tsx:2021-2033`, throttle `SYNC_FULL_SCENE_INTERVAL_MS=20000`; schedule từ `broadcastElements:1968`) đẩy TOÀN BỘ scene mỗi 20s. → DO nhận **N full-scene/20s** rồi fan-out **N×(N-1)** lần (mỗi full-scene tới N-1 peer). Đây là đỉnh tải binary-relay tệ nhất, **không phải** delta nhỏ — load test §9.3 phải mô phỏng N client × full-scene mỗi 20s đồng thời (không chỉ cursor/delta) để đo backpressure thật trên DO single-thread.
- 1 phòng 500 user (workshop): kiểm O(N) trên close (follow-map lazy, KHÔNG deserialize mọi WS mỗi close); kiểm giới hạn thật.
- Eviction test: ép DO evict sau idle → client reconnect trong suốt, presence resync, không mất scene (R2).
- **Hibernation thật:** phòng idle 10 phút → **0 wake event** trong DO log (không setInterval/alarm/heartbeat rò giữ ấm; `setWebSocketAutoResponse` không wake).

**9.4 Checklist GO/NO-GO (trước cắt August)**

- [ ] **1b đóng:** external denied/revoked KHÔNG relay được (thủ công + auto).
- [ ] **LIBRARY_FILE** R2-by-reference, file 30MB+ OK; không còn inline >1MiB; deploy đồng bộ cả hai backend.
- [ ] **Reconnect sau deploy Worker** tự phục hồi 100% client; debounce presence không nhấp nháy.
- [ ] **`first-in-room`** dùng `roomEverInitialized` storage; wake-from-hibernate KHÔNG clear scene người reconnect.
- [ ] **Cờ backend RUNTIME per-meeting** (D1), KHÔNG build-time; không split-brain cross-build.
- [ ] **Parity** canvas/presence/chat/follow/rtc/lock/knock PASS so socket.io.
- [ ] **AI + STT** trên Worker; rate-limit (B7) + STT OFF (B8) OK; `/stt` không chạm RoomDO.
- [ ] **Secrets** rotate (B3); CORS allowlist (B6) OK.
- [ ] **Rollback** diễn tập: đổi D1 + reconnect < 5 phút, không mất data; socket.io-client còn trong bundle.
- [ ] **Hibernation thật:** idle → DO evict → $0; 0 wake event 10 phút.
- [ ] **Verify trên docs Cloudflare:** `idFromName` + `locationHint` hiệu lực thực tế trước khi hứa multi-region.
- **NO-GO** nếu bất kỳ mục auth / file / reconnect / first-in-room / cờ-runtime / rollback fail.

---

## 10. Timeline & ước lượng

| Mốc | Hạng mục | Ước lượng |
|---|---|---|
| **July W1-2** | DO class skeleton + Worker route `/rooms/:id/ws` + auth handshake (JWT+canSeeMeeting+knock+WS-cap) + frame | 4-6 ngày |
| **July W1-2** | `RawWsTransport` client (mimic socket.io API) + cờ **runtime per-meeting (D1)** | 3-4 ngày |
| **July W2-3** | LIBRARY_FILE → R2-by-reference (hard-break fix, deploy cả hai backend) | 2-3 ngày |
| **July W2-3** | I-1: dời AI/STT routes lên Worker + secrets + rate-limit + route-split `/stt` | 3-4 ngày |
| **July W3-4** | Reconnect/resync loop + presence (3 invariant §3.1) + debounce close | 3-4 ngày |
| **July W4** | rtc-signal + follow targeted relay (follow-map lazy) | 2-3 ngày |
| **July (suốt)** | **Test nội bộ Fly socket.io = mặc định**; DO bật cờ cho subset phòng; thu log parity | song song |
| **Aug W1** | Unit + E2E + load test; chạy GO/NO-GO checklist | 4-5 ngày |
| **Aug W1-2** | Bật DO default cho nội bộ (parity verified), giữ Fly làm rollback | 2-3 ngày |
| **Aug W2** | **Cắt DO TRƯỚC khi mở external + global (Phi)**; theo dõi eviction/latency | — |
| **Aug W2+** | Giữ socket.io Fly + socket.io-client trong bundle thêm vài tuần làm lưới rollback | — |

Tổng lõi kỹ thuật: ~3-4 tuần-người, gói trong July; August = hardening + cutover. (1 người tự maintain → realistic vì DO = relay ngu, không CRDT server.)

---

## 11. Rủi ro & giảm thiểu

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | **1b auth gap** — `room/src/index.ts:863-920` relay không verify; guest denied vẫn edit | **CHẶN external** | DO verify JWT+canSeeMeeting+knock+WS-cap trước 101 (§4); enforce ở handshake |
| R2 | **1 MiB/msg** vs `maxHttpBufferSize 50MB` — LIBRARY_FILE inline vỡ | Cao | R2-by-reference trước cutover; deploy CẢ HAI backend đồng bộ; test 30MB+ |
| R3 | **Cờ build-time → split-brain** 2 client khác build cùng phòng | **Cao** | Cờ RUNTIME per-meeting từ D1, KHÔNG `import.meta.env`; A/B theo cả phòng |
| R4 | **Deploy = đứt mọi WS** (restart DO) | Cao | Reconnect loop client bắt buộc; re-INIT sau nối; debounce presence |
| R5 | **`first-in-room` từ `getWebSockets().length`** → wake-from-hibernate clear scene | **Cao** | Cờ `roomEverInitialized` trong `ctx.storage`; KHÔNG suy từ length |
| R6 | Reconnect reset `broadcastedElementVersions` → full-scene re-broadcast bão | TB | Reconnect chỉ swap transport, KHÔNG `Portal.close()`; giữ Map; test |
| R7 | Token không vào được WS header | TB | `Sec-WebSocket-Protocol` (ưu tiên) > `?token=`; tránh rò log |
| R8 | socketId/follow không sống qua hibernation → rtc/follow vỡ âm thầm | TB | `serializeAttachment`; follow-map lazy rebuild on-wake; `rtc-error` khi peer offline |
| R9 | `idFromName` + `locationHint` KHÔNG cùng hiệu lực → hứa region sai | TB | Verify trên docs trước; bỏ `home_region` August; host APAC `.get()` đầu |
| R10 | Frame parsing bug | TB | Phân biệt string/ArrayBuffer thay length-prefix tự chế; unit test input méo |
| R11 | Accidental keep-alive phá hibernation → mất $0 | TB | Cấm timer giữ ấm; `RawWsTransport` không heartbeat; `setWebSocketAutoResponse` ping |
| R12 | Presence churn / N×close khi deploy → nhấp nháy | TB | **Debounce `room-user-change` ~250ms BẮT BUỘC** (không optional) |
| R13 | DO single-thread: fanout 200KB × N socket chặn event loop | TB | Đo thật; chunk fanout `queueMicrotask` nếu chậm; không hứa 10ms khi chưa đo |
| R14 | Runaway bill (spam mở WS sau global) | TB | WS-count cap ở handshake (RPC count, > N → 403); B1 spend-cap |
| R15 | `/stt` đụng `/rooms/:id/ws`; AI cache/rate-limit per-isolate (không global) | TB | Route-split theo pathname trước `.get()`; per-isolate đủ cho dev (P4) |
| R16 | volatile cursor flood buffer vô hạn (không drop khi backpressure) | TB | Check `bufferedAmount` < ngưỡng cho volatile path; test 60fps × 100 user |
| R17 | JWKS stale sau hibernation/xoay key Supabase | Thấp | `max-age=60s`; refetch JWKS on 401; client retry |

---

## Checklist thực thi

1. [ ] DO `RoomDO` class + Worker route `/rooms/:id/ws` (route-split theo `pathname` trước `.get()`).
2. [ ] **Auth handshake §4** ở Worker: JWT (subprotocol token) + canSeeMeeting + knock(external) + WS-count cap → 401/403 trước 101. **(đóng 1b/B12)**
3. [ ] `acceptWebSocket` + `serializeAttachment({socketId,userId,email,role,joinedAt})` + gửi `init-room` NGAY sau accept.
4. [ ] Cờ `roomEverInitialized` trong `ctx.storage` cho `first-in-room`; mọi reconnect khác = `new-user`.
5. [ ] Relay: `server-broadcast` (OPEN only) + `server-volatile-broadcast` (check `bufferedAmount`) + `request-room-clients`.
6. [ ] Targeted: `rtc-signal` (+`rtc-error` peer-offline) + `user-follow` (follow-map lazy in-memory).
7. [ ] `webSocketClose`: follow cleanup + **debounce `room-user-change` ~250ms** + `broadcast-unfollow`.
8. [ ] Bỏ app-heartbeat; `setWebSocketAutoResponse` ping/pong (không wake).
9. [ ] **LIBRARY_FILE → R2-by-reference**; deploy CẢ HAI backend đồng bộ; test 30MB+.
10. [ ] `RawWsTransport` client (mimic socket.io API; frame string vs ArrayBuffer) — swap tại `Collab.tsx:1100-1126`.
11. [ ] Reconnect loop (backoff+jitter), re-`join-room`, re-INIT; KHÔNG `Portal.close()` (giữ `broadcastedElementVersions`).
12. [ ] **Cờ backend RUNTIME per-meeting** trong D1 (`realtime_backend`); client đọc lúc `initializeRoom`.
13. [ ] I-1: dời `/translate`,`/translate-batch`,`/chatbot`,`/summarize` lên Worker; `/stt` WS proxy route riêng.
14. [ ] `wrangler secret put` (Daily/Gemini/Deepgram/Resend); rate-limit per-isolate; STT OFF mặc định.
15. [ ] Unit + E2E (Playwright) + load + eviction + hibernation (0 wake/10min) test.
16. [ ] Verify trên docs Cloudflare: `idFromName`+`locationHint`; quyết định placement Phi (KHÔNG schema mới).
17. [ ] Chạy **GO/NO-GO §9.4**; July test nội bộ Fly default; **Aug cắt DO trước external + global**.
18. [ ] Rollback diễn tập < 5 phút (đổi D1 + reconnect); giữ Fly + socket.io-client bundle vài tuần.

---

## Parity acceptance checklist (Team C)

> GO/NO-GO trước khi bật DO cho một phòng. Mỗi mục = một hành vi thật trên `client-broadcast` switch (`Collab.tsx:1303-1567`, 19 WS_SUBTYPES) hoặc một control-frame của DO. So sánh DO-path với socket.io-path; **bất kỳ NO-GO nào = không cắt.** Re-derived 06-17 từ code thực, không phỏng đoán.

**1. Scene sync**
- [ ] `INIT` (SCENE_INIT, `:1306-1322`): late-joiner nhận scene đầy đủ 1 lần; `socketInitialized` chống INIT trùng.
- [ ] `UPDATE` (SCENE_UPDATE, `:1323-1331`): vẽ/move/delete reconcile đúng version + thứ tự; **deletion cần version bump** mới broadcast (ref collab-gotchas).
- [ ] **20s full-sync** (`queueBroadcastAllElements:2021-2033`): mỗi 20s full-scene fan-out N×(N-1) không gây desync / không nhân đôi version (D6 — cũng vào load test).

**2. Presence**
- [ ] `first-in-room` (control, `:1571-1590`): CHỈ 1 lần/đời phòng (cờ `roomEverInitialized` storage, KHÔNG length); wake-from-hibernate KHÔNG clear scene người reconnect.
- [ ] `new-user` (control): peer cũ đẩy lại USER_PROFILE + INIT; KHÔNG double khi reconnect.
- [ ] `room-user-change` (control): join/leave list đúng; **debounce ~250ms** gộp N×close (deploy) không nhấp nháy.
- [ ] `USER_PROFILE` (`:1464-1477`): tên/công ty/avatar + `joinedAt` layer đúng lên Collaborator; late-joiner nhận snapshot rebroadcast.
- [ ] `MOUSE_LOCATION` (`:1332-1366`, volatile): cursor mượt; backpressure-drop khi buffer đầy (không phình vô hạn).
- [ ] `IDLE_STATUS` (`:1402-1409`): active/idle/away đổi đúng.
- [ ] `USER_VISIBLE_SCENE_BOUNDS` (`:1368-1400`): chỉ tác động khi đang follow đúng socketId; bỏ qua cross-follow.

**3. Follow**
- [ ] `user-follow` FOLLOW/UNFOLLOW (control): A follow B → viewport B đẩy tới A.
- [ ] `user-follow-room-change` (control): followed nhận đúng danh sách follower.
- [ ] `broadcast-unfollow` (control): B rời / mất hết follower → A nhận unfollow, không treo.

**4. RTC / voice (D1 — kept-but-unused)**
- [ ] `rtc-signal` + `request-room-clients`: **hiện KHÔNG client nào emit** (WebRTC mesh đã thay bằng Daily.co). Server đã build + test, GIỮ làm forward-compat (comment trong `roomDO.ts`). Verify = **chúng KHÔNG được kích hoạt vô tình**; KHÔNG cần parity hành vi vì không có caller. KHÔNG xoá code/test.
- [ ] `AUDIO_STATE` (`:1558-1562`): in-call + muted (kể cả self-mute) render đúng icon mic mọi peer real-time.

**5. Locks**
- [ ] `SCREEN_SHARE` (`:1448-1452`): 1 người share → người khác early-return (`applyScreenShare:2405-2421`); sharer rớt ngột → prune-on-leave (`:1862-1883`) không kẹt lock; media qua Daily.co.
- [ ] `LIBRARY_FILE_LOCK` (`:1431-1440`): lock/unlock file thư viện mirror lên ảnh canvas tham chiếu file đó.

**6. Chat / reactions / raise-hand**
- [ ] `CHAT` (`:1411-1414`): tin nhắn tới đúng thứ tự.
- [ ] `CHAT_REACTION` (`:1416-1419`): reaction áp đúng tin.
- [ ] `MEETING_REACTION` (`:1454-1457`): emoji nổi ephemeral, tự hết hạn, bounded list.
- [ ] `RAISE_HAND` (`:1442-1446`): badge sticky tới khi hạ; prune khi peer rời (`:1845-1859`).

**7. STT**
- [ ] `STT_SEGMENT` (`:1459-1462`): subtitle finalized đi đường `client-broadcast` (E2E qua roomKey), giữ thứ tự per-sender (DO single-thread); `/stt` proxy KHÔNG chạm RoomDO.

**8. Recording**
- [ ] `RECORDING_STATE` (`:1479-1493`): banner "Đang ghi âm" + elapsed timer (startedAt) đúng cho late-joiner; host id check ở render-time.

**9. Knock / auth**
- [ ] External `denied`/`invited` (chưa admitted) → DO handshake **403, KHÔNG mở WS** (§4).
- [ ] External `admitted` → 101; internal staff + admin auto skip knock.
- [ ] JWT hết hạn/sai audience → 401; canSeeMeeting fail → 403; WS-count cap → 403.
- [ ] **Finished = read-only (D3):** phòng `finished` → handshake **409**, reviewer KHÔNG relay được.
- [ ] Subprotocol: token = segment KHÁC `mcm.v1`; server echo `mcm.v1` (KHÔNG echo JWT) trên 101 (M1).
- [ ] `init-room` mang `args:[{socketId}]`; client đọc `args[0].socketId` set `.id` (M2).
- [ ] `realtime_backend` (do|socketio) đọc end-to-end; absent/null → `socketio` (non-breaking) (M3).

**10. Reconnect**
- [ ] Kill network 2s → tự reconnect (backoff+jitter), re-`join-room`, re-INIT, KHÔNG desync.
- [ ] Deploy Worker → mọi client tự nối lại; KHÔNG `Portal.close()` (giữ `broadcastedElementVersions`) → KHÔNG full-scene re-broadcast bão.
- [ ] DO mint socketId mới mỗi accept → host dedup bằng `joinedAt`, KHÔNG socketId.

**11. Host command / AI**
- [ ] `HOST_COMMAND` (`:1495-1556`): END_MEETING verify qua registry (finished); KICK chỉ từ elected host hoặc `fromAuthority`; MUTE/UNMUTE target-scoped tự self-mute.
- [ ] AI: `/translate`, `/chatbot`, `/summarize` trả kết quả + rate-limit (per-isolate) hoạt động.

**12. Library-file**
- [ ] `LIBRARY_FILE` (`:1421-1424`) + `LIBRARY_FILE_DELETE` (`:1426-1429`): file thư viện qua **R2-by-reference** (KHÔNG inline >1MiB); add/delete đồng bộ; test 30MB+.
- [ ] `INVALID_RESPONSE` (`:1304-1305`): early-return, không vỡ switch; `default: assertNever` (`:1564-1566`) giữ làm lưới biên dịch (D7).

---

_File neo đã xác minh khớp 100% code thực tế: `room/src/index.ts:855-1019`, `excalidraw-app/collab/Portal.tsx:30-114`, `excalidraw-app/collab/Collab.tsx:1100-1146,1303-1567,1571-1604`; `worker/src/index.ts:146-183,306-372,693-728,3467-3589,4429-4577`; `worker/src/roomDO.ts`; `excalidraw-app/collab/RawWsTransport.ts`; `excalidraw-app/data/projects.ts:340-393`._
